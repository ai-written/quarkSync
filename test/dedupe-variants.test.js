// 上游重传/搬运造成的「同一集不同名字」：上传标签、`_1` 副本序号、画质标记位置
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareForKeep,
  deduplicateByEpisode,
  findDuplicateSets,
  getEpisodeGroup,
  getQualityScore,
  looseCopySuffix,
  stripUploadTags,
} from '../src/index.js';

// 用户截图里的真实文件名：同一集被上游换名重新上传
const PAIRS = [
  {
    names: ['灵境行者-08.mkv', '灵境行者-ZLJZCSDR-08.mp4'],
    sizes: [799.1, 762.5],
    keep: '灵境行者-08.mkv',
    evidence: '剧名带上传标签',
  },
  {
    names: ['李熊猫-S01E14.mp4', '李熊猫-ZGXMTXL-14.mkv'],
    sizes: [985.1, 669.9],
    keep: '李熊猫-S01E14.mp4',
    evidence: '季集写法不同',
  },
  {
    names: ['吞噬星空-245 4K.mp4', '吞噬星空-245_4K_1.mkv'],
    sizes: [1600, 1300],
    keep: '吞噬星空-245 4K.mp4',
    evidence: '有序号副本',
  },
];

test('同一集的不同写法被归到同一个分组键（上传标签 / 副本序号 / 画质标记位置）', () => {
  for (const { names } of PAIRS) {
    const a = getEpisodeGroup(names[0]);
    const b = getEpisodeGroup(names[1]);
    assert.equal(a.loose, b.loose, `${names[0]} 与 ${names[1]} 应归为同一集`);
  }
});

test('findDuplicateSets：三组真实重复都识别，保留画质/体积更好的那份并给出证据', () => {
  const files = [];
  for (const { names, sizes } of PAIRS) {
    files.push({ file_name: names[0], size: sizes[0] });
    files.push({ file_name: names[1], size: sizes[1] });
  }
  const { sets, skipped } = findDuplicateSets(files);
  assert.deepEqual(skipped, []);
  assert.equal(sets.length, 3);
  for (const p of PAIRS) {
    const set = sets.find(s => s.keep.file_name === p.keep);
    assert.ok(set, `应保留 ${p.keep}`);
    assert.equal(set.evidence, p.evidence);
    const dropped = set.drop.map(f => f.file_name);
    assert.deepEqual(dropped, p.names.filter(n => n !== p.keep));
  }
});

test('deduplicateByEpisode：三组重复收敛成三份，不误伤其它集', () => {
  const files = [
    ...PAIRS.flatMap(({ names, sizes }) => [
      { file_name: names[0], size: sizes[0] },
      { file_name: names[1], size: sizes[1] },
    ]),
    { file_name: '大夏守墓人-7.mp4', size: 58.5 },
    { file_name: '灵境行者-09.mkv', size: 700 },   // 不同集要留着
  ];
  const out = deduplicateByEpisode(files);
  assert.deepEqual(out.map(f => f.file_name), [
    '灵境行者-08.mkv',
    '李熊猫-S01E14.mp4',
    '吞噬星空-245 4K.mp4',
    '大夏守墓人-7.mp4',
    '灵境行者-09.mkv',
  ]);
});

test('stripUploadTags：只剥「≥5 个字符、无元音」的全大写标签', () => {
  assert.equal(stripUploadTags('灵境行者-ZLJZCSDR-08.mp4'), '灵境行者-08.mp4');
  assert.equal(stripUploadTags('李熊猫-ZGXMTXL-14.mkv'), '李熊猫-14.mkv');
  // 正常英文缩写 / 剧名里的英文词不能被剥：长度不够或含元音（Y 也算）
  for (const name of [
    'SEAL-08.mkv',          // 含元音
    'TBBT-S01E01.mkv',      // 只有 4 个字母
    'RHYTHM-08.mkv',        // 含 Y
    'SD高达-01.mp4',        // 不是独立成词
    '[SD] 高达-01.mkv',     // 太短
    'Show.S01E07.mkv',      // S01E07 的字母部分只有 2 个
    '斗罗大陆2-08.mkv',     // 没有标签
  ]) {
    assert.equal(stripUploadTags(name), name, `不该剥: ${name}`);
  }
});

