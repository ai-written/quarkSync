// 序号副本 / 季号写法的归一化、「同一集」分组、去重与重复副本清理
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  cleanupLocalDuplicates,
  buildEpisodeIndex,
  compareForKeep,
  deduplicateByEpisode,
  findDuplicateSets,
  getEpisodeGroup,
  getEpisodeKey,
  groupByEpisode,
  indexHasSameEpisode,
  stripNumericSuffix,
} from '../src/index.js';

// 线上真实遇到的那批文件（来自用户截图）：同一集被转存了 4 份
const REAL = [
  { file_name: '凡人修仙传-194 4K.mkv', size: 3200 },
  { file_name: '凡人修仙传-194 4K (2).mkv', size: 3300 },
  { file_name: '凡人修仙传-194 4K (3).mkv', size: 3300 },
  { file_name: '凡人修仙传-194 4K (4).mkv', size: 3300 },
  { file_name: '择日飞升-14 4K HDR.mp4', size: 2200 },
  { file_name: '斗罗大陆2绝世唐门-171 4K (3).mp4', size: 1600 },
  { file_name: '斗罗大陆2绝世唐门-171 4K (4).mp4', size: 1600 },
  { file_name: '灵境行者-S01E07.mkv', size: 615 },
  { file_name: '大夏守墓人-1.mp4', size: 126 },
  { file_name: '灵境行者-05.mkv', size: 725 },
  { file_name: '灵境行者-07.mkv', size: 615 },
];

// ---------- 序号后缀归一化 ----------

test('stripNumericSuffix：去掉为避免重名加上的 (2)/(3) 序号', () => {
  assert.equal(stripNumericSuffix('a.mkv'), 'a.mkv');
  assert.equal(stripNumericSuffix('凡人修仙传-194 4K (2).mkv'), '凡人修仙传-194 4K.mkv');
  assert.equal(stripNumericSuffix('凡人修仙传-194 4K（4）.mkv'), '凡人修仙传-194 4K.mkv');
  assert.equal(stripNumericSuffix('剧名 第05集 (12).mp4'), '剧名 第05集.mp4');
  // 没有扩展名时也认
  assert.equal(stripNumericSuffix('a (3)'), 'a');
});

test('stripNumericSuffix：不碰正常名字里的 (1) 与 4 位以上数字', () => {
  assert.equal(stripNumericSuffix('a (1).mkv'), 'a (1).mkv');
  assert.equal(stripNumericSuffix('a (1000).mkv'), 'a (1000).mkv');
  assert.equal(stripNumericSuffix('电影 (2024).mkv'), '电影 (2024).mkv');
  assert.equal(stripNumericSuffix('普通名字.mkv'), '普通名字.mkv');
});

// ---------- 集数键：序号与画质写法都不能影响判定 ----------

test('getEpisodeKey：序号副本与原始文件是同一个键', () => {
  const base = getEpisodeKey('凡人修仙传-194 4K.mkv');
  assert.equal(getEpisodeKey('凡人修仙传-194 4K (2).mkv'), base);
  assert.equal(getEpisodeKey('凡人修仙传-194 4K (4).mkv'), base);
});

test('getEpisodeKey：HDR 与普通版是同一个键（hd 不会咬掉 HDR 留下残渣）', () => {
  assert.equal(
    getEpisodeKey('择日飞升-14 4K HDR.mp4'),
    getEpisodeKey('择日飞升-14 4K.mp4'),
  );
  assert.equal(
    getEpisodeKey('择日飞升-14 4K HDR.mp4'),
    getEpisodeKey('择日飞升-14 4K.mkv'),
  );
});

test('getEpisodeGroup：区分「没写季号」与「明确写了第几季」', () => {
  assert.deepEqual(getEpisodeGroup('灵境行者-S01E07.mkv'), { loose: 'ep_灵境行者_E7', season: 1 });
  assert.deepEqual(getEpisodeGroup('灵境行者-07.mkv'), { loose: 'ep_灵境行者_E7', season: null });
  assert.deepEqual(getEpisodeGroup('剧名 第2季 第7集.mp4'), { loose: 'ep_剧名_E7', season: 2 });
  assert.equal(getEpisodeGroup('电影名.mkv'), null);
});

// ---------- 同一集分组 ----------

