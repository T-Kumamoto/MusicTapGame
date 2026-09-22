// 解析済み特徴量から、拍グリッドに揃った譜面を難易度ごとに組み立てる。

import { percentile } from './analyze.js';

export const LANES = 5;

export const DIFFICULTIES = {
  EASY: { subdiv: 2, minGapBeats: 1, minGapSec: 0.36, nps: 1.4, chord: 0, hold: 0.12, flick: 0, maxStep: 1 },
  NORMAL: { subdiv: 2, minGapBeats: 0.5, minGapSec: 0.22, nps: 2.6, chord: 0.03, hold: 0.1, flick: 0.03, maxStep: 2 },
  HARD: { subdiv: 4, minGapBeats: 0.25, minGapSec: 0.12, nps: 4.4, chord: 0.08, hold: 0.08, flick: 0.06, maxStep: 2 },
  EXPERT: { subdiv: 4, minGapBeats: 0.25, minGapSec: 0.085, nps: 6.5, chord: 0.12, hold: 0.07, flick: 0.08, maxStep: 3 },
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// グリッド(16分)ごとに「ここにノーツを置く価値」を計算する。難易度に依らないので一度だけ。
export function buildGrid(features) {
  const { flux, rms, centroid, hopSec, frames, bpm, firstBeat, duration, frameTime } = features;
  const beat = 60 / bpm;
  const step = beat / 4;
  const timeToFrame = (sec) => Math.round((sec - frameTime(0)) / hopSec);

  // 帯域ごとに「周囲 3 秒の平均」で割って、局所的に目立つ立ち上がりだけを拾う
  const localMean = {};
  const radius = Math.round(1.5 / hopSec);
  for (const name of Object.keys(flux)) {
    localMean[name] = movingAverage(flux[name], radius);
    const floor = mean(flux[name]) * 0.3 + 1e-9;
    for (let i = 0; i < frames; i++) localMean[name][i] += floor;
  }

  // 盛り上がり: 4 秒平均の音量を曲中の 95 パーセンタイルで正規化
  const loud = movingAverage(rms, Math.round(2 / hopSec));
  const loudRef = percentile(loud, 0.95) + 1e-9;
  const rmsRef = percentile(rms, 0.95) + 1e-9;

  const sortedCentroid = Float32Array.from(centroid.filter((c) => c > 0)).sort();
  const centroidRank = (hz) => {
    if (!sortedCentroid.length) return 0.5;
    let lo = 0;
    let hi = sortedCentroid.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sortedCentroid[m] < hz) lo = m + 1;
      else hi = m;
    }
    return lo / sortedCentroid.length;
  };

  const weights = { low: 1.2, mid: 1.0, high: 0.75 };
  const win = Math.max(1, Math.round(0.03 / hopSec));
  const grid = [];
  for (let k = 0, t = firstBeat; t < duration - 0.3; k++, t = firstBeat + k * step) {
    const f = timeToFrame(t);
    if (f < 1 || f >= frames) continue;
    const strength = {};
    let score = 0;
    let peakFrame = f;
    for (const name of Object.keys(flux)) {
      let best = 0;
      for (let j = Math.max(1, f - win); j <= Math.min(frames - 1, f + win); j++) {
        const s = flux[name][j] / localMean[name][j];
        if (s > best) {
          best = s;
          if (name === 'mid') peakFrame = j;
        }
      }
      strength[name] = best;
      score = Math.max(score, best * weights[name]);
    }
    const level = Math.min(1.2, loud[f] / loudRef);
    const quiet = rms[f] / rmsRef < 0.02;
    grid.push({
      k,
      t,
      pos: k % 4, // 0: 表拍, 2: 8分裏, 1/3: 16分
      strength,
      score: quiet ? 0 : score * (0.45 + level),
      level,
      pitch: centroidRank(centroid[peakFrame]),
    });
  }
  return { grid, beat, step };
}

