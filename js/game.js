// 判定とスコア。描画や入力デバイスには依存しない(時刻とレーン番号だけを受け取る)。

export const WINDOW = { PERFECT: 0.05, GREAT: 0.1, GOOD: 0.15 };
const WEIGHT = { PERFECT: 1, GREAT: 0.75, GOOD: 0.4, MISS: 0 };
// ロングの終点はこれだけ早く離しても成功扱い
const HOLD_RELEASE_GRACE = 0.15;
// フリックは押してからこの秒数以内に指を動かせばよい
const FLICK_TIMEOUT = 0.25;
// ロング中に指が隣のレーンへずれても許す幅
const HOLD_LANE_TOLERANCE = 1;

export const RANKS = [
  ['S', 950000],
  ['A', 900000],
  ['B', 800000],
  ['C', 700000],
  ['D', 0],
];

export const rankOf = (score) => RANKS.find(([, min]) => score >= min)[0];

export function gradeOf(absDt) {
  if (absDt <= WINDOW.PERFECT) return 'PERFECT';
  if (absDt <= WINDOW.GREAT) return 'GREAT';
  return 'GOOD';
}

export class Game {
  constructor(chart, { offset = 0, auto = false } = {}) {
    // オートは時計そのもので叩くので、音と見た目のずれをそのまま確認できる
    this.offset = auto ? 0 : offset;
    this.auto = auto;
    this.lanes = chart.lanes;
    this.notes = chart.notes
      .map((n) => ({ ...n, state: 'pending' }))
      .sort((a, b) => a.t - b.t);
    this.notes.forEach((n, i) => (n.id = i));
    this.byLane = Array.from({ length: this.lanes }, () => []);
    for (const n of this.notes) this.byLane[n.lane].push(n);
    this.laneCursor = new Array(this.lanes).fill(0);

    // ロングは始点と終点の 2 回判定する
    this.total = this.notes.length + this.notes.filter((n) => n.type === 'hold').length;
    this.counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
    this.combo = 0;
    this.maxCombo = 0;
    this.missStreak = 0;
    this.weightSum = 0;
    this.judged = 0;
    this.timing = [];
    this.events = [];
    this.pointers = new Map();
    this.missCursor = 0;
    this.autoHolds = new Set();
  }

  get score() {
    return this.total ? Math.round((1e6 * this.weightSum) / this.total) : 0;
  }

  get finished() {
    return this.judged >= this.total;
  }

  heldLanes() {
    const lanes = new Set();
    for (const p of this.pointers.values()) lanes.add(p.lane);
    for (const n of this.autoHolds) lanes.add(n.lane);
    return lanes;
  }

  record(grade, note, part, dt = null) {
    this.counts[grade]++;
    this.judged++;
    this.weightSum += WEIGHT[grade];
    if (grade === 'MISS') {
      this.combo = 0;
      this.missStreak++;
    } else {
      this.maxCombo = Math.max(this.maxCombo, ++this.combo);
      this.missStreak = 0;
    }
    if (dt !== null) this.timing.push(dt);
    this.events.push({
      type: 'judge',
      grade,
      lane: note.lane,
      kind: note.type,
      part,
      combo: this.combo,
      missStreak: this.missStreak,
    });
  }

  press(pointerId, lane, t) {
    const at = t - this.offset;
    const ptr = { lane, hold: null, flick: null };
    this.pointers.set(pointerId, ptr);
    this.events.push({ type: 'press', lane });
    if (this.auto) return;

    const target = this.findTarget(lane, at);
    if (!target) return;
    const dt = at - target.t;
    const grade = gradeOf(Math.abs(dt));
    if (target.type === 'tap') {
      target.state = 'done';
      this.record(grade, target, 'head', dt);
    } else if (target.type === 'hold') {
      target.state = 'holding';
      ptr.hold = target;
      this.record(grade, target, 'head', dt);
    } else if (target.type === 'flick') {
      target.state = 'flicking';
      ptr.flick = { note: target, grade, dt, at };
    }
  }

