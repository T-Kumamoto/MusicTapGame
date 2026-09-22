// タッチ(マルチタッチ)・マウス・キーボードを「レーンを押した/動かした/離した」に変換する。
// 時刻はイベント発生時刻(event.timeStamp)から求め、処理の遅れが判定に乗らないようにする。

const KEYS = ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'];
// フリックと見なす指の移動量(CSS px)
const FLICK_PX = 28;

export class Input {
  constructor(canvas, renderer, audio) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.audio = audio;
    this.game = null;
    this.touches = new Map();

    canvas.addEventListener('pointerdown', (e) => this.onDown(e), { passive: false });
    canvas.addEventListener('pointermove', (e) => this.onMove(e), { passive: false });
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
  }

  attach(game) {
    this.game = game;
    this.touches.clear();
  }

  detach() {
    this.game = null;
    this.touches.clear();
  }

  time(e) {
    // 古いブラウザでは timeStamp がエポック基準のことがあるので、その時は今の時刻を使う
    const now = performance.now();
    const ts = e.timeStamp;
    return this.audio.songTime(ts > 0 && ts <= now + 50 && ts > now - 1000 ? ts : now);
  }

  lane(x) {
    const f = this.renderer.laneAt(x);
    const lanes = this.renderer.lanes;
    if (f < -0.75 || f > lanes + 0.75) return null;
    return Math.max(0, Math.min(lanes - 1, Math.floor(f)));
  }

  onDown(e) {
    if (!this.game) return;
    e.preventDefault();
    const lane = this.lane(e.clientX);
    if (lane === null) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // 一部のブラウザは合成イベントで失敗する
    }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, flicked: false });
    this.game.press(e.pointerId, lane, this.time(e));
  }

  onMove(e) {
    const touch = this.touches.get(e.pointerId);
    if (!this.game || !touch) return;
    e.preventDefault();
    const lane = this.lane(e.clientX);
    const travel = Math.hypot(e.clientX - touch.x, e.clientY - touch.y);
    const flicked = !touch.flicked && travel >= FLICK_PX;
    if (flicked) touch.flicked = true;
    this.game.move(e.pointerId, lane === null ? -99 : lane, flicked, this.time(e));
  }

  onUp(e) {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);
    if (this.game) this.game.release(e.pointerId, this.time(e));
  }

  onKey(e, down) {
    const lane = KEYS.indexOf(e.code);
    if (!this.game || lane < 0 || lane >= this.renderer.lanes) return;
    e.preventDefault();
    if (e.repeat) return;
    const id = `key-${e.code}`;
    const t = this.time(e);
    if (down) {
      this.game.press(id, lane, t);
      // キーボードではフリックできないので、押した時点で弾いたことにする
      this.game.move(id, lane, true, t);
    } else {
      this.game.release(id, t);
    }
  }
}
