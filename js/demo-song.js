// 初期曲をその場で合成する。音源ファイルを同梱しないので、権利の心配なく配れる。
// 乱数は曲ごとに固定しているので、何度作っても同じ波形(= 同じ曲 ID)になる。

import { mulberry32 } from './chart/generate.js';

const SR = 32000;

const PROGRESSIONS = {
  // I - V - vi - IV
  pop: [[48, 52, 55], [43, 47, 50], [45, 48, 52], [41, 45, 48]],
  // vi - IV - I - V(切ない系)
  emo: [[45, 48, 52], [41, 45, 48], [48, 52, 55], [43, 47, 50]],
};

// sections は 1 文字 = 1 小節。i: イントロ, a: A メロ, c: サビ, m: 落ち着く所
export const BUILTIN_SONGS = [
  {
    key: 'starlight',
    title: 'Starlight Parade',
    synth: {
      bpm: 128,
      transpose: 0,
      progression: 'pop',
      sections: 'iiiiaaaaccccccccmmmmcccccccc',
      melody: [72, 74, 76, 79, 76, 74, 72, 69, 71, 72, 74, 76, 74, 72, 71, 67],
      seed: 128,
    },
  },
  {
    key: 'neon-rush',
    title: 'Neon Rush',
    synth: {
      bpm: 172,
      transpose: 2,
      progression: 'emo',
      sections: 'iiiiaaaaaaaaccccccccmmmmcccccccccccc',
      melody: [76, 79, 81, 79, 76, 74, 76, 72, 74, 76, 79, 81, 84, 81, 79, 76],
      seed: 172,
    },
  },
  {
    key: 'moonlight-letter',
    title: 'Moonlight Letter',
    synth: {
      bpm: 86,
      transpose: -3,
      progression: 'emo',
      sections: 'iiaaaammmmccccmmcc',
      melody: [69, 72, 76, 74, 72, 71, 72, 67, 69, 71, 72, 76, 79, 76, 74, 72],
      seed: 86,
    },
  },
];

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

export async function renderSynthSong(opts) {
  const { bpm, transpose, sections, melody, seed } = opts;
  const progression = PROGRESSIONS[opts.progression];
  const beat = 60 / bpm;
  const bars = sections.length;
  const seconds = bars * 4 * beat + 2;
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);

  const rand = mulberry32(seed);
  const noise = ctx.createBuffer(1, SR, SR);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = rand() * 2 - 1;
  const slow = bpm < 100;
  const fast = bpm > 150;

  for (let bar = 0; bar < bars; bar++) {
    const sec = sections[bar];
    const chord = progression[bar % 4].map((n) => n + transpose);
    const barStart = bar * 4 * beat;
    const phrase = melody.map((m) => m + transpose + (bar % 4 === 2 ? -3 : 0));

    // パッド(和音を伸ばす)
    for (const note of chord) {
      const level = sec === 'm' || slow ? 0.08 : 0.05;
      tone(ctx, master, 'triangle', midiHz(note + 12), barStart, 4 * beat, level, 0.2, 0.15);
    }

    for (let b = 0; b < 4; b++) {
      const t = barStart + b * beat;
      const drums = sec !== 'i' && !(slow && sec === 'm');
      if (drums) {
        if (sec === 'c' || b % 2 === 0) kick(ctx, master, t);
        if (b % 2 === 1) snare(ctx, master, noise, t, sec === 'c' ? 0.45 : 0.25);
      }
      for (const h of [0, 0.5]) {
        if (sec === 'i' && h === 0 && b % 2 === 0) continue;
        if (slow && h === 0.5 && sec !== 'c') continue;
        hat(ctx, master, noise, t + h * beat, sec === 'c' ? 0.12 : 0.06);
      }
      if (sec !== 'i') {
        // ベース。速い曲は 4 分、それ以外は 8 分
        for (const h of fast ? [0] : [0, 0.5]) bass(ctx, master, midiHz(chord[0] - 12), t + h * beat, beat * (fast ? 0.9 : 0.45));
      }
    }

    // メロディ。A メロは 4 分、サビは 8 分、落ち着く所は伸ばす
    if (sec === 'm') {
      for (let b = 0; b < 4; b += 2) {
        tone(ctx, master, 'square', midiHz(phrase[(bar * 2 + b) % 16]), barStart + b * beat, beat * 1.9, 0.09, 0.01, beat * 0.5, 3000);
      }
    } else {
      const step = sec === 'c' ? 0.5 : 1;
      for (let e = 0; e < 4 / step; e++) {
        if (sec === 'i' && e % 2 === 1) continue;
        const idx = ((bar % 2) * 8 + e * step * 2) % 16;
        tone(ctx, master, 'square', midiHz(phrase[idx]), barStart + e * step * beat, beat * step * 0.85, 0.1, 0.01, beat * 0.1, 3000);
      }
    }
  }
  // 最後の一発
  const end = bars * 4 * beat;
  kick(ctx, master, end);
  for (const note of progression[0]) tone(ctx, master, 'square', midiHz(note + transpose + 24), end, 1.4, 0.07, 0.01, 0.6, 3000);

  return ctx.startRendering();
}

function tone(ctx, out, type, hz, t, len, level, attack, release, cutoff) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + attack);
  g.gain.setValueAtTime(level, Math.max(t + attack, t + len - release));
  g.gain.linearRampToValueAtTime(0, t + len);
  let node = osc;
  if (cutoff) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    node = osc.connect(lp);
  }
  node.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + len);
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

function noiseHit(ctx, out, noise, t, level, filterType, freq, len) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(level, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  src.connect(f).connect(g).connect(out);
  src.start(t, (t * 7.31) % 0.5);
  src.stop(t + len + 0.01);
}

const snare = (ctx, out, noise, t, level) => noiseHit(ctx, out, noise, t, level, 'bandpass', 1800, 0.18);
const hat = (ctx, out, noise, t, level) => noiseHit(ctx, out, noise, t, level, 'highpass', 7000, 0.05);

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