test('groupByEpisode：序号副本合成一组', () => {
  const groups = [...groupByEpisode(REAL).values()];
  const fanren = groups.find(g => g.some(f => f.file_name.startsWith('凡人修仙传')));
  assert.equal(fanren.length, 4);
});

test('groupByEpisode：S01E07 与 07 合成一组', () => {
  const groups = [...groupByEpisode([
    { file_name: '灵境行者-S01E07.mkv', size: 1 },
    { file_name: '灵境行者-07.mkv', size: 2 },
  ]).values()];
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test('groupByEpisode：两季都写了季号时不合并（S01E07 与 S02E07 是不同集）', () => {
  const groups = [...groupByEpisode([
    { file_name: 'Show.S01E07.mkv', size: 1 },
    { file_name: 'Show.S02E07.mkv', size: 2 },
  ]).values()];
  assert.equal(groups.length, 2);
});

test('groupByEpisode：桶里有多个季号时，没写季号的那份不并入任何一组（宁可漏合）', () => {
  const groups = [...groupByEpisode([
    { file_name: 'Show.S01E07.mkv', size: 1 },
    { file_name: 'Show.S02E07.mkv', size: 2 },
    { file_name: 'Show-07.mkv', size: 3 },
  ]).values()];
  assert.equal(groups.length, 3);
});

test('groupByEpisode：识别不出集数的文件不进任何分组（电影、特别篇永远不会被当成重复）', () => {
  const groups = [...groupByEpisode([
    { file_name: '电影名.mkv', size: 1 },
    { file_name: '剧名 特别篇.mkv', size: 2 },
    { file_name: 'Show.S01E01.mkv', size: 3 },
  ]).values()];
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0].file_name, 'Show.S01E01.mkv');
});

// ---------- 转存前的「同集已存在」判定 ----------

test('indexHasSameEpisode：与 groupByEpisode 给出同样结论', () => {
  const cases = [
    [['Show.S01E07.mkv'], 'Show-07.mkv', true],
    [['Show-07.mkv'], 'Show.S01E07.mkv', true],
    [['Show.S01E07.mkv', 'Show.S02E07.mkv'], 'Show-07.mkv', false],
    [['Show.S01E07.mkv', 'Show.S02E07.mkv'], 'Show.S02E07.mkv', true],
    [['Show.S01E01.mkv'], 'Show.S01E02.mkv', false],
    [['凡人修仙传-194 4K.mkv'], '凡人修仙传-194 4K (2).mkv', true],
    [['电影名.mkv'], '电影名（另一个版本）.mkv', false],
  ];
  for (const [existing, candidate, expected] of cases) {
    const index = buildEpisodeIndex(existing.map(file_name => ({ file_name })));
    assert.equal(indexHasSameEpisode(index, candidate), expected, `${existing} vs ${candidate}`);
    // 交叉验证：把候选并进去，看它是否与已有文件落在同一组
    const all = [...existing, candidate].map(file_name => ({ file_name }));
    const grouped = [...groupByEpisode(all).values()].some(g => g.length > 1 && g.some(f => f.file_name === candidate));
    assert.equal(grouped, expected, `分组结论不一致: ${existing} vs ${candidate}`);
  }
});

// ---------- 去重 ----------

test('deduplicateByEpisode：真实那批文件从 11 个收敛到 6 个', () => {
  const out = deduplicateByEpisode(REAL);
  const names = out.map(f => f.file_name);
  assert.equal(out.length, 6);

  // 凡人修仙传只留一份，且是体积更大的 3.3GB 那份
  const fanren = out.filter(f => f.file_name.startsWith('凡人修仙传'));
  assert.equal(fanren.length, 1);
  assert.equal(fanren[0].size, 3300);

  // 灵境行者 S01E07 与 07 是同一集，只留一份
  assert.equal(out.filter(f => f.file_name.startsWith('灵境行者-') || f.file_name.startsWith('灵境行者.')).length, 2);
  assert.ok(names.includes('灵境行者-05.mkv'), '不同集要留着');
  assert.ok(names.includes('择日飞升-14 4K HDR.mp4'));
  assert.ok(names.includes('大夏守墓人-1.mp4'));
  assert.equal(out.filter(f => f.file_name.startsWith('斗罗大陆')).length, 1);
});

