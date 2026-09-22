// ソ連テーマの演出。
//   - 鎌と金槌: ステージ奥に置き、コンボが続くほど金色に輝く。50 コンボごとに光が弾ける
//   - シベリア送り: MISS が続くと画面が凍りつき、雪とともに表示される
// 記号は端末によってフォントに無いことがある(☭ が □ になる)ので、図形で描く。

// コンボごとの演出の段階
//   10 コンボごとに一段大きくなり画面中央へ寄る(GROW_STEPS 段で最大)
//   50 でずっと輝き、100・200 でさらに輝く。各段に達した瞬間は光が弾ける
const GROW_EVERY = 10;
const GROW_STEPS = 10;
export const SHINE_TIERS = [50, 100, 200];
// 連続 MISS がこの数に達するたびにシベリア送り
export const SIBERIA_STREAK = 8;
// リザルトでシベリア送りになる MISS の割合
export const SIBERIA_MISS_RATE = 0.3;
const SIBERIA_SECONDS = 2.6;

// 100×100 の枠に描く鎌と金槌。部品ごとに別のパスにする
// (一つのパスにまとめると、回る向きが逆の部品が重なった所が穴になる)
function emblemParts() {
  const rad = (deg) => (deg * Math.PI) / 180;
  const polygon = (pts) => {
    const path = new Path2D();
    pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    path.closePath();
    return path;
  };

  // 鎌の刃: 左下の柄から下・右・上を回って左上の先端へ。先端ほど細くなる三日月
  const blade = new Path2D();
  blade.arc(52, 48, 34, rad(135), rad(225), true);
  blade.arc(47, 44, 27, rad(225), rad(135), false);
  blade.closePath();

  // 金槌の柄(左上から右下へ)。端は丸める
  const handle = new Path2D();
  handle.moveTo(31, 38);
  handle.lineTo(38, 31);
  handle.lineTo(84, 77);
  handle.quadraticCurveTo(84, 84, 77, 84);
  handle.closePath();

  return [
    blade,
    polygon([[23, 64], [32, 72], [19, 86], [10, 78]]), // 鎌の柄
    handle,
    polygon([[17, 36], [36, 17], [45, 26], [26, 45]]), // 金槌の頭(柄に直交する)
  ];
}

export class Emblem {
  constructor() {
    this.parts = typeof Path2D === 'function' ? emblemParts() : null;
    this.sparkles = Array.from({ length: 10 }, (_, i) => ({ a: (i / 10) * Math.PI * 2, r: 0.75 + (i % 3) * 0.12 }));
    this.reset();
  }

  reset() {
    this.grow = 0; // 0: 奥で小さい 〜 1: 中央で最大
    this.glow = 0;
    this.flash = 0;
    this.bump = 0;
    this.combo = 0;
    this.tier = 0;
  }

  update(dt, combo) {
    const prev = this.combo;
    this.combo = combo;
    const step = Math.min(Math.floor(combo / GROW_EVERY), GROW_STEPS);
    if (step > Math.min(Math.floor(prev / GROW_EVERY), GROW_STEPS)) this.bump = 1;
    for (const t of SHINE_TIERS) if (prev < t && combo >= t) this.flash = 1;
    this.tier = SHINE_TIERS.filter((t) => combo >= t).length;

    // 大きくなる時はふわっと、コンボが切れたらすっと戻る
    const growTarget = step / GROW_STEPS;
    this.grow += (growTarget - this.grow) * Math.min(1, (growTarget > this.grow ? 4 : 6) * dt);
    // 50 コンボまではだんだん光り、そこからはずっと輝く
    const glowTarget = this.tier ? 1 : Math.max(0, (combo - GROW_EVERY) / (SHINE_TIERS[0] - GROW_EVERY)) * 0.6;
    this.glow += (glowTarget - this.glow) * Math.min(1, (glowTarget > this.glow ? 2 : 5) * dt);
    this.flash = Math.max(0, this.flash - dt * 1.2);
    this.bump = Math.max(0, this.bump - dt * 4);
  }

  // layout: { cx, topY, centerY, minSize, maxSize }
  draw(ctx, layout, pulse, now) {
    if (!this.parts) return;
    const g = this.glow;
    const f = this.flash;
    const tier = this.tier;
    const ease = 1 - (1 - this.grow) ** 2;
    const size = (layout.minSize + (layout.maxSize - layout.minSize) * ease) * (1 + 0.12 * this.bump);
    const cx = layout.cx;
    const cy = layout.topY + (layout.centerY - layout.topY) * ease;
    const shine = Math.min(1.6, g * (0.75 + 0.25 * pulse) + f + 0.25 * Math.max(0, tier - 1));

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (shine > 0.02) {
      // 後光。段階が上がるほど大きく白く
      const r = size * (0.85 + 0.25 * tier + 0.5 * f);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const core = tier >= 2 ? '255, 245, 210' : '255, 200, 80';
      grad.addColorStop(0, `rgba(${core}, ${0.4 * Math.min(1, shine)})`);
      grad.addColorStop(0.5, `rgba(255, 70, 40, ${0.16 * Math.min(1, shine)})`);
      grad.addColorStop(1, 'rgba(255, 60, 40, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // 光線。100 で本数が増え、200 で赤い光線が逆回転で重なる
      const spin = now * 0.25;
      this.rays(ctx, cx, cy, r * 1.35, tier >= 2 ? 18 : 12, spin, `rgba(255, 220, 130, ${0.1 * Math.min(1, shine)})`);
      if (tier >= 3) this.rays(ctx, cx, cy, r * 1.6, 9, -spin * 1.6, `rgba(255, 70, 60, ${0.12 * (0.7 + 0.3 * pulse)})`);
    }

    // 200 コンボ以上は周りを星が回る
    if (tier >= 3) {
      for (const sp of this.sparkles) {
        const a = sp.a + now * 0.9;
        const x = cx + Math.cos(a) * size * sp.r;
        const y = cy + Math.sin(a) * size * sp.r * 0.9;
        star(ctx, x, y, size * 0.05 * (0.7 + 0.5 * pulse), '#fff4c0');
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // 本体。光っていない時は暗い赤のシルエット、光るほど金色、100 以上は白金に近づく
    const k = Math.max(g, f);
    const whiten = tier >= 2 ? 0.35 + 0.15 * pulse : 0;
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 100, size / 100);
    const fill = ctx.createLinearGradient(0, 0, 100, 100);
    fill.addColorStop(0, mix(mix3([120, 30, 40], [255, 236, 160], k), [255, 255, 245], whiten));
    fill.addColorStop(1, mix(mix3([90, 20, 30], [255, 165, 35], k), [255, 225, 150], whiten));
    // 大きくなって譜面に重なっても邪魔しすぎないよう、不透明度は上限を設ける
    ctx.globalAlpha = (0.25 + 0.65 * k) * (1 - 0.15 * ease);
    if (k > 0.05) {
      ctx.shadowColor = tier >= 2 ? 'rgba(255, 240, 190, 0.95)' : 'rgba(255, 190, 60, 0.9)';
      // shadowBlur は座標変換の影響を受けないので、画面上の px で指定する
      ctx.shadowBlur = (6 + 20 * Math.min(1.5, shine)) * (size / 100);
    }
    ctx.fillStyle = fill;
    for (const part of this.parts) ctx.fill(part);
    ctx.restore();
  }

  rays(ctx, cx, cy, r, count, spin, color) {
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const a = spin + (i / count) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a - 0.06, a + 0.06);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function star(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = i % 2 ? r * 0.35 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
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

function mix3(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

function mix(a, b, t) {
  const c = mix3(a, b, t).map(Math.round);
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
