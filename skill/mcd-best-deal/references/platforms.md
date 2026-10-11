# 多平台安装（详细版）

本技能遵循 Agent Skills 开放标准（一个文件夹 + `SKILL.md`），并内置**零依赖直连客户端**——
在任何能运行 Node.js 20+ 的环境中都可用；平台 MCP 连接器是体验增强，而非运行前提。

## 平台对照表

| 平台 | Skills 目录 | MCP 配置位置 | 启用方式 |
| --- | --- | --- | --- |
| WorkBuddy | `~/.workbuddy/skills/` | `~/.workbuddy/mcp.json` | 连接器页 Trust → 「+」启用 → 重开会话 |
| Claude Code | `~/.claude/skills/` | `~/.claude.json`（或 `claude mcp add`） | 重启会话；`/mcp` 确认 |
| Codex | `~/.agents/skills/`（旧版 `~/.codex/skills/`） | `~/.codex/config.toml` | 重启；`codex mcp list` 确认 |
| Trae | `~/.trae-cn/skills/`（或项目 `.trae/skills/`） | 设置 → MCP（界面添加） | 添加后重启 |
| 其他 | 支持 `.agents/skills/` 约定的环境 | 按各工具文档 | — |

## 生态 CLI（npx skills，跨 40+ 平台）

本仓库已兼容通用 skills CLI（[skills.sh](https://skills.sh) 生态，支持 Claude Code / Codex / Cursor 等 40+ 平台），无需手动克隆：

```bash
npx skills add lzitong01-wq/mcd-best-deal           # 交互式：选择技能与目标平台
npx skills add lzitong01-wq/mcd-best-deal -g -y     # 非交互：全局安装
```

安装后同样运行 `setup-connector.mjs` 配置 Token 即可（见下）。

## 一键安装（推荐，离线可用）

```bash
bash install.sh                       # 自动检测本机平台并安装
bash install.sh --target claude       # 只装指定平台
bash install.sh --target all          # 装到全部已知平台
bash install.sh --dry-run             # 预览
```

Windows PowerShell 对应：`powershell -ExecutionPolicy Bypass -File install.ps1 [-Target claude] [-DryRun]`

安装 = 把技能目录复制到 `<平台目录>/mcd-best-deal`；重复运行即为更新。

## 手动安装

把 `skill/mcd-best-deal` 整个文件夹复制到上表对应平台的 Skills 目录，或导入 `dist/mcd-best-deal-skill.zip`。

## Token 配置（所有平台通用，只需一次）

```bash
node "<技能目录>/scripts/setup-connector.mjs"
# 交互式粘贴 Token（不回显）；或：MCD_MCP_TOKEN='<Token>' node ...
```

脚本行为：
1. 写入**通用凭证文件** `~/.mcd-best-deal/token`（本技能脚本在任何平台都用它直连）；
2. 自动写入检测到的平台 MCP 配置（WorkBuddy / Claude Code / Codex，写前自动备份 `.bak-<时间戳>`）；
3. 为 Trae 输出界面添加指引（Trae 仅支持界面配置 MCP）；
4. 在线验证 Token（显示服务名、工具数、核心工具是否齐全）。

可选参数：`--target auto|all|workbuddy|claude|codex|trae|none`、`--dry-run`、`--offline`、`--json`。

## 各平台细节

### WorkBuddy
- 连接器管理页 → 自定义连接器 → 对 `mcd-mcp` 点「Trust」→ 聊天窗口左下角「+」启用 → 重开会话。

### Claude Code
- 允许的 JSON 条目（`~/.claude.json`）：`{"type": "http", "url": "https://mcp.mcd.cn", "headers": {"Authorization": "Bearer <Token>"}}`
- 或命令：`claude mcp add --transport http mcd-mcp https://mcp.mcd.cn --header "Authorization: Bearer <Token>"`
- 验证：会话内 `/mcp`，或终端 `claude mcp list`。

### Codex
- `~/.codex/config.toml`：
  ```toml
  [mcp_servers.mcd-mcp]
  url = "https://mcp.mcd.cn"
  http_headers = { Authorization = "Bearer <Token>" }
  ```
  （更安全的方式：`bearer_token_env_var = "MCD_MCP_TOKEN"`，Token 留在环境变量）
- 验证：重启后 `codex mcp list`。

### Trae
- 设置 → MCP → 添加 → 手动添加，粘贴：
  ```json
  { "mcpServers": { "mcd-mcp": { "url": "https://mcp.mcd.cn", "headers": { "Authorization": "Bearer <Token>" } } } }
  ```
- 项目级可放 `.trae/mcp.json`（需在设置里开启「启用项目级 MCP」）。

### 其他工具
- 复制技能文件夹到该工具的 skills 目录（若支持 `.agents/skills/` 约定则更简单）；
- 设置环境变量 `MCD_MCP_TOKEN=<Token>`，技能脚本即可直连官方 MCP，无需任何平台配置。

## 校验安装

```bash
node "<技能目录>/scripts/check-connector.mjs"     # 应输出「连接器可用」，并显示 Token 来源
```
