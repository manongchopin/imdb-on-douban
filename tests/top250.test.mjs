import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRankIndex,
  compact,
  findRank,
  isValidTop250,
  parseChartHtml,
} from '../src/lib/top250.js';
import { TOP250 } from '../data/top250.js';

function chartHtml(edges) {
  const payload = { props: { pageProps: { pageData: { chartTitles: { edges } } } } };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    payload
  )}</script></body></html>`;
}

const EDGES = [
  {
    currentRank: 2,
    node: { id: 'tt0068646', titleText: { text: 'The Godfather' }, releaseYear: { year: 1972 } },
  },
  {
    currentRank: 1,
    node: {
      id: 'tt0111161',
      titleText: { text: 'The Shawshank Redemption' },
      releaseYear: { year: 1994 },
    },
  },
];

test('parseChartHtml 解析榜单并按名次排序', () => {
  const items = parseChartHtml(chartHtml(EDGES));
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => [i.rank, i.id]),
    [
      [1, 'tt0111161'],
      [2, 'tt0068646'],
    ]
  );
  assert.equal(items[0].title, 'The Shawshank Redemption');
  assert.equal(items[0].year, 1994);
});

test('parseChartHtml 对挑战页 / 空页面返回 null', () => {
  assert.equal(parseChartHtml('<html>awsWaf challenge</html>'), null);
  assert.equal(parseChartHtml(''), null);
  assert.equal(parseChartHtml('<script id="__NEXT_DATA__">not json</script>'), null);
  assert.equal(
    parseChartHtml('<script id="__NEXT_DATA__">{"props":{"pageProps":{}}}</script>'),
    null
  );
});

test('parseChartHtml 跳过非法 id', () => {
  const items = parseChartHtml(
    chartHtml([
      { currentRank: 1, node: { id: 'tt0111161', titleText: { text: 'A' } } },
      { currentRank: 2, node: { id: 'nm0000206', titleText: { text: 'B' } } },
      { currentRank: 3, node: {} },
    ])
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'tt0111161');
});

test('isValidTop250 拦住残缺数据', () => {
  assert.equal(isValidTop250(EDGES.map((e) => ({ rank: e.currentRank, id: e.node.id }))), false);
  assert.equal(isValidTop250(null), false);

  const real = TOP250.items;
  assert.equal(isValidTop250(real), true);
  assert.equal(real.length, 250);
  assert.equal(real[0].rank, 1);
  assert.equal(real[0].id, 'tt0111161');
});

test('buildRankIndex / findRank 查名次', () => {
  const items = parseChartHtml(chartHtml(EDGES));
  const map = buildRankIndex(items);
  assert.equal(map.get('tt0111161'), 1);
  assert.equal(map.get('tt0068646'), 2);
  assert.equal(findRank(items, 'tt0111161'), 1);
  assert.equal(findRank(items, 'tt9999999'), null);
  assert.equal(findRank(items, ''), null);
});

test('compact 只保留展示需要的字段', () => {
  const [item] = compact([
    { rank: 1, id: 'tt0111161', title: 'X', year: 1994, extra: '不要', poster: '不要' },
  ]);
  assert.deepEqual(Object.keys(item).sort(), ['id', 'rank', 'title', 'year']);
});

test('内置快照里经典片的名次符合预期', () => {
  const map = buildRankIndex(TOP250.items);
  assert.equal(map.get('tt0111161'), 1); // 肖申克的救赎
  assert.equal(map.get('tt0068646'), 2); // 教父
  assert.equal(map.get('tt0468569'), 3); // 黑暗骑士
  assert.equal(map.has('tt0000000'), false);
});
