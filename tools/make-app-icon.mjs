#!/usr/bin/env node
/**
 * 生成「小小闫桌宠」应用图标
 *
 * 用法：
 *   node tools/make-app-icon.mjs            生成 build/icon.png 与 build/icon.ico
 *
 * 设计：
 *   - 底：酒红 (#9B4351) → 深紫黑 (#2A1A2E) 斜向渐变圆角方块，取角色外套与发色
 *   - 主体：pet-head-01.png 裁出的头部半身像
 *   - 描边：沿用素材自带的白色贴纸描边（不再自行膨胀 alpha，
 *           自行膨胀会把素材的羽化边缘切成条纹杂点）
 *   - 融合：底部做线性渐隐，消掉人物被横切产生的硬边
 *   - 输出：16/24/32/48/64/128/256 多尺寸 .ico，供 Windows exe 内嵌
 *
 * 依赖：sharp（项目 devDependencies 已有 0.34.x）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const root = process.cwd();
const outDir = path.join(root, 'build');
const headSrc = path.join(root, 'src', 'assets', 'pet', 'pet-head-01.png');

/** Windows 图标所需的尺寸阶梯 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** 渲染基准分辨率，再由 sharp 缩放到各尺寸 */
const BASE = 512;

/** 从原画裁出头部（含肩颈，让主体在方形里有依托） */
const CROP = { left: 155, top: 95, width: 200, height: 215 };
/** 主体在图标中的占比与位置 */
const SUBJECT_H = 0.78;
const SUBJECT_TOP = 0.10;
/** 底部渐隐的高度占比（相对于主体高度），消掉横切硬边 */
const FADE_RATIO = 0.16;

/**
 * 生成主图（BASE×BASE RGBA）
 */
async function renderMaster() {
  const radius = Math.round(BASE * 0.22);

  // 1) 渐变底 + 光影（SVG 直出）
  const gradientSvg = Buffer.from(
    `<svg width="${BASE}" height="${BASE}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#9B4351"/>
          <stop offset="45%" stop-color="#6B2E42"/>
          <stop offset="100%" stop-color="#2A1A2E"/>
        </linearGradient>
        <radialGradient id="glow" cx="0.24" cy="0.16" r="0.78">
          <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.26"/>
          <stop offset="55%" stop-color="#FFFFFF" stop-opacity="0.05"/>
          <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="warm" cx="0.88" cy="0.92" r="0.55">
          <stop offset="0%" stop-color="#E8A85C" stop-opacity="0.24"/>
          <stop offset="100%" stop-color="#E8A85C" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${BASE}" height="${BASE}" rx="${radius}" ry="${radius}" fill="url(#g)"/>
      <rect width="${BASE}" height="${BASE}" rx="${radius}" ry="${radius}" fill="url(#glow)"/>
      <rect width="${BASE}" height="${BASE}" rx="${radius}" ry="${radius}" fill="url(#warm)"/>
    </svg>`,
  );

  const base = await sharp(gradientSvg).ensureAlpha().png().toBuffer();

  // 2) 主体：裁剪 + 缩放，并对底部做线性渐隐
  const subjectMeta = await sharp(headSrc).metadata();
  const subjectH = Math.round(BASE * SUBJECT_H);
  const subjectW = Math.round((CROP.width / CROP.height) * subjectH);
  if (CROP.left + CROP.width > subjectMeta.width || CROP.top + CROP.height > subjectMeta.height) {
    throw new Error('裁剪区域超出源图范围');
  }

  const subjectRaw = await sharp(headSrc)
    .extract(CROP)
    .resize({ width: subjectW, height: subjectH, fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 底部渐隐：从 fadeStart 行起，alpha 按线性比例衰减到 0
  const fadeHeight = Math.round(subjectH * FADE_RATIO);
  const fadeStart = subjectH - fadeHeight;
  const pixels = Buffer.from(subjectRaw.data);
  for (let y = fadeStart; y < subjectH; y += 1) {
    const t = (y - fadeStart) / fadeHeight; // 0 → 1
    const keep = 1 - t * t; // 二次缓出，顶部过渡更柔和
    for (let x = 0; x < subjectW; x += 1) {
      const i = (y * subjectW + x) * 4;
      pixels[i + 3] = Math.round(pixels[i + 3] * keep);
    }
  }

  const subject = await sharp(pixels, {
    raw: { width: subjectW, height: subjectH, channels: 4 },
  })
    .png()
    .toBuffer();

  // 3) 合成到底图上
  const left = Math.round((BASE - subjectW) / 2);
  const top = Math.round(BASE * SUBJECT_TOP);

  return sharp(base)
    .composite([{ input: subject, left, top }])
    .png()
    .toBuffer();
}

/**
 * 把 PNG 缓冲编码为 Windows .ico（多尺寸，PNG 压缩条目）
 */
function encodeIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + dir.length;

  entries.forEach((entry, index) => {
    const base = index * 16;
    // 256 像素在目录项里写 0
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 0);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    dir.writeUInt8(0, base + 2); // 调色板数
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // color planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(entry.data.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((entry) => entry.data)]);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const master = await renderMaster();

  const pngPath = path.join(outDir, 'icon.png');
  await writeFile(pngPath, master);

  const entries = [];
  for (const size of ICO_SIZES) {
    const resized = await sharp(master)
      .resize({ width: size, height: size, fit: 'fill' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    entries.push({ size, data: resized });
  }

  const icoPath = path.join(outDir, 'icon.ico');
  await writeFile(icoPath, encodeIco(entries));

  console.log('图标已生成:');
  console.log(`  ${path.relative(root, pngPath)}  (${BASE}x${BASE})`);
  console.log(`  ${path.relative(root, icoPath)}  (${ICO_SIZES.join('/')})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
