# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；变更记录参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [Unreleased]

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
