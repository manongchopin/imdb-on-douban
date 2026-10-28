import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchUrl,
  buildTitleUrl,
  mapOmdbError,
  parseSearch,
  parseVotes,
  requestOmdb,
  toRating,
  OmdbError,
} from '../src/lib/omdb.js';

const TITLE_JSON = {
  Title: 'The Shawshank Redemption',
  Year: '1994',
  Rated: 'R',
  Type: 'movie',
  imdbRating: '9.3',
  imdbVotes: '3,258,937',
  imdbID: 'tt0111161',
  Poster: 'https://m.media-amazon.com/images/M/poster.jpg',
  Ratings: [
    { Source: 'Internet Movie Database', Value: '9.3/10' },
    { Source: 'Rotten Tomatoes', Value: '91%' },
    { Source: 'Metacritic', Value: '82/100' },
  ],
  Response: 'True',
};

test('URL 拼接带上 apikey 和参数', () => {
  const titleUrl = new URL(buildTitleUrl({ apiKey: 'abc123', imdbId: 'tt0111161' }));
  assert.equal(titleUrl.origin + titleUrl.pathname, 'https://www.omdbapi.com/');
  assert.equal(titleUrl.searchParams.get('apikey'), 'abc123');
  assert.equal(titleUrl.searchParams.get('i'), 'tt0111161');

  const searchUrl = new URL(buildSearchUrl({ apiKey: 'k', query: 'Dune', year: 2021, type: 'movie' }));
  assert.equal(searchUrl.searchParams.get('s'), 'Dune');
  assert.equal(searchUrl.searchParams.get('y'), '2021');
  assert.equal(searchUrl.searchParams.get('type'), 'movie');
});

test('toRating 归一化字段，并剔除 IMDb 自身的 Ratings 条目', () => {
  const data = toRating(TITLE_JSON);
  assert.equal(data.imdbId, 'tt0111161');
  assert.equal(data.rating, 9.3);
  assert.equal(data.votes, 3258937);
  assert.equal(data.type, 'movie');
  assert.equal(data.url, 'https://www.imdb.com/title/tt0111161/');
  assert.deepEqual(
    data.extras.map((e) => [e.label, e.short]),
    [
      ['烂番茄', '91%'],
      ['Metacritic', '82'],
    ]
  );
});

test('toRating 对 N/A 和缺字段保持健壮', () => {
  const data = toRating({
    Title: 'X',
    Year: '2020',
    Type: 'movie',
    imdbRating: 'N/A',
    imdbVotes: 'N/A',
    imdbID: 'tt1234567',
    Poster: 'N/A',
    Ratings: [{ Source: 'Rotten Tomatoes', Value: 'N/A' }],
    Response: 'True',
  });
  assert.equal(data.rating, null);
  assert.equal(data.votes, null);
  assert.equal(data.poster, null);
  assert.deepEqual(data.extras, []);
});

test('toRating 把 Response=False 转成带 code 的错误', () => {
  assert.throws(
    () => toRating({ Response: 'False', Error: 'Invalid API key!' }),
    (err) => err instanceof OmdbError && err.code === 'BAD_KEY'
  );
});

test('parseVotes 处理千分位和空值', () => {
  assert.equal(parseVotes('3,258,937'), 3258937);
  assert.equal(parseVotes('N/A'), null);
  assert.equal(parseVotes(undefined), null);
});

test('parseSearch 过滤非法 id 并容忍「没找到」', () => {
  const list = parseSearch({
    Response: 'True',
    Search: [
      { Title: 'A', Year: '1994', imdbID: 'tt0111161', Type: 'movie' },
      { Title: 'B', Year: '1995', imdbID: 'bad-id', Type: 'movie' },
    ],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].imdbID, 'tt0111161');
  assert.deepEqual(parseSearch({ Response: 'False', Error: 'Movie not found!' }), []);
});

test('mapOmdbError 覆盖常见错误文案', () => {
  assert.equal(mapOmdbError('Invalid API key!'), 'BAD_KEY');
  assert.equal(mapOmdbError('Request limit reached!'), 'RATE_LIMIT');
  assert.equal(mapOmdbError('Movie not found!'), 'NOT_FOUND');
  assert.equal(mapOmdbError('Too many results.'), 'TOO_MANY');
  assert.equal(mapOmdbError('something else'), 'OMDB_ERROR');
});

test('requestOmdb 把网络异常和 HTTP 状态映射成错误码', async () => {
  await assert.rejects(
    () =>
      requestOmdb('https://www.omdbapi.com/', async () => {
        throw new Error('offline');
      }),
    (err) => err.code === 'NETWORK'
  );

  await assert.rejects(
    () => requestOmdb('https://www.omdbapi.com/', async () => ({ ok: false, status: 401 })),
    (err) => err.code === 'BAD_KEY'
  );

  const ok = await requestOmdb('https://www.omdbapi.com/', async () => ({
    ok: true,
    status: 200,
    json: async () => TITLE_JSON,
  }));
  assert.equal(ok.imdbID, 'tt0111161');
});
