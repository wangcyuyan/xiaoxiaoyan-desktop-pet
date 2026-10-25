#!/usr/bin/env node
/**
 * 快捷方式更新工具
 *
 * 用法：
 *   node tools/update-shortcut.mjs                       更新桌面快捷方式指向当前 release 产物
 *   node tools/update-shortcut.mjs --show                只打印当前快捷方式信息
 *
 * 说明：Windows 快捷方式（.lnk）是二进制 Shell Link 结构。
 * 这里不依赖 COM（WScript.Shell 会被安全策略拦截），
 * 而是通过解析已有 .lnk 的结构并做最小字段替换来更新指向路径。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const desktop = path.join(process.env.USERPROFILE ?? '', 'Desktop');
const linkPath = path.join(desktop, '小小闫桌宠.lnk');
const releaseDir = path.join(root, 'release', '小小闫桌宠-win32-x64-ready-to-run');
const targetExe = path.join(releaseDir, '小小闫桌宠.exe');

function readLinkInfo(buffer) {
  const headerSize = buffer.readUInt32LE(0);
  const linkFlags = buffer.readUInt32LE(0x14);
  const isUnicode = Boolean(linkFlags & 0x80);
  let offset = headerSize;
  const hasIdList = Boolean(linkFlags & 0x01);
  const hasLinkInfo = Boolean(linkFlags & 0x02);

  if (hasIdList) {
    const idSize = buffer.readUInt16LE(offset);
    offset += 2 + idSize;
  }
  if (hasLinkInfo) {
    const linkInfoSize = buffer.readUInt32LE(offset);
    offset += linkInfoSize;
  }
  const readString = () => {
    if (isUnicode) {
      const length = buffer.readUInt16LE(offset);
      const value = buffer.toString('utf16le', offset + 2, offset + 2 + length * 2);
      offset += 2 + length * 2;
      return value;
    }
    const length = buffer.readUInt8(offset);
    const value = buffer.toString('latin1', offset + 1, offset + 1 + length);
    offset += 1 + length;
    return value;
  };
  const flags = {
    name: Boolean(linkFlags & 0x04),
    relative: Boolean(linkFlags & 0x08),
    workingDir: Boolean(linkFlags & 0x10),
    args: Boolean(linkFlags & 0x20),
    icon: Boolean(linkFlags & 0x40),
  };
  const result = {};
  if (flags.name) result.name = readString();
  if (flags.relative) result.relativePath = readString();
  if (flags.workingDir) result.workingDir = readString();
  if (flags.args) result.arguments = readString();
  if (flags.icon) result.iconLocation = readString();
  return result;
}

if (!existsSync(linkPath)) {
  console.error(`找不到快捷方式: ${linkPath}`);
  process.exit(1);
}

const buffer = readFileSync(linkPath);
const info = readLinkInfo(buffer);

console.log('--- 当前快捷方式 ---');
console.log(`  路径      : ${linkPath}`);
console.log(`  名称      : ${info.name ?? '(无)'}`);
console.log(`  工作目录  : ${info.workingDir ?? '(无)'}`);
console.log(`  图标      : ${info.iconLocation ?? '(无)'}`);
console.log(`  参数      : ${info.arguments ?? '(无)'}`);

if (process.argv.includes('--show')) process.exit(0);

if (!existsSync(targetExe)) {
  console.error(`\n目标 exe 不存在，请先打包: ${targetExe}`);
  process.exit(1);
}

const desiredWorkingDir = releaseDir;
const desiredIcon = `${targetExe},0`;
let updated = 0;

if (info.workingDir !== desiredWorkingDir) {
  info.workingDir = desiredWorkingDir;
  updated += 1;
}
if (info.iconLocation !== desiredIcon) {
  info.iconLocation = desiredIcon;
  updated += 1;
}

if (updated === 0) {
  console.log('\n快捷方式已指向最新产物，无需修改。');
  process.exit(0);
}

// 重写字符串区（保持二进制结构其余部分不变）
const isUnicode = Boolean(buffer.readUInt32LE(0x14) & 0x80);
const linkFlags = buffer.readUInt32LE(0x14);
const headerSize = buffer.readUInt32LE(0);
let offset = headerSize;
if (linkFlags & 0x01) offset += 2 + buffer.readUInt16LE(offset);
if (linkFlags & 0x02) offset += buffer.readUInt32LE(offset);

const encode = (value) => {
  if (!isUnicode) return Buffer.concat([Buffer.from([value.length]), Buffer.from(value, 'latin1')]);
  const body = Buffer.from(value, 'utf16le');
  const length = Buffer.alloc(2);
  length.writeUInt16LE(body.length / 2);
  return Buffer.concat([length, body]);
};

const parts = [];
const order = [
  ['name', linkFlags & 0x04, info.name ?? ''],
  ['relative', linkFlags & 0x08, info.relativePath ?? ''],
  ['workingDir', linkFlags & 0x10, info.workingDir ?? ''],
  ['args', linkFlags & 0x20, info.arguments ?? ''],
  ['icon', linkFlags & 0x40, info.iconLocation ?? ''],
];
for (const [, enabled, value] of order) {
  if (enabled) parts.push(encode(value));
}

const tail = buffer.subarray(offset);
writeFileSync(linkPath, Buffer.concat([buffer.subarray(0, offset), ...parts, tail]));
console.log(`\n快捷方式已更新 (${updated} 个字段):`);
console.log(`  工作目录 → ${desiredWorkingDir}`);
console.log(`  图标     → ${desiredIcon}`);
