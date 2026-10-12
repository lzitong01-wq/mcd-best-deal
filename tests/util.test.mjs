// mcd-best-deal · 单元测试（node:test，零依赖、无需网络）
// 运行：node --test   （或 bash test.sh 会一并执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCompactTable, findNutrition, upsertTomlSection, isLightItem, loadPreferences, expandWantTerms, splitWants, matchLevel, matchesTerms } from '../skill/mcd-best-deal/scripts/lib/util.mjs';

// ---- parseCompactTable：解析 MCP 的「紧凑表格」字符串 ----

test('parseCompactTable：解析标准紧凑表格', () => {
  const text = '[2]{productName,energyKcal}:\n 巨无霸,513\n 中薯条,289';
  const rows = parseCompactTable(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { productName: '巨无霸', energyKcal: '513' });
  assert.deepEqual(rows[1], { productName: '中薯条', energyKcal: '289' });
});

test('parseCompactTable：null 值转换为 null', () => {
  const text = '[1]{productName,nutritionDescription,energyKcal}:\n 猪柳麦满分,null,308';
  const rows = parseCompactTable(text);
  assert.deepEqual(rows[0], { productName: '猪柳麦满分', nutritionDescription: null, energyKcal: '308' });
});

test('parseCompactTable：非法格式返回 null（不抛错）', () => {
  assert.equal(parseCompactTable('not a table'), null);
  assert.equal(parseCompactTable(''), null);
  assert.equal(parseCompactTable(null), null);
});

// ---- findNutrition：营养表匹配（exact / fuzzy / none） ----

const TABLE = [
  { productName: '巨无霸', energyKcal: '513', protein: '26' },
  { productName: '中薯条', energyKcal: '289' },
  { productName: '麦咖啡™美式中杯', energyKcal: '13' },
];

test('findNutrition：完全一致 → exact', () => {
  const { row, quality } = findNutrition(TABLE, '巨无霸');
  assert.equal(quality, 'exact');
  assert.equal(row.productName, '巨无霸');
});

test('findNutrition：去掉套餐后缀匹配 → fuzzy（不得冒充 exact）', () => {
  const { row, quality } = findNutrition(TABLE, '巨无霸三件套');
  assert.equal(quality, 'fuzzy');
  assert.equal(row.productName, '巨无霸');
});

test('findNutrition：商标符号差异视为一致 → exact', () => {
  const { quality } = findNutrition(TABLE, '麦咖啡美式中杯');
  assert.equal(quality, 'exact');
});

test('findNutrition：未匹配 → none 且 row 为 null', () => {
  const { row, quality } = findNutrition(TABLE, '不存在的商品名');
  assert.equal(quality, 'none');
  assert.equal(row, null);
});

test('findNutrition：空输入安全', () => {
  assert.equal(findNutrition(TABLE, '').quality, 'none');
  assert.equal(findNutrition([], '巨无霸').quality, 'none');
  assert.equal(findNutrition(null, '巨无霸').quality, 'none');
});

// ---- upsertTomlSection：TOML 段插入/替换 ----

test('upsertTomlSection：追加新段且保留原内容', () => {
  const raw = '[other]\nkey = "value"\n';
  const out = upsertTomlSection(raw, 'mcp_servers.demo', ['url = "https://x"']);
  assert.match(out, /\[other\]/);
  assert.match(out, /\[mcp_servers\.demo\]/);
  assert.match(out, /url = "https:\/\/x"/);
});

test('upsertTomlSection：替换已有段（不重复、不影响相邻段）', () => {
  const raw = '[a]\nx = 1\n\n[mcp_servers.demo]\nurl = "old"\n\n[b]\ny = 2\n';
  const out = upsertTomlSection(raw, 'mcp_servers.demo', ['url = "new"']);
  assert.match(out, /url = "new"/);
  assert.ok(!out.includes('url = "old"'));
  assert.match(out, /\[a\]/);
  assert.match(out, /\[b\]/);
  assert.equal((out.match(/\[mcp_servers\.demo\]/g) || []).length, 1);
});