test('compareForKeep：画质 → 体积 → 不带序号的名字 → 更早的那份', () => {
  assert.ok(compareForKeep({ file_name: 'a.4k.mkv', size: 1 }, { file_name: 'a.1080p.mkv', size: 999 }) < 0);
  assert.ok(compareForKeep({ file_name: 'a.1080p.mkv', size: 999 }, { file_name: 'a.1080p.mkv', size: 1 }) < 0);
  // 画质与体积都一样时，优先留没有序号的名字
  assert.ok(compareForKeep({ file_name: 'a.1080p.mkv', size: 5 }, { file_name: 'a.1080p (2).mkv', size: 5 }) < 0);
  assert.ok(compareForKeep({ file_name: 'a.1080p (2).mkv', size: 5 }, { file_name: 'a.1080p.mkv', size: 5 }) > 0);
});

// ---------- 清理：挑选规则 ----------

test('findDuplicateSets：同集多份时给出「留一份、删其余」', () => {
  const sets = findDuplicateSets([
    { file_name: 'Show.S01E01.mkv', size: 100 },
    { file_name: 'Show.S01E01 (2).mkv', size: 200 },
    { file_name: 'Show.S01E01 (3).mkv', size: 200 },
    { file_name: 'Show.S01E02.mkv', size: 10 },
  ]);
  assert.equal(sets.length, 1);
  // 体积更大的胜出（a (2) 与 a (3) 并列，原始那份体积最小）
  assert.equal(sets[0].keep.file_name, 'Show.S01E01 (2).mkv');
  assert.deepEqual(sets[0].drop.map(f => f.file_name).sort(), ['Show.S01E01 (3).mkv', 'Show.S01E01.mkv']);
});

test('findDuplicateSets：画质与体积都并列时，留没有序号的那份', () => {
  const sets = findDuplicateSets([
    { file_name: 'Show.S01E01 (2).mkv', size: 200 },
    { file_name: 'Show.S01E01.mkv', size: 200 },
  ]);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].keep.file_name, 'Show.S01E01.mkv');
  assert.deepEqual(sets[0].drop.map(f => f.file_name), ['Show.S01E01 (2).mkv']);
});

test('findDuplicateSets：无法识别集数的文件永远不会被列入', () => {
  const sets = findDuplicateSets([
    { file_name: '电影 A.mkv', size: 1 },
    { file_name: '电影 B.mkv', size: 2 },
  ]);
  assert.deepEqual(sets, []);
});

// ---------- 清理：本地目录端到端 ----------

function withTempDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-dedupe-'));
  try {
    for (const [name, size] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 1));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LOCAL_FILES = {
  '凡人修仙传-194 4K.mkv': 100,
  '凡人修仙传-194 4K (2).mkv': 200,
  '凡人修仙传-194 4K (3).mkv': 300,
  '电影名.mkv': 10,
  '.downloaded.json': 5,
  '没下完的.mkv.part': 999,
};

test('cleanupLocalDuplicates：预览模式只报告，不动任何文件', () => {
  withTempDir(LOCAL_FILES, dir => {
    const r = cleanupLocalDuplicates(dir, { apply: false });
    assert.equal(r.sets.length, 1);
    assert.equal(r.deleted.length, 2);
    assert.equal(r.scanned, 4);   // 点文件与 .part 半成品不计入
    assert.equal(fs.readdirSync(dir).length, 6);
  });
});

test('cleanupLocalDuplicates：执行后同集只剩体积最大的那份，其余一概不动', () => {
  withTempDir(LOCAL_FILES, dir => {
    const r = cleanupLocalDuplicates(dir, { apply: true });
    assert.equal(r.deleted.length, 2);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.kept.map(f => f.name), ['凡人修仙传-194 4K (3).mkv']);

    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, [
      '.downloaded.json',
      '凡人修仙传-194 4K (3).mkv',
      '没下完的.mkv.part',
      '电影名.mkv',
    ].sort());
  });
});

test('cleanupLocalDuplicates：没有重复时什么都不删', () => {
  withTempDir({ 'a.mkv': 10, 'b.mkv': 20 }, dir => {
    const r = cleanupLocalDuplicates(dir, { apply: true });
    assert.deepEqual(r.sets, []);
    assert.deepEqual(r.deleted, []);
    assert.equal(fs.readdirSync(dir).length, 2);
  });
});
