#!/usr/bin/env bash
# mcd-best-deal · 基础自检（结构 + 语法 + frontmatter + JSON 合法性）
# 用法：bash test.sh   （可在任意目录执行）

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR/skill/mcd-best-deal"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); echo "  [PASS] $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  [FAIL] $1"; }

check_file() { [ -f "$1" ] && ok "存在 $2" || bad "缺少 $2（$1）"; }

echo "== 1. 必需文件 =="
check_file "$SCRIPT_DIR/README.md" "README.md"
check_file "$SCRIPT_DIR/CONTEST_DECLARATION.md" "CONTEST_DECLARATION.md"
check_file "$SCRIPT_DIR/MCP_INTEGRATION.md" "MCP_INTEGRATION.md"
check_file "$SCRIPT_DIR/LICENSE" "LICENSE"
check_file "$SCRIPT_DIR/CHANGELOG.md" "CHANGELOG.md"
check_file "$SCRIPT_DIR/llms.txt" "llms.txt"
check_file "$SKILL_DIR/SKILL.md" "skill/SKILL.md"
check_file "$SKILL_DIR/config/rules.json" "config/rules.json"
check_file "$SKILL_DIR/install.sh" "install.sh"

echo "== 2. 脚本语法 =="
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ]; then
  for f in "$SKILL_DIR"/scripts/*.mjs "$SKILL_DIR"/scripts/lib/*.mjs; do
    if "$NODE_BIN" --check "$f" >/dev/null 2>&1; then
      ok "语法 $(basename "$f")"
    else
      bad "语法 $(basename "$f")"
    fi
  done
else
  echo "  [SKIP] 未找到 node，跳过 JS 语法检查"
fi
if bash -n "$SKILL_DIR/install.sh"; then ok "语法 install.sh"; else bad "语法 install.sh"; fi

echo "== 3. SKILL.md frontmatter =="
FRONT="$(awk '/^---$/{n++; next} n==1{print} n==2{exit}' "$SKILL_DIR/SKILL.md")"
echo "$FRONT" | grep -q "^name:" && ok "frontmatter: name" || bad "frontmatter: name"
echo "$FRONT" | grep -q "^description:" && ok "frontmatter: description" || bad "frontmatter: description"
echo "$FRONT" | grep -q "agent_created: true" && ok "frontmatter: agent_created" || bad "frontmatter: agent_created"

echo "== 4. JSON 配置合法性 =="
if [ -n "$NODE_BIN" ]; then
  if (cd "$SKILL_DIR" && "$NODE_BIN" -e "JSON.parse(require('fs').readFileSync('config/rules.json','utf8'))" >/dev/null 2>&1); then
    ok "rules.json 合法"
  else
    bad "rules.json 非法"
  fi
fi

echo
echo "结果：PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "全部通过"
else
  echo "存在失败项"
  exit 1
fi
