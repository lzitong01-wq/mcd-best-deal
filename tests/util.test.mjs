// mcd-best-deal · 单元测试（node:test，零依赖、无需网络）
// 运行：node --test tests/   （或 bash test.sh 会一并执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompactTable, findNutrition, upsertTomlSection } from '../skill/mcd-best-deal/scripts/lib/util.mjs';

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