test('upsertTomlSection：空文件可直接生成段', () => {
  const out = upsertTomlSection('', 'mcp_servers.demo', ['url = "https://x"']);
  assert.match(out, /\[mcp_servers\.demo\]/);
});

// ---- isLightItem：轻食类识别（饮品/咖啡/冰淇淋/甜点默认不计入正餐） ----

test('isLightItem：饮品与咖啡类识别', () => {
  assert.equal(isLightItem({ name: '可乐' }), true);
  assert.equal(isLightItem({ name: '麦咖啡™冰美式中杯' }), true);
  assert.equal(isLightItem({ name: '奶铁中杯' }), true);
  assert.equal(isLightItem({ name: '经典麦旋风' }), true);
  assert.equal(isLightItem({ name: '灰焰圆筒' }), true);
  assert.equal(isLightItem({ name: '阳光柠檬红茶' }), true);
  assert.equal(isLightItem({ name: '纯牛奶(盒装)' }), true);
  assert.equal(isLightItem({ name: '浓浓黑巧（冰/热）' }), true);
  assert.equal(isLightItem({ name: '麦咖啡™美式', category: '热饮' }), true);
});

test('isLightItem：正餐与小食不误伤', () => {
  assert.equal(isLightItem({ name: '巨无霸' }), false);
  assert.equal(isLightItem({ name: '麦辣鸡腿汉堡' }), false);
  assert.equal(isLightItem({ name: '中薯条' }), false);
  assert.equal(isLightItem({ name: '脆薯饼' }), false);
  assert.equal(isLightItem({ name: '枫糖风味厚松饼猪柳蛋堡' }), false);
  assert.equal(isLightItem({ name: '板烧鸡腿堡三件套' }), false);
});

test('isLightItem：空值安全', () => {
  assert.equal(isLightItem(null), false);
  assert.equal(isLightItem({}), false);
});

// ---- loadPreferences：用户偏好读取（缺失安全 + 字段规范化） ----

test('loadPreferences：文件不存在返回安全默认值', async () => {
  const prefs = await loadPreferences('C:/definitely-not-exists/preferences.json');
  assert.deepEqual(prefs.avoidItems, []);
  assert.deepEqual(prefs.preferItems, []);
  assert.equal(prefs.defaultMode, null);
  assert.equal(prefs.homeCity, null);
});

test('loadPreferences：解析并规范化字段（过滤空值/非法模式）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcd-test-'));
  const file = path.join(dir, 'preferences.json');
  await writeFile(file, JSON.stringify({
    avoidItems: ['香菜', '', 123],
    preferItems: ['麦辣'],
    defaultMode: 'healthy',
    homeCity: '北京',
    homeArea: ' 国贸 ',
  }));
  const prefs = await loadPreferences(file);
  assert.deepEqual(prefs.avoidItems, ['香菜']);
  assert.deepEqual(prefs.preferItems, ['麦辣']);
  assert.equal(prefs.defaultMode, 'healthy');
  assert.equal(prefs.homeCity, '北京');
  assert.equal(prefs.homeArea, '国贸');
});

test('loadPreferences：非法 defaultMode 归零', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcd-test-'));
  const file = path.join(dir, 'preferences.json');
  await writeFile(file, JSON.stringify({ defaultMode: 'hacker' }));
  const prefs = await loadPreferences(file);
  assert.equal(prefs.defaultMode, null);
});

// ---- expandWantTerms / matchesTerms：搜索词扩展与匹配（回归：「汉堡」漏商品） ----

test('expandWantTerms：汉堡包含常见商品名关键词与「堡」', () => {
  const terms = expandWantTerms('汉堡');
  assert.ok(terms.includes('堡'));
  assert.ok(terms.includes('巨无霸'));
  assert.ok(terms.includes('麦香鸡'));
});

