#!/usr/bin/env node
// mcd-best-deal · 最优方案计算引擎
// 读取 collect 输出与规则文件：生成候选方案 → 调官方算价器逐个试算 → 多目标评分排序。
// 一切价格以官方 calculate-price 实时返回为准；本脚本只做枚举、比较与排序。
//
// 用法：
//   node scripts/plan.mjs --input data.json [--mode save|healthy|easy] [--people 1]
//                         [--want 关键词（多词用 和/、/，）] [--budget 总价上限(元)] [--top 3]
//                         [--protein-min 30 --kcal-max 600 --fat-max 30 --sodium-max 800]
//                         [--rules ../config/rules.json] [--output plan.json]

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpClient, resolveToken } from './lib/mcp-client.mjs';
import { findNutrition, isLightItem, loadPreferences, expandWantTerms, matchLevel, splitWants, WANT_ALIASES, matchesTerms } from './lib/util.mjs';

const SCHEMA = 'mcd-best-deal/plan@0.1.0';
const COMBO_PATTERN = /套餐|三件套|四件套|随心选|双人餐|双人|单人餐|拼盘|随心拼|分享餐/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  if (argv.includes('--help')) return { help: true };
  const options = { mode: null, people: 1, top: 3, want: null, budget: null, output: null, rules: null, style: 'any' };
  const allowed = new Set(['--input', '--mode', '--people', '--want', '--budget', '--top', '--rules', '--output', '--style',
    '--protein-min', '--kcal-max', '--fat-max', '--sodium-max']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) fail(`未知参数：${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${key} 缺少值`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!options.input) fail('需要 --input <collect 输出文件>');
  if (options.mode !== null && !['save', 'healthy', 'easy'].includes(options.mode)) fail('--mode 只能是 save / healthy / easy');
  for (const key of ['proteinMin', 'kcalMax', 'fatMax', 'sodiumMax']) {
    if (options[key] != null) {
      const value = Number(options[key]);
      if (!Number.isFinite(value) || value <= 0) fail(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} 必须是正数`);
      options[key] = value;
    }
  }
  if (!['any', 'combo', 'single'].includes(String(options.style))) fail('--style 只能是 any / combo / single');
  options.people = Number(options.people);
  if (!Number.isInteger(options.people) || options.people < 1 || options.people > 20) fail('--people 必须是 1-20 的整数');
  options.top = Number(options.top);
  if (!Number.isInteger(options.top) || options.top < 1 || options.top > 10) fail('--top 必须是 1-10 的整数');
  if (options.budget != null) {
    options.budget = Number(options.budget);
    if (!Number.isFinite(options.budget) || options.budget <= 0) fail('--budget 必须是正数（元）');
  }
  return options;
}

// ---- 营养匹配与计算 ----

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function nutritionOf(items, nutritionTable, targets) {
  const totals = { energyKcal: 0, protein: 0, fat: 0, sodium: 0 };
  let exactCount = 0;
  let fuzzyCount = 0;
  const details = [];
  for (const item of items) {
    const { row, quality } = findNutrition(nutritionTable, item.productName);
    if (!row) {
      details.push({ productName: item.productName, quality: 'none' });
      continue;
    }
    if (quality === 'exact') exactCount += 1;
    else fuzzyCount += 1;
    const quantity = item.quantity ?? 1;
    totals.energyKcal += num(row.energyKcal) * quantity;
    totals.protein += num(row.protein) * quantity;
    totals.fat += num(row.fat) * quantity;
    totals.sodium += num(row.sodium) * quantity;
    details.push({ productName: item.productName, matchedAs: row.productName, quality });
  }
  // 只有「全部商品都精确匹配」才算完整；模糊匹配会低估营养，不用于展示与评分（数据诚实）
  const complete = items.length > 0 && exactCount === items.length;
  const partial = exactCount + fuzzyCount > 0;
  let score = 0.5;
  if (complete) {
    const penalties = [];
    if (targets.energyKcalMax && totals.energyKcal > targets.energyKcalMax) {
      penalties.push((totals.energyKcal - targets.energyKcalMax) / targets.energyKcalMax);
    }
    if (targets.proteinGMin && totals.protein < targets.proteinGMin) {
      penalties.push((targets.proteinGMin - totals.protein) / targets.proteinGMin);
    }
    if (targets.fatGMax && totals.fat > targets.fatGMax) {
      penalties.push((totals.fat - targets.fatGMax) / targets.fatGMax);
    }
    if (targets.sodiumMgMax && totals.sodium > targets.sodiumMgMax) {
      penalties.push((totals.sodium - targets.sodiumMgMax) / targets.sodiumMgMax);
    }
    score = Math.max(0, 1 - penalties.reduce((sum, value) => sum + value, 0));
  } else {
    // 营养数据不完整：降权（不给中性分）——避免「0 kcal 的酱料」在健康模式里赢过有真实数据的商品
    score = 0.3;
  }
  return {
    energyKcal: Math.round(totals.energyKcal),
    protein: Math.round(totals.protein),
    fat: Math.round(totals.fat),
    sodium: Math.round(totals.sodium),
    matched: complete,
    partial,
    fuzzy: fuzzyCount > 0,
    details,
    score: round3(score),
  };
}

// ---- 候选生成 ----

function collectPool(data, options) {
  // 返回 [{ storeCode, meals: [{code,name,price,originalPrice,tags,category,isPopular,isCombo}] }]
  const pools = [];
  for (const storeCode of data.candidates ?? []) {
    const menu = data.menus?.[storeCode];
    if (!menu) continue;
    // 收集每个商品的全部所在分类（商品可能出现在多个分类；取第一个为主分类，人气按任意分类判定）
    const categoriesOf = new Map();
    for (const category of menu.categories ?? []) {
      for (const entry of category.meals ?? []) {
        const code = String(entry.code);
        if (!categoriesOf.has(code)) categoriesOf.set(code, []);
        categoriesOf.get(code).push(category.name ?? '');
      }
    }
    const meals = Object.entries(menu.meals ?? {}).map(([code, meal]) => {
      const names = categoriesOf.get(code) ?? [];
      return {
        code,
        name: meal.name ?? '',
        price: Number(meal.currentPrice),
        originalPrice: Number(meal.originalPrice),
        tags: meal.tags ?? [],
        category: names[0] ?? '',
        isPopular: names.some((name) => name.includes('人气')),
        isCombo: COMBO_PATTERN.test(meal.name ?? '') || /套餐|单人餐|多人餐|拼盘/.test(names.join(' ')),
      };
    }).filter((meal) => meal.code && Number.isFinite(meal.price));
    pools.push({ storeCode, meals });
  }
  return pools;
}

function buildCandidates(data, rules, options) {
  const candidates = [];
  const matchedCatalog = [];
  const pools = collectPool(data, options);
  const maxPerType = rules.constraints?.maxCandidatesPerType ?? 4;
  const people = options.people;
  const budgetFen = options.budget ? Math.round(options.budget * 100) : null;
  const prefs = options.preferences ?? { avoidItems: [], preferItems: [] };

  const want = options.want?.trim() || null;
  // 词条扩展与匹配在 lib/util.mjs（多词拆分 + 别名 + 「去后缀」变体，如 麦辣鸡腿堡→麦辣鸡腿）
  const wantTerms = expandWantTerms(want);
  // 品类词（汉堡/咖啡/冰淇淋…）允许「分类名」宽松匹配参与；具体商品词（巨无霸/麦香鸡）以名称命中为准
  const broadMatch = splitWants(want).some((piece) => piece in WANT_ALIASES);
  // explicitlyWants：用户「明确点名」（无 want 时为 false，绝不因缺省而放行）
  const explicitlyWants = (name, tags, category) => Boolean(want) && matchesTerms(name, tags, category, wantTerms);
  const matchesWant = (name, tags, category) => !want || explicitlyWants(name, tags, category);
  const isAvoided = (meal) => prefs.avoidItems.some((item) => meal.name.includes(item));
  const isPreferred = (meal) => prefs.preferItems.some((item) => meal.name.includes(item));

  for (const pool of pools) {
    // 正餐池：① 轻食类（饮品/冰淇淋/甜点）默认排除——用户点名时保留；
    //         ② 排除用户忌口商品。
    const diningPool = pool.meals.filter((meal) => {
      if (isAvoided(meal)) return false;
      // 轻食/配餐类（饮品/冰淇淋/甜点/酱料/苹果片等）默认排除——仅当用户明确点名时保留。
      // 注意：不豁免「套餐」——「XX 饮品随心选」这类含套餐字样的轻食套餐同样不该进正餐候选（外部实测发现）。
      if (isLightItem(meal) && !explicitlyWants(meal.name, meal.tags, meal.category)) return false;
      return true;
    });
    // 排序偏好：用户喜欢的 > 人气款（仅作「不确定时的备用参考」，不再作为过滤条件）> 其余（保持原序）
    const prefScore = (meal) => (isPreferred(meal) ? 2 : 0) + (meal.isPopular ? 1 : 0);
    const ranked = [...diningPool].sort((a, b) => prefScore(b) - prefScore(a));
    // 匹配优先级（修复「点名巨无霸，Top 却是同分类里更便宜的牛肉堡」）：
    //  · 品类词（宽匹配）→ 名称级 + 分类级合并；
    //  · 具体商品词 → 以名称/标签直接命中的候选为准；名称级为空时才退回分类级。
    let wanted;
    if (!want) {
      wanted = ranked;
    } else if (broadMatch) {
      wanted = ranked.filter((meal) => matchLevel(meal.name, meal.tags, meal.category, wantTerms) > 0);
    } else {
      const nameLevel = ranked.filter((meal) => matchLevel(meal.name, meal.tags, meal.category, wantTerms) === 2);
      wanted = nameLevel.length
        ? nameLevel
        : ranked.filter((meal) => matchLevel(meal.name, meal.tags, meal.category, wantTerms) === 1);
    }
    // 完整匹配清单（供展示层说明覆盖范围：候选受名额限制，但「想吃的」的完整匹配可如实告知）
    if (want && wanted.length) {
      matchedCatalog.push({
        storeCode: pool.storeCode,
        total: wanted.length,
        names: wanted.slice(0, 30).map((meal) => meal.name),
      });
    }
    const styleAllowsCombo = options.style !== 'single';
    const styleAllowsSingle = options.style !== 'combo';
    const combos = styleAllowsCombo
      ? wanted.filter((meal) => meal.isCombo).slice(0, maxPerType)
      : [];
    // 单品选取：人气/偏好靠前 2 款 + 全池最便宜 1 款 + （点名时）最直接命中的 1 款（去重）
    // ——「最直接命中」= 名称级匹配中名称最短的那个（点「麦香鱼」时保证「麦香鱼」本身进候选）
    const singlePool = wanted.filter((meal) => !meal.isCombo);
    const cheapest = [...singlePool].sort((a, b) => a.price - b.price)[0];
    const directHit = want
      ? [...singlePool]
        .filter((meal) => matchLevel(meal.name, meal.tags, meal.category, wantTerms) === 2)
        .sort((a, b) => a.name.length - b.name.length)[0]
      : null;
    const singles = styleAllowsSingle
      ? [...singlePool.slice(0, 2), ...(cheapest ? [cheapest] : []), ...(directHit ? [directHit] : [])]
        .filter((meal, index, array) => array.findIndex((item) => item.code === meal.code) === index)
        .slice(0, 4)
      : [];

    // 类型 1：官方套餐
    for (const combo of combos) {
      const quantity = /双人/.test(combo.name) ? Math.ceil(people / 2) : people;
      candidates.push({
        kind: 'combo', storeCode: pool.storeCode, group: combo.name.replace(COMBO_PATTERN, ''),
        title: `${combo.name} ×${quantity}`,
        items: [{ productCode: combo.code, productName: combo.name, quantity }],
        estimateFen: Math.round(combo.price * 100) * quantity, // 菜单现价（元）→ 分；仅供预算预筛，实付价一律以算价器为准
        ...(combo.isPopular ? { popular: true } : {}),
      });
    }

    // 类型 2：单品裸买
    for (const single of singles.slice(0, 4)) {
      candidates.push({
        kind: 'single', storeCode: pool.storeCode, group: single.name,
        title: `${single.name} ×${people}`,
        items: [{ productCode: single.code, productName: single.name, quantity: people }],
        estimateFen: Math.round(single.price * 100) * people, // 菜单现价（元）→ 分
        ...(single.isPopular ? { popular: true } : {}),
      });
    }

    // 类型 3：单品 + 基础搭配（薯条 + 可乐；配套商品同样遵循忌口）
    const fries = pool.meals.find((meal) => /薯条/.test(meal.name) && !meal.isCombo && !isAvoided(meal));
    const drink = pool.meals.find((meal) => /可乐/.test(meal.name) && !meal.isCombo && !isAvoided(meal));
    for (const single of singles.slice(0, 3)) {
      if (!fries && !drink) break;
      const items = [{ productCode: single.code, productName: single.name, quantity: people }];
      if (fries) items.push({ productCode: fries.code, productName: fries.name, quantity: people });
      if (drink) items.push({ productCode: drink.code, productName: drink.name, quantity: people });
      candidates.push({
        kind: 'combo-parts', storeCode: pool.storeCode, group: single.name,
        title: `${single.name} + ${fries?.name ?? ''}${drink ? ` + ${drink.name}` : ''} ×${people}`,
        items,
        estimateFen: Math.round((single.price + (fries?.price ?? 0) + (drink?.price ?? 0)) * 100) * people,
        ...(single.isPopular ? { popular: true } : {}),
      });
    }

    // 类型 4：券商品方案（该店可用券，一单一券）
    const coupons = data.storeCoupons?.[pool.storeCode] ?? [];
    const relatedCoupons = [];
    for (const coupon of coupons.slice(0, maxPerType)) {
      const product = coupon.products?.[0];
      if (!product?.productCode) continue;
      // 券商品进入主候选的条件：
      //  · 用户点名（want 命中）→ 进入；
      //  · 用户未点名：轻食类券（饮品/冰淇淋等）不进主候选（降级为「顺便可用」提示）；
      //    其余商品券（小食等）进入主候选。
      const couponIsLight = isLightItem({ name: product.productName ?? '' });
      const couponMatches = want
        ? matchesWant(`${coupon.title} ${product.productName ?? ''}`, [], '')
        : !couponIsLight;
      const couponItem = {
        productCode: String(product.productCode),
        productName: product.productName ?? '券商品',
        quantity: 1,
        couponId: coupon.couponId,
        couponCode: coupon.couponCode,
      };
      candidates.push({
        kind: 'coupon', storeCode: pool.storeCode, group: `券:${coupon.title}`,
        title: `${coupon.title}（${product.productName}）`,
        // 与「想吃的」匹配的券参与主排序；不匹配的降级为「顺便可用」提示
        matchesWant: couponMatches,
        items: [couponItem],
        coupon: { title: coupon.title, couponId: coupon.couponId },
      });
      if (couponMatches) relatedCoupons.push({ title: coupon.title, items: [couponItem] });
    }

    // 类型 5：拆单方案（多张券各占一单；官方限制一单一券，拆单才能同时用上多张）
    if (relatedCoupons.length >= 2) {
      const chosen = relatedCoupons.slice(0, 3);
      candidates.push({
        kind: 'split', storeCode: pool.storeCode, group: '拆单',
        title: `拆单：${chosen.map((entry) => entry.title).join(' + ')}（分 ${chosen.length} 单）`,
        items: chosen.flatMap((entry) => entry.items),
        subOrders: chosen.map((entry) => ({ title: entry.title, items: entry.items })),
        splitOrders: chosen.length,
        matchesWant: true,
      });
    }
  }

  // 预算预筛（按菜单现价估算，留 50% 余量避免误杀「券后可能达标」的候选；含券/无法估价的一律保留）
  const preScreenCap = budgetFen ? Math.round(budgetFen * 1.5) : null;
  const kept = budgetFen
    ? candidates.filter((candidate) => !candidate.estimateFen || candidate.estimateFen <= preScreenCap)
    : candidates;
  // 去重：同店 + 同商品组合签名
  const seen = new Set();
  const deduped = kept.filter((candidate) => {
    const signature = `${candidate.storeCode}|${candidate.items.map((item) => `${item.productCode}x${item.quantity}${item.couponId ?? ''}`).join(',')}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
  return { candidates: deduped, matchedCatalog };
}

// ---- 官方试算 ----

async function quote(client, scene, store, candidate, data) {
  const orderType = scene === 'delivery' ? 2 : 1;
  const beType = scene === 'delivery' ? 2 : 1;
  const params = {
    storeCode: store.storeCode,
    orderType,
    beType,
    needTableware: false,
    items: candidate.items.map((item) => ({
      productCode: item.productCode,
      quantity: item.quantity,
      ...(item.couponId ? { couponId: item.couponId, couponCode: item.couponCode } : {}),
    })),
  };
  if (beType === 2 && store.beCode) params.beCode = store.beCode;
  const payload = await client.call('calculate-price', params);
  if (payload?.success === false) {
    fail(payload.message ?? `code ${payload.code}`);
  }
  const result = payload?.data ?? payload;
  if (!Number.isFinite(Number(result?.price))) fail('算价返回缺少 price 字段');
  return {
    originalPrice: Number(result.originalPrice ?? result.productOriginalPrice ?? 0),
    discount: Number(result.discount ?? 0),
    price: Number(result.price),
    productList: result.productList ?? [],
    takeWayList: result.takeWayList ?? [],
  };
}

// ---- 主流程 ----

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      '用法：node scripts/plan.mjs --input <collect输出> [选项]',
      '  --mode save|healthy|easy   目标模式（默认：偏好文件中的 defaultMode，否则 save）',
      '  --people 1                 用餐人数（默认 1）',
      '  --want 巨无霸              想吃的（名称/标签关键词；多词用「和/、/，」分隔，可选）',
      '  --style any|combo|single   购买方式偏好：any 都给（默认）/ combo 只看套餐 / single 只看单点',
      '  --budget 50                总价上限（元，可选）',
      '  --top 3                    输出前 N 个方案（默认 3，同一方案只展示最优门店）',
      '  --protein-min 30           营养目标覆盖：蛋白质下限（g，可选）',
      '  --kcal-max 600             营养目标覆盖：热量上限（kcal，可选）',
      '  --fat-max 30 / --sodium-max 800   营养目标覆盖：脂肪（g）/ 钠（mg）上限（可选）',
      '  --rules <文件>             规则文件（默认 ../config/rules.json）',
      '  --output <文件>            输出到文件（默认 stdout）',
      '',
    ].join('\n'));
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rulesPath = options.rules ?? path.join(scriptDir, '..', 'config', 'rules.json');
  const [data, rules] = await Promise.all([
    readFile(options.input, 'utf8').then((raw) => JSON.parse(raw)),
    readFile(rulesPath, 'utf8').then((raw) => JSON.parse(raw)),
  ]);
  if (data?.schema !== 'mcd-best-deal/collect@0.1.0') {
    fail('输入文件不是 collect.mjs 的输出（schema 不匹配）。请先运行 collect.mjs。');
  }

  const notes = [...(data.notes ?? [])];
  const scene = data.query?.scene ?? 'dine-in';
  const storeByCode = {};
  for (const store of data.stores ?? []) storeByCode[store.storeCode] = store;

  // 0. 用户偏好（~/.mcd-best-deal/preferences.json；缺失/损坏时安全降级为空偏好）
  const preferences = await loadPreferences();
  if (options.mode === null) {
    options.mode = preferences.defaultMode ?? 'save';
    if (preferences.defaultMode) notes.push(`按用户偏好使用默认模式：${preferences.defaultMode}`);
  }
  if (preferences.avoidItems.length) notes.push(`已按偏好排除：${preferences.avoidItems.join('、')}`);
  options.preferences = preferences;

  // 1. 生成候选
  const { candidates, matchedCatalog } = buildCandidates(data, rules, options);
  if (!candidates.length) {
    fail('没有生成任何候选方案：请检查 --want 关键词是否过窄（或改用 collect 时更常见的门店）。');
  }

  // 2. 逐个官方试算
  const { token } = await resolveToken();
  if (!token) fail('未找到 Token：请先运行 setup-connector.mjs，或设置 MCD_MCP_TOKEN。');
  const client = new McpClient(token);
  await client.initialize();

  const quoted = [];
  const failed = [];
  const maxQuoteCalls = rules.constraints?.maxQuoteCalls ?? 30;
  let quoteCalls = 0;
  for (const candidate of candidates) {
    if (quoteCalls >= maxQuoteCalls) {
      notes.push(`已达试算上限（${quoteCalls} 次），其余候选未试算。`);
      break;
    }
    const store = storeByCode[candidate.storeCode];
    if (!store) continue;
    try {
      let pricing;
      if (candidate.kind === 'split' && Array.isArray(candidate.subOrders) && candidate.subOrders.length) {
        // 拆单方案：逐单独立试算（每单一券），价格求和
        const orders = [];
        for (const sub of candidate.subOrders) {
          if (quoteCalls >= maxQuoteCalls) break;
          orders.push(await quote(client, scene, store, { items: sub.items }, data));
          quoteCalls += 1;
        }
        if (!orders.length) fail('拆单子单均未试算');
        pricing = {
          originalPrice: orders.reduce((sum, order) => sum + order.originalPrice, 0),
          discount: orders.reduce((sum, order) => sum + order.discount, 0),
          price: orders.reduce((sum, order) => sum + order.price, 0),
          productList: [],
          takeWayList: [],
          orders: orders.map((order, index) => ({
            title: candidate.subOrders[index]?.title ?? `第 ${index + 1} 单`,
            price: order.price,
            discount: order.discount,
          })),
        };
      } else {
        pricing = await quote(client, scene, store, candidate, data);
        quoteCalls += 1;
      }
      quoted.push({ ...candidate, pricing });
    } catch (error) {
      failed.push({ title: candidate.title, storeCode: candidate.storeCode, reason: error.message });
    }
  }
  if (!quoted.length) {
    fail(`全部候选试算失败。首要原因：${failed[0]?.reason ?? '未知'}`);
  }

  // 2.5 券综合评估：对基础候选（按价格从低到高取前 K 个）逐一叠加「每张可用券」试算，
  //     综合比较所有商品可用券的实际效果（官方限制一单一券，每次仅叠加一张）
  // 「加成」变体判断券商品是否命中需求所需（与 buildCandidates 内的匹配口径一致）
  const wantQuery = options.want?.trim() || null;
  const wantTermList = expandWantTerms(wantQuery);

  const maxVariants = rules.constraints?.maxCouponVariants ?? 15;
  const couponEvalTopK = rules.constraints?.couponEvalTopK ?? 5;
  const maxCouponsPerStore = rules.constraints?.maxCouponsPerStore ?? 4;
  // 券评估对象 =「价格最低的前 K 个基础候选」+「至少 1 个套餐」+「至少 1 个单点组合」。
  // 注意：务必先排除券/拆单候选再按价格取前 K——券候选价格天然最低，此前会把名单占满，
  // 导致「套餐/组合 + 券」变体从不生成（外部实测：多个候选里组合+券数量为 0）。
  const evalPool = quoted.filter((candidate) => candidate.kind !== 'coupon' && candidate.kind !== 'split');
  const byPrice = [...evalPool].sort((a, b) => a.pricing.price - b.pricing.price);
  const baseRanked = [];
  const seenBase = new Set();
  const addBase = (candidate) => {
    if (candidate && !seenBase.has(candidate)) {
      seenBase.add(candidate);
      baseRanked.push(candidate);
    }
  };
  byPrice.slice(0, couponEvalTopK).forEach(addBase);
  addBase(byPrice.find((candidate) => candidate.kind === 'combo'));
  addBase(byPrice.find((candidate) => candidate.kind === 'combo-parts'));
  const variants = [];
  const variantSignatures = new Set();
  for (const base of baseRanked) {
    if (variants.length >= maxVariants) break;
    const storeCoupons = data.storeCoupons?.[base.storeCode] ?? [];
    for (const coupon of storeCoupons.slice(0, maxCouponsPerStore)) {
      if (variants.length >= maxVariants) break;
      const product = coupon.products?.[0];
      if (!product?.productCode) continue;
      const signature = `${base.storeCode}|${base.items.map((item) => `${item.productCode}x${item.quantity}`).join(',')}|${coupon.couponId}`;
      if (variantSignatures.has(signature)) continue;
      variantSignatures.add(signature);
      const items = base.items.map((item) => ({ ...item }));
      const existing = items.find((item) => item.productCode === String(product.productCode));
      if (existing) {
        // 候选里正好含券商品：把券直接应用在该商品上
        existing.couponId = coupon.couponId;
        existing.couponCode = coupon.couponCode;
      } else {
        items.push({
          productCode: String(product.productCode),
          productName: product.productName ?? '券商品',
          quantity: 1,
          couponId: coupon.couponId,
          couponCode: coupon.couponCode,
        });
      }
      // 「加成」变体 = 候选本身不含券商品、靠追加构成的组合（如「苹果片 + 咖啡券」）。
      // 这类组合只在券商品命中「想吃的」时才参与主推荐；否则标记 addon（保留在 all / 分组里作参考，不进 Top）。
      const isAddon = !existing;
      variants.push({
        kind: base.kind, storeCode: base.storeCode, group: base.group,
        title: `${base.title} + 券「${coupon.title}」`,
        items,
        coupon: { title: coupon.title, couponId: coupon.couponId },
        matchesWant: true,
        ...(isAddon
          ? { addon: true, addonRelevant: Boolean(wantQuery) && matchLevel(product.productName ?? '', [], '', wantTermList) > 0 }
          : {}),
      });
    }
  }
  for (const variant of variants) {
    if (quoteCalls >= maxQuoteCalls) {
      notes.push(`已达试算上限（${quoteCalls} 次），部分「候选 + 券」组合未试算。`);
      break;
    }
    const store = storeByCode[variant.storeCode];
    if (!store) continue;
    try {
      const pricing = await quote(client, scene, store, variant, data);
      quoteCalls += 1;
      quoted.push({ ...variant, pricing });
    } catch (error) {
      failed.push({ title: variant.title, storeCode: variant.storeCode, reason: error.message });
    }
  }

  // 3. 评分
  const weights = rules.modes?.[options.mode]?.weights ?? { price: 0.7, nutrition: 0.1, convenience: 0.2 };
  const targets = { ...(rules.nutritionTargets ?? {}) };
  // 命令行可覆盖营养目标（如「蛋白质 30g 以上、600 卡以内」→ --protein-min 30 --kcal-max 600）
  const targetOverrides = [
    ['proteinMin', 'proteinGMin', '蛋白质下限(g)'],
    ['kcalMax', 'energyKcalMax', '热量上限(kcal)'],
    ['fatMax', 'fatGMax', '脂肪上限(g)'],
    ['sodiumMax', 'sodiumMgMax', '钠上限(mg)'],
  ];
  for (const [optionKey, targetKey, label] of targetOverrides) {
    if (options[optionKey] != null) {
      targets[targetKey] = options[optionKey];
      notes.push(`营养目标已覆盖：${label} → ${options[optionKey]}`);
    }
  }
  const prices = quoted.map((candidate) => candidate.pricing.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const distances = Object.values(storeByCode).map((store) => store.distance ?? 0);
  const maxDistance = Math.max(...distances, 1);

  for (const candidate of quoted) {
    const priceScore = maxPrice === minPrice ? 1 : (maxPrice - candidate.pricing.price) / (maxPrice - minPrice);
    const nutrition = nutritionOf(candidate.items, data.nutrition ?? [], targets);
    const store = storeByCode[candidate.storeCode];
    let convenienceScore = store?.distance != null ? 1 - store.distance / maxDistance : 0.5;
    if ((candidate.splitOrders ?? 1) > 1) {
      convenienceScore = Math.max(0, convenienceScore - 0.2 * (candidate.splitOrders - 1));
    }
    const total = weights.price * priceScore + weights.nutrition * nutrition.score + weights.convenience * convenienceScore;
    candidate.scores = {
      price: round3(priceScore),
      nutrition: round3(nutrition.score),
      convenience: round3(convenienceScore),
      total: round3(total),
    };
    candidate.nutrition = nutrition;
  }

  // 3.5 菜单价与实算价差异过大时如实标注（以算价器为准；同名只记一次）
  const priceDriftNoted = new Set();
  for (const candidate of quoted) {
    const estimate = candidate.estimateFen;
    if (!estimate || !candidate.pricing) continue;
    if (Math.abs(candidate.pricing.price - estimate) / estimate > 0.3) {
      const key = candidate.items?.[0]?.productName ?? candidate.title;
      if (priceDriftNoted.has(key)) continue;
      priceDriftNoted.add(key);
      notes.push(`价格差异提示：「${key}」菜单价约 ¥${(estimate / 100).toFixed(2)}，实算 ¥${(candidate.pricing.price / 100).toFixed(2)}——以实算价为准（菜单价可能是展示价 / 选规格起价 / 过期活动价）。`);
    }
  }

  // 4. 排序与组装输出
  const budgetFen = options.budget ? Math.round(options.budget * 100) : null;
  // 「顺便可用」的券：不匹配「想吃的」，不进主排序，仅作提示
  const couponHints = quoted
    .filter((candidate) => candidate.kind === 'coupon' && candidate.matchesWant === false)
    .map((candidate) => ({
      title: candidate.coupon?.title ?? candidate.title,
      product: candidate.items?.[0]?.productName ?? '',
      priceYuan: (candidate.pricing.price / 100).toFixed(2),
      store: storeByCode[candidate.storeCode]?.storeName ?? candidate.storeCode,
    }));
  const mainList = quoted.filter((candidate) => candidate.kind !== 'coupon' || candidate.matchesWant !== false);
  // 兜底顺序：主列表 → 非券候选 → 全部（避免把「降级为提示的券」当作主推荐捞回来）
  const nonCoupon = quoted.filter((candidate) => candidate.kind !== 'coupon');
  const fallbackPool = mainList.length ? mainList : (nonCoupon.length ? nonCoupon : quoted);
  const sorted = [...fallbackPool].sort((a, b) => b.scores.total - a.scores.total);
  const filtered = budgetFen ? sorted.filter((candidate) => candidate.pricing.price <= budgetFen) : sorted;
  if (budgetFen && !filtered.length) {
    const closest = [...sorted].sort((a, b) => a.pricing.price - b.pricing.price)[0];
    const closestYuan = ((closest?.pricing.price ?? 0) / 100).toFixed(2);
    const overYuan = (((closest?.pricing.price ?? 0) - budgetFen) / 100).toFixed(2);
    notes.push(`预算 ¥${options.budget} 内没有符合项；最接近的是「${closest?.title ?? '—'}」实付 ¥${closestYuan}（超 ¥${overYuan}），以下按其展示。`);
  }
  const finalList = (filtered.length ? filtered : sorted).map((candidate, index) => {
    const store = storeByCode[candidate.storeCode];
    const priceYuan = (candidate.pricing.price / 100).toFixed(2);
    const reasons = [`实付 ¥${priceYuan}`];
    if (candidate.pricing.discount > 0) {
      reasons.push(`含优惠 ¥${(candidate.pricing.discount / 100).toFixed(2)}${candidate.coupon ? `（${candidate.coupon.title}）` : ''}`);
    }
    reasons.push(`门店 ${store?.storeName ?? candidate.storeCode}${store?.distance != null ? `（${store.distance}m）` : ''}`);
    if (candidate.kind === 'combo') reasons.push('官方套餐');
    if (candidate.kind === 'combo-parts') reasons.push('单点组合（对照套餐价）');
    if (candidate.kind === 'coupon') reasons.push('用券方案');
    if (candidate.kind === 'split') reasons.push(`需分 ${candidate.splitOrders} 次下单（每单一券）`);
    if (candidate.nutrition?.matched) {
      reasons.push(`约 ${candidate.nutrition.energyKcal} kcal`);
      if (options.mode === 'healthy') {
        const parts = [];
        const nutrition = candidate.nutrition;
        if (targets.energyKcalMax) parts.push(`热量 ${nutrition.energyKcal}/${targets.energyKcalMax} kcal${nutrition.energyKcal <= targets.energyKcalMax ? ' ✓' : '（超上限）'}`);
        if (targets.proteinGMin) parts.push(`蛋白 ${nutrition.protein}/${targets.proteinGMin} g${nutrition.protein >= targets.proteinGMin ? ' ✓' : '（不足）'}`);
        if (parts.length) reasons.push(`健康目标：${parts.join('、')}`);
      }
    } else {
      reasons.push('营养数据不完整（不计分）');
    }
    if (scene === 'delivery') reasons.push('外卖实付含配送/打包费');
    return {
      rank: index + 1,
      title: candidate.title,
      kind: candidate.kind,
      group: candidate.group,
      store: {
        storeCode: candidate.storeCode,
        storeName: store?.storeName ?? '',
        distance: store?.distance ?? null,
        openNow: store?.openNow ?? null,
      },
      items: candidate.items,
      ...(candidate.popular ? { popular: true } : {}),
      ...(candidate.addon ? { addon: true, addonRelevant: candidate.addonRelevant ?? false } : {}),
      ...(candidate.coupon ? { coupon: candidate.coupon } : {}),
      ...(candidate.subOrders ? { subOrders: candidate.subOrders } : {}),
      pricing: {
        originalPrice: candidate.pricing.originalPrice,
        discount: candidate.pricing.discount,
        price: candidate.pricing.price,
        priceYuan,
        ...(candidate.pricing.orders ? { orders: candidate.pricing.orders } : {}),
      },
      scores: candidate.scores,
      nutrition: candidate.nutrition,
      reason: reasons.join('；'),
    };
  });

  // 4.5 Top 展示去重：同一方案（同商品名、不含数量）只展示最优门店，避免「同款三店」占满 Top（其余保留在 all）
  const topDeduped = [];
  const seenTopKeys = new Set();
  for (const entry of finalList) {
    // 「加成」券组合（如 苹果片+咖啡券）默认不进 Top——除非券商品命中用户点名；它们保留在 all/byStyle 作参考
    if (entry.addon && !entry.addonRelevant) continue;
    const key = entry.title.replace(/\s*×\d+\s*$/, '');
    if (seenTopKeys.has(key)) continue;
    seenTopKeys.add(key);
    topDeduped.push(entry);
    if (topDeduped.length >= options.top) break;
  }

  // 5. 显式对比：同店同组下「套餐 vs 单点组合」，直接给出价差结论
  const comparisons = [];
  const buckets = new Map();
  for (const entry of finalList) {
    if (entry.kind !== 'combo' && entry.kind !== 'combo-parts') continue;
    const key = `${entry.store.storeCode}|${entry.group}`;
    if (!buckets.has(key)) buckets.set(key, {});
    const bucket = buckets.get(key);
    if (entry.kind === 'combo' && !bucket.combo) bucket.combo = entry;
    if (entry.kind === 'combo-parts' && !bucket.parts) bucket.parts = entry;
  }
  for (const bucket of buckets.values()) {
    if (!bucket.combo || !bucket.parts) continue;
    const diff = bucket.parts.pricing.price - bucket.combo.pricing.price;
    comparisons.push({
      store: bucket.combo.store.storeName,
      group: bucket.combo.group,
      combo: { title: bucket.combo.title, priceYuan: bucket.combo.pricing.priceYuan },
      parts: { title: bucket.parts.title, priceYuan: bucket.parts.pricing.priceYuan },
      diffYuan: (diff / 100).toFixed(2),
      conclusion: diff > 0
        ? `套餐更便宜，省 ¥${(diff / 100).toFixed(2)}`
        : diff < 0
          ? `单点组合更便宜，省 ¥${(-diff / 100).toFixed(2)}`
          : '两者价格持平',
    });
  }

  // 6. 按购买方式分组（套餐 / 单点 / 券 / 拆单），供用户按偏好直接挑选
  const byStyle = {
    combo: finalList.filter((entry) => entry.kind === 'combo'),
    single: finalList.filter((entry) => entry.kind === 'single' || entry.kind === 'combo-parts'),
    coupon: finalList.filter((entry) => entry.kind === 'coupon'),
    split: finalList.filter((entry) => entry.kind === 'split'),
  };

  const planOutput = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    modeName: rules.modes?.[options.mode]?.name ?? options.mode,
    weights,
    query: data.query,
    people: options.people,
    want: options.want ?? null,
    budget: options.budget ?? null,
    stats: {
      candidates: candidates.length,
      quoted: quoted.length,
      failed: failed.length,
      quoteCalls,
    },
    top: topDeduped.map((entry, index) => ({ ...entry, rank: index + 1 })), // top 为展示视图，重编连续序号（all 中保留竞争排名）
    all: finalList,
    byStyle,
    comparisons,
    couponHints,
    ...(matchedCatalog.length ? { matchedCatalog } : {}),
    failed,
    notes,
  };

  const serialized = `${JSON.stringify(planOutput, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, serialized, 'utf8');
    process.stdout.write([
      `方案计算完成（${planOutput.modeName}）：`,
      `  候选 ${candidates.length} 个 → 试算成功 ${quoted.length} 个，失败 ${failed.length} 个`,
      `  输出：${options.output}`,
      ...(notes.length ? ['  提示：', ...notes.map((note) => `    - ${note}`)] : []),
      '',
    ].join('\n'));
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`);
  process.exitCode = 1;
});
