// 「按周几更新」（updateDays）与单分享下载过滤的纯函数回归测试。
//
// 这些函数决定「今天要不要同步某个分享」和「该分享的时间窗口多大」：
// 逻辑错了不会报错，只会静默漏同步（窗口太窄、集数永远进不来）或把用户勾的周几丢掉，
// 所以单独盯一遍。只测纯函数，不碰网络与转存。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKDAY_LABELS,
  weekdayOf,
  normalizeUpdateDays,
  updateDaysMaxGapHours,
  effectiveShareHours,
  shareRunsOnDay,
  filterSharesForWeekday,
  shareUrlsText,
  shareDownloadTips,
  planDayDownload,
  filterDownloadGroupsByTips,
  pruneDeadUrls,
} from '../src/index.js';
import { validateConfig } from '../src/web.js';

// 固定日期一律用本地时间构造（new Date(y, m, d)）。
// 写成 '2026-10-19' 这类 ISO 字符串会按 UTC 解析：东八区还好，往西的时区会落到前一天，
// 测试就会变成「看运行机器时区」的薛定谔用例。
const localDate = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

test('WEEKDAY_LABELS：1=周一 … 7=周日', () => {
  assert.deepEqual(WEEKDAY_LABELS, ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
});

test('weekdayOf：用本地时间把周日映射成 7（不沿用 JS 的 0=周日）', () => {
  assert.equal(weekdayOf(localDate(2026, 10, 19)), 1); // 2026-10-19 周一
  assert.equal(weekdayOf(localDate(2026, 10, 20)), 2); // 周二
  assert.equal(weekdayOf(localDate(2026, 10, 25)), 7); // 周日
});

test('normalizeUpdateDays：只留 1..7 的整数、去重升序，非法值静默丢弃', () => {
  assert.deepEqual(normalizeUpdateDays([3, 1, 1, 8, 0, '2']), [1, 3]);
  assert.deepEqual(normalizeUpdateDays([7, 1]), [1, 7]);
  assert.deepEqual(normalizeUpdateDays([1.5, 2.5]), []);
  assert.deepEqual(normalizeUpdateDays([]), []);
});

test('normalizeUpdateDays：非数组（含缺失）一律当作「每天」', () => {
  for (const value of [undefined, null, '1', 1, { 1: true }]) {
    assert.deepEqual(normalizeUpdateDays(value), []);
  }
});

test('updateDaysMaxGapHours：按周循环取「相邻两次同步」的最大间隔', () => {
  assert.equal(updateDaysMaxGapHours([]), 0);
  assert.equal(updateDaysMaxGapHours(undefined), 0);
  assert.equal(updateDaysMaxGapHours([3]), 168); // 只周三：一个整周
  assert.equal(updateDaysMaxGapHours([1, 4]), 96); // 周四 → 下周一，4 天
  assert.equal(updateDaysMaxGapHours([1, 2]), 144); // 周二 → 下周一，6 天
  assert.equal(updateDaysMaxGapHours([1, 2, 3, 4, 5, 6, 7]), 24); // 每天都同步
});

test('effectiveShareHours：窗口不足才放宽，本来就够大则保持原值', () => {
  assert.equal(effectiveShareHours(24, [1, 4]), 96);
  assert.equal(effectiveShareHours(200, [1]), 200);
  assert.equal(effectiveShareHours(24, []), 24);
  assert.equal(effectiveShareHours(24, undefined), 24);
});

test('shareRunsOnDay：没配 updateDays = 每天同步（向后兼容旧配置）', () => {
  assert.equal(shareRunsOnDay({ url: 'u' }, 2), true);
  assert.equal(shareRunsOnDay({ url: 'u', updateDays: [] }, 2), true);
  assert.equal(shareRunsOnDay({ url: 'u', updateDays: null }, 2), true);
  assert.equal(shareRunsOnDay('u', 2), true); // 分享项写成纯字符串的旧格式
});

test('shareRunsOnDay：配了周几就只在那几天同步', () => {
  const share = { url: 'u', updateDays: [1, 4] };
  assert.equal(shareRunsOnDay(share, 1), true);
  assert.equal(shareRunsOnDay(share, 4), true);
  assert.equal(shareRunsOnDay(share, 2), false);
});

test('filterSharesForWeekday：切分结果保持原顺序，index 是原数组下标', () => {
  const a = { url: 'a', updateDays: [1, 4] };
  const b = { url: 'b' };
  const c = { url: 'c', updateDays: [2] };
  const d = { url: 'd', updateDays: [4, 7] };
  const { active, skipped } = filterSharesForWeekday([a, b, c, d], 4);
  assert.deepEqual(active, [
    { share: a, index: 0 },
    { share: b, index: 1 },
    { share: d, index: 3 },
  ]);
  assert.deepEqual(skipped, [{ share: c, index: 2 }]);
});

test('shareUrlsText：字符串、数组、对象三种形式都归一成一行一个链接', () => {
  assert.equal(shareUrlsText('https://pan.quark.cn/s/aaa'), 'https://pan.quark.cn/s/aaa');
  assert.equal(shareUrlsText(['u1', 'u2']), 'u1\nu2');
  assert.equal(shareUrlsText({ url: ['u1', 'u2'], tip: '遮天' }), 'u1\nu2');
  assert.equal(shareUrlsText({ url: 'u1', tip: '遮天' }), 'u1');
  // 空行/空白项要丢掉：网页端拿它和已保存配置比对，多一行空行会被误判成「不一致」
  assert.equal(shareUrlsText({ url: ['u1', '  ', 'u2'] }), 'u1\nu2');
  assert.equal(shareUrlsText(null), '');
});

// ---- 单分享下载：只保留该分享（影视名称）的文件 ----

test('filterDownloadGroupsByTips：平铺模式按「影视名称-」前缀过滤（夸克字段 file_name）', () => {
  const groups = [{
    relDir: '',
    files: [
      { file_name: '遮天-01.mp4', size: 1 },
      { file_name: '斗破苍穹-02.mp4', size: 2 },
    ],
  }];
  const out = filterDownloadGroupsByTips(groups, ['遮天'], { flatten: true });
  assert.deepEqual(out.map(g => g.files.map(f => f.file_name)), [['遮天-01.mp4']]);
  // 不能原地改调用方传进来的组：collectDownloadGroups 的结果后面还有别的用途
  assert.equal(groups[0].files.length, 2);
});

test('filterDownloadGroupsByTips：AList 的名字字段是 name，默认 nameOf 同样认', () => {
  const groups = [{
    relDir: '',
    files: [{ name: '遮天-01.mkv' }, { name: '其它.mp4' }],
  }];
  const out = filterDownloadGroupsByTips(groups, ['遮天'], { flatten: true });
  assert.deepEqual(out[0].files.map(f => f.name), ['遮天-01.mkv']);
});

test('filterDownloadGroupsByTips：分文件夹模式整组保留影视名称文件夹，当层仍按前缀筛', () => {
  const groups = [
    { relDir: '', files: [{ file_name: '遮天-01.mp4' }, { file_name: '斗破苍穹-02.mp4' }] },
    { relDir: '遮天', files: [{ file_name: '遮天-03.mp4' }, { file_name: '遮天-04.mp4' }] },
    { relDir: '斗破苍穹', files: [{ file_name: '斗破苍穹-05.mp4' }] },
  ];
  const out = filterDownloadGroupsByTips(groups, ['遮天']);
  assert.deepEqual(out.map(g => g.relDir), ['', '遮天']);
  assert.deepEqual(out[0].files.map(f => f.file_name), ['遮天-01.mp4']);
  // 影视名称文件夹里的文件整组保留：组内文件名可能没带前缀，不能按前缀再筛一遍
  assert.deepEqual(out[1].files.map(f => f.file_name), ['遮天-03.mp4', '遮天-04.mp4']);
});

test('filterDownloadGroupsByTips：多个影视名称同时生效，返回顺序保持原样', () => {
  const groups = [
    { relDir: '遮天', files: [{ file_name: '遮天-01.mp4' }] },
    { relDir: '斗破苍穹', files: [{ file_name: '斗破苍穹-02.mp4' }] },
    { relDir: '凡人修仙传', files: [{ file_name: '凡人修仙传-03.mp4' }] },
  ];
  const out = filterDownloadGroupsByTips(groups, ['遮天', ' 斗破苍穹 ']);
  assert.deepEqual(out.map(g => g.relDir), ['遮天', '斗破苍穹']);
});

test('filterDownloadGroupsByTips：tips 为空时原样返回（定时任务/全量下载不做过滤）', () => {
  const groups = [{ relDir: '', files: [{ file_name: '遮天-01.mp4' }] }];
  assert.equal(filterDownloadGroupsByTips(groups, []), groups);
  assert.equal(filterDownloadGroupsByTips(groups, undefined), groups);
  assert.equal(filterDownloadGroupsByTips(groups, null), groups);
});

// ---- 前缀包含：选中「遮天」不能把「遮天-外传」的文件也算进来 ----
// 下载后删除云端时，这个误匹配会删掉别的分享的文件，所以调用方要传 knownTips。
test('filterDownloadGroupsByTips：knownTips 最长前缀优先，前缀包含的另一部剧不会被误匹配', () => {
  const groups = [{
    relDir: '',
    files: [
      { file_name: '遮天-01.mp4' },
      { file_name: '遮天-外传-01.mp4' },
      { file_name: '斗破苍穹-01.mp4' },
    ],
  }];
  const knownTips = ['遮天', '遮天-外传', '斗破苍穹'];
  const out = filterDownloadGroupsByTips(groups, ['遮天'], { flatten: true, knownTips });
  assert.deepEqual(out[0].files.map(f => f.file_name), ['遮天-01.mp4']);
  // 不传 knownTips 时只有选中项参与匹配，「遮天-外传」也以「遮天-」开头 → 被误算成「遮天」
  const naive = filterDownloadGroupsByTips(groups, ['遮天'], { flatten: true });
  assert.deepEqual(naive[0].files.map(f => f.file_name), ['遮天-01.mp4', '遮天-外传-01.mp4']);
});

// ---- 定时「同步+下载」的下载范围决策 ----
test('shareDownloadTips：取实际同步分享的影视名称（去重、trim），统计无法识别的分享数', () => {
  const entries = [
    { share: { tip: '遮天' } },
    { share: { tip: ' 遮天 ' } },
    { share: { tip: '斗破苍穹' } },
    { share: {} },
  ];
  assert.deepEqual(shareDownloadTips({}, entries), { tips: ['遮天', '斗破苍穹'], withoutTip: 1 });
  // 全局 tip 是回退值：分享自身没填时用它
  assert.deepEqual(
    shareDownloadTips({ tip: '全局前缀' }, [{ share: {} }]),
    { tips: ['全局前缀'], withoutTip: 0 },
  );
  assert.deepEqual(shareDownloadTips({}, []), { tips: [], withoutTip: 0 });
});

test('planDayDownload：没做周几过滤时维持全量下载', () => {
  assert.deepEqual(planDayDownload({}, null), { mode: 'full' });
  assert.deepEqual(planDayDownload({}, { filtered: false, tips: [], withoutTip: 0 }), { mode: 'full' });
});

test('planDayDownload：只同步了部分分享时，下载只取这些分享', () => {
  assert.deepEqual(
    planDayDownload({}, { filtered: true, tips: ['遮天', '斗破'], withoutTip: 0 }),
    { mode: 'filtered', tips: ['遮天', '斗破'] },
  );
});

test('planDayDownload：有分享没填影视名称时无法安全过滤', () => {
  const day = { filtered: true, tips: ['遮天'], withoutTip: 1 };
  // 开了「下载后删除云端」：全量下载会把没安排今天的分享的文件也删掉，宁可跳过下载
  assert.deepEqual(planDayDownload({ deleteAfterDownload: true }, day),
    { mode: 'skip', reason: 'missing-tip-delete' });
  // 没开删除：退化为全量下载（只会多下，不会误删）
  assert.deepEqual(planDayDownload({ deleteAfterDownload: false }, day),
    { mode: 'full', reason: 'missing-tip' });
});

// ---- 清理失效链接不能丢周几配置 ----

test('pruneDeadUrls：清理失效链接时 updateDays 仍保留', () => {
  const shareUrls = [
    { url: 'https://pan.quark.cn/s/aaa111', tip: '遮天', updateDays: [1, 4] },
    'https://pan.quark.cn/s/bbb222',
    { url: ['https://pan.quark.cn/s/ccc333', 'https://pan.quark.cn/s/ddd444'], tip: '备用', updateDays: [7] },
  ];
  const { shareUrls: pruned, removed } = pruneDeadUrls(shareUrls, new Set(['aaa111', 'ccc333']));
  // 全部失效的单链接：url 清空但条目与周几配置保留（方便手动换成新链接）
  assert.deepEqual(pruned[0], { url: '', tip: '遮天', updateDays: [1, 4] });
  // 没失效的纯字符串项保持原样
  assert.equal(pruned[1], 'https://pan.quark.cn/s/bbb222');
  // 备用组只删失效那条，留下的同一条目里的 updateDays 不能丢
  assert.deepEqual(pruned[2], {
    url: ['https://pan.quark.cn/s/ddd444'],
    tip: '备用',
    updateDays: [7],
  });
  assert.deepEqual(
    removed.map(r => r.url),
    ['https://pan.quark.cn/s/aaa111', 'https://pan.quark.cn/s/ccc333'],
  );
});

// ---- 网页保存配置时的 updateDays 校验（web.js） ----
// 运行时 normalizeUpdateDays 会静默丢弃非法值；网页保存必须提前报错，
// 否则用户勾了/手写了「8」却以为生效了。

const validateWithDays = updateDays =>
  validateConfig({ shareUrls: [{ url: 'https://pan.quark.cn/s/xxxx', updateDays }] });

test('validateConfig：updateDays 合法值放行（含空数组 = 每天、缺失 = 每天）', () => {
  assert.deepEqual(validateWithDays([1, 4]), []);
  assert.deepEqual(validateWithDays([]), []);
  assert.deepEqual(validateWithDays(undefined), []);
  assert.deepEqual(validateWithDays(null), []);
  // 重复值交给运行时归一，校验不拦
  assert.deepEqual(validateWithDays([1, 1, 4]), []);
});

test('validateConfig：updateDays 非法值报错', () => {
  for (const bad of [[0], [8], '1', [1.5], {}]) {
    const errors = validateWithDays(bad);
    assert.equal(errors.length, 1, `updateDays=${JSON.stringify(bad)} 应当报错`);
    assert.match(errors[0], /updateDays 必须是 1-7 的整数数组/);
  }
});
