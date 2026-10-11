# mcd-best-deal · 一键安装脚本（Windows PowerShell）
#
# 把本技能复制到各 AI 平台的 skills 目录（WorkBuddy / Claude Code / Codex / Trae，
# 以及任何支持 Agent Skills 标准（.agents/skills/）的工具）。
#
# 用法（在 PowerShell 中）：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Target workbuddy
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Target all
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun     # 预览
#
# 说明：
#   - 安装 = 把本目录（SKILL.md / scripts / config）复制到 <平台目录>\mcd-best-deal
#   - Token 配置在安装后运行 scripts\setup-connector.mjs 完成（所有平台通用，只需一次）
#   - 重复运行本脚本 = 更新到最新版本

param(
  [string]$Target = "auto",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }

function Get-PlatformDir([string]$Name) {
  switch ($Name) {
    "workbuddy" { Join-Path $HomeDir ".workbuddy\skills" }
    "claude"    { Join-Path $HomeDir ".claude\skills" }
    "codex"     { Join-Path $HomeDir ".agents\skills" }
    "trae"      { Join-Path $HomeDir ".trae-cn\skills" }
    default     { "" }
  }
}

function Test-PlatformPresent([string]$Name) {
  switch ($Name) {
    "workbuddy" { Test-Path (Join-Path $HomeDir ".workbuddy") }
    "claude"    { (Test-Path (Join-Path $HomeDir ".claude")) -or (Test-Path (Join-Path $HomeDir ".claude.json")) }
    "codex"     { (Test-Path (Join-Path $HomeDir ".codex")) -or (Test-Path (Join-Path $HomeDir ".agents")) }
    "trae"      { (Test-Path (Join-Path $HomeDir ".trae-cn")) -or (Test-Path (Join-Path $HomeDir ".trae")) }
    default     { $false }
  }
}

function Install-To([string]$Name, [string]$Dir) {
  if (-not $Dir) {
    Write-Host "  [跳过] $Name：未知目标目录"
    return
  }
  if ($DryRun) {
    Write-Host "  [预览] $Name -> $Dir\mcd-best-deal"
    return
  }
  try {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $targetPath = Join-Path $Dir "mcd-best-deal"
    if (Test-Path $targetPath) { Remove-Item -Recurse -Force $targetPath }
    Copy-Item -Recurse -Force $ScriptDir $targetPath
    $gitDir = Join-Path $targetPath ".git"
    if (Test-Path $gitDir) { Remove-Item -Recurse -Force $gitDir }
    Write-Host "  [完成] $Name -> $targetPath"
  } catch {
    Write-Host "  [失败] $Name：$($_.Exception.Message)"
  }
}

Write-Host "麦麦最优方案（mcd-best-deal）· 一键安装"
Write-Host "源目录：$ScriptDir"
Write-Host ""

$AllPlatforms = @("workbuddy", "claude", "codex", "trae")
$ToInstall = @()

switch ($Target) {
  "auto" {
    foreach ($p in $AllPlatforms) {
      if (Test-PlatformPresent $p) { $ToInstall += $p }
    }
    if ($ToInstall.Count -eq 0) {
      Write-Host "未检测到已知平台（WorkBuddy / Claude Code / Codex / Trae）。"
      Write-Host "可选做法："
      Write-Host "  1) 指定平台安装：install.ps1 -Target claude"
      Write-Host "  2) 手动复制：把本目录复制到目标平台的 skills 目录（见 README「安装」一节）"
      exit 0
    }
  }
  "all" { $ToInstall = $AllPlatforms }
  { @("workbuddy", "claude", "codex", "trae") -contains $_ } { $ToInstall = @($Target) }
  default {
    Write-Host "未知 -Target：$Target（可用：auto|workbuddy|claude|codex|trae|all）"
    exit 1
  }
}

Write-Host ("目标平台：" + ($ToInstall -join " "))
Write-Host ""
foreach ($p in $ToInstall) {
  Install-To $p (Get-PlatformDir $p)
}
Write-Host ""

if ($DryRun) {
  Write-Host "（预览模式：未做任何改动。去掉 -DryRun 即实际安装）"
  exit 0
}

$FirstDir = ""
foreach ($p in $ToInstall) {
  $d = Get-PlatformDir $p
  if ($d) { $FirstDir = $d; break }
}
Write-Host "下一步 · 配置麦当劳 MCP Token（所有平台通用，只需一次）："
Write-Host "  node `"$FirstDir\mcd-best-deal\scripts\setup-connector.mjs`""
Write-Host ""
Write-Host "完成后，在对应平台的对话里说「帮我算今天怎么吃麦当劳」即可使用。"
