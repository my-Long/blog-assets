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
const path = require('path');
const fs = require('fs/promises');

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

async function detectSourceTheme(input) {
  const { stdout } = await exec('magick', [
    input,
    '-colorspace', 'Gray',
    '-format', '%[fx:mean*255]',
    'info:'
  ]);
  return parseFloat(stdout.trim()) > 128 ? 'light' : 'dark';
}

// 仅对近灰度区域做色阶映射，彩色像素原样保留
// stops 按 from 亮度排序后取首尾作为 +level-colors 端点：black→stops[0].to，white→stops[last].to
// +level-colors 在端点间平滑插值，消除抗锯齿描边伪影
async function invertGrayscaleRegions(input, output, stops) {
  const sorted = [...stops].sort((a, b) => hexBrightness(a.from) - hexBrightness(b.from));
  const levelColors = `${sorted[0].to},${sorted[sorted.length - 1].to}`;

  await exec('magick', [
    input,
    '(', '+clone', '-channel', 'RGB', '+level-colors', levelColors, '+channel', ')',
    '(', '-clone', '0', '-alpha', 'off',
      '-fx', `(max(max(r,g),b) - min(min(r,g),b)) < ${CHROMA_THRESHOLD} ? 1 : 0`,
    ')',
    '-compose', 'Over', '-composite',
    output
  ]);
}

async function main() {
  const input  = process.argv[2];
  const target = process.argv[3]; // 'dark' | 'light'

  if (!input || !['dark', 'light'].includes(target)) {
    console.error('用法: node theme.js <path/to/image> <dark|light>');
    process.exit(1);
  }

  const absInput = path.resolve(input);
  await fs.access(absInput);

  const { map: colorMap, fromFile } = await loadColorMap();
  const parsed = path.parse(absInput);

  // target 是目标主题，source 是原图主题（相反）
  const isSourceLight = target === 'dark';
  const sourceSuffix  = isSourceLight ? '-light' : '-dark';
  const stops         = isSourceLight ? colorMap.lightToDark : colorMap.darkToLight;

  const sourceCopy   = path.join(parsed.dir, `${parsed.name}${sourceSuffix}${parsed.ext}`);
  const invertedFile = path.join(parsed.dir, `${parsed.name}-${target}${parsed.ext}`);

  await fs.rename(absInput, sourceCopy);
  await invertGrayscaleRegions(sourceCopy, invertedFile, stops);

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
