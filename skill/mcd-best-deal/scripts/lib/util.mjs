// mcd-best-deal · 纯工具函数（解析 / 匹配 / 文本处理 / 用户偏好读取）
// 除 loadPreferences 读取本地偏好文件外，其余函数无副作用、无网络依赖，便于单元测试。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

// 解析 MCP 部分工具返回的「紧凑表格」字符串，格式：
//   [行数]{列1,列2,...}:
//     值1,值2,...
//     ...
// 例：list-nutrition-foods 的 data 字段（160 行营养数据）。解析失败返回 null。
export function parseCompactTable(text) {
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

// 营养表按名称匹配。返回 { row, quality }。
// quality: exact=名称完全一致；fuzzy=需推断（会低估营养，不展示具体数值、不计分）；none=未匹配
export function findNutrition(table, productName) {
  if (!productName || !table?.length) return { row: null, quality: 'none' };
  const clean = (text) => String(text).replace(/\s|™/g, '');
  const target = clean(productName);
  let hit = table.find((row) => clean(row.productName) === target);
  if (hit) return { row: hit, quality: 'exact' };
  const stripped = target.replace(/三件套|四件套|套餐|随心选|双人餐|单人餐|单点|（.*?）|\(.*?\)/g, '');
  if (stripped && stripped !== target) {
    hit = table.find((row) => clean(row.productName) === stripped);
    if (hit) return { row: hit, quality: 'fuzzy' };
  }
  hit = table.find((row) => target.includes(clean(row.productName)) || clean(row.productName).includes(target));
  return hit ? { row: hit, quality: 'fuzzy' } : { row: null, quality: 'none' };
}

// 在 TOML 文本中插入或替换一个 [section] 段（保留其余内容与注释）
export function upsertTomlSection(raw, sectionName, bodyLines) {
  const header = `[${sectionName}]`;
  const lines = raw.split('\n');
  const start = lines.findIndex((item) => item.trim() === header);
  if (start === -1) {
    const base = raw.trimEnd();
    const prefix = base === '' ? '' : `${base}\n\n`;
    return `${prefix}# mcd-best-deal（麦麦最优方案）· 麦当劳官方 MCP\n${header}\n${bodyLines.join('\n')}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) { end = index; break; }
  }
  const merged = [...lines.slice(0, start), header, ...bodyLines, '', ...lines.slice(end)];
  return merged.join('\n');
}

// 轻食类识别（饮品 / 咖啡 / 冰淇淋 / 甜点）：
// 默认不计入「正餐」推荐（用户在追求吃饱时通常不考虑这类商品）；
// 用户明确点名（want 命中）时保留。注意不要误伤名称含相似字的正餐（如「厚松饼猪柳蛋堡」）。
const LIGHT_PATTERN = /(麦咖啡|饮品|冷饮|热饮|咖啡|美式|奶铁|拿铁|卡布奇诺|浓缩|雪冰|冰淇淋|麦旋风|新地|圆筒|奶昔|圣代|甜筒|黑巧|可乐|雪碧|芬达|果汁|柠檬|红茶|奶茶|牛奶|燕麦奶|纯悦|矿泉水|香芋派|菠萝派|红豆派|派$|酱$|饼干|曲奇|棒球帽|徽章|玩具|公仔|冰箱贴|帆布|周边)/;

export function isLightItem(meal) {
  if (!meal) return false;
  // 逐字段独立匹配：「派$ / 酱$」等锚定式规则的语义是「某个字段以此结尾」，
  // 若拼成一整串再匹配，锚点会被分隔空格破坏（曾导致「香芋派 / 牧场酱」识别失效）。
  const parts = [String(meal.name ?? ''), String(meal.category ?? ''), ...(meal.tags ?? []).map(String)];
  return parts.some((part) => LIGHT_PATTERN.test(part));
}

// 常用搜索词的别名扩展。「汉堡」不能只展开为「堡」——麦香鸡、巨无霸等名字不含「堡」，
// 需同时结合分类名匹配（见 matchesTerms 的 category 参数）与常见商品名关键词。
export const WANT_ALIASES = {
  '汉堡': ['堡', '巨无霸', '麦香鸡', '麦香鱼'],
  '咖啡': ['咖啡', '美式', '奶铁', '拿铁', '卡布奇诺', '浓缩', '麦咖啡'],
  '冰淇淋': ['冰淇淋', '新地', '麦旋风', '圆筒'],
  '早餐': ['早餐', '松饼', '麦满分', '猪柳', '烟肉'],
  '鸡': ['鸡'],
  '双吉': ['双吉', '双层吉士'],
  '麦辣': ['麦辣'],
};

// 把用户输入拆成多个搜索词（支持「巨无霸和麦辣鸡腿堡」「A、B」等写法）
export function splitWants(want) {
  return String(want ?? '').split(/[和与及、,，]|跟/).map((piece) => piece.trim()).filter(Boolean);
}

// 单词条展开：别名表 → 原词 →「去后缀」变体（「麦辣鸡腿堡」→「麦辣鸡腿」，可命中「麦辣鸡腿汉堡」）
function expandOne(piece) {
  if (WANT_ALIASES[piece]) return WANT_ALIASES[piece];
  const terms = new Set([piece]);
  const stripped = piece.replace(/(汉堡|三件套|四件套|套餐|双人餐|单人餐)$/, '').replace(/堡$/, '');
  if (stripped && stripped !== piece && stripped.length >= 2) terms.add(stripped);
  return [...terms];
}

export function expandWantTerms(want) {
  if (!want) return null;
  const merged = new Set();
  for (const piece of splitWants(want)) {
    for (const term of expandOne(piece)) merged.add(term);
  }
  return [...merged];
}

// 匹配级别：2 = 名称/标签直接命中（精确级）；1 = 仅分类名命中（宽松级）；0 = 未命中。
// 分类命中用于覆盖「巨无霸牛鱼肉堡」「炸鸡大堡口福」等类目下名字不含关键词的商品（如麦香鸡）；
// 但具体商品词（如「巨无霸」）应以名称级为准，避免被同分类下更便宜的商品挤掉。
export function matchLevel(name, tags, category, terms) {
  if (!terms || !terms.length) return 0;
  if (terms.some((term) => String(name).includes(term)
    || (tags ?? []).some((tag) => String(tag).includes(term)))) return 2;
  if (terms.some((term) => String(category ?? '').includes(term))) return 1;
  return 0;
}

// 兼容入口：命中即算（名称级或分类级）
export function matchesTerms(name, tags, category, terms) {
  return matchLevel(name, tags, category, terms) > 0;
}

// 用户偏好文件路径（跨平台）与读取（缺失/损坏时返回安全默认值）
export function preferencesPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return path.join(home, '.mcd-best-deal', 'preferences.json');
}

export async function loadPreferences(file = preferencesPath()) {
  const fallback = { avoidItems: [], preferItems: [], defaultMode: null, homeCity: null, homeArea: null, note: null };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
  return {
    avoidItems: Array.isArray(parsed?.avoidItems) ? parsed.avoidItems.filter((item) => typeof item === 'string' && item.trim()) : [],
    preferItems: Array.isArray(parsed?.preferItems) ? parsed.preferItems.filter((item) => typeof item === 'string' && item.trim()) : [],
    defaultMode: ['save', 'healthy', 'easy'].includes(parsed?.defaultMode) ? parsed.defaultMode : null,
    homeCity: typeof parsed?.homeCity === 'string' && parsed.homeCity.trim() ? parsed.homeCity.trim() : null,
    homeArea: typeof parsed?.homeArea === 'string' && parsed.homeArea.trim() ? parsed.homeArea.trim() : null,
    note: typeof parsed?.note === 'string' && parsed.note.trim() ? parsed.note.trim() : null,
  };
}