export function generateChart(features, gridInfo, difficulty, seed) {
  const cfg = DIFFICULTIES[difficulty];
  const rand = mulberry32(seed ^ hashString(difficulty));
  const { grid, beat } = gridInfo;
  const metric = cfg.subdiv === 2 ? [1, 0, 0.55, 0] : [1, 0.45, 0.7, 0.45];

  const candidates = grid
    .filter((g) => metric[g.pos] > 0 && g.score > 1.15)
    .map((g) => ({ ...g, rank: g.score * metric[g.pos] }))
    .sort((a, b) => b.rank - a.rank);

  const active = activeSpan(grid);
  const target = Math.max(8, Math.round(cfg.nps * (active.end - active.start)));
  const minGap = Math.max(cfg.minGapBeats * beat, cfg.minGapSec) - 1e-6;

  // 強い候補から順に、最小間隔を守りながら採用する
  const taken = [];
  for (const c of candidates) {
    if (taken.length >= target) break;
    const i = lowerBound(taken, c.t);
    if (i > 0 && c.t - taken[i - 1].t < minGap) continue;
    if (i < taken.length && taken[i].t - c.t < minGap) continue;
    taken.splice(i, 0, c);
  }

  const notes = taken.map((g) => ({ t: g.t, lane: 0, type: 'tap', g }));
  markHolds(notes, features, beat, cfg, rand);
  markFlicks(notes, beat, cfg);
  assignLanes(notes, beat, cfg, rand);
  const withChords = addChords(notes, cfg);

  const out = withChords.map((n) => {
    const note = { t: round3(n.t), lane: n.lane, type: n.type };
    if (n.type === 'hold') note.end = round3(n.end);
    return note;
  });
  out.sort((a, b) => a.t - b.t || a.lane - b.lane);
  return { difficulty, lanes: LANES, notes: out, level: estimateLevel(out) };
}

// 次のノーツまで空いていて、その間の音が伸びている(音量はあるのに立ち上がりが少ない)所をロングにする
function markHolds(notes, features, beat, cfg, rand) {
  if (!cfg.hold) return;
  const { rms, onset, hopSec, frameTime, frames } = features;
  const toFrame = (sec) => Math.min(frames - 1, Math.max(0, Math.round((sec - frameTime(0)) / hopSec)));
  const eligible = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const next = i + 1 < notes.length ? notes[i + 1].t : features.duration;
    const room = next - n.t - beat * 0.5;
    if (room < beat) continue;
    const a = toFrame(n.t + 0.05);
    const b = toFrame(n.t + room);
    let energy = 0;
    let busy = 0;
    for (let f = a; f <= b; f++) {
      energy += rms[f];
      busy += onset[f];
    }
    const len = b - a + 1;
    // 音が消えていく区間はロングにしない
    if (rms[b] < rms[a] * 0.35) continue;
    const sustain = energy / len / (busy / len + 0.05);
    const beats = Math.min(Math.floor(room / beat / 0.5) * 0.5, 4);
    eligible.push({ n, sustain: sustain * (0.8 + 0.4 * rand()), beats });
  }
  eligible.sort((x, y) => y.sustain - x.sustain);
  const count = Math.round(notes.length * cfg.hold);
  for (const e of eligible.slice(0, count)) {
    e.n.type = 'hold';
    e.n.end = e.n.t + e.beats * beat;
  }
}

// フレーズの締め(強い音のあとに間が空く所)をフリックにする
function markFlicks(notes, beat, cfg) {
  if (!cfg.flick) return;
  const eligible = [];
  for (let i = 1; i < notes.length; i++) {
    const n = notes[i];
    if (n.type !== 'tap') continue;
    const before = n.t - notes[i - 1].t;
    const after = i + 1 < notes.length ? notes[i + 1].t - n.t : Infinity;
    if (before < beat * 0.5 || after < beat) continue;
    eligible.push({ n, score: n.g.score * Math.min(after / beat, 4) });
  }
  eligible.sort((a, b) => b.score - a.score);
  for (const e of eligible.slice(0, Math.round(notes.length * cfg.flick))) e.n.type = 'flick';
}

