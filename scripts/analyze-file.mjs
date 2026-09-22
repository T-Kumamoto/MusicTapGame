// 手元の mp3 で譜面生成を確かめる開発用スクリプト。
//   node scripts/analyze-file.mjs <曲.mp3> [--dump]
// 拍追跡の結果と、グリッド位置ごとの「強い音がある割合」を出す。
// 拍が合っていれば表拍 > 8分裏 > 16分 の順にはっきり差が出る。

import { readFile } from 'node:fs/promises';
import { MPEGDecoder } from 'mpg123-decoder';
import { analyze, downmix } from '../js/chart/analyze.js';
import { buildGrid, generateChart, DIFFICULTIES } from '../js/chart/generate.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/analyze-file.mjs <file.mp3>');
  process.exit(1);
}

const decoder = new MPEGDecoder();
await decoder.ready;
const { channelData, sampleRate } = decoder.decode(new Uint8Array(await readFile(path)));
decoder.free();

const t0 = performance.now();
const { samples, sampleRate: sr } = downmix(channelData, sampleRate);
const features = analyze(samples, sr);
const gridInfo = buildGrid(features);
const elapsed = performance.now() - t0;

const beats = features.beats;
const intervals = beats.slice(1).map((b, i) => b - beats[i]);
const bpms = intervals.map((d) => 60 / d).sort((a, b) => a - b);
const q = (p) => bpms[Math.floor(p * (bpms.length - 1))];

console.log(`duration ${features.duration.toFixed(1)}s, analyzed in ${elapsed.toFixed(0)}ms`);
console.log(`tempo: ${features.tempoMode}, bpm ${features.bpm} (local 10/50/90%: ${q(0.1).toFixed(1)} / ${q(0.5).toFixed(1)} / ${q(0.9).toFixed(1)})`);

const grid = gridInfo.grid.filter((g) => g.score > 0);
for (const thr of [1, 2]) {
  const share = (pos) => {
    const xs = grid.filter((g) => pos.includes(g.pos));
    return (xs.filter((g) => g.score > thr).length / xs.length).toFixed(2);
  };
  console.log(`score>${thr}: beat ${share([0])}  8th-off ${share([2])}  16th ${share([1, 3])}`);
}

for (const diff of Object.keys(DIFFICULTIES)) {
  const chart = generateChart(features, gridInfo, diff, 1);
  const types = chart.notes.reduce((m, n) => ((m[n.type] = (m[n.type] || 0) + 1), m), {});
  console.log(`${diff.padEnd(6)} Lv${String(chart.level).padStart(2)}  ${String(chart.notes.length).padStart(4)} notes  ${JSON.stringify(types)}`);
}
