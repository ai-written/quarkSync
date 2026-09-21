// 剧集识别、画质评分与同名集去重
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEpisode,
  getEpisodeKey,
  getQualityScore,
  isHigherQuality,
  deduplicateByEpisode,
  sortByEpisode,
  getDedupKey,
} from '../src/index.js';

test('parseEpisode：识别 S01E02 / 第N季第M集 / 第N集', () => {
  assert.deepEqual(parseEpisode('Show.S01E02.1080p.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisode('Show.S01EP02.mkv'), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisode('剧名 第3季 第12集.mp4'), { season: 3, episode: 12 });
  assert.deepEqual(parseEpisode('剧名 第05集.mp4'), { season: 0, episode: 5 });
});

test('parseEpisode：无季集标记时取最长的数字，并排除年份', () => {
  // 2019 被当作年份排除，剩下 1080 作为集数（启发式，与实现一致）
  assert.deepEqual(parseEpisode('movie.2019.1080p.mkv'), { season: 0, episode: 1080 });
  assert.deepEqual(parseEpisode('ep12.mkv'), { season: 0, episode: 12 });
});

test('parseEpisode：完全没有数字时返回 null', () => {
  assert.equal(parseEpisode('电影名.mkv'), null);
});

test('getEpisodeKey：同剧同集的不同画质/扩展名归为同一 key', () => {
  const a = getEpisodeKey('Show.S01E02.1080p.mkv');
  const b = getEpisodeKey('Show.S01E02.4K.mkv');
  assert.ok(a && b, '都应能解析出 key');
  assert.equal(a, b);
  assert.notEqual(a, getEpisodeKey('Show.S01E03.1080p.mkv'));   // 不同集
  assert.notEqual(a, getEpisodeKey('Other.S01E02.1080p.mkv'));  // 不同剧
});

test('getEpisodeKey：无集数信息时返回 null', () => {
  assert.equal(getEpisodeKey('电影名.mkv'), null);
});

test('getQualityScore：按关键字给出画质分', () => {
  assert.equal(getQualityScore('a.4k.mkv'), 5);
  assert.equal(getQualityScore('a.2160p.mkv'), 4);
  assert.equal(getQualityScore('a.1080p.mkv'), 3);
  assert.equal(getQualityScore('a.720p.mkv'), 2);
  assert.equal(getQualityScore('a.高清.mkv'), 2);
  assert.equal(getQualityScore('a.标清.mkv'), 1);
  assert.equal(getQualityScore('a.mkv'), 0);
});

test('isHigherQuality：先比画质，画质相同再比体积', () => {
  assert.equal(isHigherQuality('a.4k.mkv', 100, 'a.1080p.mkv', 9999), true);
  assert.equal(isHigherQuality('a.1080p.mkv', 9999, 'a.4k.mkv', 100), false);
  assert.equal(isHigherQuality('a.1080p.mkv', 900, 'a.1080p.mkv', 500), true);
  assert.equal(isHigherQuality('a.1080p.mkv', 500, 'a.1080p.mkv', 900), false);
});

test('deduplicateByEpisode：同集保留最高画质，即便体积更小', () => {
  const files = [
    { file_name: 'Show.S01E01.1080p.mkv', size: 1000 },
    { file_name: 'Show.S01E01.4K.mkv', size: 500 },
  ];
  const out = deduplicateByEpisode(files);
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'Show.S01E01.4K.mkv');
});

test('deduplicateByEpisode：画质相同时保留体积更大的', () => {
  const files = [
    { file_name: 'Show.S01E02.720p.mkv', size: 900 },
    { file_name: 'Show.S01E02.1080p.mkv', size: 500 },
  ];
  const out = deduplicateByEpisode(files);
  assert.equal(out.length, 1);
  assert.equal(out[0].file_name, 'Show.S01E02.1080p.mkv');
});

test('deduplicateByEpisode：不同集与无法识别集数的文件都保留', () => {
  const files = [
    { file_name: 'Show.S01E01.1080p.mkv', size: 100 },
    { file_name: 'Show.S01E02.1080p.mkv', size: 100 },
    { file_name: 'Show.S01E02.720p.mkv', size: 50 },
    { file_name: '剧名 特别篇.mkv', size: 10 },
  ];
  const out = deduplicateByEpisode(files).map(f => f.file_name).sort();
  assert.deepEqual(out, ['Show.S01E01.1080p.mkv', 'Show.S01E02.1080p.mkv', '剧名 特别篇.mkv'].sort());
});

test('sortByEpisode：季集倒序（最新的在前），无集数的排在后面', () => {
  const files = [
    { file_name: 'Show.S01E01.1080p.mkv', updated_at: 1 },
    { file_name: 'Show.S01E05.1080p.mkv', updated_at: 2 },
    { file_name: 'Show.S02E01.1080p.mkv', updated_at: 3 },
    { file_name: '花絮.mkv', updated_at: 4 },
  ];
  const order = files.slice().sort(sortByEpisode).map(f => f.file_name);
  assert.deepEqual(order, [
    'Show.S02E01.1080p.mkv',
    'Show.S01E05.1080p.mkv',
    'Show.S01E01.1080p.mkv',
    '花絮.mkv',
  ]);
});

test('getDedupKey：有集数信息时用集 key，否则退化为「文件名|大小」', () => {
  assert.equal(
    getDedupKey({ file_name: 'Show.S01E02.1080p.mkv', size: 100 }),
    getDedupKey({ file_name: 'Show.S01E02.4K.mkv', size: 200 }),
  );
  assert.equal(getDedupKey({ file_name: '电影名.mkv', size: 100 }), '电影名.mkv|100');
  assert.equal(getDedupKey({ file_name: '电影名.mkv', size: 200 }), '电影名.mkv|200');
  assert.notEqual(getDedupKey({ file_name: '电影名.mkv', size: 100 }), getDedupKey({ file_name: '电影名.mkv', size: 200 }));
});
