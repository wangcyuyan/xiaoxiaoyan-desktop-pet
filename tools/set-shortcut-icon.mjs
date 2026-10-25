#!/usr/bin/env node
/**
 * 重写桌面快捷方式的图标字段，使其直接指向独立的 .ico 文件。
 *
 * 用法：
 *   node tools/set-shortcut-icon.mjs <ico路径>
 *
 * 背景：
 *   快捷方式的图标字段原本指向 exe（`xxx.exe,0`），依赖 exe 内嵌图标。
 *   改为直接指向 .ico 后，资源管理器会立刻重新读取，不受图标缓存影响，
 *   也不受 exe 重新打包导致的缓存过期拖延。
 *
 * 实现：不依赖 COM（WScript.Shell 与 Add-Type 均被安全策略拦截），
 *   解析 .lnk 的 Shell Link 结构，替换图标字符串后按原布局重写字符串区。
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const linkPath = path.join(process.env.USERPROFILE ?? '', 'Desktop', '小小闫桌宠.lnk');
const iconArg = process.argv[2];

if (!iconArg) {
  console.error('用法: node tools/set-shortcut-icon.mjs <ico路径>');
  process.exit(1);
}

const iconPath = path.resolve(iconArg);
const iconDir = path.join(process.env.USERPROFILE ?? '', 'Desktop', '.pet-icons');
const iconDest = path.join(iconDir, 'xiaoxiaoyan-pet.ico');

await mkdir(iconDir, { recursive: true });
await copyFile(iconPath, iconDest);

const buffer = await readFile(linkPath);

const headerSize = buffer.readUInt32LE(0);
const linkFlags = buffer.readUInt32LE(0x14);
const isUnicode = Boolean(linkFlags & 0x80);

let offset = headerSize;
if (linkFlags & 0x01) offset += 2 + buffer.readUInt16LE(offset);
if (linkFlags & 0x02) offset += buffer.readUInt32LE(offset);

const info = {};
/** 各字段在字符串区中消耗的字节数，用来算出原字符串区总长 */
const consumed = {};
const readString = (key) => {
  const start = offset;
  let value;
  if (isUnicode) {
    const length = buffer.readUInt16LE(offset);
    value = buffer.toString('utf16le', offset + 2, offset + 2 + length * 2);
    offset += 2 + length * 2;
  } else {
    const length = buffer.readUInt8(offset);
    value = buffer.toString('latin1', offset + 1, offset + 1 + length);
    offset += 1 + length;
  }
  consumed[key] = offset - start;
  return value;
};

if (linkFlags & 0x04) info.name = readString('name');
if (linkFlags & 0x08) info.relativePath = readString('relative');
if (linkFlags & 0x10) info.workingDir = readString('workingDir');
if (linkFlags & 0x20) info.arguments = readString('args');
if (linkFlags & 0x40) info.iconLocation = readString('icon');

/** 原字符串区总字节数 */
const oldAreaLength = Object.values(consumed).reduce((sum, n) => sum + n, 0);
/** 原字符串区之后（ExtraData / terminal block）的起点 */
const tailStart = offset;

if (!(linkFlags & 0x40)) {
  console.error('该快捷方式没有图标字段（linkFlags 缺少 0x40），无法直接改写。');
  process.exit(2);
}

const desiredIcon = `${iconDest},0`;
if (info.iconLocation === desiredIcon) {
  console.log(`图标字段已是目标值，无需修改：\n  ${desiredIcon}`);
  process.exit(0);
}

/**
 * 等长替换图标字符串。
 *
 * Shell Link 的字符串区后面紧跟 ExtraData / terminal block 等结构，
 * 这些结构里可能带有绝对偏移量。改变字符串区长度会整体错位，
 * 导致后续字段被读成乱码。所以这里保持字符串区总字节数不变：
 * 新字符串更短时，用零字节填充剩余空间。
 */
const encode = (value) => {
  if (!isUnicode) {
    return Buffer.concat([Buffer.from([value.length]), Buffer.from(value, 'latin1')]);
  }
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
  ['icon', linkFlags & 0x40, desiredIcon],
];
for (const [, enabled, value] of order) {
  if (enabled) parts.push(encode(value));
}

const newStringArea = Buffer.concat(parts);

if (newStringArea.length > oldAreaLength) {
  console.error(
    `新图标路径比原路径更长（${newStringArea.length} > ${oldAreaLength} 字节），\n` +
      '为保持 .lnk 结构偏移不变，无法等长替换。请改用更短的图标路径。',
  );
  process.exit(3);
}

// 等长：新字符串区 + 零填充，补齐到原长度，保证 tail（ExtraData）起点不变
const padded = Buffer.concat([newStringArea, Buffer.alloc(oldAreaLength - newStringArea.length)]);

const tail = buffer.subarray(tailStart);
await writeFile(linkPath, Buffer.concat([buffer.subarray(0, offset - oldAreaLength), padded, tail]));

console.log('快捷方式图标已更新:');
console.log(`  ${info.iconLocation ?? '(无)'}`);
console.log(`  → ${desiredIcon}`);
console.log(`  图标文件已复制到: ${iconDest}`);
console.log(`  字符串区保持等长（原 ${oldAreaLength} 字节，新 ${newStringArea.length} 字节 + 零填充）`);
console.log(`  文件总长 ${buffer.length} → ${buffer.length - oldAreaLength + newStringArea.length + (oldAreaLength - newStringArea.length)}`);
