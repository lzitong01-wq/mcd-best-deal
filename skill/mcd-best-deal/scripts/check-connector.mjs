#!/usr/bin/env node
// mcd-best-deal · 连接器体检
// 从环境变量或 WorkBuddy 配置读取 Token，在线验证麦当劳 MCP 可达性与工具覆盖。
// 不打印、不落盘任何凭证。
//
// 用法：node scripts/check-connector.mjs [--json]
// 退出码：0 = 核心工具齐全；1 = 不可用（原因见输出）

import { McpClient, OPTIONAL_TOOLS, REQUIRED_TOOLS, resolveToken } from './lib/mcp-client.mjs';

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

async function main() {
  const json = process.argv.includes('--json');
  const { token, source, file } = await resolveToken();

  const report = {
    ok: false,
    tokenSource: source,
    configFile: file ?? null,
    online: null,
    requiredTools: { ok: [], missing: [] },
    optionalTools: { ok: [], missing: [] },
  };

  if (!token) {
    const hints = {
      'missing-config': '本机还没有 mcd-mcp 配置。请先运行 setup-connector.mjs 写入 Token。',
      'invalid-config': `${file ?? '配置文件'} 不是合法 JSON，请检查后重试。`,
      'unreadable-config': `无法读取 ${file ?? '配置文件'}：请检查文件权限。`,
      'no-entry': `${file ?? '配置文件'} 里没有 mcd-mcp 条目，请先运行 setup-connector.mjs。`,
    };
    report.error = hints[source] ?? '未找到 Token。';
    if (json) { line(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
    line(`[不可用] ${report.error}`);
    line('         Token 来源优先级：环境变量 MCD_MCP_TOKEN > ~/.workbuddy/mcp.json');
    process.exitCode = 1;
    return;
  }

  const client = new McpClient(token);
  try {
    const init = await client.initialize();
    const tools = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    report.online = {
      server: init?.serverInfo ? `${init.serverInfo.name ?? '未知'} ${init.serverInfo.version ?? ''}`.trim() : '未知',
      protocol: init?.protocolVersion ?? null,
      toolCount: tools.length,
    };
    report.requiredTools.ok = REQUIRED_TOOLS.filter((name) => names.has(name));
    report.requiredTools.missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
    report.optionalTools.ok = OPTIONAL_TOOLS.filter((name) => names.has(name));
    report.optionalTools.missing = OPTIONAL_TOOLS.filter((name) => !names.has(name));
    report.ok = report.requiredTools.missing.length === 0;
  } catch (error) {
    report.error = error.message;
    if (json) { line(JSON.stringify(report, null, 2)); process.exitCode = 1; return; }
    line(`[不可用] 在线验证失败：${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (json) {
    line(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  line('麦麦最优方案 · 连接器体检');
  line();
  line(`Token 来源：${source === 'env' ? '环境变量 MCD_MCP_TOKEN' : `配置文件（${file}）`}`);
  line(`服务：${report.online.server}，协议 ${report.online.protocol ?? '未知'}，共 ${report.online.toolCount} 个工具`);
  line();
  line(`[${report.requiredTools.missing.length ? '缺少' : '齐全'}] 核心工具 ${report.requiredTools.ok.length}/${REQUIRED_TOOLS.length}`);
  if (report.requiredTools.missing.length) line(`        缺失：${report.requiredTools.missing.join(', ')}`);
  line(`[${report.optionalTools.missing.length ? '部分' : '齐全'}] 增强工具 ${report.optionalTools.ok.length}/${OPTIONAL_TOOLS.length}`);
  if (report.optionalTools.missing.length) line(`        缺失（相关功能将降级）：${report.optionalTools.missing.join(', ')}`);
  line();
  if (report.ok) {
    line('结论：连接器可用。');
  } else {
    line('结论：核心工具不齐全，无法完成最优方案计算。');
    line('提示：先在 WorkBuddy 连接器管理页确认 mcd-mcp 已启用并重开会话；仍缺失则重新运行 setup-connector.mjs。');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`);
  process.exitCode = 1;
});
