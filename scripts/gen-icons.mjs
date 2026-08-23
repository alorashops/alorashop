// One-off script: generates valid PNG icons for the PWA manifest.
// Run with: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

// CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeIcon(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    rows[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // vertical gradient indigo -> violet, with a white "cash drawer" band
      const t = y / size;
      const band = y > size * 0.42 && y < size * 0.72;
      let r = Math.round(99 + (139 - 99) * t);
      let g = Math.round(102 + (92 - 102) * t);
      let b = Math.round(241 + (246 - 241) * t);
      if (band) { r = 255; g = 255; b = 255; }
      const idx = rowStart + 1 + x * 4;
      rows[idx] = r;
      rows[idx + 1] = g;
      rows[idx + 2] = b;
      rows[idx + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return png;
}

writeFileSync(join(publicDir, 'alora-icon-192.png'), makeIcon(192));
writeFileSync(join(publicDir, 'alora-icon-512.png'), makeIcon(512));
console.log('Icons generated: alora-icon-192.png, alora-icon-512.png');
