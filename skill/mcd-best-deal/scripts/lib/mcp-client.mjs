// mcd-best-deal · 麦当劳官方 MCP 客户端（Streamable HTTP）
// 只负责连接与调用；不含业务逻辑，不持久化、不打印 Token。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const ENDPOINT = 'https://mcp.mcd.cn';
export const PROTOCOL_VERSION = '2025-06-18';

// 核心链路必备工具：缺任何一个，「最优方案」计算无法完成
export const REQUIRED_TOOLS = [
  'query-nearby-stores',
  'query-meals',
  'query-meal-detail',
  'calculate-price',
  'query-store-coupons',
  'query-my-coupons',
  'delivery-query-addresses',
  'delivery-query-stores',
  'list-nutrition-foods',
];

// 增强能力：缺失时自动降级（跳过领券、积分、活动提示等增强项）
export const OPTIONAL_TOOLS = [
  'available-coupons',
  'auto-bind-coupons',
  'query-my-account',
  'mall-points-products',
  'campaign-calendar',
  'now-time-info',
  'order-list',
  'query-order',
  'create-order',
];

function fail(message) {
  throw new Error(message);
}

// Streamable HTTP 的响应可能是纯 JSON，也可能是 SSE（data: {...} 分帧）
function parseRpcBody(body, contentType, id) {
  if (contentType.includes('text/event-stream')) {
    const events = body.replace(/\r\n/g, '\n').split(/\n\n+/);
    for (const event of events) {
      const data = event.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      let message;
      try { message = JSON.parse(data); } catch { continue; }
      if (message.id === id) return message;
    }
    fail('MCP 未返回对应的请求结果（SSE 解析失败）');
  }
  if (!body.trim()) return null;
  try { return JSON.parse(body); } catch { fail('MCP 返回内容不是合法 JSON'); }
}

export class McpClient {
  constructor(token, { endpoint = ENDPOINT } = {}) {
    if (!token || !String(token).trim()) fail('缺少 MCP Token');
    this.token = String(token).trim();
    this.endpoint = endpoint;
    this.sessionId = null;
    this.version = PROTOCOL_VERSION;
    this.nextId = 1;
  }

  async request(method, params, { notification = false } = {}) {
    const id = notification ? undefined : this.nextId++;
    const payload = { jsonrpc: '2.0', method, ...(id === undefined ? {} : { id }) };
    if (params !== undefined) payload.params = params;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': this.version,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000),
      });
    } catch (error) {
      fail(`连接 MCP 服务失败：${error.name === 'TimeoutError' ? '请求超时（25s）' : error.message}`);
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? '（Token 无效、过期或权限不足，请到 https://open.mcd.cn/mcp/doc 重新申请）'
        : response.status === 429
          ? '（触发限流：每 Token 每分钟 600 次请求，稍后再试）'
          : '';
      fail(`MCP 请求失败：HTTP ${response.status}（${method}）${hint}`);
    }
    const sid = response.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notification) return null;
    const body = await response.text();
    const rpc = parseRpcBody(body, response.headers.get('content-type') ?? '', id);
    if (rpc?.error) fail(`MCP ${method} 返回错误：${rpc.error.message ?? rpc.error.code}`);
    if (!rpc || !Object.hasOwn(rpc, 'result')) fail(`MCP ${method} 返回格式不可识别`);
    return rpc.result;
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcd-best-deal', version: '0.1.0' },
    });
    if (result?.protocolVersion) this.version = result.protocolVersion;
    await this.request('notifications/initialized', undefined, { notification: true });
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(result?.tools ?? []));
      cursor = result?.nextCursor;
    } while (cursor);
    return tools;
  }

  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) fail(`工具 ${name} 返回错误`);
    if (result?.structuredContent) return result.structuredContent;
    const text = (result?.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    if (!text) fail(`工具 ${name} 未返回可读取的数据`);
    try { return JSON.parse(text); } catch { fail(`工具 ${name} 返回内容不是 JSON`); }
  }
}

// ---- Token 解析（跨平台）----
// 优先级：环境变量 > 通用凭证文件 > WorkBuddy 配置（兼容）
// 通用凭证文件 ~/.mcd-best-deal/token 由 setup-connector.mjs 写入，
// 让本技能在 WorkBuddy / Claude Code / Codex / Trae 等任意平台下都能找到 Token。

export function configPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return path.join(home, '.workbuddy', 'mcp.json');
}

export function credentialPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return path.join(home, '.mcd-best-deal', 'token');
}

export async function readTokenFromCredentialFile() {
  const file = credentialPath();
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { token: null, source: 'missing-credential-file', file };
    return { token: null, source: 'unreadable-credential-file', file, reason: error.message };
  }
  const token = raw.split('\n')
    .map((lineText) => lineText.trim())
    .find((lineText) => lineText && !lineText.startsWith('#'));
  return { token: token ?? null, source: token ? 'credential-file' : 'empty-credential-file', file };
}

export async function readTokenFromConfig() {
  const file = configPath();
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { token: null, source: 'missing-config', file };
    return { token: null, source: 'unreadable-config', file, reason: error.message };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { token: null, source: 'invalid-config', file }; }
  const entry = parsed?.mcpServers?.['mcd-mcp'];
  const auth = entry?.headers?.Authorization ?? entry?.headers?.authorization;
  const token = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : null;
  return { token, source: token ? 'config' : 'no-entry', file };
}

export async function resolveToken() {
  const envToken = process.env.MCD_MCP_TOKEN?.trim();
  if (envToken) return { token: envToken, source: 'env' };
  const credential = await readTokenFromCredentialFile();
  if (credential.token) return credential;
  return readTokenFromConfig();
}
