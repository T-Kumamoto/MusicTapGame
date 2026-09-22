// 音声から譜面生成用の特徴量を取り出す。
//   - 帯域別(低/中/高)のスペクトラルフラックス: 音の立ち上がり(オンセット)の強さ
//   - RMS: 音量。サビなど盛り上がり区間の判定に使う
//   - スペクトル重心: 音の高さの目安。レーンの左右移動に使う
//   - BPM と最初の拍の位置: ノーツを拍グリッドに揃えるために使う

import { FFT } from './fft.js';

export const FFT_SIZE = 1024;
export const HOP = 256;

const BANDS = {
  low: [30, 200],
  mid: [200, 2500],
  high: [2500, 10000],
};

// 解析用に 22〜24kHz 程度のモノラルへ落とす。多チャンネルは平均する。
export function downmix(channels, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / 22050));
  const length = Math.floor(channels[0].length / factor);
  const out = new Float32Array(length);
  const scale = 1 / (factor * channels.length);
  for (const ch of channels) {
    for (let i = 0; i < length; i++) {
      let sum = 0;
      const base = i * factor;
      for (let j = 0; j < factor; j++) sum += ch[base + j];
      out[i] += sum * scale;
    }
  }
  return { samples: out, sampleRate: sampleRate / factor };
}

export function analyze(samples, sampleRate, onProgress = () => {}) {
  const fft = new FFT(FFT_SIZE);
  const frames = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const bins = FFT_SIZE / 2 + 1;
  const hopSec = HOP / sampleRate;

  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);

  const binOf = (hz) => Math.min(bins - 1, Math.max(1, Math.round((hz * FFT_SIZE) / sampleRate)));
  const bandRanges = Object.fromEntries(
    Object.entries(BANDS).map(([name, [lo, hi]]) => [name, [binOf(lo), binOf(hi)]]),
  );
  const [centroidLo, centroidHi] = [binOf(100), binOf(5000)];

  const flux = { low: new Float32Array(frames), mid: new Float32Array(frames), high: new Float32Array(frames) };
  const rms = new Float32Array(frames);
  const centroid = new Float32Array(frames);

  const frame = new Float64Array(FFT_SIZE);
  const mag = new Float64Array(bins);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);

  for (let t = 0; t < frames; t++) {
    const offset = t * HOP;
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[offset + i] || 0;
      energy += s * s;
      frame[i] = s * window[i];
    }
    rms[t] = Math.sqrt(energy / FFT_SIZE);

    fft.magnitude(frame, mag);
    for (let k = 0; k < bins; k++) cur[k] = Math.log1p(100 * mag[k]);

    for (const name of Object.keys(BANDS)) {
      const [lo, hi] = bandRanges[name];
      let sum = 0;
      if (t > 0) {
        for (let k = lo; k <= hi; k++) {
          const d = cur[k] - prev[k];
          if (d > 0) sum += d;
        }
      }
      flux[name][t] = sum / (hi - lo + 1);
    }

    let num = 0;
    let den = 0;
    for (let k = centroidLo; k <= centroidHi; k++) {
      num += k * mag[k];
      den += mag[k];
    }
    centroid[t] = den > 1e-9 ? (num / den) * (sampleRate / FFT_SIZE) : 0;

    [prev, cur] = [cur, prev];
    if (t % 2000 === 0) onProgress(0.7 * (t / frames));
  }

  // フレーム t のフラックスが立つのは、立ち上がりが窓の後ろ寄りに入った時点
  // (対数圧縮で小さな漏れも拾うため)。合成ドラムで実測すると窓の先頭から 0.8 窓長の位置に相当する。
  const frameTime = (t) => (t * HOP + 0.8 * FFT_SIZE) / sampleRate;

  const onset = new Float32Array(frames);
  const norm = {};
  for (const name of Object.keys(BANDS)) norm[name] = 1 / (percentile(flux[name], 0.95) + 1e-9);
  for (let t = 0; t < frames; t++) {
    onset[t] = 1.5 * flux.low[t] * norm.low + flux.mid[t] * norm.mid + 0.7 * flux.high[t] * norm.high;
  }

  onProgress(0.75);
  const duration = samples.length / sampleRate;
  const tempo = estimateTempo(onset, hopSec, frameTime);
  const beatInfo = trackBeats(onset, hopSec, frameTime, tempo, duration);
  onProgress(0.95);

  return {
    hopSec,
    frames,
    frameTime,
    duration,
    flux,
    onset,
    rms,
    centroid,
    bpm: beatInfo.bpm,
    beats: beatInfo.beats,
    firstBeat: beatInfo.beats[0] ?? tempo.firstBeat,
    tempoMode: beatInfo.mode,
  };
}

// 拍の位置を一つずつ決める。テンポが揺れる曲(生演奏・クラシック等)は一定テンポの格子だと
// 数小節でずれるので、動的計画法で「立ち上がりに乗りつつ、間隔が急に変わらない」拍列を探す
// (Ellis 2007, "Beat Tracking by Dynamic Programming")。
// テンポが一定の曲は格子の方が揺れがないので、立ち上がりへの乗り方がほぼ同じなら格子を採る。
// 小さいほどテンポの揺れに追従する。合成した加速ドラムで 30 が最も正確だった(100〜400 は裏拍へ乗り移る)
const TIGHTNESS = 30;

