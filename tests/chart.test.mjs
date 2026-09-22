// 譜面生成のテスト。BPM と拍位置が分かっている合成ドラムで検証する。
// 実行: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../js/chart/analyze.js';
import { buildGrid, generateChart, DIFFICULTIES, LANES } from '../js/chart/generate.js';
import { mulberry32 } from '../js/chart/generate.js';

const SR = 22050;

// キック(表拍)、スネア(2・4拍)、ハイハット(8分)、持続するベース
function drumLoop({ bpm, offset, seconds }) {
  const out = new Float32Array(Math.floor(SR * seconds));
  const rand = mulberry32(1);
  const beat = 60 / bpm;
  const add = (start, len, fn) => {
    const s0 = Math.floor(start * SR);
    for (let i = 0; i < len * SR && s0 + i < out.length; i++) out[s0 + i] += fn(i / SR);
  };
  for (let b = 0; offset + b * beat < seconds; b++) {
    const t = offset + b * beat;
    let phase = 0;
    add(t, 0.25, (x) => {
      phase += (2 * Math.PI * (50 + 90 * Math.exp(-x * 30))) / SR;
      return 0.9 * Math.sin(phase) * Math.exp(-x * 12);
    });
    if (b % 2 === 1) add(t, 0.15, (x) => 0.5 * (rand() * 2 - 1) * Math.exp(-x * 25));
    for (const h of [0, 0.5]) add(t + h * beat, 0.04, (x) => 0.15 * (rand() * 2 - 1) * Math.exp(-x * 90));
  }
  for (let i = 0; i < out.length; i++) out[i] += 0.1 * Math.sin((2 * Math.PI * 55 * i) / SR);
  return out;
}

function build(bpm, offset, seconds = 40) {
  const samples = drumLoop({ bpm, offset, seconds });
  const features = analyze(samples, SR);
  return { features, grid: buildGrid(features) };
}

for (const [bpm, offset] of [[128, 0.5], [96, 0.23], [174, 0.81]]) {
  test(`BPM ${bpm} と拍の位置を推定できる`, () => {
    const { features } = build(bpm, offset);
    assert.ok(Math.abs(features.bpm - bpm) / bpm < 0.01, `bpm=${features.bpm}`);
    const beat = 60 / bpm;
    let err = (features.firstBeat - offset) % beat;
    if (err > beat / 2) err -= beat;
    if (err < -beat / 2) err += beat;
    assert.ok(Math.abs(err) < 0.02, `phase error ${(err * 1000).toFixed(1)}ms`);
  });
}

test('難易度が上がるほどノーツが増え、最小間隔とレーン範囲を守る', () => {
  const { features, grid } = build(128, 0.5);
  let prevCount = 0;
  for (const diff of Object.keys(DIFFICULTIES)) {
    const chart = generateChart(features, grid, diff, 42);
    const notes = chart.notes;
    assert.ok(notes.length > prevCount, `${diff}: ${notes.length} notes`);
    prevCount = notes.length;

    const cfg = DIFFICULTIES[diff];
    const minGap = Math.max(cfg.minGapBeats * grid.beat, cfg.minGapSec) - 0.002;
    const times = [...new Set(notes.map((n) => n.t))].sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= minGap, `${diff} gap`);

    for (const n of notes) {
      assert.ok(n.lane >= 0 && n.lane < LANES);
      // 16分グリッド上にある
      const k = (n.t - features.firstBeat) / grid.step;
      assert.ok(Math.abs(k - Math.round(k)) < 0.01, `${diff} off-grid ${n.t}`);
    }
  }
});

test('ロングノーツの間、同じレーンにノーツが来ない', () => {
  const { features, grid } = build(128, 0.5);
  for (const diff of Object.keys(DIFFICULTIES)) {
    const notes = generateChart(features, grid, diff, 7).notes;
    for (const h of notes.filter((n) => n.type === 'hold')) {
      assert.ok(h.end > h.t);
      const clash = notes.find((n) => n !== h && n.lane === h.lane && n.t >= h.t && n.t <= h.end);
      assert.equal(clash, undefined, `${diff} hold at ${h.t} lane ${h.lane}`);
    }
  }
});

test('同じ曲・同じシードなら同じ譜面になる', () => {
  const { features, grid } = build(128, 0.5);
  const a = generateChart(features, grid, 'HARD', 99);
  const b = generateChart(features, grid, 'HARD', 99);
  assert.deepEqual(a, b);
});
