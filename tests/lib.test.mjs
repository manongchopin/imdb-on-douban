import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanYear, escapeHtml, formatRating, formatVotes, splitDoubanTitle } from '../src/lib/format.js';
import {
  parseGraphql,
  parseLdJson,
  parseNextData,
  parseSuggestion,
} from '../src/lib/imdb-direct.js';

test('formatVotes 用中文单位', () => {
  assert.equal(formatVotes(3258937), '325.9 万');
  assert.equal(formatVotes(10000), '1 万');
  assert.equal(formatVotes(9999), '9,999');
  assert.equal(formatVotes(120000000), '1.2 亿');
  assert.equal(formatVotes(0), '');
});

test('formatRating 保留一位小数', () => {
  assert.equal(formatRating(9), '9.0');
  assert.equal(formatRating(9.26), '9.3');
  assert.equal(formatRating(null), '');
});

test('splitDoubanTitle 拆出中文名和原名', () => {
  assert.deepEqual(splitDoubanTitle('肖申克的救赎 The Shawshank Redemption'), {
    primary: '肖申克的救赎',
    latin: 'The Shawshank Redemption',
  });
  assert.deepEqual(splitDoubanTitle('The Shawshank Redemption'), {
    primary: 'The Shawshank Redemption',
    latin: 'The Shawshank Redemption',
  });
  assert.deepEqual(splitDoubanTitle('肖申克的救赎'), { primary: '肖申克的救赎', latin: '' });
  assert.deepEqual(splitDoubanTitle('  '), { primary: '', latin: '' });
});

test('cleanYear 和 escapeHtml', () => {
  assert.equal(cleanYear('(1994)'), '1994');
  assert.equal(cleanYear(''), '');
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

test('parseLdJson 读取 JSON-LD 里的评分', () => {
  const html = `
    <html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Movie","name":"The Shawshank Redemption","aggregateRating":{"@type":"AggregateRating","ratingCount":3258937,"bestRating":10,"worstRating":1,"ratingValue":9.3}}</script>
    </head><body></body></html>`;
  const parsed = parseLdJson(html);
  assert.equal(parsed.rating, 9.3);
  assert.equal(parsed.votes, 3258937);
  assert.equal(parsed.title, 'The Shawshank Redemption');
});

test('parseLdJson 忽略非法 JSON，继续找下一块', () => {
  const html = `
    <script type="application/ld+json">{oops}</script>
    <script type="application/ld+json">{"@type":"TVSeries","name":"Breaking Bad","aggregateRating":{"ratingValue":"9.5","ratingCount":"2100000"}}</script>`;
  const parsed = parseLdJson(html);
  assert.equal(parsed.rating, 9.5);
  assert.equal(parsed.votes, 2100000);
});

test('parseLdJson 没有评分时返回 null', () => {
  assert.equal(parseLdJson('<html><body>no data</body></html>'), null);
});

test('parseNextData 兜底解析内嵌评分', () => {
  const html = '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"aboveTheFoldData":{"ratingsSummary":{"aggregateRating":8.8,"voteCount":1900000}}}}}}</script>';
  const parsed = parseNextData(html);
  assert.equal(parsed.rating, 8.8);
  assert.equal(parsed.votes, 1900000);
});

test('parseGraphql 取出 ratingsSummary', () => {
  const parsed = parseGraphql({
    data: { title: { id: 'tt0111161', titleText: { text: 'The Shawshank Redemption' }, ratingsSummary: { aggregateRating: 9.3, voteCount: 3258937 } } },
  });
  assert.equal(parsed.rating, 9.3);
  assert.equal(parsed.title, 'The Shawshank Redemption');
  assert.equal(parseGraphql({ data: { title: null } }), null);
});

test('parseSuggestion 过滤非 tt id', () => {
  const list = parseSuggestion({
    d: [
      { id: 'tt0111161', l: 'The Shawshank Redemption', y: 1994, qid: 'movie' },
      { id: 'nm0000206', l: 'Keanu Reeves' },
      { id: 'tt0133093', l: 'The Matrix', y: 1999, qid: 'movie' },
    ],
  });
  assert.deepEqual(list.map((x) => x.imdbID), ['tt0111161', 'tt0133093']);
  assert.equal(list[0].Year, '1994');
});
