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

// 对图片做一对一颜色替换，直接覆盖原文件
async function replaceColors(imgPath, pairs) {
  const normalized = imgPath.includes('/') ? imgPath : `images/${imgPath}`;
  const withExt    = path.extname(normalized) ? normalized : `${normalized}.png`;
  const absPath    = path.resolve(withExt);
  await fs.access(absPath);

  const args = [absPath];
  for (const { from, to, fuzz = 8 } of pairs) {
    args.push('-fuzz', `${fuzz}%`, '-fill', to, '-opaque', from);
  }
  args.push(absPath);
  await exec('magick', args);

  console.log(`✏️  已替换 ${path.basename(absPath)}:`);
  for (const { from, to } of pairs) console.log(`   ${from} → ${to}`);
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

  if (process.argv[2] === '--replace') {
    const imgArg   = process.argv[3];
    const pairArgs = process.argv.slice(4);
    if (!imgArg || pairArgs.length === 0) {
      console.error('用法: node theme.js --replace <文件名> <原色>/<新色> [<原色>/<新色> ...]');
      console.error('      颜色格式: #RRGGBB，可追加 :<fuzz%> 控制容差，默认 8%');
      console.error('      示例: node theme.js --replace keda-light #E0E0E0/#FFFFFF #F5F5F5/#FFFFFF:12');
      process.exit(1);
    }
    const pairs = pairArgs.map(p => {
      // 格式: #FROM/<fuzz>/#TO 或 #FROM/#TO 或 #FROM/#TO:<fuzz>
      const m = p.match(/^(#[0-9A-Fa-f]{6})(?::(\d+))?\/( #[0-9A-Fa-f]{6})(?::(\d+))?$/);
      // 简化格式: #FROM/#TO 或 #FROM/#TO:fuzz 或 #FROM:fuzz/#TO
      const m2 = p.match(/^(#[0-9A-Fa-f]{6})(?::(\d+))?\/( ?#[0-9A-Fa-f]{6})(?::(\d+))?$/);
      const parts = p.split('/');
      if (parts.length !== 2) {
        console.error(`❌ 无效颜色对: ${p}，格式应为 #RRGGBB/#RRGGBB`);
        process.exit(1);
      }
      const parseColor = s => {
        const cm = s.trim().match(/^(#[0-9A-Fa-f]{6})(?::(\d+))?$/);
        if (!cm) { console.error(`❌ 无效颜色: ${s}`); process.exit(1); }
        return { color: cm[1].toUpperCase(), fuzz: cm[2] ? parseInt(cm[2]) : null };
      };
      const fromParsed = parseColor(parts[0]);
      const toParsed   = parseColor(parts[1]);
      return { from: fromParsed.color, to: toParsed.color, fuzz: fromParsed.fuzz ?? toParsed.fuzz ?? 8 };
    });
    await replaceColors(imgArg, pairs);
    return;
  }

  const input  = process.argv[2];
  const target = process.argv[3]; // 'dark' | 'light'

  if (!input || !['dark', 'light'].includes(target)) {
    console.error('用法: node theme.js <文件名> <dark|light>');
    console.error('      node theme.js --analyze <文件名>');
    console.error('      node theme.js --replace <文件名> <原色>/<新色> [...]');
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
  // +level-colors 把暗端从 #000000 线性抬升到 #202124，亮端保持 #FFFFFF
  // light 图中 #E0E0E0 统一归白：source 为 light 时先替换再 negate；output 为 light 时 pipeline 末端替换
  const magickArgs = [sourceCopy];
  if (isSourceLight) magickArgs.push('-fuzz', '8%', '-fill', '#FFFFFF', '-opaque', '#E0E0E0');
  magickArgs.push('-negate', '-modulate', '100,100,200', '+level-colors', '#202124,#FFFFFF');
  if (!isSourceLight) magickArgs.push('-fuzz', '8%', '-fill', '#FFFFFF', '-opaque', '#E0E0E0');
  magickArgs.push(invertedFile);
  await exec('magick', magickArgs);

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