test('getQualityScore：标签里的 sd/hd 不再被当成画质；真正的标记仍要认', () => {
  // 旧实现用 includes('sd')，会把 ZLJZCSDR 判成标清 —— 于是清理时删掉画质更好的那份
  assert.equal(getQualityScore('灵境行者-ZLJZCSDR-08.mp4'), 0);
  assert.equal(getQualityScore('灵境行者-08.mkv'), 0);
  assert.equal(getQualityScore('凡人修仙传-194 4K.mkv'), 5);
  assert.equal(getQualityScore('凡人修仙传-194 1080p.mkv'), 3);
  assert.equal(getQualityScore('凡人修仙传-194 高清.mp4'), 2);
  assert.equal(getQualityScore('Show.SD.01.mkv'), 1);      // 独立成词的 SD 仍然算标清
  assert.equal(getQualityScore('SD高达-01.mp4'), 0);       // 剧名里的 SD 不算
  // 这些以前是靠 hd / 1080 子串顺带命中的，改成独立成词后必须仍然认
  assert.equal(getQualityScore('Show.HDR.01.mkv'), 2);
  assert.equal(getQualityScore('Show.HDTV.01.mkv'), 2);
  assert.equal(getQualityScore('Show.HDR10.01.mkv'), 2);
  assert.equal(getQualityScore('Show-1080i.mkv'), 3);
  // HDR 不会被 hd 咬掉后当成「未知画质」：和普通版比较时仍算更高的画质
  assert.ok(compareForKeep(
    { file_name: 'Show.HDR.01.mkv', size: 100 },
    { file_name: 'Show-01.mkv', size: 900 },
  ) < 0);
});

test('looseCopySuffix：只认「画质标记之后 + 去掉后仍有集数」的 1~2 位尾部数字', () => {
  assert.equal(looseCopySuffix('吞噬星空-245_4K_1.mkv'), '_1');
  assert.equal(looseCopySuffix('Show-08-4K_2.mkv'), '_2');
  // 没有画质标记时保守地不认（`Show-08_1` 也可能是别的命名习惯，宁可漏删）
  assert.equal(looseCopySuffix('Show-08_1.mkv'), null);
  assert.equal(looseCopySuffix('凡人修仙传-194 4K.mkv'), null);   // 194 是集数本身
  assert.equal(looseCopySuffix('大夏守墓人-1.mp4'), null);        // 1 是集数本身
  assert.equal(looseCopySuffix('斗罗大陆2绝世唐门-171 4K.mp4'), null); // 3 位数不当副本序号
  assert.equal(looseCopySuffix('Show.S01E07.mkv'), null);
});

test('画质/编码标记不同也算重复：4K SDR+ 与 4K、AVC 与 HEVC', () => {
  const pair = [
    { file_name: 'FR.EP195.V2.4K SDR+.AVC-GM.mp4', size: 3.2 * 1024 ** 3 },
    { file_name: 'FR.EP195.V2.4K.AVC-GM.mp4', size: 3.1 * 1024 ** 3 },
  ];
  // 先确认归到同一集（SDR+ 不再被当成剧名的一部分）
  assert.equal(getEpisodeGroup(pair[0].file_name).loose, getEpisodeGroup(pair[1].file_name).loose);
  const { sets, skipped } = findDuplicateSets(pair);
  assert.deepEqual(skipped, []);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].evidence, '画质/编码标记不同');
  assert.equal(sets[0].keep.file_name, 'FR.EP195.V2.4K SDR+.AVC-GM.mp4');

  // 只差编码/画质标记的另外两种写法
  const codec = findDuplicateSets([
    { file_name: 'Show-08 AVC.mkv', size: 100 },
    { file_name: 'Show-08 HEVC.mkv', size: 200 },
  ]);
  assert.equal(codec.sets.length, 1);
  assert.equal(codec.sets[0].evidence, '画质/编码标记不同');
});

test('防误删：只是分隔符不同、标记集合相同的仍按「无法确认」保留', () => {
  // 两边都有 4K，差别只有分隔符 → 不能升级成「画质/编码标记不同」的证据
  const { sets, skipped } = findDuplicateSets([
    { file_name: '凡人修仙传-194 4K.mkv', size: 100 },
    { file_name: '凡人修仙传 194 4K.mkv', size: 200 },
  ]);
  assert.deepEqual(sets, []);
  assert.equal(skipped.length, 1);
});

test('防误删：只是分隔符不同、剧名里自带数字的仍按「无法确认」保留', () => {
  // 剧名 Show2 自带数字：两边尾部数字相同（都是 8），不能当成副本序号证据
  const { sets, skipped } = findDuplicateSets([
    { file_name: 'Show2-08.mkv', size: 100 },
    { file_name: 'Show2 08.mkv', size: 200 },
  ]);
  assert.deepEqual(sets, []);
  assert.equal(skipped.length, 1);
});

test('防误删：剧名结尾带数字时，尾部数字不能当副本序号证据', () => {
  const cases = [
    ['斗罗大陆2-08.mkv', '斗罗大陆2-09.mkv'],
    ['Show2-08.mkv', 'Show2-09.mkv'],
    ['24-01.mkv', '24-02.mkv'],
    ['庆余年 2-02.mkv', '庆余年 2.mkv'],
    ['Region 2-02.mkv', 'Region 2.mkv'],
  ];
  for (const [a, b] of cases) {
    const { sets } = findDuplicateSets([
      { file_name: a, size: 100 },
      { file_name: b, size: 200 },
    ]);
    assert.deepEqual(sets, [], `不该判成可删的重复: ${a} / ${b}`);
  }
  // 没有画质标记的 `_1` 也保守地不认（宁可漏删）
  assert.deepEqual(findDuplicateSets([
    { file_name: 'Show-08_1.mkv', size: 100 },
    { file_name: 'Show-08.mkv', size: 200 },
  ]).sets, []);
});

