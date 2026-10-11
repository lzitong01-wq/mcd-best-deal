# 数据管道（Data Pipeline）

本技能全流程的原则：**候选方案由脚本枚举，价格由官方算价器逐个试算，LLM 不参与任何数字计算**。

## 全链一览

```text
用户需求（想吃什么 / 人数 / 预算 / 模式 / 场景）
  │
  ├─ collect.mjs ── 实时采集
  │    门店（含距离、营业状态）→ 菜单（现价/划线价/促销）→ 逐店可用券 → 券包 → 营养表
  │
  ├─ plan.mjs ── 枚举与试算
  │    候选构造：官方套餐 / 单品裸买 / 单点组合 / 券商品方案 / 拆单方案（多券分单）
  │    → 每个候选调用官方 calculate-price 试算实付价（分单位）
  │    → 三路评分（价格 / 营养偏差 / 便利）× 模式权重 → 排序
  │
  └─ 展示（对话 + plan.json）
       Top 方案 / 套餐对比（comparisons）/ 按购买方式分组（byStyle）/ 券提示（couponHints）
       │
       └─ 用户确认后（可选）── auto-bind-coupons → create-order → 用户自行支付
```

## 脚本与参数

### collect.mjs（数据采集）

```bash
node scripts/collect.mjs --city 北京 --keyword 三里屯 --max-stores 2 --output mcd-data.json
node scripts/collect.mjs --scene delivery --address-id <ID> --output mcd-data.json   # 外卖
```

- 输出 schema：`mcd-best-deal/collect@0.1.0`（`stores / candidates / menus / storeCoupons / wallet / nutrition / notes`）
- 候选门店选择：营业中优先 → 距离近优先，取前 `--max-stores` 家
- 营养表为官方「紧凑表格」字符串，脚本内置解析器（160 条）

### plan.mjs（方案计算）

```bash
node scripts/plan.mjs --input mcd-data.json --mode save|healthy|easy --people 1 \
  [--want 关键词] [--style any|combo|single] [--budget 50] [--top 3] --output mcd-plan.json
```

- 输出 schema：`mcd-best-deal/plan@0.1.0`
- 单次运行会调用官方算价器约 10–30 次（受 `rules.json` 的 `maxQuoteCalls` 约束）

### check-connector.mjs / setup-connector.mjs
见 `references/troubleshooting.md` 与 `references/platforms.md`。

## MCP 工具调用清单（官方工具 → 环节）

| 环节 | 官方工具 |
| --- | --- |
| 到店候选门店 | `query-nearby-stores` |
| 外卖地址/可配送门店 | `delivery-query-addresses` / `delivery-query-stores` |
| 菜单 | `query-meals`（逐店） |
| 门店可用券 | `query-store-coupons`（逐店） |
| 券包 / 可领券 / 领券 | `query-my-coupons` / `available-coupons` / `auto-bind-coupons` |
| **实付价试算** | `calculate-price`（核心；含券、单位分） |
| 营养表 | `list-nutrition-foods` |
| 下单（用户确认后） | `create-order` |
| 订单核实 | `query-order` / `order-list` |

## plan.json 关键字段速查（展示层使用）

| 字段 | 含义 |
| --- | --- |
| `top[]` | 混合排序后的前 N 个方案（含 `kind/title/store/items/pricing/scores/nutrition/reason`） |
| `all[]` | 全部已试算方案（同结构） |
| `byStyle` | 按购买方式分组：`combo` / `single` / `coupon` / `split`（供“买法由用户定”） |
| `comparisons[]` | 套餐 vs 单点组合结论（`conclusion` 如「套餐更便宜，省 ¥12」） |
| `couponHints[]` | 与需求不相关但可用的券（顺便提示） |
| `failed[]` | 试算失败的候选及原因（通常因门店打烊/券不可用） |
| `pricing.price` | 实付价（**分**，展示时除以 100） |
| `scores` | 三路得分与总分（`price/nutrition/convenience/total`） |
| `nutrition.details` | 每个商品的营养匹配质量（`exact` / `fuzzy` / `none`） |
| `notes[]` | 过程提示（降级、上限、数据问题等） |

## 引擎内置的诚实约束

- 价格只来自官方试算结果，不估算、不复用旧价；
- 营养仅精确匹配才计入评分，否则标注「不完整（不计分）」；
- 券的可用性逐店、逐时段实时查询，不缓存；
- 拆单方案显式标注「需分 N 次下单」。
