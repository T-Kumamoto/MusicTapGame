// 手元に曲がなくても遊べるよう、デモ曲をその場で合成する。
// 128 BPM・約 50 秒。イントロ → サビ → 落ち着く所 → ラストサビ。

import { mulberry32 } from './chart/generate.js';

const BPM = 128;
const BARS = 26;
const SR = 32000;

// C - G - Am - F
const PROGRESSION = [
  [48, 52, 55],
  [43, 47, 50],
  [45, 48, 52],
  [41, 45, 48],
];
const MELODY = [72, 74, 76, 79, 76, 74, 72, 69, 71, 72, 74, 76, 74, 72, 71, 67];

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

export async function renderDemoSong() {
  const beat = 60 / BPM;
  const seconds = BARS * 4 * beat + 1.5;
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);

  // 乱数を固定して毎回同じ波形にする(同じ曲として扱われる)
  const rand = mulberry32(128);
  const noise = ctx.createBuffer(1, SR, SR);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = rand() * 2 - 1;

  const section = (bar) => {
    if (bar < 4) return 'intro';
    if (bar < 12) return 'chorus';
    if (bar < 16) return 'calm';
    return 'chorus';
  };

  for (let bar = 0; bar < BARS; bar++) {
    const sec = section(bar);
    const chord = PROGRESSION[bar % 4];
    const barStart = bar * 4 * beat;

    // パッド(和音を伸ばす)
    for (const note of chord) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiHz(note + 12);
      const g = ctx.createGain();
      const level = sec === 'calm' ? 0.08 : 0.05;
      g.gain.setValueAtTime(0, barStart);
      g.gain.linearRampToValueAtTime(level, barStart + 0.2);
      g.gain.setValueAtTime(level, barStart + 4 * beat - 0.15);
      g.gain.linearRampToValueAtTime(0, barStart + 4 * beat);
      osc.connect(g).connect(master);
      osc.start(barStart);
      osc.stop(barStart + 4 * beat);
    }

    for (let b = 0; b < 4; b++) {
      const t = barStart + b * beat;
      if (sec !== 'intro') {
        if (sec === 'chorus' || b % 2 === 0) kick(ctx, master, t);
        if (b % 2 === 1) snare(ctx, master, noise, t, sec === 'calm' ? 0.2 : 0.45);
      }
      for (const h of [0, 0.5]) {
        if (sec === 'intro' && h === 0 && b % 2 === 0) continue;
        hat(ctx, master, noise, t + h * beat, sec === 'chorus' ? 0.12 : 0.06);
      }
      // ベース(8分)
      if (sec !== 'intro') {
        for (const h of [0, 0.5]) bass(ctx, master, midiHz(chord[0] - 12), t + h * beat, beat * 0.45);
      }
    }

    // メロディ(8分)。落ち着く所では伸ばす
    const phrase = MELODY.map((m) => m + (bar % 4 === 2 ? -3 : 0));
    if (sec === 'calm') {
      for (let b = 0; b < 4; b += 2) lead(ctx, master, midiHz(phrase[(bar * 2 + b) % 16]), barStart + b * beat, beat * 1.9, 0.09);
    } else {
      for (let e = 0; e < 8; e++) {
        if (sec === 'intro' && e % 2 === 1) continue;
        const idx = ((bar % 2) * 8 + e) % 16;
        lead(ctx, master, midiHz(phrase[idx]), barStart + e * beat * 0.5, beat * 0.42, 0.11);
      }
    }
  }
  // 最後の一発
  const end = BARS * 4 * beat;
  kick(ctx, master, end);
  for (const note of PROGRESSION[0]) lead(ctx, master, midiHz(note + 24), end, 1.2, 0.07);

  return ctx.startRendering();
}

function kick(ctx, out, t) {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.3);
}

function snare(ctx, out, noise, t, level) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(level, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  src.connect(bp).connect(g).connect(out);
  src.start(t, (t * 7.31) % 0.5);
  src.stop(t + 0.2);
}

function hat(ctx, out, noise, t, level) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(level, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  src.connect(hp).connect(g).connect(out);
  src.start(t, (t * 7.31) % 0.5);
  src.stop(t + 0.06);
}

function bass(ctx, out, hz, t, len) {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = hz;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.01, t + len);
  osc.connect(lp).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + len);
}

function lead(ctx, out, hz, t, len, level) {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = hz;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.01);
  g.gain.setValueAtTime(level, t + len * 0.7);
  g.gain.linearRampToValueAtTime(0, t + len);
  osc.connect(lp).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + len);
}

// AudioBuffer を 16bit WAV にする(曲ライブラリへ普通の曲と同じ形で保存するため)
export function encodeWav(buffer) {
  const data = buffer.getChannelData(0);
  const bytes = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(bytes);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}
