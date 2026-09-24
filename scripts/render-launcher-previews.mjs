// Convert memory-only GDI test output to reviewable PNGs. Does not capture the desktop.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const directory = path.resolve(process.argv[2] ?? '.artifacts/launcher-ui-0.2.21');
for (const name of await fs.readdir(directory)) {
  if (!name.endsWith('.bgra')) continue;
  const source = await fs.readFile(path.join(directory, name));
  const width = source.readUInt32LE(0), height = source.readUInt32LE(4);
  if (source.length !== 8+width*height*4) throw new Error(`Invalid bitmap: ${name}`);
  const rgb = Buffer.alloc(width*height*3);
  for (let i = 0; i < width*height; i++) {
    rgb[i*3] = source[8+i*4+2]; rgb[i*3+1] = source[8+i*4+1]; rgb[i*3+2] = source[8+i*4];
  }
  await sharp(rgb, { raw: { width, height, channels:3 } }).png().toFile(path.join(directory, name.replace('.bgra','.png')));
}
console.log(`Converted off-screen launcher previews in ${directory}`);