test('防误删：剧名里带分隔符的数字不会被剥光（斗罗大陆 2 与 斗罗大陆 是两部剧）', () => {
  // 剥尾部数字时碰到解析出来的集数就停，所以「斗罗大陆 2」不会变成「斗罗大陆」
  assert.notEqual(
    getEpisodeGroup('斗罗大陆 2-245.mp4').loose,
    getEpisodeGroup('斗罗大陆-245.mp4').loose,
  );
  assert.deepEqual(findDuplicateSets([
    { file_name: '斗罗大陆 2-245.mp4', size: 100 },
    { file_name: '斗罗大陆-245.mp4', size: 200 },
  ]).sets, []);
  // 同一部剧的两种分隔写法仍然要合并
  assert.equal(
    getEpisodeGroup('斗罗大陆 2-245.mp4').loose,
    getEpisodeGroup('斗罗大陆 2 245.mp4').loose,
  );
  // 「Region 2」同理：不能跟「Region」并成同一集
  assert.notEqual(
    getEpisodeGroup('Region 2-02.mkv').loose,
    getEpisodeGroup('Region-02.mkv').loose,
  );
});

test('画质标记在末尾（Show-08-4K）也能归到同一集，并留 4K 那份', () => {
  assert.equal(
    getEpisodeGroup('Show-08-4K.mkv').loose,
    getEpisodeGroup('Show-08.mkv').loose,
  );
  const { sets } = findDuplicateSets([
    { file_name: 'Show-08.mkv', size: 100 },
    { file_name: 'Show-08-4K.mkv', size: 200 },
  ]);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].keep.file_name, 'Show-08-4K.mkv');
  assert.equal(sets[0].evidence, '画质不同');
});

test('防误删：不同剧 + 上传标签不会被合并（集数不同 / 剧名不同）', () => {
  const { sets } = findDuplicateSets([
    { file_name: '灵境行者-ZLJZCSDR-08.mkv', size: 100 },
    { file_name: '灵境行者-ZGXMTXL-09.mkv', size: 200 },
  ]);
  assert.deepEqual(sets, []);
  const other = findDuplicateSets([
    { file_name: '灵境行者-ZLJZCSDR-08.mkv', size: 100 },
    { file_name: '遮天-ZGXMTXL-08.mkv', size: 200 },
  ]);
  assert.deepEqual(other.sets, []);
});

test('未知发布组/版本标记：DDDZZTWO、FR、V3、GM、EP194 不算剧名的一部分', () => {
  const pairs = [
    ['大主宰-DDDZZTWO-43.mp4', '大主宰-43.mp4'],
    ['凡人修仙传-FR.EP194.V3.4K SDR+.AVC-GM.mp4', '凡人修仙传-194 4K.mp4'],
    ['凡人修仙传-194 4K SDR+.AVC-GM.mp4', '凡人修仙传-194 4K.mp4'],
    ['大王饶命-S03E04 4K-GyWEB.mp4', '大王饶命-S03E04 4K.mp4'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(getEpisodeGroup(a).loose, getEpisodeGroup(b).loose, `${a} 与 ${b} 应归为同一集`);
    const { sets, skipped } = findDuplicateSets([
      { file_name: a, size: 100 },
      { file_name: b, size: 200 },
    ]);
    assert.equal(skipped.length, 0, `${a} 与 ${b} 不应是「无法确认」`);
    assert.equal(sets.length, 1, `${a} 与 ${b} 应判为重复`);
    assert.equal(sets[0].evidence, '剧名带上传标签');
  }
});

test('未知标记只在含中文的名字里忽略；英文剧名里的短大写片段仍算剧名', () => {
  // 英文剧名不做「短大写片段」剥离：Show-A 与 Show 可能是两部剧
  const { sets } = findDuplicateSets([
    { file_name: 'Show-A-07.mkv', size: 100 },
    { file_name: 'Show-07.mkv', size: 200 },
  ]);
  assert.deepEqual(sets, []);
  // 画质标记差异仍归到「画质/编码标记不同」，不会被发布组证据抢先
  const sdr = findDuplicateSets([
    { file_name: 'FR.EP195.V2.4K SDR+.AVC-GM.mp4', size: 100 },
    { file_name: 'FR.EP195.V2.4K.AVC-GM.mp4', size: 200 },
  ]);
  assert.equal(sdr.sets.length, 1);
  assert.equal(sdr.sets[0].evidence, '画质/编码标记不同');
});
