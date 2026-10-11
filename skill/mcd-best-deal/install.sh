#!/usr/bin/env bash
# mcd-best-deal · 一键安装脚本（macOS / Linux / Windows Git Bash）
#
# 把本技能复制到各 AI 平台的 skills 目录（WorkBuddy / Claude Code / Codex / Trae，
# 以及任何支持 Agent Skills 标准（.agents/skills/）的工具）。
#
# 用法：
#   bash install.sh                       # 自动检测本机平台并安装
#   bash install.sh --target workbuddy    # 只装到指定平台
#   bash install.sh --target all          # 装到全部已知平台
#   bash install.sh --dry-run             # 预览会做什么，不实际复制
#
# 说明：
#   - 安装 = 把本目录（SKILL.md / scripts / config）复制到 <平台目录>/mcd-best-deal
#   - Token 配置在安装后运行 scripts/setup-connector.mjs 完成（所有平台通用，只需一次）
#   - 重复运行本脚本 = 更新到最新版本

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${USERPROFILE:-$HOME}"
TARGET="auto"
DRY_RUN=0

usage() {
  echo "用法：bash install.sh [--target auto|workbuddy|claude|codex|trae|all] [--dry-run]"
  echo "  auto（默认）：自动检测本机已安装的平台并逐一安装"
  echo "  也可先 --dry-run 预览"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || { echo "缺少 --target 的值"; exit 1; }
      TARGET="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1（可用：--target auto|workbuddy|claude|codex|trae|all --dry-run）"; exit 1 ;;
  esac
done

dir_for() {
  case "$1" in
    workbuddy) echo "$HOME_DIR/.workbuddy/skills" ;;
    claude)    echo "$HOME_DIR/.claude/skills" ;;
    codex)     echo "$HOME_DIR/.agents/skills" ;;
    trae)      echo "$HOME_DIR/.trae-cn/skills" ;;
    *) echo "" ;;
  esac
}

is_present() {
  case "$1" in
    workbuddy) [ -d "$HOME_DIR/.workbuddy" ] ;;
    claude)    [ -d "$HOME_DIR/.claude" ] || [ -f "$HOME_DIR/.claude.json" ] ;;
    codex)     [ -d "$HOME_DIR/.codex" ] || [ -d "$HOME_DIR/.agents" ] ;;
    trae)      [ -d "$HOME_DIR/.trae-cn" ] || [ -d "$HOME_DIR/.trae" ] ;;
    *) return 1 ;;
  esac
}

install_to() {
  local name="$1"
  local dir="$2"
  if [ -z "$dir" ]; then
    echo "  [跳过] $name：未知目标目录"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [预览] $name -> $dir/mcd-best-deal"
    return
  fi
  mkdir -p "$dir" || { echo "  [失败] 无法创建 $dir"; return; }
  if [ -d "$dir/mcd-best-deal" ]; then
    rm -rf "$dir/mcd-best-deal" || { echo "  [失败] 无法更新 $dir/mcd-best-deal"; return; }
  fi
  cp -r "$SCRIPT_DIR" "$dir/mcd-best-deal" || { echo "  [失败] 复制到 $dir 失败"; return; }
  rm -rf "$dir/mcd-best-deal/.git" 2>/dev/null || true
  echo "  [完成] $name -> $dir/mcd-best-deal"
}

echo "麦麦最优方案（mcd-best-deal）· 一键安装"
echo "源目录：$SCRIPT_DIR"
echo ""

ALL_PLATFORMS="workbuddy claude codex trae"
TO_INSTALL=""
case "$TARGET" in
  auto)
    for p in $ALL_PLATFORMS; do
      if is_present "$p"; then TO_INSTALL="$TO_INSTALL $p"; fi
    done
    if [ -z "$TO_INSTALL" ]; then
      echo "未检测到已知平台（WorkBuddy / Claude Code / Codex / Trae）。"
      echo "可选做法："
      echo "  1) 指定平台安装：bash install.sh --target claude"
      echo "  2) 手动复制：把本目录复制到目标平台的 skills 目录（见 README「安装」一节）"
      exit 0
    fi
    ;;
  all) TO_INSTALL=" $ALL_PLATFORMS" ;;
  workbuddy|claude|codex|trae) TO_INSTALL=" $TARGET" ;;
  *) echo "未知 --target：$TARGET（可用：auto|workbuddy|claude|codex|trae|all）"; exit 1 ;;
esac

echo "目标平台：$TO_INSTALL"
echo ""
for p in $TO_INSTALL; do
  install_to "$p" "$(dir_for "$p")"
done
echo ""

if [ "$DRY_RUN" = "1" ]; then
  echo "（预览模式：未做任何改动。去掉 --dry-run 即实际安装）"
  exit 0
fi

echo "下一步 · 配置麦当劳 MCP Token（所有平台通用，只需一次）："
FIRST=""
for p in $TO_INSTALL; do
  d="$(dir_for "$p")"
  if [ -n "$d" ] && [ -z "$FIRST" ]; then FIRST="$d"; fi
done
echo "  node \"$FIRST/mcd-best-deal/scripts/setup-connector.mjs\""
echo ""
echo "完成后，在对应平台的对话里说「帮我算今天怎么吃麦当劳」即可使用。"
