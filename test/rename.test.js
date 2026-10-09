// 转存后加前缀：改名失败的重试、复核与日志（线上出现过 404 / code 14014 "illegal text"）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNamePrefix } from '../src/index.js';

const QK_ERROR = 'API 返回错误 [404]: {"status":404,"code":14014,"message":"illegal text"}';

// 桩客户端：applyNamePrefix 只用到 listAllUserFiles 与 renameFile 两个方法。
// listAllUserFiles 记录参数：复核那一步必须用传进来的目标文件夹，用错目录（例如回落 '0' 根目录）
// 会把「其实已改好」判成失败，而那种接线错误只有断言参数才抓得住。
function makeClient({ files = [], failTimes = 0, alwaysFail = false, applyDespiteError = false } = {}) {
  const state = { files: files.map(f => ({ ...f })), calls: [], listCalls: 0, listArgs: [] };
  return {
    state,
    async listAllUserFiles(fid) {
      state.listCalls++;
      state.listArgs.push(fid);
      return state.files.map(f => ({ ...f }));
    },
    async renameFile(fid, name) {
      state.calls.push({ fid, name });
      const f = state.files.find(x => x.fid === fid);
      if (alwaysFail || state.calls.length <= failTimes) {
        // applyDespiteError 模拟「服务端其实改成功了，却回了错误」
        if (applyDespiteError && f) f.file_name = name;
        throw new Error(QK_ERROR);
      }
      if (f) f.file_name = name;
    },
  };
}

// 目标文件夹用一个非 '0' 的 fid：'0' 是根目录，用它就分不出「传对了」还是「回落到默认值」
const TARGET_FID = 'dir-目标';

// 收集日志：log 与 logError 分开收 —— 只按文本断言的话，把失败降级成 INFO 也照样全绿
function capture() {
  const lines = [];
  const errors = [];
  return {
    lines,
    errors,
    log: m => lines.push(String(m)),
    logError: m => { lines.push(String(m)); errors.push(String(m)); },
  };
}

// 单测里不等待、不重试等待
const opts = cap => ({
  settleMs: 0,
  retryMs: 0,
  renameRetryDelays: [0, 0],
  log: cap.log,
  logError: cap.logError,
});

test('applyNamePrefix：正常改名一次成功', async () => {
  const client = makeClient({ files: [{ fid: 'f1', file_name: '10 4K.mp4' }] });
  const cap = capture();
  const out = await applyNamePrefix(client, TARGET_FID, ['10 4K.mp4'], '诛仙', opts(cap));

  assert.deepEqual(out, ['诛仙-10 4K.mp4']);
  assert.equal(client.state.files[0].file_name, '诛仙-10 4K.mp4');
  assert.equal(client.state.calls.length, 1);
  assert.ok(cap.lines.some(l => l.includes('✓ 10 4K.mp4 → 诛仙-10 4K.mp4')));
  assert.deepEqual(cap.errors, [], '成功不该走 error 通道');
});

test('applyNamePrefix：首次失败会重试（线上那次 404 / 14014）', async () => {
  const client = makeClient({ files: [{ fid: 'f1', file_name: '10 4K.mp4' }], failTimes: 1 });
  const cap = capture();
  const out = await applyNamePrefix(client, TARGET_FID, ['10 4K.mp4'], '诛仙', opts(cap));

  assert.deepEqual(out, ['诛仙-10 4K.mp4']);
  assert.equal(client.state.calls.length, 2, '应该试了两次');
  assert.ok(cap.lines.some(l => l.includes('⚠ 改名失败（第 1/3 次）')), cap.lines.join('\n'));
  assert.ok(cap.lines.some(l => l.includes('✓ 10 4K.mp4 → 诛仙-10 4K.mp4')));
  assert.ok(!cap.lines.some(l => l.includes('重命名失败（目标名')), '重试成功后不该报错');
  assert.deepEqual(cap.errors, [], '重试成功不该走 error 通道');
});