test('expandWantTerms：无别名词返回原词 / 空输入返回 null', () => {
  assert.deepEqual(expandWantTerms('板烧'), ['板烧']);
  assert.equal(expandWantTerms(null), null);
  assert.equal(expandWantTerms(''), null);
});

test('matchesTerms：分类名参与匹配——名字不含「堡」的汉堡商品不漏（回归用例）', () => {
  const terms = expandWantTerms('汉堡');
  // 麦香鸡：名字不含「堡」，但其分类「炸鸡/大堡口福」含「堡」
  assert.equal(matchesTerms('麦香鸡', [], '炸鸡/大堡口福', terms), true);
  // 巨无霸：分类「巨无霸 牛鱼肉堡」含「堡」
  assert.equal(matchesTerms('巨无霸', [], '巨无霸\n牛鱼肉堡', terms), true);
  // 名字或标签直接命中
  assert.equal(matchesTerms('板烧鸡腿堡', [], '', terms), true);
  // 非汉堡商品不误伤
  assert.equal(matchesTerms('中薯条', [], '小食', terms), false);
  assert.equal(matchesTerms('可乐', ['冷饮'], '饮品', terms), false);
});

test('matchesTerms：空词表返回 false', () => {
  assert.equal(matchesTerms('巨无霸', [], '', null), false);
  assert.equal(matchesTerms('巨无霸', [], '', []), false);
});

// ---- matchLevel：匹配分级（回归：「点名巨无霸不该被同分类更便宜商品挤掉」） ----

test('matchLevel：名称级=2，分类级=1，未命中=0', () => {
  const terms = expandWantTerms('巨无霸');
  assert.equal(matchLevel('巨无霸', [], '巨无霸\n牛鱼肉堡', terms), 2); // 名称直接命中
  assert.equal(matchLevel('麦香鱼', [], '巨无霸\n牛鱼肉堡', terms), 1); // 仅分类命中
  assert.equal(matchLevel('中薯条', [], '小食', terms), 0);
});

test('matchLevel：标签命中算名称级', () => {
  assert.equal(matchLevel('某新品', ['辣的'], '', ['辣']), 2);
});

// ---- splitWants / expandWantTerms：多词与去后缀变体 ----

test('splitWants：支持 和/、/，/跟 分隔', () => {
  assert.deepEqual(splitWants('巨无霸和麦辣鸡腿堡'), ['巨无霸', '麦辣鸡腿堡']);
  assert.deepEqual(splitWants('A、B，C'), ['A', 'B', 'C']);
  assert.deepEqual(splitWants(''), []);
});

test('expandWantTerms：去后缀变体（麦辣鸡腿堡 → 麦辣鸡腿，可命中麦辣鸡腿汉堡）', () => {
  const terms = expandWantTerms('麦辣鸡腿堡');
  assert.ok(terms.includes('麦辣鸡腿堡'));
  assert.ok(terms.includes('麦辣鸡腿'));
});

test('expandWantTerms：双吉别名与多词合并', () => {
  const dual = expandWantTerms('双吉');
  assert.ok(dual.includes('双层吉士'));
  const merged = expandWantTerms('巨无霸和双层吉士汉堡');
  assert.ok(merged.includes('巨无霸'));
  assert.ok(merged.includes('双层吉士'));
});

// ---- isLightItem：酱料 / 饼干 / 周边（回归：不该排「正餐」第一） ----

test('isLightItem：调料 / 饼干 / 周边识别，可食用小食不误伤', () => {
  assert.equal(isLightItem({ name: '北美招牌牧场酱' }), true);
  assert.equal(isLightItem({ name: '素龙限定饼干' }), true);
  assert.equal(isLightItem({ name: '联名复古棒球帽' }), true);
  assert.equal(isLightItem({ name: '蘸酱炸鸡' }), false);
});
