// mcd-best-deal · 纯工具函数（解析 / 匹配 / 文本处理）
// 无副作用、无网络依赖，便于单元测试（tests/util.test.mjs）。

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
