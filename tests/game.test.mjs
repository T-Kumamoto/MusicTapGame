import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, rankOf } from '../js/game.js';

const chart = (notes) => ({ lanes: 5, notes });

test('判定幅に応じて PERFECT/GREAT/GOOD になり、遅れた GOOD も取れる', () => {
  const g = new Game(chart([
    { t: 1, lane: 0, type: 'tap' },
    { t: 2, lane: 1, type: 'tap' },
    { t: 3, lane: 2, type: 'tap' },
  ]));
  g.press('a', 0, 1.03);
  g.update(1.9);
  g.press('b', 1, 2.08);
  // 以前の実装では 0.15 秒で MISS になり、遅れの GOOD が取れなかった
  g.update(3.13);
  g.press('c', 2, 3.14);
  assert.deepEqual(g.counts, { PERFECT: 1, GREAT: 1, GOOD: 1, MISS: 0 });
  assert.equal(g.combo, 3);
});

test('叩かなかったノーツは MISS になりコンボが切れる', () => {
  const g = new Game(chart([
    { t: 1, lane: 0, type: 'tap' },
    { t: 2, lane: 0, type: 'tap' },
  ]));
  g.press('a', 0, 1);
  g.update(2.2);
  assert.equal(g.counts.MISS, 1);
  assert.equal(g.combo, 0);
  assert.ok(g.finished);
});

test('判定オフセットの分だけずらして判定する', () => {
  const g = new Game(chart([{ t: 1, lane: 0, type: 'tap' }]), { offset: 0.08 });
  g.press('a', 0, 1.08);
  assert.equal(g.counts.PERFECT, 1);
});

test('ロングは終点まで押し続ければ始点と終点の 2 判定', () => {
  const g = new Game(chart([{ t: 1, lane: 2, type: 'hold', end: 2 }]));
  g.press('a', 2, 1);
  g.update(1.5);
  g.move('a', 3, false, 1.5); // 隣のレーンへのずれは許す
  g.update(2.01);
  assert.equal(g.counts.PERFECT, 2);
  assert.ok(g.finished);
});

test('ロングを途中で離すと終点が MISS', () => {
  const g = new Game(chart([{ t: 1, lane: 2, type: 'hold', end: 2 }]));
  g.press('a', 2, 1);
  g.release('a', 1.4);
  assert.deepEqual(g.counts, { PERFECT: 1, GREAT: 0, GOOD: 0, MISS: 1 });
});

test('フリックは弾けば押した時刻で判定、弾かなければ GOOD', () => {
  const g = new Game(chart([
    { t: 1, lane: 0, type: 'flick' },
    { t: 2, lane: 0, type: 'flick' },
  ]));
  g.press('a', 0, 1.01);
  g.move('a', 0, true, 1.05);
  g.press('b', 0, 2.0);
  g.update(2.4);
  assert.deepEqual(g.counts, { PERFECT: 1, GREAT: 0, GOOD: 1, MISS: 0 });
});

test('同時押しは別々の指でそれぞれ取れる', () => {
  const g = new Game(chart([
    { t: 1, lane: 0, type: 'tap' },
    { t: 1, lane: 4, type: 'tap' },
  ]));
  g.press('a', 0, 1);
  g.press('b', 4, 1.01);
  assert.equal(g.counts.PERFECT, 2);
});

test('オートプレイは全部 PERFECT', () => {
  const g = new Game(chart([
    { t: 1, lane: 0, type: 'tap' },
    { t: 1.5, lane: 1, type: 'hold', end: 2.5 },
    { t: 3, lane: 2, type: 'flick' },
  ]), { auto: true, offset: 0.1 });
  for (let t = 0; t <= 3.5; t += 1 / 60) g.update(t);
  assert.equal(g.counts.PERFECT, 4);
  assert.equal(g.score, 1000000);
  assert.equal(rankOf(g.score), 'S');
});

test('連続 MISS を数え、成功で 0 に戻る', () => {
  const notes = Array.from({ length: 10 }, (_, i) => ({ t: 1 + i, lane: 0, type: 'tap' }));
  const g = new Game(chart(notes));
  g.update(8.5); // 1〜8 秒のノーツが MISS
  assert.equal(g.missStreak, 8);
  assert.equal(g.events.filter((e) => e.type === 'judge').at(-1).missStreak, 8);
  g.press('a', 0, 9);
  assert.equal(g.missStreak, 0);
});