export function trackBeats(onset, hopSec, frameTime, tempo, duration) {
  const env = highpass(onset, Math.round(1 / hopSec));
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (env[i] - mean) ** 2;
  const sd = Math.sqrt(variance / n) || 1;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = env[i] / sd;

  const beatSec = 60 / tempo.bpm;
  const constant = [];
  for (let t = tempo.firstBeat; t < duration; t += beatSec) constant.push(t);

  const period = beatSec / hopSec;
  const lo = Math.max(1, Math.round(period * 0.6));
  const hi = Math.round(period * 1.6);
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const r = Math.log(d / period);
      const v = score[t - d] - TIGHTNESS * r * r;
      if (v > best) {
        best = v;
        arg = t - d;
      }
    }
    if (arg >= 0 && best > 0) {
      score[t] = e[t] + best;
      back[t] = arg;
    } else {
      score[t] = e[t];
    }
  }
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();
  const tracked = frames.map(frameTime);

  // 格子の拍はフレームの間に落ちるので、前後 1 フレームの最大値で比べる(追跡側と条件を揃える)
  const at = (sec) => {
    const i = Math.round((sec - frameTime(0)) / hopSec);
    let m = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) m = Math.max(m, e[j]);
    return m;
  };
  const fit = (beats) => (beats.length ? beats.reduce((s, b) => s + at(b), 0) / beats.length : 0);
  const constantFit = fit(constant);
  const trackedFit = fit(tracked);

  if (tracked.length < 8 || constantFit >= 0.9 * trackedFit) {
    return { mode: 'constant', beats: constant, bpm: tempo.bpm };
  }
  const intervals = tracked.slice(1).map((b, i) => b - tracked[i]).sort((a, b) => a - b);
  const median = intervals[intervals.length >> 1];
  return { mode: 'tracked', beats: tracked, bpm: Math.round((60 / median) * 100) / 100 };
}

// 曲全体を一定テンポとみなした時の BPM と位相。オンセット包絡の自己相関で大まかな BPM を出し、
// 拍位置に櫛形フィルタを当てて BPM と位相を細かく詰める。
export function estimateTempo(onset, hopSec, frameTime) {
  const n = onset.length;
  const env = highpass(onset, Math.round(1 / hopSec));

  const minBpm = 70;
  const maxBpm = 200;
  const lagMin = Math.floor(60 / maxBpm / hopSec);
  const lagMax = Math.ceil(60 / minBpm / hopSec);
  const ac = new Float64Array(lagMax * 2 + 2);
  for (let lag = lagMin; lag <= Math.min(lagMax * 2, n - 1); lag++) {
    let sum = 0;
    for (let t = lag; t < n; t++) sum += env[t] * env[t - lag];
    ac[lag] = sum / (n - lag);
  }

  let best = { score: -Infinity, lag: lagMin };
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = 60 / (lag * hopSec);
    // 人が拍として感じやすい 120〜130 付近を少し優遇する(Ellis 2007 と同じ考え方)
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.9) ** 2);
    const harmonic = lag * 2 < ac.length ? 0.5 * ac[lag * 2] : 0;
    const score = (ac[lag] + harmonic) * prior;
    if (score > best.score) best = { score, lag };
  }
  const coarseBpm = 60 / (best.lag * hopSec);

  // 櫛形フィルタで BPM(0.05 刻み)と位相を同時に詰める
  let refined = { score: -Infinity, bpm: coarseBpm, phase: 0 };
  for (let bpm = coarseBpm * 0.97; bpm <= coarseBpm * 1.03; bpm += 0.05) {
    const period = 60 / bpm / hopSec;
    for (let phase = 0; phase < period; phase += 0.25) {
      let sum = 0;
      let count = 0;
      for (let pos = phase; pos < n - 1; pos += period) {
        const i = Math.floor(pos);
        const f = pos - i;
        sum += env[i] * (1 - f) + env[i + 1] * f;
        count++;
      }
      const score = count ? sum / count : 0;
      if (score > refined.score) refined = { score, bpm, phase };
    }
  }

  const bpm = Math.round(refined.bpm * 100) / 100;
  const beatSec = 60 / bpm;
  const phaseIndex = Math.floor(refined.phase);
  const phaseFrac = refined.phase - phaseIndex;
  let firstBeat = frameTime(phaseIndex) + phaseFrac * hopSec;
  firstBeat = ((firstBeat % beatSec) + beatSec) % beatSec;
  return { bpm, firstBeat };
}

function highpass(signal, width) {
  const out = new Float32Array(signal.length);
  const prefix = new Float64Array(signal.length + 1);
  for (let i = 0; i < signal.length; i++) prefix[i + 1] = prefix[i] + signal[i];
  for (let i = 0; i < signal.length; i++) {
    const a = Math.max(0, i - width);
    const b = Math.min(signal.length, i + width + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    out[i] = Math.max(0, signal[i] - mean);
  }
  return out;
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = Float32Array.from(arr).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
