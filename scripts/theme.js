/*
 * @Date: 2026-06-11 19:53:08
 * @Author: monet.Lo
 * @LastEditors: monet.Lo
 * @LastEditTime: 2026-06-12 00:00:00
 * @FilePath: /blog-assets/scripts/theme.js
 * @description: 通过 ImageMagick -negate + hue-rotate 180° 生成 -light/-dark 双版本
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs   = require('fs/promises');

const exec = promisify(execFile);

// 分析图片主色，输出颜色分布
async function analyzeImage(imgPath) {
  const normalized = imgPath.includes('/') ? imgPath : `images/${imgPath}`;
  const withExt    = path.extname(normalized) ? normalized : `${normalized}.png`;
  const absPath    = path.resolve(withExt);
  await fs.access(absPath);

  const { stdout } = await exec('magick', [absPath, '-format', '%c', 'histogram:info:-']);

  const entries = [];
  for (const line of stdout.trim().split('\n')) {
    const m = line.match(/^\s*(\d+):\s*\(\d+,\d+,\d+\)\s+#([0-9A-Fa-f]{6})/);
    if (m) entries.push({ count: parseInt(m[1]), hex: '#' + m[2].toUpperCase() });
  }

  entries.sort((a, b) => b.count - a.count);
  const top   = entries.slice(0, 15);
  const total = entries.reduce((s, e) => s + e.count, 0);

  console.log(`\n📊 ${path.basename(absPath)} 颜色分析 (前 ${top.length} 名):\n`);
  console.log('  像素数      占比    Hex');
  console.log('  ───────────────────────');
  for (const { count, hex } of top) {
    const pct = ((count / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${String(count).padStart(8)}   ${pct}%   ${hex}`);
  }
}

async function main() {
  if (process.argv[2] === '--analyze') {
    const imgArg = process.argv[3];
    if (!imgArg) {
      console.error('用法: node theme.js --analyze <文件名>');
      process.exit(1);
    }
    await analyzeImage(imgArg);
    return;
  }

  const input  = process.argv[2];
  const target = process.argv[3]; // 'dark' | 'light'

  if (!input || !['dark', 'light'].includes(target)) {
    console.error('用法: node theme.js <文件名> <dark|light>');
    console.error('      node theme.js --analyze <文件名>');
    process.exit(1);
  }

  const normalized = input.includes('/') ? input : `images/${input}`;
  const withExt    = path.extname(normalized) ? normalized : `${normalized}.png`;
  const absInput   = path.resolve(withExt);
  await fs.access(absInput);

  const parsed       = path.parse(absInput);
  const isSourceLight = target === 'dark';
  const sourceSuffix  = isSourceLight ? '-light' : '-dark';
  const baseName      = parsed.name.replace(/-(light|dark)$/, '');
  const sourceCopy    = path.join(parsed.dir, `${baseName}${sourceSuffix}${parsed.ext}`);
  const invertedFile  = path.join(parsed.dir, `${baseName}-${target}${parsed.ext}`);

  await fs.rename(absInput, sourceCopy);

  // invert + hue-rotate 180°：黑白互换，彩色基本保留
  // -level-colors 把暗端从 #000000 线性抬升到 #202124，亮端保持 #FFFFFF
  await exec('magick', [sourceCopy, '-negate', '-modulate', '100,100,200',
    '+level-colors', '#202124,#FFFFFF', invertedFile]);

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
