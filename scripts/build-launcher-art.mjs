// Build-time only: pack supplied artwork as top-down BGR pixels for Win32 GDI.
// No remote images, image decoders, or new dependencies in the launcher runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'apps/launcher/assets');
await fs.mkdir(path.join(assets, 'packed'), { recursive: true });
async function pack(source, name, width, height, background) {
  const { data, info } = await sharp(source).resize(width, height, { fit: 'cover' })
    .flatten({ background }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) [data[i], data[i + 2]] = [data[i + 2], data[i]];
  const header = Buffer.alloc(8);
  header.writeUInt32LE(info.width, 0); header.writeUInt32LE(info.height, 4);
  await fs.writeFile(path.join(assets, 'packed', `${name}.bgra`), Buffer.concat([header, data]));
}
// Keep source aspect ratio: runtime performs the one and only cover crop.
await pack(path.join(assets, 'news-update.png'), 'hero', 1024, 1024, '#111513');
await pack(path.join(assets, 'news-map.png'), 'map', 128, 128, '#101211');
await pack(path.join(assets, 'avatar.png'), 'avatar', 112, 112, '#101211');
await pack(path.join(assets, 'wordmark.svg'), 'wordmark', 260, 90, '#080a08');
for (let rank = 1; rank <= 18; rank++) {
  const input = await sharp(path.join(root, `apps/web/public/ranks/${rank}.svg`))
    .resize(224, 88, { fit: 'contain', background: '#101211' }).png().toBuffer();
  await pack(input, `rank-${rank}`, 224, 88, '#101211');
}
console.log('Packed launcher hero, wordmark and 18 rank emblems.');
