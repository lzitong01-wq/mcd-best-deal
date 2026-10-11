#!/usr/bin/env node
// mcd-best-deal · 数据采集
// 一次调用采集「最优方案」计算所需的全部实时数据，输出归一化 JSON。
// 原则：只采集与归一化，不做推荐；一切以官方接口实时返回为准。
//
// 用法：
//   到店：node scripts/collect.mjs --city 北京 --keyword 国贸 [--max-stores 2] [--output data.json]
//   外卖：node scripts/collect.mjs --scene delivery --address-id <地址ID> [--max-stores 2] [--output data.json]
//   不带 --output 时输出到 stdout。

import { writeFile } from 'node:fs/promises';
import { McpClient, resolveToken } from './lib/mcp-client.mjs';

const SCHEMA = 'mcd-best-deal/collect@0.1.0';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  if (argv.includes('--help')) return { help: true };
  const options = { scene: 'dine-in', maxStores: 2, output: null };
  const allowed = new Set(['--city', '--keyword', '--address-id', '--scene', '--max-stores', '--output']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!allowed.has(key)) fail(`未知参数：${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${key} 缺少值`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (options.scene !== 'dine-in' && options.scene !== 'delivery') fail('--scene 只能是 dine-in 或 delivery');
  if (options.scene === 'dine-in') {
    if (!options.city?.trim()) fail('到店场景需要 --city');
    if (!options.keyword?.trim()) fail('到店场景需要 --keyword（按位置找店，如「国贸」「三里屯」）');
  } else if (!options.addressId?.trim()) {
    fail('外卖场景需要 --address-id（可先用 delivery-query-addresses 查询已有地址）');
  }
  options.maxStores = Number(options.maxStores);
  if (!Number.isInteger(options.maxStores) || options.maxStores < 1 || options.maxStores > 5) {
    fail('--max-stores 必须是 1-5 的整数');
  }
  return options;
}

// ---- 通用解析工具 ----

function unwrap(payload, toolName) {
  if (payload?.success === false) {
    fail(`${toolName} 业务错误：${payload.message ?? payload.code ?? '未知原因'}`);
  }
  return payload?.data ?? payload;
}

function pickArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

// MCP 部分工具以「紧凑表格」字符串返回数据，格式：
//   [行数]{列1,列2,...}:
//     值1,值2,...
//     ...
// 例：list-nutrition-foods 的 data 字段（160 行营养数据）。解析失败返回 null。
function parseCompactTable(text) {
  const match = String(text).match(/^\[(\d+)\]\{([^}]+)\}:\s*\n([\s\S]+)$/);
  if (!match) return null;
  const columns = match[2].split(',').map((column) => column.trim());
  return match[3].split('\n')
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const values = row.split(',');
      const item = {};
      columns.forEach((column, index) => {
        const value = values[index];
        item[column] = value === undefined || value === 'null' ? null : value;
      });
      return item;
    });
}

// 当前北京时间（HH:mm），用于营业状态判断
function nowBeijingHHMM() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

// 支持跨天营业时间（如 22:00-04:00）
function isOpenNow(start, end, nowHHMM) {
  if (!start || !end) return null;
  if (start <= end) return nowHHMM >= start && nowHHMM < end;
  return nowHHMM >= start || nowHHMM < end;
}

