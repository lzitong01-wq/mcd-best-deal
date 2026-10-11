#!/usr/bin/env node
// mcd-best-deal · 一键配置（多平台）
//
// 把麦当劳 MCP Token 写入：
//   1) 通用凭证文件 ~/.mcd-best-deal/token —— 所有平台通用，供本技能脚本直连使用；
//   2) 按 --target 写入各平台的 MCP 配置（可选增强，让平台的 Agent 也能直接调用工具）：
//      · workbuddy → ~/.workbuddy/mcp.json
//      · claude    → ~/.claude.json（合并 mcpServers 条目）
//      · codex     → ~/.codex/config.toml（写入 [mcp_servers.mcd-mcp] 段）
//      · trae      → 输出配置指引（Trae 通过设置界面管理 MCP）
//
// 写前自动备份、保留其他条目；随后在线验证。全程不打印 Token。
//
// 用法：
//   MCD_MCP_TOKEN=<你的Token> node scripts/setup-connector.mjs    （推荐）
//   node scripts/setup-connector.mjs --token <你的Token>
//   node scripts/setup-connector.mjs                              （交互式，输入不回显）
// 可选：
//   --target auto|all|workbuddy|claude|codex|trae|none（默认 auto：自动检测本机平台）
//   --offline  跳过在线验证
//   --dry-run  只预览将做什么，不写入任何文件
//   --json     输出机器可读结果（不含 Token）
// 退出码：0 = 配置成功；1 = 失败（原因见输出）

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import path from 'node:path';
import { homedir } from 'node:os';
import { ENDPOINT, McpClient, REQUIRED_TOOLS, credentialPath } from './lib/mcp-client.mjs';
import { upsertTomlSection } from './lib/util.mjs';

const SERVER_KEY = 'mcd-mcp';
// WorkBuddy：小写 streamablehttp（2026-10-11 与实测可用的本机条目对齐）
const WORKBUDDY_ENTRY_TYPE = 'streamablehttp';
// Claude Code：http（streamable-http 的官方别名）
const CLAUDE_ENTRY_TYPE = 'http';

function fail(message) {
  throw new Error(message);
}

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function homePath(...segments) {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return path.join(home, ...segments);
}

function parseArgs(argv) {
  const options = { json: false, offline: false, dryRun: false, token: null, target: 'auto', help: false };
  const allowedTargets = new Set(['auto', 'all', 'workbuddy', 'claude', 'codex', 'trae', 'none']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--token') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail('--token 后面要跟 Token 值（或改用 MCD_MCP_TOKEN 环境变量 / 交互式输入）');
      options.token = value;
    } else if (arg === '--target') {
      const value = argv[++index];
      if (!value || !allowedTargets.has(value)) {
        fail(`--target 只能是：${[...allowedTargets].join(' / ')}`);
      }
      options.target = value;
    } else fail(`未知参数：${arg}（可用：--token <值> --target <平台> --offline --dry-run --json）`);
  }
  return options;
}

async function readTokenInteractive() {
  const muted = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  const token = await rl.question('请粘贴你的麦当劳 MCP Token（输入不会回显）：');
  rl.close();
  return token.trim();
}

function validateToken(token) {
  if (!token) fail('没有拿到 Token。请在 https://open.mcd.cn/mcp/doc 申请后，用 MCD_MCP_TOKEN 环境变量、--token 参数或交互式输入提供。');
  if (token.includes('YOUR_MCP_TOKEN')) fail('这是文档里的占位符，不是真实 Token。请到 https://open.mcd.cn/mcp/doc 申请并复制真实 Token。');
  if (/\s/.test(token)) fail('Token 中间含有空格或换行，复制可能不完整，请重新一键复制。');
  if (token.length < 16) fail(`Token 长度只有 ${token.length} 位，异常偏短（麦当劳 MCP Token 通常为 32 位），请核对。`);
}

function timestamp() {
  const digits = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).replace(/\D/g, '');
  return `${digits.slice(0, 8)}-${digits.slice(8)}`;
}

async function backupFile(file) {
  const backup = `${file}.bak-${timestamp()}`;
  await copyFile(file, backup);
  return backup;
}

// ---- 各平台写入实现 ----

async function writeUniversalCredential(token, { dryRun }) {
  const file = credentialPath();
  const content = [
    '# mcd-best-deal · 麦当劳 MCP Token（本文件由 setup-connector.mjs 写入）',
    '# 供本技能脚本在任意平台直连官方 MCP 使用；请勿提交到任何仓库。',
    token,
    '',
  ].join('\n');
  if (dryRun) return { status: 'preview', file };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
  return { status: 'ok', file };
}

