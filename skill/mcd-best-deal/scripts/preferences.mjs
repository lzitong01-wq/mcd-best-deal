#!/usr/bin/env node
// mcd-best-deal · 用户偏好管理
// 读取/写入 ~/.mcd-best-deal/preferences.json。
// 首次使用时由 Agent 引导确认（问 3-4 个问题），之后可随时更改；
// plan.mjs 会在每次计算时自动读取并生效（忌口排除 / 口味优先 / 默认模式）。
//
// 用法：
//   node scripts/preferences.mjs show
//   node scripts/preferences.mjs set --avoid 香菜,洋葱 --prefer 麦辣 --mode save --city 北京 --area 国贸
//   node scripts/preferences.mjs set --avoid ""            # 清空忌口
//   node scripts/preferences.mjs set --note "口味清淡，不吃辣"
//
// 字段说明：
//   avoidItems    忌口 / 不爱吃（商品名包含即排除）
//   preferItems   偏好口味（匹配的商品在候选中优先）
//   defaultMode   默认模式 save|healthy|easy（用户未指定模式时使用）
//   homeCity      常用城市（collect 未指定 --city 时的默认值）
//   homeArea      常用商圈/地标（collect 未指定 --keyword 时的默认值）
//   note          自由备注（自然语言，供 Agent 展示时参考）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { preferencesPath, loadPreferences } from './lib/util.mjs';

function fail(message) {
  throw new Error(message);
}

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

const FIELD_KEYS = { '--avoid': 'avoid', '--prefer': 'prefer', '--mode': 'mode', '--city': 'city', '--area': 'area', '--note': 'note' };

function parseArgs(argv) {
  const command = argv[0];
  if (command === '--help' || command === '-h') return { command: 'help' };
  if (command !== 'show' && command !== 'set') {
    fail('用法：node scripts/preferences.mjs show | set [--avoid ...] [--prefer ...] [--mode save|healthy|easy] [--city ...] [--area ...] [--note ...]');
  }
  const changes = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!(key in FIELD_KEYS)) fail(`未知参数：${key}（可用：${Object.keys(FIELD_KEYS).join(' ')}）`);
    const value = argv[++index];
    if (value === undefined) fail(`${key} 缺少值（清空请传空字符串 ""）`);
    changes[FIELD_KEYS[key]] = value;
  }
  if (command === 'set' && !Object.keys(changes).length) {
    fail('set 至少需要提供一个字段（--avoid/--prefer/--mode/--city/--area/--note）');
  }
  return { command, changes };
}

const splitList = (value) => String(value).split(/[,，;；、]/).map((item) => item.trim()).filter(Boolean);

async function readRaw(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    line('用法：node scripts/preferences.mjs show | set [选项]');
    line('  show                        查看当前偏好');
    line('  set --avoid 香菜,洋葱        设置忌口（空字符串清空）');
    line('      --prefer 麦辣           设置偏好口味');
    line('      --mode save|healthy|easy  设置默认模式');
    line('      --city 北京 --area 国贸   设置常用位置');
    line('      --note "口味清淡"        自由备注');
    line(`  存储位置：${preferencesPath()}`);
    return;
  }

  const file = preferencesPath();

  if (options.command === 'show') {
    const prefs = await loadPreferences();
    line(`当前用户偏好（${file}）：`);
    line(`  忌口/不爱吃   ：${prefs.avoidItems.join('、') || '（未设置）'}`);
    line(`  偏好口味     ：${prefs.preferItems.join('、') || '（未设置）'}`);
    line(`  默认模式     ：${prefs.defaultMode ?? '（未设置，默认 save）'}`);
    line(`  常用位置     ：${[prefs.homeCity, prefs.homeArea].filter(Boolean).join(' ') || '（未设置）'}`);
    line(`  备注         ：${prefs.note ?? '（无）'}`);
    return;
  }

  // set
  const raw = await readRaw(file);
  const changes = options.changes;
  const applied = [];
  if ('avoid' in changes) {
    const list = splitList(changes.avoid);
    if (list.length) raw.avoidItems = list;
    else delete raw.avoidItems;
    applied.push(`忌口=${list.join('、') || '(清空)'}`);
  }
  if ('prefer' in changes) {
    const list = splitList(changes.prefer);
    if (list.length) raw.preferItems = list;
    else delete raw.preferItems;
    applied.push(`偏好=${list.join('、') || '(清空)'}`);
  }
  if ('mode' in changes) {
    const mode = changes.mode.trim();
    if (!['save', 'healthy', 'easy'].includes(mode)) fail('--mode 只能是 save / healthy / easy');
    raw.defaultMode = mode;
    applied.push(`默认模式=${mode}`);
  }
  if ('city' in changes) {
    const value = changes.city.trim();
    if (value) raw.homeCity = value;
    else delete raw.homeCity;
    applied.push(`常用城市=${value || '(清空)'}`);
  }
  if ('area' in changes) {
    const value = changes.area.trim();
    if (value) raw.homeArea = value;
    else delete raw.homeArea;
    applied.push(`常用商圈=${value || '(清空)'}`);
  }
  if ('note' in changes) {
    const value = changes.note.trim();
    if (value) raw.note = value;
    else delete raw.note;
    applied.push(`备注=${value || '(清空)'}`);
  }

  raw.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  line('已更新：' + applied.join('；'));
  line(`（文件：${file}）`);
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`);
  process.exitCode = 1;
});