function normalizeStore(store) {
  return {
    storeCode: String(store.storeCode ?? ''),
    storeName: store.storeName ?? store.name ?? '',
    address: store.address ?? '',
    distance: Number.isFinite(Number(store.distance)) ? Number(store.distance) : null,
    beCode: store.beCode ? String(store.beCode) : null,
    businessHours: `${store.businessStartTime ?? '?'}-${store.businessEndTime ?? '?'}`,
    openNow: isOpenNow(store.businessStartTime, store.businessEndTime, nowBeijingHHMM()),
    reservation: Boolean(store.reservation),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      '用法：node scripts/collect.mjs --city <城市> --keyword <位置关键词> [--max-stores 2] [--output 文件]',
      '      node scripts/collect.mjs --scene delivery --address-id <地址ID> [--max-stores 2] [--output 文件]',
      '说明：到店场景按位置搜索门店；外卖场景按配送地址查询可配送门店。',
      '      输出为归一化 JSON（含门店、菜单、门店券、券包、营养表）。',
      '',
    ].join('\n'));
    return;
  }

  const { token, source } = await resolveToken();
  if (!token) {
    fail('未找到 Token：请先运行 setup-connector.mjs 配置，或设置 MCD_MCP_TOKEN 环境变量。');
  }
  const client = new McpClient(token);
  await client.initialize();

  const notes = [];
  const result = {
    schema: SCHEMA,
    retrievedAt: new Date().toISOString(),
    tokenSource: source,
    query: {
      scene: options.scene,
      city: options.city ?? null,
      keyword: options.keyword ?? null,
      maxStores: options.maxStores,
    },
    stores: [],
    candidates: [],
    menus: {},
    storeCoupons: {},
    wallet: [],
    nutrition: [],
    timeInfo: null,
    notes,
  };

  // 1. 门店
  if (options.scene === 'dine-in') {
    const payload = await client.call('query-nearby-stores', {
      beType: 1, searchType: 2, city: options.city, keyword: options.keyword,
    });
    result.stores = pickArray(unwrap(payload, 'query-nearby-stores'))
      .map(normalizeStore)
      .filter((store) => store.storeCode);
  } else {
    const payload = await client.call('delivery-query-stores', {
      addressId: options.addressId, beType: 2,
    });
    result.stores = pickArray(unwrap(payload, 'delivery-query-stores'), ['stores'])
      .map(normalizeStore)
      .filter((store) => store.storeCode);
  }

  // 2. 候选门店：营业中优先 → 距离近优先
  const sorted = [...result.stores].sort((a, b) => {
    const openRank = (store) => (store.openNow === false ? 1 : 0);
    if (openRank(a) !== openRank(b)) return openRank(a) - openRank(b);
    return (a.distance ?? Number.MAX_SAFE_INTEGER) - (b.distance ?? Number.MAX_SAFE_INTEGER);
  });
  const candidates = sorted.slice(0, options.maxStores);
  if (!candidates.length) {
    fail('没有找到任何门店：请检查城市/关键词是否过窄，或换一个更常见的商圈名。');
  }
  if (!candidates.some((store) => store.openNow !== false)) {
    notes.push('候选门店当前均不在营业时段：实时算价可能被拒（可考虑预约单或换时段再算）。');
  }
  result.candidates = candidates.map((store) => store.storeCode);

  // 3. 逐候选门店：菜单 + 门店可用券
  const orderType = options.scene === 'dine-in' ? 1 : 2;
  const beType = options.scene === 'dine-in' ? 1 : 2;
  for (const store of candidates) {
    const common = {
      storeCode: store.storeCode, orderType, beType,
      ...(beType === 2 && store.beCode ? { beCode: store.beCode } : {}),
    };
    try {
      const menuPayload = unwrap(await client.call('query-meals', common), 'query-meals');
      result.menus[store.storeCode] = {
        categories: menuPayload?.categories ?? [],
        meals: menuPayload?.meals ?? {},
      };
    } catch (error) {
      notes.push(`${store.storeName} 菜单获取失败：${error.message}`);
    }
    try {
      const couponsPayload = unwrap(await client.call('query-store-coupons', common), 'query-store-coupons');
      result.storeCoupons[store.storeCode] = pickArray(couponsPayload);
    } catch (error) {
      notes.push(`${store.storeName} 门店券查询失败：${error.message}`);
    }
  }

  // 4. 券包（全部已持有券）
  try {
    const walletPayload = unwrap(await client.call('query-my-coupons', {}), 'query-my-coupons');
    result.wallet = pickArray(walletPayload, ['coupons', 'list', 'items', 'records']);
  } catch (error) {
    notes.push(`券包查询失败：${error.message}`);
  }

  // 5. 营养表（data 可能是数组，也可能是「紧凑表格」字符串）
  try {
    const nutritionPayload = unwrap(await client.call('list-nutrition-foods', {}), 'list-nutrition-foods');
    if (Array.isArray(nutritionPayload)) {
      result.nutrition = nutritionPayload;
    } else if (typeof nutritionPayload === 'string') {
      result.nutrition = parseCompactTable(nutritionPayload) ?? [];
    } else {
      result.nutrition = pickArray(nutritionPayload, ['list', 'foods', 'items']);
    }
    if (!result.nutrition.length) {
      notes.push('营养表返回为空或格式无法识别（健康模式将无法进行营养约束）。');
    }
  } catch (error) {
    notes.push(`营养表获取失败：${error.message}`);
  }

  // 6. 官方时间（参考；失败可忽略）
  try {
    result.timeInfo = unwrap(await client.call('now-time-info', {}), 'now-time-info');
  } catch {
    result.timeInfo = null;
  }

  // 7. 输出
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, serialized, 'utf8');
    const couponCount = Object.values(result.storeCoupons).reduce((total, list) => total + list.length, 0);
    process.stdout.write([
      '采集完成：',
      `  门店：共 ${result.stores.length} 家，候选 ${candidates.length} 家（营业中 ${candidates.filter((s) => s.openNow !== false).length}）`,
      `  菜单：${Object.keys(result.menus).length} 份`,
      `  门店券：${couponCount} 张 | 券包：${result.wallet.length} 张 | 营养条目：${result.nutrition.length} 条`,
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