async function writeWorkbuddy(token, { dryRun }) {
  const file = homePath('.workbuddy', 'mcp.json');
  let config = { mcpServers: {} };
  let existed = false;
  let backup = null;
  try {
    const raw = await readFile(file, 'utf8');
    existed = true;
    try {
      config = JSON.parse(raw);
    } catch {
      return { status: 'error', file, detail: '现有配置不是合法 JSON，未做修改。请手动检查后重试。' };
    }
    if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  } catch (error) {
    if (error.code !== 'ENOENT') return { status: 'error', file, detail: error.message };
    // 文件不存在：WorkBuddy 未安装或未使用过，跳过
    return { status: 'skipped', file, detail: '未找到 ~/.workbuddy/mcp.json（未检测到 WorkBuddy 配置）' };
  }
  if (dryRun) return { status: 'preview', file };
  backup = await backupFile(file);
  config.mcpServers[SERVER_KEY] = {
    type: WORKBUDDY_ENTRY_TYPE,
    url: ENDPOINT,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
    disabled: false,
  };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { status: 'ok', file, backup, existed };
}

async function writeClaude(token, { dryRun }) {
  const file = homePath('.claude.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'skipped', file, detail: '未找到 ~/.claude.json（先安装并运行一次 Claude Code，或使用命令：claude mcp add --transport http mcd-mcp https://mcp.mcd.cn --header "Authorization: Bearer <Token>"）' };
    }
    return { status: 'error', file, detail: error.message };
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return { status: 'error', file, detail: '~/.claude.json 不是合法 JSON，未做修改，请手动检查。' };
  }
  if (dryRun) return { status: 'preview', file };
  const backup = await backupFile(file);
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};
  config.mcpServers[SERVER_KEY] = {
    type: CLAUDE_ENTRY_TYPE,
    url: ENDPOINT,
    headers: { Authorization: `Bearer ${token}` },
  };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { status: 'ok', file, backup };
}

async function writeCodex(token, { dryRun }) {
  const file = homePath('.codex', 'config.toml');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'skipped', file, detail: '未找到 ~/.codex/config.toml（先安装并运行一次 Codex，或手动添加 [mcp_servers.mcd-mcp] 段）' };
    }
    return { status: 'error', file, detail: error.message };
  }
  if (dryRun) return { status: 'preview', file };
  const backup = await backupFile(file);
  const body = [
    'url = "https://mcp.mcd.cn"',
    `http_headers = { Authorization = "Bearer ${token}" }`,
    'startup_timeout_sec = 30',
  ];
  const updated = upsertTomlSection(raw, `mcp_servers.${SERVER_KEY}`, body);
  await writeFile(file, updated, 'utf8');
  return { status: 'ok', file, backup };
}

function traeGuide() {
  return [
    'Trae 的 MCP 通过设置界面管理，请手动添加：',
    '  ① 打开 Trae → 设置 → MCP → 添加 → 手动添加',
    '  ② 把下面这段 JSON 粘贴进去，并把 <Token> 替换为你申请的 Token：',
    '',
    '  {',
    '    "mcpServers": {',
    '      "mcd-mcp": {',
    '        "url": "https://mcp.mcd.cn",',
    '        "headers": { "Authorization": "Bearer <Token>" }',
    '      }',
    '    }',
    '  }',
    '',
    '  （Token 已写入通用凭证文件 ~/.mcd-best-deal/token，本技能脚本在 Trae 中可直接使用；',
    '    上面的 MCP 配置用于让 Trae 的 Agent 也能直接调用官方工具，属可选增强）',
  ];
}

// ---- 在线验证 ----

async function verifyOnline(token) {
  const result = { status: 'skipped', findings: [] };
  try {
    const client = new McpClient(token);
    const init = await client.initialize();
    const tools = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
    result.status = missing.length ? 'partial' : 'ok';
    result.serverInfo = init?.serverInfo
      ? `${init.serverInfo.name ?? '未知'} ${init.serverInfo.version ?? ''}`.trim()
      : null;
    result.protocolVersion = init?.protocolVersion ?? null;
    result.toolCount = tools.length;
    result.missingRequired = missing;
    if (missing.length) result.findings.push(`服务缺少核心工具：${missing.join(', ')}`);
  } catch (error) {
    result.status = 'error';
    result.findings.push(error.message);
  }
  return result;
}

// ---- 平台检测 ----

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function detectPlatforms() {
  const detected = [];
  if (await exists(homePath('.workbuddy', 'mcp.json'))) detected.push('workbuddy');
  if (await exists(homePath('.claude.json'))) detected.push('claude');
  if (await exists(homePath('.codex', 'config.toml'))) detected.push('codex');
  if (await exists(homePath('.trae-cn')) || await exists(homePath('.trae'))) detected.push('trae');
  return detected;
}

