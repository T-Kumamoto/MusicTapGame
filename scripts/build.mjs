// スマホ配布用のファイルセットを作る。
//   node scripts/build.mjs
// dist/MusicTapGame/ にアプリ本体だけ(テスト・開発用スクリプト・node_modules を除く)をコピーし、
// dist/MusicTapGame-web.zip にまとめる。https で配信できる静的サーバーならどこに置いても動く。

import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'MusicTapGame');
const zipPath = join(root, 'dist', 'MusicTapGame-web.zip');

const INCLUDE = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'songs'];
const SKIP = new Set(['README.md']);

async function walk(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return [path];
  const out = [];
  for (const name of await readdir(path)) out.push(...(await walk(join(path, name))));
  return out;
}

const files = [];
for (const entry of INCLUDE) {
  for (const abs of await walk(join(root, entry))) {
    const rel = relative(root, abs).split(sep).join('/');
    if (!SKIP.has(rel.split('/').pop())) files.push(rel);
  }
}
files.sort();

// Service Worker のキャッシュ対象に漏れがないか確かめる(漏れるとオフラインで起動しない)
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.matchAll(/'([^']+\.(?:html|css|js|png|webmanifest))'/g)].map((m) => m[1]);
const missing = shell.filter((f) => !files.includes(f));
const uncached = files.filter((f) => /\.(js|css|html)$/.test(f) && f !== 'sw.js' && !shell.includes(f));
if (missing.length || uncached.length) {
  console.error('sw.js の SHELL と実ファイルが食い違っています');
  if (missing.length) console.error('  存在しない:', missing.join(', '));
  if (uncached.length) console.error('  キャッシュされない:', uncached.join(', '));
  process.exit(1);
}

await rm(join(root, 'dist'), { recursive: true, force: true });
const entries = [];
for (const rel of files) {
  const data = await readFile(join(root, rel));
  const dest = join(outDir, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, data);
  entries.push({ name: `MusicTapGame/${rel}`, data });
}
await writeFile(zipPath, zip(entries));

const total = entries.reduce((s, e) => s + e.data.length, 0);
console.log(`${entries.length} files, ${(total / 1024).toFixed(0)} KB`);
console.log(`→ ${relative(root, outDir)}/`);
console.log(`→ ${relative(root, zipPath)} (${((await stat(zipPath)).size / 1024).toFixed(0)} KB)`);

// ---- 無圧縮 zip(外部ライブラリなしで作るため)----

function zip(items) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { date, time } = dosTime(new Date());
  for (const { name, data } of items) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // ファイル名は UTF-8
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, data);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function crc32(buf) {
  // 関数宣言は巻き上げられるので、本体より前に呼ばれても使えるよう表は関数に持たせる
  const crcTable = (crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
