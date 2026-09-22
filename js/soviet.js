// ソ連テーマの演出。
//   - 鎌と金槌: ステージ奥に置き、コンボが続くほど金色に輝く。50 コンボごとに光が弾ける
//   - シベリア送り: MISS が続くと画面が凍りつき、雪とともに表示される
// 記号は端末によってフォントに無いことがある(☭ が □ になる)ので、図形で描く。

// 何コンボから光り始め、何コンボで最大になるか
const GLOW_START = 10;
const GLOW_FULL = 100;
export const COMBO_BURST_EVERY = 50;
// 連続 MISS がこの数に達するたびにシベリア送り
export const SIBERIA_STREAK = 8;
// リザルトでシベリア送りになる MISS の割合
export const SIBERIA_MISS_RATE = 0.3;
const SIBERIA_SECONDS = 2.6;

// 100×100 の枠に描く鎌と金槌
function emblemPath() {
  const p = new Path2D();
  const rad = (deg) => (deg * Math.PI) / 180;
  // 鎌の刃: 左下の柄から下・右・上を回って左上の先端へ。先端ほど細くなる三日月
  p.arc(52, 48, 34, rad(135), rad(225), true);
  p.arc(47, 44, 27, rad(225), rad(135), false);
  p.closePath();
  // 鎌の柄
  p.moveTo(23, 64);
  p.lineTo(32, 72);
  p.lineTo(19, 86);
  p.lineTo(10, 78);
  p.closePath();
  // 金槌の柄(左上から右下へ)
  p.moveTo(31, 38);
  p.lineTo(38, 31);
  p.lineTo(84, 77);
  p.quadraticCurveTo(84, 84, 77, 84);
  p.closePath();
  // 金槌の頭(柄に直交する)
  p.moveTo(17, 36);
  p.lineTo(36, 17);
  p.lineTo(45, 26);
  p.lineTo(26, 45);
  p.closePath();
  return p;
}

export class Emblem {
  constructor() {
    this.path = typeof Path2D === 'function' ? emblemPath() : null;
    this.glow = 0;
    this.flash = 0;
  }

  reset() {
    this.glow = 0;
    this.flash = 0;
  }

  burst() {
    this.flash = 1;
  }

  update(dt, combo) {
    const target = Math.max(0, Math.min(1, (combo - GLOW_START) / (GLOW_FULL - GLOW_START)));
    // 光り始めはゆっくり、コンボが切れたらすっと消える
    const rate = target > this.glow ? 1.5 : 4;
    this.glow += (target - this.glow) * Math.min(1, rate * dt);
    this.flash = Math.max(0, this.flash - dt * 1.4);
  }

  draw(ctx, cx, cy, size, pulse) {
    if (!this.path) return;
    const g = this.glow;
    const f = this.flash;
    const scale = size / 100;

    ctx.save();
    // 後光(輝いている時だけ)
    const halo = Math.min(1, g * (0.6 + 0.4 * pulse) + f);
    if (halo > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      const r = size * (0.9 + 0.5 * f);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(255, 200, 80, ${0.45 * halo})`);
      grad.addColorStop(0.5, `rgba(255, 60, 40, ${0.18 * halo})`);
      grad.addColorStop(1, 'rgba(255, 60, 40, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      // 放射状の光線
      const rays = 12;
      ctx.fillStyle = `rgba(255, 215, 120, ${0.12 * halo})`;
      const spin = performance.now() / 4000;
      for (let i = 0; i < rays; i++) {
        const a = spin + (i / rays) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r * 1.3, a - 0.07, a + 0.07);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(scale, scale);
    // 光っていない時は暗い赤のシルエット、光るほど金色に
    const alpha = 0.22 + 0.78 * Math.max(g, f);
    const fill = ctx.createLinearGradient(0, 0, 100, 100);
    fill.addColorStop(0, mix([120, 30, 40], [255, 240, 170], Math.max(g, f)));
    fill.addColorStop(1, mix([90, 20, 30], [255, 170, 40], Math.max(g, f)));
    ctx.globalAlpha = alpha;
    if (g > 0.05 || f > 0) {
      ctx.shadowColor = 'rgba(255, 190, 60, 0.9)';
      // shadowBlur は座標変換の影響を受けないので、画面上の px で指定する
      ctx.shadowBlur = (6 + 22 * Math.max(g * (0.7 + 0.3 * pulse), f)) * scale;
    }
    ctx.fillStyle = fill;
    ctx.fill(this.path);
    ctx.restore();
  }
}

export class Siberia {
  constructor() {
    this.t = 0;
    this.flakes = [];
  }

  reset() {
    this.t = 0;
    this.flakes = [];
  }

  trigger(W, H) {
    this.t = SIBERIA_SECONDS;
    this.flakes = Array.from({ length: 90 }, () => ({
      x: Math.random() * W,
      y: Math.random() * -H,
      v: 60 + Math.random() * 140,
      drift: (Math.random() - 0.5) * 40,
      r: 1.5 + Math.random() * 3,
    }));
  }

  update(dt) {
    if (this.t <= 0) return;
    this.t = Math.max(0, this.t - dt);
    for (const f of this.flakes) {
      f.y += f.v * dt;
      f.x += f.drift * dt;
    }
  }

  draw(ctx, W, H, ui) {
    if (this.t <= 0) return;
    const age = SIBERIA_SECONDS - this.t;
    // 出だしは素早く凍り、最後の 0.6 秒で溶ける
    const k = Math.min(1, age / 0.2) * Math.min(1, this.t / 0.6);

    ctx.save();
    const frost = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75);
    frost.addColorStop(0, `rgba(170, 220, 255, ${0.12 * k})`);
    frost.addColorStop(1, `rgba(210, 240, 255, ${0.55 * k})`);
    ctx.fillStyle = frost;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * k})`;
    for (const f of this.flakes) {
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * ui, 0, Math.PI * 2);
      ctx.fill();
    }

    const shake = age < 0.5 ? (0.5 - age) * 14 * ui : 0;
    const x = W / 2 + (Math.random() - 0.5) * shake;
    const y = H * 0.4 + (Math.random() - 0.5) * shake;
    const size = Math.round(Math.min(W / 7.5, 64 * ui));
    ctx.globalAlpha = k;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${size}px "M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", "Yu Gothic UI", sans-serif`;
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = 'rgba(10, 30, 60, 0.85)';
    ctx.strokeText('シベリア送り', x, y);
    const g = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#8fd3ff');
    ctx.fillStyle = g;
    ctx.fillText('シベリア送り', x, y);
    ctx.font = `800 ${Math.round(size * 0.3)}px "M PLUS Rounded 1c", sans-serif`;
    ctx.fillStyle = '#d8f0ff';
    ctx.fillText(`${SIBERIA_STREAK} 連続 MISS`, x, y + size * 0.85);
    ctx.restore();
  }
}

function mix(a, b, t) {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
