# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；变更记录参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [Unreleased]

### Added
- `tests/util.test.mjs`：单元测试（node:test，零依赖、无需网络；11 例覆盖解析/匹配/TOML 处理）
- `scripts/lib/util.mjs`：纯工具函数独立成模块（紧凑表格解析 / 营养匹配 / TOML 段写入），供测试与脚本共用
- README 新增 `npx skills add lzitong01-wq/mcd-best-deal` 生态安装方式（已实测可被 skills CLI 正确发现）

### Changed
- 推荐逻辑（基于用户体验反馈，plan.mjs）：
  - 轻食类（饮品/咖啡/冰淇淋/甜点）默认不计入正餐候选——仅当用户点名、或商品本身为套餐时保留
  - 取消「人气热卖」硬过滤：改为全量正餐候选，「人气款」仅作排序偏好与备用参考（输出 `popular` 标记）
  - 券综合评估：对基础候选 × 每张门店可用券逐一试算（含把券应用到候选内同商品的场景），输出全部「含券」结果供横向比较
  - 套餐与单点综合呈现（byStyle 分组 + comparisons 结论），由用户自行选择
  - 新增用户偏好体系：`~/.mcd-best-deal/preferences.json` + `preferences.mjs`（忌口/口味/默认模式/常用位置），首次确认、随时可改；plan/collect 自动读取
  - SKILL.md：需求模糊时先与用户确认（不猜测）；新增轻食/用券/人气参考展示规范

### Fixed
- `test.sh` 的 `node --test` 调用方式（目录参数在 Windows 下无法解析，改为自动发现模式）
- 轻食过滤在无 want 场景被短路（饮品/冰淇淋仍进入候选）的问题
- 商品出现在多个菜单分类时分类被覆盖、导致「人气」判定丢失的问题（改为保留全部分类）
- plan 输出未透传 `coupon` / `popular` 字段的问题

## [0.3.0] - 2026-10-11

### Added
- `references/` 详细文档：排障手册（troubleshooting）、多平台安装（platforms）、数据管道（pipeline）
- `llms.txt`：面向 LLM 的项目摘要
- `LICENSE`（MIT）、`SECURITY.md`、本 CHANGELOG
- `.claude-plugin/`：Claude Code 插件清单（支持以插件方式安装）
- `test.sh`：基础自检（语法 / 结构 / frontmatter 校验）

### Changed
- `SKILL.md` 精简：排障细节与平台细节移入 `references/`（渐进式披露），强化触发描述与「必须走本技能试算」约束

## [0.2.0] - 2026-10-11

### Added
- 多平台安装支持：`install.sh` / `install.ps1` 一键安装（自动检测 WorkBuddy / Claude Code / Codex / Trae）
- 通用凭证文件 `~/.mcd-best-deal/token`（跨平台共用）
- `setup-connector.mjs` 自动配置各平台 MCP（写前备份；Trae 输出指引）

### Fixed
- 平台检测无法识别目录型平台（改用 stat）
- Trae 配置指引不再回显 Token

## [0.1.0] - 2026-10-11

### Added
- 首个可用版本：数据采集（门店/菜单/券/营养）、方案引擎（候选枚举 → 官方算价器逐个试算 → 三模式加权排序）
- 套餐 vs 单点对比、拆单方案（多券分单）、券提示
- 三种模式：省钱 / 健康 / 省事（权重可在 `config/rules.json` 调整）
- 连接器体检与一键配置脚本
