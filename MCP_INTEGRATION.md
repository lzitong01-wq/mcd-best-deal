# 麦当劳 MCP 接入说明

本文档说明「麦麦最优方案（mcd-best-deal）」实际使用的麦当劳 MCP Server、Tool、调用流程与业务价值。全部内容基于 2026-10-11 的真实 Token 联调记录。

## 一、使用的服务（Server）

| 项 | 内容 |
| --- | --- |
| 提供方 | 麦当劳中国 |
| 连接器名称 | `mcd-mcp` |
| 服务地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP（MCP 协议版本 2025-06-18） |
| 认证方式 | `Authorization: Bearer <Token>`，Token 由用户前往麦当劳 MCP 开放平台（open.mcd.cn/mcp/doc）申请 |
| 工具规模 | 35 个（2026-10-11 `tools/list` 实测） |
| 官方限流 | 每 Token 每分钟 600 次请求（429 时暂停重试） |

本项目通过两个通道使用同一官方服务：

1. **WorkBuddy 对话内的 `mcd-mcp` 连接器**：Agent 直接调用工具完成交互式查询；
2. **项目自带零依赖 Node.js 直连客户端**（`skill/mcd-best-deal/scripts/lib/mcp-client.mjs`，Streamable HTTP + SSE 解析），用于「采集 → 试算 → 排序」的确定性计算链路，保证连接器尚未加载时也能完整工作。

**凭证安全**：Token 只写入用户本机（通用凭证文件 `~/.mcd-best-deal/token`、各平台配置或环境变量 `MCD_MCP_TOKEN`）；不进入仓库文件、不写入日志、不在对话中回显。本仓库不含任何真实凭证。

### 多平台接入

本技能遵循 Agent Skills 开放标准，并可通过标准 MCP（Streamable HTTP）接入多个 AI 工具。一条配置命令即可完成（`scripts/setup-connector.mjs` 会写入通用凭证文件，并自动写入检测到的平台配置）：

| 平台 | Skills 目录 | MCP 配置 | 配置方式 |
| --- | --- | --- | --- |
| WorkBuddy | `~/.workbuddy/skills/` | `~/.workbuddy/mcp.json` | 脚本自动写入；连接器页 Trust + 启用 |
| Claude Code | `~/.claude/skills/` | `~/.claude.json` | 脚本自动合并；或 `claude mcp add --transport http mcd-mcp https://mcp.mcd.cn --header "Authorization: Bearer <Token>"` |
| Codex | `~/.agents/skills/` | `~/.codex/config.toml` | 脚本自动写入 `[mcp_servers.mcd-mcp]` 段（url + http_headers） |
| Trae | `~/.trae-cn/skills/` | 设置 → MCP | 按脚本输出的 JSON 指引手动添加 |
| 其他工具 | 支持 `.agents/skills/` 约定的环境 | 按各工具文档 | 复制技能文件夹 + 配置 MCP 或设置 `MCD_MCP_TOKEN` |

**关键设计**：本技能自带零依赖 Node.js 直连客户端（`scripts/lib/mcp-client.mjs`），只需 Token（通用凭证文件或环境变量）即可完成「采集 → 官方算价 → 排序」全链路，**不依赖任何平台的 MCP 加载状态**——平台连接器是体验增强（Agent 可直接调用官方工具），而非运行前提。

## 二、使用的 Tool 及角色

### 核心链路

| Tool | 在项目中的用途 | 实测 |
| --- | --- | --- |
| `query-nearby-stores` | 到店场景候选门店：按「城市 + 商圈」搜索，返回门店编码、地址、**到店距离（米）**、营业状态与预约时段 | ✅ |
| `delivery-query-addresses` | 外卖场景起点：读取用户配送地址簿（为空时引导用 `delivery-create-address` 创建） | ✅ |
| `delivery-query-stores` | 外卖场景候选门店：按配送地址返回可配送门店（含 beCode） | 已接入（需地址后完整验证） |
| `query-meals` | 门店菜单：现价 / 划线价 / 促销标记 / 随单购信息（逐店实时获取） | ✅ |
| `query-meal-detail` | 套餐组成与可特调信息（用于套餐↔单点对比的细化与下单参数回收） | 已接入 |
| `calculate-price` | **官方算价器（项目核心）**：对每个候选方案试算实付价；支持商品组合、优惠券（couponId/couponCode）、数量、预约时间；返回分单位明细（原价/优惠/现价/逐项小计/取餐方式） | ✅ |
| `list-nutrition-foods` | 营养表（160 条：能量/蛋白质/脂肪/碳水/钠/钙），供健康模式的营养约束 | ✅ |
| `query-store-coupons` | 指定门店 + 场景下的**可用券**（券名/券 ID/券码/有效期/适用商品） | ✅ |
| `query-my-coupons` | 用户券包（全部已持有券） | ✅ |
| `available-coupons` | 「麦麦省」可领取券池 | ✅ |
| `auto-bind-coupons` | 一键领取全部可领券（下单前使用，扩大优惠池） | ✅ |
| `now-time-info` | 官方时间（用于营业状态与时段判断的参照） | ✅ |

