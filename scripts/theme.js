/*
 * @Date: 2026-06-11 19:53:08
 * @Author: monet.Lo
 * @LastEditors: monet.Lo
 * @LastEditTime: 2026-06-11 22:40:00
 * @FilePath: /blog-assets/scripts/theme.js
 * @description: 通过 ImageMagick 仅映射近灰度像素，配合 color-map.json 输出 -light/-dark 双版本
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const os   = require('os');
const path = require('path');
const fs   = require('fs/promises');

const exec = promisify(execFile);

// 绝对色差阈值：max(R,G,B) - min(R,G,B) < 此值视为"近灰度"，用绝对色差而非 HSL 饱和度
const CHROMA_THRESHOLD = 0.08;

const CONFIG_FILE = path.join(__dirname, 'color-map.json');

const DEFAULT_MAP = {
  lightToDark: [
    { from: '#000000', to: '#E8E8E8' },
    { from: '#FFFFFF', to: '#21252C' },
  ],
  darkToLight: [
    { from: '#000000', to: '#FAFAFA' },
    { from: '#FFFFFF', to: '#1A1A1A' },
  ],
};

async function loadColorMap() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    return { map: JSON.parse(raw), fromFile: true };
  } catch {
    return { map: DEFAULT_MAP, fromFile: false };
  }
}

// 取 hex 颜色的亮度均值，用于对 stops 排序
function hexBrightness(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r + g + b) / 3;
}

// light→dark 背景减除：消除彩色文字的白色光晕
// new = u + min(R,G,B) * (bg_avg - 1)，单次 -fx 同时处理三通道，避免顺序修改导致的 min 偏差
function bgSubFx(bgHex) {
  const r = parseInt(bgHex.slice(1, 3), 16) / 255;
  const g = parseInt(bgHex.slice(3, 5), 16) / 255;
  const b = parseInt(bgHex.slice(5, 7), 16) / 255;
  return `u + min(r,min(g,b)) * (${((r + g + b) / 3).toFixed(6)} - 1)`;
}

// 把 stops 拼成 256px 宽的 CLUT 临时文件：
// 每段用 gradient:A-B 生成，各段长度按 from-亮度位置划分，+append 后正好 256px
// 避免 sparse-color Barycentric 在 1D 共线点上矩阵奇异的问题
async function buildClutFile(sorted) {
  const clutFile = path.join(os.tmpdir(), `theme-clut-${process.pid}.png`);
  const args = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = Math.round(hexBrightness(sorted[i].from));
    const p1 = Math.round(hexBrightness(sorted[i + 1].from));
    const isLast = i === sorted.length - 2;
    const width  = isLast ? (p1 - p0 + 1) : (p1 - p0);
    args.push('(', '-size', `${width}x1`, `gradient:${sorted[i].to}-${sorted[i + 1].to}`, ')');
  }
  await exec('magick', [...args, '+append', clutFile]);
  return clutFile;
}

// 近灰度区域：CLUT 多段映射（所有 stop 均生效）
// 彩色区域（light→dark）：背景减除（消除白色光晕）
// 两者通过色度遮罩合成
async function invertGrayscaleRegions(input, output, stops, isSourceLight) {
  const sorted     = [...stops].sort((a, b) => hexBrightness(a.from) - hexBrightness(b.from));
  const chromaMask = `(max(max(r,g),b) - min(min(r,g),b)) < ${CHROMA_THRESHOLD} ? 1 : 0`;
  const clutFile   = await buildClutFile(sorted);

  try {
    if (isSourceLight) {
      const bgHex = sorted[sorted.length - 1].to;
      await exec('magick', [
        input,
        '(', '+clone', '-channel', 'RGB', '-fx', bgSubFx(bgHex), '+channel', ')', // [1] 背景减除
        '(', '-clone', '0', clutFile, '-clut', ')',                                 // [2] CLUT 灰度映射
        '(', '-clone', '0', '-alpha', 'off', '-fx', chromaMask, ')',               // [3] 遮罩
        '-delete', '0',
        '-compose', 'Over', '-composite',
        output
      ]);
    } else {
      await exec('magick', [
        input,
        '(', '+clone', clutFile, '-clut', ')',                                      // [1] CLUT 灰度映射
        '(', '-clone', '0', '-alpha', 'off', '-fx', chromaMask, ')',               // [2] 遮罩
        '-compose', 'Over', '-composite',
        output
      ]);
    }
  } finally {
    await fs.unlink(clutFile).catch(() => {});
  }
}

async function main() {
  const input  = process.argv[2];
  const target = process.argv[3]; // 'dark' | 'light'

  if (!input || !['dark', 'light'].includes(target)) {
    console.error('用法: node theme.js <文件名> <dark|light>');
    process.exit(1);
  }

  // 只传文件名时自动补 images/ 目录和 .png 扩展名
  const normalized = input.includes('/') ? input : `images/${input}`;
  const withExt    = path.extname(normalized) ? normalized : `${normalized}.png`;
  const absInput   = path.resolve(withExt);
  await fs.access(absInput);

  const { map: colorMap, fromFile } = await loadColorMap();
  const parsed = path.parse(absInput);

  // target 是目标主题，source 是原图主题（相反）
  const isSourceLight = target === 'dark';
  const sourceSuffix  = isSourceLight ? '-light' : '-dark';
  const stops         = isSourceLight ? colorMap.lightToDark : colorMap.darkToLight;

  // 去掉文件名中已有的 -light/-dark 后缀，避免重复叠加
  const baseName     = parsed.name.replace(/-(light|dark)$/, '');
  const sourceCopy   = path.join(parsed.dir, `${baseName}${sourceSuffix}${parsed.ext}`);
  const invertedFile = path.join(parsed.dir, `${baseName}-${target}${parsed.ext}`);

  await fs.rename(absInput, sourceCopy);
  await invertGrayscaleRegions(sourceCopy, invertedFile, stops, isSourceLight);

  console.log(`🎨 颜色配置: ${fromFile ? CONFIG_FILE : '内置默认值'}`);
  console.log(`📋 原图副本: ${sourceCopy}`);
  console.log(`✨ 目标版本: ${invertedFile}`);
}

main().catch(err => {
  if (err.code === 'ENOENT' && /magick/.test(err.message || '')) {
    console.error('❌ 未找到 magick 命令，请先执行: brew install imagemagick');
  } else {
    console.error('❌ 处理失败:', err.message || err);
  }
  process.exit(1);
});
