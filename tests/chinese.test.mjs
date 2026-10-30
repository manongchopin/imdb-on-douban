import test from 'node:test';
import assert from 'node:assert/strict';

import { CHINESE_TOP100 } from '../data/top100-chinese.js';

test('华语榜结构正确：100 条、名次连续、id 唯一', () => {
  const items = CHINESE_TOP100.items;
  assert.equal(items.length, 100);
  assert.deepEqual(
    items.map((i) => i.rank),
    Array.from({ length: 100 }, (_, i) => i + 1)
  );
  assert.equal(new Set(items.map((i) => i.id)).size, 100);
  assert.equal(items.every((i) => /^tt\d{6,10}$/.test(i.id)), true);
});

test('华语榜按加权分降序，且记录了规则', () => {
  const items = CHINESE_TOP100.items;
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i - 1].score >= items[i].score, `第 ${i + 1} 条顺序不对`);
  }
  assert.equal(CHINESE_TOP100.rule.minVotes, 2000);
  assert.equal(CHINESE_TOP100.rule.m, 2500);
  // 入榜的最低票数不能低于门槛
  assert.ok(items.every((i) => i.votes >= CHINESE_TOP100.rule.minVotes));
});

test('经典华语片在榜内', () => {
  const byId = new Map(CHINESE_TOP100.items.map((i) => [i.id, i]));
  assert.equal(byId.get('tt0110081').rank, 1); // 活着
  assert.equal(byId.get('tt0106332').rank, 4); // 霸王别姬
  assert.ok(byId.has('tt0118694')); // 花样年华
  assert.ok(byId.has('tt0109424')); // 无间道
});
