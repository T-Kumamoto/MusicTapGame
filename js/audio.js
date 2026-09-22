// 再生と時計。判定の基準は「いまスピーカーから鳴っている曲の位置」なので、
// 出力遅延を差し引いた時刻を返す。

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.songStart = 0;
    this.musicGain = null;
    this.hitGain = null;
    this.hitBuffers = null;
  }

  // iOS/Android ではユーザー操作の中で作らないと音が出ない
  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.musicGain = this.ctx.createGain();
      this.musicGain.connect(this.ctx.destination);
      this.hitGain = this.ctx.createGain();
      this.hitGain.connect(this.ctx.destination);
      this.hitBuffers = makeHitSounds(this.ctx);
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
    return this.ctx;
  }

  decode(arrayBuffer) {
    const ctx = this.ensure();
    // Safari の古い版は Promise を返さないのでコールバック形式で呼ぶ
    return new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuffer.slice(0), resolve, reject));
  }

  setVolumes(music, hit) {
    if (!this.ctx) return;
    this.musicGain.gain.value = music;
    this.hitGain.gain.value = hit;
  }

  // leadIn 秒後に曲の頭が鳴るように予約する。それまでの songTime は負になる。
  play(buffer, leadIn) {
    const ctx = this.ensure();
    this.stop();
    this.source = ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.connect(this.musicGain);
    this.songStart = ctx.currentTime + leadIn;
    this.source.start(this.songStart);
  }

  // 無音で時計だけ動かす(タイミング調整用)
  startClock(leadIn) {
    const ctx = this.ensure();
    this.stop();
    this.songStart = ctx.currentTime + leadIn;
  }

  stop() {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // まだ開始していない/既に止まっている
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  pause() {
    return this.ctx && this.ctx.suspend();
  }

  resume() {
    return this.ctx && this.ctx.resume();
  }

  // perfNow (performance.now() の時間軸, ms) の時点で耳に届いている曲の位置(秒)
  songTime(perfNow = performance.now()) {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const upper = ctx.currentTime - this.songStart;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ctx.state === 'running' && ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      const t = ts.contextTime + (perfNow - ts.performanceTime) / 1000 - this.songStart;
      return Math.min(t, upper);
    }
    return upper - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  // songTime 基準で when 秒に音を鳴らす(クリック音の予約用)
  scheduleClick(when, accent = false) {
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    src.buffer = accent ? this.hitBuffers.accent : this.hitBuffers.click;
    src.connect(this.hitGain);
    src.start(this.songStart + when);
  }

  hit(kind = 'tap') {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.hitBuffers[kind] || this.hitBuffers.tap;
    src.connect(this.hitGain);
    src.start();
  }
}

// タップ音は外部ファイルを使わずその場で合成する
function makeHitSounds(ctx) {
  const sr = ctx.sampleRate;
  const make = (seconds, fn) => {
    const buf = ctx.createBuffer(1, Math.floor(sr * seconds), sr);
    const d = buf.getChannelData(0);
    let seed = 12345;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x3fffffff - 1;
    };
    for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, noise);
    return buf;
  };
  return {
    tap: make(0.08, (t, n) => (0.5 * Math.sin(2 * Math.PI * 1800 * t) + 0.35 * n()) * Math.exp(-t * 60)),
    flick: make(0.14, (t, n) => (0.4 * Math.sin(2 * Math.PI * (1400 + 5000 * t) * t) + 0.25 * n()) * Math.exp(-t * 28)),
    hold: make(0.1, (t) => 0.4 * Math.sin(2 * Math.PI * 1320 * t) * Math.exp(-t * 35)),
    click: make(0.05, (t) => 0.8 * Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t * 90)),
    accent: make(0.05, (t) => 0.9 * Math.sin(2 * Math.PI * 1600 * t) * Math.exp(-t * 90)),
  };
}
