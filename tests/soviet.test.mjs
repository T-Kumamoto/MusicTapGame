import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emblem } from '../js/soviet.js';

// 1 秒あたり 10 コンボ、60fps で進める
function play(emblem, from, to) {
  for (let c = from; c <= to; c++) for (let i = 0; i < 6; i++) emblem.update(1 / 60, c);
}

test('10 コンボごとに大きくなり、100 コンボで最大になる', () => {
  const e = new Emblem();
  play(e, 0, 9);
  assert.ok(e.grow < 0.01);
  play(e, 10, 55);
  const mid = e.grow;
  assert.ok(mid > 0.3 && mid < 0.6, `grow ${mid}`);
  play(e, 56, 140);
  for (let i = 0; i < 120; i++) e.update(1 / 60, 140);
  assert.ok(e.grow > 0.99, `grow ${e.grow}`);
});

test('50 でずっと輝き、100・200 で段階が上がって光が弾ける', () => {
  const e = new Emblem();
  play(e, 0, 49);
  assert.equal(e.tier, 0);
  assert.ok(e.glow < 0.7);
  e.update(1 / 60, 50);
  assert.equal(e.tier, 1);
  assert.equal(e.flash, 1 - 1.2 / 60);
  play(e, 51, 99);
  assert.ok(e.glow > 0.95);
  e.update(1 / 60, 100);
  assert.equal(e.tier, 2);
  play(e, 101, 200);
  assert.equal(e.tier, 3);
});

test('コンボが切れたら奥へ戻って暗くなる', () => {
  const e = new Emblem();
  play(e, 0, 120);
  for (let i = 0; i < 90; i++) e.update(1 / 60, 0);
  assert.equal(e.tier, 0);
  assert.ok(e.grow < 0.01 && e.glow < 0.01, `grow ${e.grow} glow ${e.glow}`);
});