// 音が高くなれば右、低くなれば左へ動かす。間が詰まっている時は同じレーンの連打を避ける。
function assignLanes(notes, beat, cfg, rand) {
  let lane = 2;
  let dir = rand() < 0.5 ? -1 : 1;
  let prev = null;
  for (const n of notes) {
    if (!prev) {
      n.lane = clampLane(Math.round(n.g.pitch * (LANES - 1)));
      lane = n.lane;
      prev = n;
      continue;
    }
    const gap = (n.t - prev.t) / beat;
    const dp = n.g.pitch - prev.g.pitch;
    if (Math.abs(dp) > 0.06) dir = Math.sign(dp);
    else if (rand() < 0.35) dir = -dir;

    let step = 1;
    if (gap >= 1 && cfg.maxStep > 1) step = 1 + Math.floor(rand() * cfg.maxStep);
    else if (gap >= 0.5 && cfg.maxStep > 1 && rand() < 0.3) step = 2;
    // 間が十分あれば同じレーンを叩かせてもよい
    if (gap >= 1 && rand() < 0.15) step = 0;

    let next = lane + dir * step;
    // 音の高さから大きく離れたら引き戻す
    const target = n.g.pitch * (LANES - 1);
    if (Math.abs(next - target) > 2.2) next = lane + Math.sign(target - lane) * Math.max(1, step);
    if (next < 0 || next >= LANES) {
      dir = -dir;
      next = lane + dir * Math.max(1, step);
    }
    next = clampLane(next);
    // ロング中のレーンには置かない
    if (prev.type === 'hold' && prev.end > n.t - 1e-6 && next === prev.lane) next = clampLane(next + (next < 2 ? 1 : -1));
    if (step !== 0 && next === lane && gap < 1) next = clampLane(lane + (lane < 2 ? 1 : -1));
    n.lane = next;
    lane = next;
    prev = n;
  }
}

// 表拍の特に強い音を同時押しにする。相方は中央を挟んだ反対側に置く。
function addChords(notes, cfg) {
  if (!cfg.chord) return notes;
  const eligible = notes
    .filter((n) => n.type === 'tap' && n.g.pos === 0 && n.g.strength.low > 1.5)
    .sort((a, b) => b.g.score - a.g.score)
    .slice(0, Math.round(notes.length * cfg.chord));
  const extra = [];
  for (const n of eligible) {
    let other = LANES - 1 - n.lane;
    if (other === n.lane) other = n.lane + (n.g.pitch > 0.5 ? -2 : 2);
    extra.push({ t: n.t, lane: clampLane(other), type: 'tap', g: n.g });
  }
  return notes.concat(extra);
}

export function estimateLevel(notes) {
  if (!notes.length) return 1;
  // 最も密な 10 秒間の密度を主に、全体の密度を少し足す
  let peak = 0;
  let j = 0;
  for (let i = 0; i < notes.length; i++) {
    while (notes[i].t - notes[j].t > 10) j++;
    peak = Math.max(peak, i - j + 1);
  }
  const span = Math.max(1, notes[notes.length - 1].t - notes[0].t);
  const avg = notes.length / span;
  return Math.max(1, Math.min(30, Math.round(2 + (peak / 10) * 2.4 + avg * 1.2)));
}

function activeSpan(grid) {
  const strong = grid.filter((g) => g.score > 1.3);
  if (!strong.length) return { start: 0, end: 1 };
  return { start: strong[0].t, end: strong[strong.length - 1].t };
}

function movingAverage(signal, radius) {
  const out = new Float32Array(signal.length);
  const prefix = new Float64Array(signal.length + 1);
  for (let i = 0; i < signal.length; i++) prefix[i + 1] = prefix[i] + signal[i];
  for (let i = 0; i < signal.length; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(signal.length, i + radius + 1);
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
}

function lowerBound(sorted, t) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m].t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const clampLane = (l) => Math.max(0, Math.min(LANES - 1, l));
const round3 = (x) => Math.round(x * 1000) / 1000;

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