  // flicked: 押した位置から指がしきい値以上動いたら true
  move(pointerId, lane, flicked, t) {
    const ptr = this.pointers.get(pointerId);
    if (!ptr) return;
    ptr.lane = lane;
    if (ptr.flick && flicked) {
      const { note, grade, dt } = ptr.flick;
      note.state = 'done';
      ptr.flick = null;
      this.record(grade, note, 'head', dt);
    }
    if (ptr.hold && Math.abs(lane - ptr.hold.lane) > HOLD_LANE_TOLERANCE) this.release(pointerId, t);
  }

  release(pointerId, t) {
    const ptr = this.pointers.get(pointerId);
    if (!ptr) return;
    const at = t - this.offset;
    if (ptr.flick) this.failFlick(ptr);
    if (ptr.hold) {
      const hold = ptr.hold;
      hold.state = 'done';
      ptr.hold = null;
      this.record(at >= hold.end - HOLD_RELEASE_GRACE ? 'PERFECT' : 'MISS', hold, 'tail');
    }
    this.pointers.delete(pointerId);
  }

  // 押したが弾かなかったフリックは GOOD 扱い(コンボは繋がる)
  failFlick(ptr) {
    const { note, dt } = ptr.flick;
    note.state = 'done';
    ptr.flick = null;
    this.record('GOOD', note, 'head', dt);
  }

  findTarget(lane, at) {
    const list = this.byLane[lane];
    let i = this.laneCursor[lane];
    while (i < list.length && list[i].state !== 'pending') i++;
    this.laneCursor[lane] = i;
    let best = null;
    let bestAbs = Infinity;
    for (; i < list.length; i++) {
      const n = list[i];
      const dt = at - n.t;
      if (dt < -WINDOW.GOOD) break;
      if (n.state !== 'pending') continue;
      if (Math.abs(dt) <= WINDOW.GOOD && Math.abs(dt) < bestAbs) {
        best = n;
        bestAbs = Math.abs(dt);
      }
    }
    return best;
  }

  update(t) {
    const at = t - this.offset;

    if (this.auto) this.autoPlay(t);

    // 判定幅を過ぎても叩かれなかったノーツは MISS
    const notes = this.notes;
    let i = this.missCursor;
    for (; i < notes.length && notes[i].t < at - WINDOW.GOOD; i++) {
      const n = notes[i];
      if (n.state !== 'pending') continue;
      n.state = 'done';
      n.missed = true;
      this.record('MISS', n, 'head');
      if (n.type === 'hold') this.record('MISS', n, 'tail');
    }
    this.missCursor = i;

    for (const ptr of this.pointers.values()) {
      if (ptr.flick && at - ptr.flick.at > FLICK_TIMEOUT) this.failFlick(ptr);
      // 終点まで押し続けたら離すのを待たずに成功
      if (ptr.hold && at >= ptr.hold.end) {
        ptr.hold.state = 'done';
        this.record('PERFECT', ptr.hold, 'tail');
        ptr.hold = null;
      }
    }
  }

  autoPlay(t) {
    const notes = this.notes;
    for (let i = this.missCursor; i < notes.length && notes[i].t <= t; i++) {
      const n = notes[i];
      if (n.state !== 'pending') continue;
      this.events.push({ type: 'press', lane: n.lane });
      if (n.type === 'hold') {
        n.state = 'holding';
        this.autoHolds.add(n);
      } else {
        n.state = 'done';
      }
      this.record('PERFECT', n, 'head', 0);
    }
    for (const n of this.autoHolds) {
      if (t >= n.end) {
        n.state = 'done';
        this.autoHolds.delete(n);
        this.record('PERFECT', n, 'tail');
      }
    }
  }

  timingStats() {
    if (!this.timing.length) return null;
    const mean = this.timing.reduce((a, b) => a + b, 0) / this.timing.length;
    return { meanMs: Math.round(mean * 1000), count: this.timing.length };
  }
}
