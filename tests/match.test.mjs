import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize, similarity, pickBest, scoreCandidate, firstYear, candidateImdbId } from '../src/lib/match.js';

const SHAWSHANK = { titles: ['肖申克的救赎', 'The Shawshank Redemption'], year: 1994, kinds: ['movie'] };

const OMDB_RESULTS = [
  { imdbID: 'tt5443390', Title: 'The Shawshank Redemption: Cast Interviews', Year: '2004', Type: 'movie' },
  { imdbID: 'tt0111161', Title: 'The Shawshank Redemption', Year: '1994', Type: 'movie' },
  { imdbID: 'tt0265738', Title: 'The SharkTank Redemption', Year: '2000', Type: 'short' },
  { imdbID: 'tt9999999', Title: 'The Shawshank Redemption', Year: '1994', Type: 'episode' },
];

test('normalize 去标点、去冠词、统一大小写', () => {
  assert.equal(normalize('The Shawshank Redemption'), 'shawshank redemption');
  assert.equal(normalize('肖申克的救赎（1994）'), '肖申克的救赎');
  assert.equal(normalize('A.I. 人工智能'), 'a i 人工智能');
  assert.equal(normalize(''), '');
});

test('similarity：完全相同为 1，无关为接近 0', () => {
  assert.equal(similarity('The Shawshank Redemption', 'the shawshank redemption'), 1);
  assert.ok(similarity('The Shawshank Redemption', 'The Shawshank Redemption: Cast Interviews') > 0.6);
  assert.ok(similarity('肖申克的救赎', '肖申克的救赎') === 1);
  assert.ok(similarity('肖申克的救赎', '泰坦尼克号') < 0.2);
});

test('year 解析支持区间和单值', () => {
  assert.equal(firstYear('1994'), 1994);
  assert.equal(firstYear('2008–2013'), 2008);
  assert.equal(firstYear('N/A'), null);
});

test('pickBest 选中正确的条目，跳过同名特辑和集', () => {
  const { best, confident } = pickBest(OMDB_RESULTS, SHAWSHANK);
  assert.equal(best.imdbID, 'tt0111161');
  assert.equal(confident, true);
  assert.equal(candidateImdbId(best), 'tt0111161');
});

test('pickBest 在年份不一致时降低分数但仍可选中唯一候选', () => {
  const results = [{ imdbID: 'tt0000001', Title: 'Dune', Year: '1984', Type: 'movie' }];
  const hit = pickBest(results, { titles: ['Dune'], year: 1984, kinds: ['movie'] });
  assert.equal(hit.best.imdbID, 'tt0000001');
  assert.equal(hit.confident, true);

  const miss = pickBest(results, { titles: ['Dune'], year: 2021, kinds: ['movie'] });
  assert.equal(miss.confident, false);
});

test('中文片名 + 英文又名都能命中', () => {
  const results = [{ imdbID: 'tt0133093', Title: 'The Matrix', Year: '1999', Type: 'movie' }];
  const target = { titles: ['黑客帝国', 'The Matrix', '22世纪杀人网络'], year: 1999, kinds: ['movie'] };
  assert.equal(pickBest(results, target).best.imdbID, 'tt0133093');
});

test('完全无关的搜索结果不会被误判为匹配', () => {
  const results = [{ imdbID: 'tt0000002', Title: 'Totally Different Movie', Year: '1994', Type: 'movie' }];
  const hit = pickBest(results, SHAWSHANK);
  assert.equal(hit.confident, false);
});

test('scoreCandidate 对 episode 类型降权', () => {
  const base = { imdbID: 'tt1', Title: 'Dune', Year: '2021' };
  const movie = scoreCandidate({ ...base, Type: 'movie' }, { titles: ['Dune'], year: 2021, kinds: ['movie'] });
  const episode = scoreCandidate({ ...base, Type: 'episode' }, { titles: ['Dune'], year: 2021, kinds: ['movie'] });
  assert.ok(movie.score > episode.score);
});
