// 时间窗口与筛选：单位解析、可读回显、全局窗口优先级、按更新时间过滤
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDuration,
  parseDurationHours,
  formatHours,
  resolveWindowHours,
  filterByHours,
} from '../src/index.js';

test('isValidDuration：接受纯数字与各种单位写法', () => {
  for (const v of [24, 0, 1.5, '24', '0', '1d', '1.5d', '12h', '12hr', '30m', '30min', '1mo', '1w', '1y', '2D', ' 1 d ', '0.5w']) {
    assert.equal(isValidDuration(v), true, `${JSON.stringify(v)} 应合法`);
  }
});

test('isValidDuration：拒绝非法值', () => {
  for (const v of [undefined, null, '', '   ', '1x', 'abc', 'd', '1 月', -1, NaN, Infinity, {}, [], true]) {
    assert.equal(isValidDuration(v), false, `${JSON.stringify(v)} 应非法`);
  }
});

test('parseDurationHours：纯数字按小时，兼容旧配置', () => {
  assert.equal(parseDurationHours(24), 24);
  assert.equal(parseDurationHours('24'), 24);
  assert.equal(parseDurationHours(0), 0);
  assert.equal(parseDurationHours('0'), 0);
  assert.equal(parseDurationHours(1.5), 1.5);
});

test('parseDurationHours：单位换算（m=分钟、mo=月）', () => {
  assert.equal(parseDurationHours('30m'), 0.5);
  assert.equal(parseDurationHours('12h'), 12);
  assert.equal(parseDurationHours('12hr'), 12);
  assert.equal(parseDurationHours('1d'), 24);
  assert.equal(parseDurationHours('1.5d'), 36);
  assert.equal(parseDurationHours('1w'), 168);
  assert.equal(parseDurationHours('1mo'), 720);
  assert.equal(parseDurationHours('30mo'), 21600);
  assert.equal(parseDurationHours('1y'), 8760);
  assert.equal(parseDurationHours('2D'), 48);          // 大小写不敏感
  assert.equal(parseDurationHours(' 1 d '), 24);       // 允许空格
});

test('parseDurationHours：无法识别时回退（默认 48 小时）', () => {
  assert.equal(parseDurationHours('1x'), 48);
  assert.equal(parseDurationHours('abc'), 48);
  assert.equal(parseDurationHours(undefined), 48);
  assert.equal(parseDurationHours(null), 48);
  assert.equal(parseDurationHours(''), 48);
  assert.equal(parseDurationHours(-1), 48);
  assert.equal(parseDurationHours(NaN), 48);
  assert.equal(parseDurationHours('1x', 12), 12);      // 自定义 fallback
});

test('formatHours：把小时数还原成易读形式', () => {
  assert.equal(formatHours(0), '0 小时');
  assert.equal(formatHours(0.5), '30 分钟');
  assert.equal(formatHours(24), '1 天');
  assert.equal(formatHours(48), '2 天');
  assert.equal(formatHours(168), '1 周');
  assert.equal(formatHours(720), '1 个月');
  assert.equal(formatHours(8760), '1 年');
  assert.equal(formatHours(36), '36 小时');
  assert.equal(formatHours(1.25), '1.25 小时');
  assert.equal(formatHours(NaN), 'NaN');
});

test('resolveWindowHours：hours 优先，其次历史字段 days，否则 48', () => {
  assert.equal(resolveWindowHours({ hours: 24 }), 24);
  assert.equal(resolveWindowHours({ hours: '1d' }), 24);
  assert.equal(resolveWindowHours({ hours: 12, days: 2 }), 12);   // hours 优先
  assert.equal(resolveWindowHours({ hours: '' , days: 2 }), 48);  // 空串视为未配置 -> days
  assert.equal(resolveWindowHours({ days: 2 }), 48);
  assert.equal(resolveWindowHours({ days: 0 }), 48);              // 历史语义：falsy 即未配置
  assert.equal(resolveWindowHours({}), 48);
  assert.equal(resolveWindowHours({ hours: 0 }), 0);              // 0 是显式覆盖（会什么都转存不了）
});

test('filterByHours：只保留窗口内更新的文件，跳过目录', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const files = [
    { file_name: 'recent.mkv', size: 1, updated_at: nowSec - 3600 },              // 1 小时内
    { file_name: 'edge.mkv', size: 1, updated_at: nowSec - 23 * 3600 },           // 窗口内
    { file_name: 'old.mkv', size: 1, updated_at: nowSec - 3 * 86400 },            // 3 天前
    { file_name: 'dir', dir: true, updated_at: nowSec - 60 },                     // 目录
    { file_name: 'ms.mkv', size: 1, updated_at: (nowSec - 7200) * 1000 },         // 毫秒时间戳
  ];
  const kept = filterByHours(files, 24).map(f => f.file_name);
  assert.deepEqual(kept, ['recent.mkv', 'edge.mkv', 'ms.mkv']);
});

test('filterByHours：窗口为 0 时什么都留不下（与文档一致）', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const kept = filterByHours([{ file_name: 'a.mkv', size: 1, updated_at: nowSec - 60 }], 0);
  assert.equal(kept.length, 0);
});