test('applyNamePrefix：接口一直报错但其实已经改好 → 复核后按成功处理', async () => {
  const client = makeClient({
    files: [{ fid: 'f1', file_name: '10 4K.mp4' }],
    alwaysFail: true,
    applyDespiteError: true,
  });
  const cap = capture();
  const out = await applyNamePrefix(client, TARGET_FID, ['10 4K.mp4'], '诛仙', opts(cap));

  assert.deepEqual(out, ['诛仙-10 4K.mp4']);
  assert.equal(client.state.calls.length, 3, '1 次 + 2 次重试');
  assert.ok(cap.lines.some(l => l.includes('复核后确认已经改好')), cap.lines.join('\n'));
  assert.ok(!cap.lines.some(l => l.includes('重命名失败（目标名')), '复核成功就不该报错');
  assert.deepEqual(cap.errors, [], '复核成功不该走 error 通道');
  // 复核必须用传进来的目标文件夹，不能回落到根目录 '0'
  assert.ok(client.state.listArgs.length > 0);
  assert.deepEqual([...new Set(client.state.listArgs)], [TARGET_FID]);
});

test('applyNamePrefix：一直失败且确实没改成 → 报错写明目标名与 fid，文件保持原名', async () => {
  const client = makeClient({ files: [{ fid: 'f9', file_name: '10 4K.mp4' }], alwaysFail: true });
  const cap = capture();
  const out = await applyNamePrefix(client, TARGET_FID, ['10 4K.mp4'], '诛仙', opts(cap));

  // 文件不会丢，只是没加上前缀
  assert.deepEqual(out, ['10 4K.mp4']);
  assert.equal(client.state.files[0].file_name, '10 4K.mp4');
  assert.equal(client.state.calls.length, 3);

  const err = cap.lines.find(l => l.includes('重命名失败'));
  assert.ok(err, cap.lines.join('\n'));
  assert.ok(err.includes('目标名: 诛仙-10 4K.mp4'), err);
  assert.ok(err.includes('fid: f9'), err);
  assert.ok(err.includes('14014'), '原始报错要留给用户看');
  // 真失败必须走 error 通道：降级成 INFO 的话，默认「下载清单」视图就看不见了
  assert.deepEqual(cap.errors, [err]);
});

test('applyNamePrefix：目标名被占用时改用序号名，并说明原因', async () => {
  const client = makeClient({
    files: [
      { fid: 'f1', file_name: '10 4K.mp4' },
      { fid: 'f2', file_name: '诛仙-10 4K.mp4' },
    ],
  });
  const cap = capture();
  const out = await applyNamePrefix(client, TARGET_FID, ['10 4K.mp4'], '诛仙', opts(cap));

  assert.deepEqual(out, ['诛仙-10 4K (2).mp4']);
  assert.equal(client.state.calls.length, 1);
  assert.equal(client.state.calls[0].fid, 'f1');
  assert.equal(client.state.calls[0].name, '诛仙-10 4K (2).mp4');
  assert.ok(cap.lines.some(l => l.includes('加序号避免覆盖')));
});

test('applyNamePrefix：文件本身已带前缀时不叠加', async () => {
  const client = makeClient({ files: [{ fid: 'f1', file_name: '诛仙-10.mp4' }] });
  const cap = capture();
  const out = await applyNamePrefix(client, TARGET_FID, ['诛仙-10.mp4'], '诛仙', opts(cap));

  assert.deepEqual(out, ['诛仙-10.mp4']);
  assert.equal(client.state.calls.length, 0);
  assert.ok(cap.lines.some(l => l.includes('已带前缀，跳过')));
});

test('applyNamePrefix：没设影视名称时原样返回，一个请求都不发', async () => {
  const client = makeClient();
  const cap = capture();
  const out = await applyNamePrefix(client, TARGET_FID, ['a.mkv'], '', opts(cap));

  assert.deepEqual(out, ['a.mkv']);
  assert.equal(client.state.listCalls, 0);
  assert.equal(client.state.calls.length, 0);
});

test('applyNamePrefix：找不到刚转存的文件时只报告，不报错也不改名', async () => {
  const client = makeClient({ files: [{ fid: 'f1', file_name: '别的文件.mkv' }] });
  const cap = capture();
  const out = await applyNamePrefix(client, TARGET_FID, ['10 4K.mp4'], '诛仙', opts(cap));

  assert.deepEqual(out, ['10 4K.mp4']);
  assert.equal(client.state.calls.length, 0);
  assert.ok(cap.lines.some(l => l.includes('仍未找到，跳过重命名')));
});