### 交易链路（仅在用户逐项确认后调用）

| Tool | 用途 | 说明 |
| --- | --- | --- |
| `create-order` | 创建订单（到店需 `takeWayCode`；外卖需 `addressId`） | 支付始终由用户在官方流程完成 |
| `query-order` / `order-list` | 订单状态核实 | 支付后查询 |

## 三、调用流程（实际业务链路）

```text
【到店场景】
用户需求（想吃什么 / 人数 / 预算 / 模式）
  ├─ query-nearby-stores(city, keyword)        → 候选门店（距离 / 营业状态排序）
  ├─ query-meals(storeCode)        × 候选门店   → 菜单（现价 / 促销价）
  ├─ query-store-coupons(storeCode) × 候选门店  → 各店可用券（逐店不同）
  ├─ list-nutrition-foods()                     → 营养表
  └─ calculate-price(storeCode, items[, 券])    → 每个候选方案实付价（逐个试算）
        ↓
  评分排序 → Top 方案 + 套餐 vs 单点对比 + 拆单方案 + 券提示
        ↓
  【用户确认后】auto-bind-coupons → create-order → 用户在官方流程支付
  （到店 takeWayCode 取自算价返回 takeWayList；不自动付款）

【外卖场景】（与到店的差异）
  delivery-query-addresses → （无地址则 delivery-create-address）
  → delivery-query-stores(addressId) → 可配送门店
  → 后续同到店链（orderType=2，实付价含配送费 / 打包费）

【预约场景】
  calculate-price(..., reservationDate)          → 预约单算价（不受门店当前打烊影响）
```

候选方案类型（由 `plan.mjs` 枚举后逐个调用 `calculate-price` 试算）：

- 官方套餐（如「巨无霸三件套」）
- 单品裸买（单点）
- 单点组合（汉堡 + 薯条 + 可乐，用于对照套餐价）
- 券商品方案（券 + 其对应商品，一单一券）
- 拆单方案（多张券分多单，各用一张；价格 = 各单试算之和）

## 四、业务价值

1. **把「优惠」从展示变成可计算的决策**：官方 MCP 提供了券、菜单价、促销标记等原始数据；本项目用官方算价器 `calculate-price` 对每个候选方案**逐一试算**，把「哪种买法最划算」变成可验证的结论——
   - 套餐 vs 单点：实测「巨无霸三件套 ¥36.5 vs 单点组合 ¥48.5，省 ¥12」；
   - 用券 vs 促销价：实测「美式促销 ¥11.9 < 7 折券 ¥13.3」，避免「有券就用」的直觉损失；
   - 多门店比价：同一商品在不同门店/时段价格不同（实测 ¥25.5 与 ¥26），逐店实时试算。
2. **在官方约束内做最大化**：把「一单一券」「券与门店/时段绑定」「打烊拒算价」等限制，转化为拆单方案、逐店查券、预约单等产品能力。
3. **诚实的数据链**：营养匹配不完整时如实标注不计分；查不到的范围明确说明；不估算、不编造、不复用旧价。
4. **可扩展与可验证**：全部 MCP 调用封装为零依赖脚本（采集 / 试算 / 排序），规则（模式权重、营养目标）集中在 `config/rules.json`，便于测试、审查与二次开发。

## 五、真实联调记录（2026-10-11）

- **握手**：`serverInfo: mcd-mcp 1.0.0`，协议 `2025-06-18`，`tools/list` 返回 35 个工具；核心 12 个工具全部可用。
- **到店链**（北京三里屯，深夜实测）：返回 5 家门店（距离 628–1397 米，含 24 小时店）；2 家候选门店菜单（各 100+ 商品）；门店券 3 张；券包 5 张；营养表 160 条。
- **算价**：单个方案 11–19 个候选全部试算成功；示例：巨无霸三件套 ¥36.5、单点组合 ¥48.5、用 7 折券美式中杯 ¥19→¥13.3（与券包标注「用券价格」一致）。
- **边界**：一单一券（报错码 600022）；券与门店/时段强绑定（同一张券在不同门店可用性不同，门店打烊后券列表为空）；打烊门店拒算价（预约单可绕过）；`list-nutrition-foods` 返回「紧凑表格」文本（项目内含解析器，已实测解析 160/160 条）。

## 六、已知限制

- 一单一券：多张券需拆单（项目已提供拆单方案并明确标注多单成本）；
- 券可用性随门店、时段变化，必须实时查询，不能缓存复用；
- 外卖链路的完整验证依赖真实配送地址（地址为空时走「引导创建地址」流程）；
- 营养表名称与门店商品名不完全一一对应，仅精确匹配才计入营养分（其余如实标注）；
- `create-order` 未做真实付款验证（支付由用户完成），到店 `takeWayCode` 取值链路已在算价返回中确认。