const NEXT_STEPS = {
  workbuddy: [
    'WorkBuddy：连接器管理页 → 自定义连接器 → 对 mcd-mcp 点「Trust」→ 左下角「+」启用 → 重开一轮会话',
  ],
  claude: [
    'Claude Code：重启会话后输入 /mcp 可看到 mcd-mcp；或在终端运行 claude mcp list 检查',
  ],
  codex: [
    'Codex：重启 Codex 后运行 codex mcp list 确认 mcd-mcp 已加载',
  ],
  trae: [
    'Trae：按上面的指引在「设置 → MCP」中添加；添加完成后重启 Trae',
  ],
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    line('用法：node scripts/setup-connector.mjs [--token <Token>] [--target auto|all|workbuddy|claude|codex|trae|none]');
    line('      [--offline] [--dry-run] [--json]');
    line('  Token 来源优先级：--token 参数 > MCD_MCP_TOKEN 环境变量 > 交互式隐藏输入');
    line('  --target 默认 auto：自动检测本机平台并写入对应配置；none = 只写通用凭证文件');
    line('  --dry-run 只预览不写入；--offline 跳过在线验证；--json 输出结构化结果（不含 Token）');
    return;
  }

  const token = (options.token ?? process.env.MCD_MCP_TOKEN ?? await readTokenInteractive()).trim();
  validateToken(token);

  // 目标平台
  let targets;
  if (options.target === 'auto') {
    targets = await detectPlatforms();
    if (!targets.length) targets = ['none'];
  } else if (options.target === 'all') {
    targets = ['workbuddy', 'claude', 'codex', 'trae'];
  } else if (options.target === 'none') {
    targets = [];
  } else {
    targets = [options.target];
  }

  const results = [];

  // 1) 通用凭证文件
  const credential = await writeUniversalCredential(token, options);
  results.push({ platform: '通用凭证', ...credential });

  // 2) 各平台配置
  const writers = { workbuddy: writeWorkbuddy, claude: writeClaude, codex: writeCodex };
  for (const platform of targets) {
    if (platform === 'trae') {
      results.push({ platform: 'trae', status: 'guide', guide: traeGuide() });
      continue;
    }
    const writer = writers[platform];
    if (!writer) continue;
    try {
      const result = await writer(token, options);
      results.push({ platform, ...result });
    } catch (error) {
      results.push({ platform, status: 'error', detail: error.message });
    }
  }

  // 3) 在线验证
  const online = options.offline ? { status: 'skipped', findings: [] } : await verifyOnline(token);
  const ok = options.offline || online.status === 'ok' || online.status === 'partial';

  // 4) 输出
  if (options.json) {
    line(JSON.stringify({
      ok,
      dryRun: options.dryRun,
      results: results.map((item) => ({ ...item, guide: item.guide })),
      online,
      nextSteps: ok ? targets.flatMap((platform) => NEXT_STEPS[platform] ?? []) : [],
    }, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }

  line('麦麦最优方案 · 一键配置（多平台）');
  if (options.dryRun) line('（预览模式：不会写入任何文件）');
  line();
  for (const result of results) {
    const tag = {
      ok: '[完成]', preview: '[预览]', skipped: '[跳过]', error: '[失败]', guide: '[指引]',
    }[result.status] ?? '[信息]';
    line(`${tag} ${result.platform}${result.file ? `：${result.file}` : ''}`);
    if (result.backup) line(`        已备份原文件：${result.backup}`);
    if (result.detail) line(`        ${result.detail}`);
  }
  const guides = results.filter((item) => item.status === 'guide');
  for (const guide of guides) {
    line();
    for (const guideLine of guide.guide) line(guideLine);
  }
  line();
  line('[在线验证]');
  if (online.status === 'ok' || online.status === 'partial') {
    line(`  连接成功：${online.serverInfo ?? '未知服务'}，协议 ${online.protocolVersion ?? '未知'}，共 ${online.toolCount} 个工具`);
    line(`  核心工具：${online.missingRequired.length ? `缺 ${online.missingRequired.join(', ')}` : '齐全'}`);
  } else if (online.status === 'skipped') {
    line('  已跳过（--offline）');
  } else {
    line(`  验证未通过：${online.findings.join('；')}`);
    line('  若提示 Token 无效，请到 https://open.mcd.cn/mcp/doc 重新申请后再次运行本脚本。');
    process.exitCode = 1;
    return;
  }
  line();
  if (options.dryRun) {
    line('预览结束。去掉 --dry-run 即实际写入。');
    return;
  }
  line('[下一步]');
  const steps = targets.flatMap((platform) => NEXT_STEPS[platform] ?? []);
  if (steps.length) {
    for (const step of steps) line(`  · ${step}`);
  } else {
    line('  · 通用凭证已就绪，技能脚本可直接直连官方 MCP 使用。');
  }
  line('  · 在任意平台的对话里说「帮我算今天怎么吃麦当劳」即可开始。');
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`);
  process.exitCode = 1;
});
