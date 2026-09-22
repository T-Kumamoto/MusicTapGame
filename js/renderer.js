// Canvas 2D で奥行きのあるステージを描く。
// レーンは画面奥の消失点へ向かう台形。ノーツは時間に比例して奥から手前へ進み、
// 手前ほど速く大きく見えるよう軽い遠近をかける。

const NOTE_COLORS = {
  tap: ['#e9fdff', '#5ce1ff', '#1d8fd6'],
  chord: ['#fffbe6', '#ffd35c', '#e0901c'],
  hold: ['#eafff4', '#6dffb0', '#1fae6a'],
  flick: ['#fff0f8', '#ff6fb5', '#d42a7c'],
};
const GRADE_COLORS = { PERFECT: '#ffe47a', GREAT: '#ff8fcf', GOOD: '#7fe9ff', MISS: '#a79fc4' };
const FONT = '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Yu Gothic UI", sans-serif';

import { Emblem, Siberia, SIBERIA_STREAK } from './soviet.js';

// 奥の端でのレーン幅(手前を 1 とした比)
const FAR_SCALE = 0.14;
// 遠近の強さ。0 なら等速、大きいほど奥でゆっくり手前で速い
const PERSPECTIVE = 0.9;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lanes = 5;
    this.particles = [];
    this.rings = [];
    this.laneFlash = [];
    this.popup = null;
    this.comboBump = 0;
    this.bgImage = null;
    this.bgDim = 0.55;
    this.emblem = new Emblem();
    this.siberia = new Siberia();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { W, H } = this;
    this.cx = W / 2;
    this.horizonY = H * 0.12;
    this.judgeY = H * (H > W ? 0.83 : 0.85);
    this.laneAreaW = Math.min(W * 0.96, H * 0.72);
    this.ui = Math.min(W, H * 0.6) / 400;
  }

  // 新しいプレイの前に演出を消す
  reset() {
    this.particles = [];
    this.rings = [];
    this.popup = null;
    this.emblem.reset();
    this.siberia.reset();
  }

  setLanes(lanes) {
    this.lanes = lanes;
    this.laneFlash = new Array(lanes).fill(0);
  }

  // z: 判定ラインまでの残り時間を落下時間で割ったもの(1 で画面奥, 0 で判定ライン)
  project(z) {
    const p = z >= 0 ? (1 - z) / (1 + PERSPECTIVE * z) : 1 - z * (1 + PERSPECTIVE);
    return {
      y: this.horizonY + (this.judgeY - this.horizonY) * p,
      s: FAR_SCALE + (1 - FAR_SCALE) * p,
    };
  }

  laneX(pos, s) {
    return this.cx + (pos - this.lanes / 2) * (this.laneAreaW / this.lanes) * s;
  }

  // 画面の x 座標が判定ライン上で何レーン目に当たるか(小数)
  laneAt(x) {
    return (x - (this.cx - this.laneAreaW / 2)) / (this.laneAreaW / this.lanes);
  }

  // ---------- 演出 ----------

  handleEvents(events, now) {
    for (const e of events) {
      if (e.type === 'press') {
        this.laneFlash[e.lane] = 1;
        continue;
      }
      this.popup = { grade: e.grade, t: now };
      if (e.grade === 'MISS') {
        if (e.missStreak % SIBERIA_STREAK === 0) this.siberia.trigger(this.W, this.H);
        continue;
      }
      this.comboBump = 1;
      const x = this.laneX(e.lane + 0.5, 1);
      const color = GRADE_COLORS[e.grade];
      const strong = e.grade === 'PERFECT';
      this.rings.push({ x, y: this.judgeY, life: 1, color, big: e.kind === 'flick' });
      const count = strong ? 14 : 8;
      for (let i = 0; i < count; i++) {
        const a = -Math.PI * (0.1 + 0.8 * Math.random());
        const v = (140 + Math.random() * 320) * this.ui;
        this.particles.push({
          x,
          y: this.judgeY,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          life: 1,
          decay: 1.6 + Math.random(),
          size: (2 + Math.random() * 3.5) * this.ui,
          color: Math.random() < 0.5 ? color : '#ffffff',
        });
      }
    }
  }

  updateEffects(dt, combo) {
    this.emblem.update(dt, combo);
    this.siberia.update(dt);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 700 * this.ui * dt;
      p.life -= p.decay * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const r of this.rings) r.life -= dt * 3;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (let i = 0; i < this.laneFlash.length; i++) this.laneFlash[i] = Math.max(0, this.laneFlash[i] - dt * 5);
    this.comboBump = Math.max(0, this.comboBump - dt * 6);
  }

  // ---------- 描画 ----------

  draw(state) {
    const { ctx, W, H } = this;
    const { now, dt } = state;
    this.updateEffects(dt, state.game ? state.game.combo : 0);
    ctx.clearRect(0, 0, W, H);

    // 直前の拍からの経過時間でステージを脈打たせる
    const beats = state.beats || [];
    const lastBeat = lastIndexAtOrBefore(beats, now);
    const pulse = now > 0 && lastBeat >= 0 ? Math.exp(-(now - beats[lastBeat]) * 7) : 0;

    this.drawBackground(now, pulse);
    this.drawStage(state, pulse);
    // 鎌と金槌: 普段はレーンの奥、コンボが続くほど大きくなって画面中央へ。
    // ステージの床より手前・ノーツより奥に描いて、大きくなっても譜面は隠さない
    const short = Math.min(W, H);
    this.emblem.draw(
      ctx,
      {
        cx: this.cx,
        topY: this.horizonY + short * 0.02,
        centerY: this.horizonY + (this.judgeY - this.horizonY) * 0.36,
        minSize: short * 0.22,
        maxSize: short * 0.55,
      },
      pulse,
      now,
    );
    this.drawNotes(state);
    this.drawEffects();
    this.drawHud(state);
    this.siberia.draw(ctx, W, H, this.ui);
  }

  drawBackground(now, pulse) {
    const { ctx, W, H } = this;
    if (this.bgImage) {
      const img = this.bgImage;
      const scale = Math.max(W / img.width, H / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      ctx.fillStyle = `rgba(10, 6, 26, ${this.bgDim})`;
      ctx.fillRect(0, 0, W, H);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#2a1650');
      g.addColorStop(0.55, '#150c30');
      g.addColorStop(1, '#070412');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // ライブ会場のスポットライト。ビートに合わせて明るくなる
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const beams = [
      { x: W * 0.1, color: '255, 111, 181', phase: 0 },
      { x: W * 0.9, color: '92, 225, 255', phase: 2.1 },
      { x: W * 0.5, color: '180, 120, 255', phase: 4.2 },
    ];
    for (const b of beams) {
      const sway = Math.sin(now * 0.7 + b.phase) * W * 0.25;
      const alpha = 0.07 + 0.1 * pulse;
      const g = ctx.createLinearGradient(b.x, 0, b.x + sway, H * 0.8);
      g.addColorStop(0, `rgba(${b.color}, ${alpha * 2})`);
      g.addColorStop(1, `rgba(${b.color}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(b.x - 8, -10);
      ctx.lineTo(b.x + 8, -10);
      ctx.lineTo(b.x + sway + W * 0.18, H * 0.85);
      ctx.lineTo(b.x + sway - W * 0.18, H * 0.85);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  drawStage(state, pulse) {
    const { ctx, H, lanes } = this;
    const far = this.project(1);
    const bottomZ = -(H - this.judgeY) / (this.judgeY - this.horizonY) / (1 + PERSPECTIVE);
    const near = this.project(bottomZ);

    // レーンの床
    const floor = ctx.createLinearGradient(0, far.y, 0, H);
    floor.addColorStop(0, 'rgba(10, 6, 30, 0.15)');
    floor.addColorStop(0.7, 'rgba(10, 6, 30, 0.72)');
    floor.addColorStop(1, 'rgba(10, 6, 30, 0.85)');
    ctx.fillStyle = floor;
    this.quad(0, lanes, far, near);
    ctx.fill();

    // 押しているレーンを光らせる
    const held = state.game ? state.game.heldLanes() : new Set();
    for (let l = 0; l < lanes; l++) {
      const a = Math.max(this.laneFlash[l] * 0.9, held.has(l) ? 0.55 : 0);
      if (a <= 0.01) continue;
      const g = ctx.createLinearGradient(0, this.judgeY, 0, far.y);
      g.addColorStop(0, `rgba(160, 230, 255, ${0.45 * a})`);
      g.addColorStop(1, 'rgba(160, 230, 255, 0)');
      ctx.fillStyle = g;
      this.quad(l, l + 1, this.project(1), this.project(0));
      ctx.fill();
    }

    // 拍線(小節線は濃く)
    const beats = state.beats || [];
    if (beats.length && state.fallTime) {
      for (let b = lastIndexAtOrBefore(beats, state.now) + 1; b < beats.length; b++) {
        const z = (beats[b] - state.now) / state.fallTime;
        if (z > 1) break;
        const { y, s } = this.project(z);
        ctx.strokeStyle = b % 4 === 0 ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = b % 4 === 0 ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(this.laneX(0, s), y);
        ctx.lineTo(this.laneX(lanes, s), y);
        ctx.stroke();
      }
    }

    // レーン区切り
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    for (let l = 1; l < lanes; l++) {
      ctx.beginPath();
      ctx.moveTo(this.laneX(l, far.s), far.y);
      ctx.lineTo(this.laneX(l, near.s), near.y);
      ctx.stroke();
    }

    // 外枠(ネオン)
    ctx.lineWidth = 3;
    for (const [pos, color] of [[0, '#ff6fb5'], [lanes, '#5ce1ff']]) {
      const g = ctx.createLinearGradient(0, far.y, 0, near.y);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.6, color);
      g.addColorStop(1, color);
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(this.laneX(pos, far.s), far.y);
      ctx.lineTo(this.laneX(pos, near.s), near.y);
      ctx.stroke();
    }

    // 判定ライン
    const x0 = this.laneX(0, 1);
    const x1 = this.laneX(lanes, 1);
    const glow = 0.5 + 0.5 * pulse;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const band = ctx.createLinearGradient(0, this.judgeY - 14, 0, this.judgeY + 14);
    band.addColorStop(0, 'rgba(255, 150, 210, 0)');
    band.addColorStop(0.5, `rgba(255, 150, 210, ${0.35 + 0.35 * glow})`);
    band.addColorStop(1, 'rgba(255, 150, 210, 0)');
    ctx.fillStyle = band;
    ctx.fillRect(x0, this.judgeY - 14, x1 - x0, 28);
    ctx.restore();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, this.judgeY - 1.5, x1 - x0, 3);
  }

  // レーン a〜b の、二つの奥行き位置の間の台形をパスにする
  quad(a, b, p1, p2) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(this.laneX(a, p1.s), p1.y);
    ctx.lineTo(this.laneX(b, p1.s), p1.y);
    ctx.lineTo(this.laneX(b, p2.s), p2.y);
    ctx.lineTo(this.laneX(a, p2.s), p2.y);
    ctx.closePath();
  }

  drawNotes(state) {
    const { game, now, fallTime } = state;
    if (!game) return;
    const notes = game.notes;
    const visible = [];
    for (const n of notes) {
      if (n.t - now > fallTime * 1.02) break;
      if (n.state === 'done' || n.state === 'flicking') continue;
      if ((n.type === 'hold' ? n.end : n.t) < now - 0.4) continue;
      visible.push(n);
    }

    // ロングの帯を先に描き、その上に頭を描く
    for (const n of visible) if (n.type === 'hold') this.drawHoldBody(n, now, fallTime);

    // 同時押しを線でつなぐ
    const { ctx } = this;
    for (let i = 0; i + 1 < visible.length; i++) {
      const a = visible[i];
      const b = visible[i + 1];
      if (a.t !== b.t || a.state !== 'pending' || b.state !== 'pending') continue;
      const { y, s } = this.project((a.t - now) / fallTime);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = Math.max(1, 3 * s * this.ui);
      ctx.beginPath();
      ctx.moveTo(this.laneX(Math.min(a.lane, b.lane) + 0.5, s), y);
      ctx.lineTo(this.laneX(Math.max(a.lane, b.lane) + 0.5, s), y);
      ctx.stroke();
    }

    for (let i = visible.length - 1; i >= 0; i--) {
      const n = visible[i];
      if (n.state === 'holding') continue;
      const chord = (visible[i - 1] && visible[i - 1].t === n.t) || (visible[i + 1] && visible[i + 1].t === n.t);
      const kind = n.type === 'tap' && chord ? 'chord' : n.type;
      this.drawNoteHead(n.lane, (n.t - now) / fallTime, kind);
    }
  }

  drawHoldBody(n, now, fallTime) {
    const { ctx } = this;
    const holding = n.state === 'holding';
    const z0 = holding ? 0 : Math.max(0, (n.t - now) / fallTime);
    const z1 = Math.min(1, (n.end - now) / fallTime);
    if (z1 <= z0) return;
    const p0 = this.project(z0);
    const p1 = this.project(z1);
    const g = ctx.createLinearGradient(0, p0.y, 0, p1.y);
    const a = holding ? 0.85 : 0.5;
    g.addColorStop(0, `rgba(109, 255, 176, ${a})`);
    g.addColorStop(1, `rgba(109, 255, 176, ${a * 0.35})`);
    ctx.fillStyle = g;
    this.quad(n.lane + 0.14, n.lane + 0.86, p1, p0);
    ctx.fill();
    if (holding) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(180, 255, 215, 0.5)';
      const x = this.laneX(n.lane + 0.5, 1);
      const r = (this.laneAreaW / this.lanes) * 0.42;
      ctx.beginPath();
      ctx.ellipse(x, this.judgeY, r, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // 終点
    if (z1 < 1) this.drawNoteHead(n.lane, z1, 'hold', 0.6);
  }

  drawNoteHead(lane, z, kind, scale = 1) {
    if (z > 1.02) return;
    const { ctx } = this;
    const { y, s } = this.project(z);
    const x0 = this.laneX(lane + 0.07, s);
    const x1 = this.laneX(lane + 0.93, s);
    const h = Math.max(4, 20 * s * this.ui * scale);
    const [light, mid, dark] = NOTE_COLORS[kind];

    const g = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
    g.addColorStop(0, light);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, dark);
    ctx.fillStyle = g;
    roundRect(ctx, x0, y - h / 2, x1 - x0, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = Math.max(1, 2 * s * this.ui);
    ctx.stroke();

    if (kind === 'flick') {
      // 上向きの矢印
      const cx = (x0 + x1) / 2;
      const aw = (x1 - x0) * 0.22;
      const ah = h * 1.3;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(cx, y - h / 2 - ah);
      ctx.lineTo(cx + aw, y - h / 2 - ah * 0.2);
      ctx.lineTo(cx - aw, y - h / 2 - ah * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = mid;
      ctx.beginPath();
      ctx.moveTo(cx, y - h / 2 - ah * 0.72);
      ctx.lineTo(cx + aw * 0.5, y - h / 2 - ah * 0.32);
      ctx.lineTo(cx - aw * 0.5, y - h / 2 - ah * 0.32);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawEffects() {
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rings) {
      const k = 1 - r.life;
      const w = (this.laneAreaW / this.lanes) * (0.5 + k * (r.big ? 1.4 : 0.9));
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = r.life;
      ctx.lineWidth = 3 * this.ui;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, w, w * 0.32, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawHud(state) {
    const { ctx, W, ui } = this;
    const { game, now } = state;
    if (!game) return;
    const top = (state.safeTop || 0) + 12;

    // スコアと進行バー
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(24 * ui)}px ${FONT}`;
    ctx.fillText(String(game.score).padStart(7, '0'), W - 16, top);
    ctx.font = `800 ${Math.round(11 * ui)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('SCORE', W - 16, top + 28 * ui);
    if (state.title) {
      ctx.textAlign = 'left';
      ctx.font = `500 ${Math.round(12 * ui)}px ${FONT}`;
      ctx.fillText(ellipsis(ctx, state.title, W * 0.45), 64, top + 4);
    }
    const progress = Math.max(0, Math.min(1, now / state.duration));
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(64, top + 26 * ui, W * 0.4, 4);
    const pg = ctx.createLinearGradient(64, 0, 64 + W * 0.4, 0);
    pg.addColorStop(0, '#ff6fb5');
    pg.addColorStop(1, '#5ce1ff');
    ctx.fillStyle = pg;
    ctx.fillRect(64, top + 26 * ui, W * 0.4 * progress, 4);

    // コンボ
    const midY = this.horizonY + (this.judgeY - this.horizonY) * 0.42;
    if (game.combo >= 3) {
      const bump = 1 + 0.18 * this.comboBump;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(this.cx, midY);
      ctx.scale(bump, bump);
      ctx.font = `800 ${Math.round(56 * ui)}px ${FONT}`;
      const cg = ctx.createLinearGradient(0, -30 * ui, 0, 30 * ui);
      cg.addColorStop(0, '#ffffff');
      cg.addColorStop(1, '#ffc6e6');
      ctx.fillStyle = cg;
      ctx.globalAlpha = 0.9;
      ctx.fillText(String(game.combo), 0, 0);
      ctx.restore();
      ctx.font = `800 ${Math.round(13 * ui)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.textAlign = 'center';
      ctx.fillText('COMBO', this.cx, midY + 38 * ui);
    }

    // 判定文字
    if (this.popup) {
      const age = now - this.popup.t;
      if (age > 0.5 || age < 0) {
        this.popup = null;
      } else {
        const k = Math.min(1, age / 0.08);
        const scale = 0.7 + 0.3 * easeOutBack(k);
        ctx.save();
        ctx.translate(this.cx, midY + 80 * ui);
        ctx.scale(scale, scale);
        ctx.globalAlpha = age > 0.35 ? (0.5 - age) / 0.15 : 1;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${Math.round(30 * ui)}px ${FONT}`;
        ctx.lineWidth = 5 * ui;
        ctx.strokeStyle = 'rgba(20, 8, 40, 0.8)';
        ctx.strokeText(this.popup.grade, 0, 0);
        ctx.fillStyle = GRADE_COLORS[this.popup.grade];
        ctx.fillText(this.popup.grade, 0, 0);
        ctx.restore();
      }
    }

    // 開始前のカウント
    if (now < 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(40 * ui)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText('READY', this.cx, midY);
    }
  }
}

function lastIndexAtOrBefore(sorted, t) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function easeOutBack(k) {
  const c = 1.70158;
  return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
}

function ellipsis(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}
