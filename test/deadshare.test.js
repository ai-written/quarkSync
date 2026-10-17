// 失效分享判定（isShareDead）与失效链接清理（pruneDeadUrls）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShareDead, pruneDeadUrls } from '../src/index.js';

// 生产环境真实报错：分享者账号被封禁 → 403 / 41031
const DEAD_403 = 'API 返回错误 [403]: {"status":403,"code":41031,"message":"分享者用户封禁链接查看受限",'
  + '"req_id":"9f07w2-2b51c124a2c876","timestamp":1792152012,"metadata":'
  + '{"_t_group":"0:_s_vp:1;9:_s_wx_channel_preview_back:3;13:_s_save_complete_auto_back:1",'
  + '"_g_group":"3:_s_vtp:1;7:_s_goback_app_pop:1;0:_s_vp:1;1:_s_ap:0;10:_s_wb_atc:1;12:_s_login_auto_save:1;'
  + '8:_s_goback_auto_save:1;2:_s_bp:1;4:_s_wl:1;11:_s_unsupported_preview_guide_back:0"}}';

test('isShareDead：分享者用户封禁 / 41031 查看受限判为失效', () => {
  assert.equal(isShareDead(DEAD_403), true);
  assert.equal(isShareDead('该分享者账号已被封禁'), true);
  // 只有错误码、没有可识别文案时也要认
  assert.equal(isShareDead('API 返回错误 [403]: {"code":41031}'), true);
});

test('isShareDead：失效 / 过期 / 违规 / 屏蔽等既有文案仍然认', () => {
  assert.equal(isShareDead('分享已失效'), true);
  assert.equal(isShareDead('该分享不存在'), true);
  assert.equal(isShareDead('分享已过期'), true);
  assert.equal(isShareDead('链接违规，无法访问'), true);
  assert.equal(isShareDead('该分享已被屏蔽'), true);
  assert.equal(isShareDead('share not found'), true);
  assert.equal(isShareDead('pwd_id invalid'), true);
});

test('isShareDead：提取码错误不算失效（链接本身没坏）', () => {
  assert.equal(isShareDead('提取码错误，请重新输入'), false);
  assert.equal(isShareDead('passcode error'), false);
  assert.equal(isShareDead('分享密码不正确'), false);
});

test('isShareDead：网络抖动 / 超时 / 限流 / 5xx 不算失效', () => {
  assert.equal(isShareDead('timeout of 30000ms exceeded'), false);
  assert.equal(isShareDead('read ECONNRESET'), false);
  assert.equal(isShareDead('请求过于频繁（23018）'), false);
  assert.equal(isShareDead('API 返回错误 [503]: Service Unavailable'), false);
  assert.equal(isShareDead('Request failed with status code 502'), false);
  assert.equal(isShareDead('{"status":500,"message":"服务器内部错误"}'), false);
  // 只有「查看受限 / 访问受限」、没有「封禁 / 41031」时按临时故障处理（保守，宁可不删）
  assert.equal(isShareDead('当前链接访问受限'), false);
});

test('isShareDead：时间戳 / req_id 里的数字不会被当成 5xx', () => {
  // 1792152012 中含 "520"，旧规则用裸 5\d\d 会误判成服务端错误
  assert.equal(isShareDead('API 返回错误 [403]: {"message":"操作失败","timestamp":1792152012}'), false);
  assert.equal(isShareDead('req_id 9f07w2-2b51c124a2c876 请求失败'), false);
});

test('pruneDeadUrls：备用组只删坏的那条，保留可用项与其它字段', () => {
  const item = {
    url: ['https://pan.quark.cn/s/aaa', 'https://pan.quark.cn/s/bbb?pwd=1234'],
    tip: '大夏守墓人',
    hours: '12h',
  };
  const { shareUrls, removed } = pruneDeadUrls([item], new Set(['bbb']));
  assert.deepEqual(shareUrls, [{
    url: ['https://pan.quark.cn/s/aaa'],
    tip: '大夏守墓人',
    hours: '12h',
  }]);
  assert.deepEqual(removed, [{ url: 'https://pan.quark.cn/s/bbb?pwd=1234', tip: '大夏守墓人' }]);
  // 不能改到调用方传进来的原对象
  assert.equal(item.url.length, 2);
});

test('pruneDeadUrls：唯一链接失效时清空 url，但保留条目与筛选条件', () => {
  const item = { url: 'https://pan.quark.cn/s/aaa', tip: '某剧', minFileSizeMB: 200, maxFilesPerShare: 3 };
  const { shareUrls, removed } = pruneDeadUrls([item], new Set(['aaa']));
  assert.deepEqual(shareUrls, [{ url: '', tip: '某剧', minFileSizeMB: 200, maxFilesPerShare: 3 }]);
  assert.deepEqual(removed, [{ url: 'https://pan.quark.cn/s/aaa', tip: '某剧' }]);
});

test('pruneDeadUrls：字符串写法失效时也转成保留字段的对象', () => {
  const { shareUrls } = pruneDeadUrls(['https://pan.quark.cn/s/aaa'], new Set(['aaa']));
  assert.deepEqual(shareUrls, [{ url: '' }]);
});

test('pruneDeadUrls：没有失效项时原样返回，且不复制对象', () => {
  const alive = { url: 'https://pan.quark.cn/s/aaa', tip: '某剧' };
  const items = ['https://pan.quark.cn/s/bbb', alive, { url: '' }];
  const { shareUrls, removed } = pruneDeadUrls(items, new Set());
  assert.deepEqual(shareUrls, items);
  assert.equal(shareUrls[1], alive);
  assert.deepEqual(removed, []);
});

test('pruneDeadUrls：空 url 条目与无法解析的链接保持不动', () => {
  const items = [{ url: '' }, { url: '不是链接' }, { url: 'https://pan.quark.cn/s/aaa', tip: 'x' }];
  const { shareUrls } = pruneDeadUrls(items, new Set(['aaa']));
  assert.deepEqual(shareUrls, [{ url: '' }, { url: '不是链接' }, { url: '', tip: 'x' }]);
});
