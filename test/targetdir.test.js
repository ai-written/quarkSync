// 目标文件夹的多级路径解析（不触网：注入假的 client）
//
// resolveDirPath 是 QuarkClient.resolveTargetDir 的实现主体，抽出来是为了能单测：
// 它只要求 client 提供 findFolderByName / createFolder。resolveTargetDir 本身只剩
// 「targetDirFid 优先、否则用 targetDirName」这几行，属平凡包装，由集成行为覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDirPath } from '../src/index.js';

// 假的目录树：键为 `父fid/名字`，值为 fid
function makeClient(seed = {}, badCreate) {
  const tree = new Map(Object.entries(seed));
  const calls = [];
  let n = 0;
  return {
    calls,
    tree,
    findFolderByName: async (name, pdir = '0') => {
      calls.push(['find', name, pdir]);
      const k = `${pdir}/${name}`;
      return tree.has(k) ? tree.get(k) : null;
    },
    createFolder: async (name, pdir = '0') => {
      calls.push(['create', name, pdir]);
      if (badCreate && badCreate(name)) return undefined;   // 模拟接口返回 200 但没有 fid
      const fid = `new${++n}`;
      tree.set(`${pdir}/${name}`, fid);
      return fid;
    },
  };
}

// 解析过程中会打印进度，测试里静音，避免污染输出
async function run(client, dirName, opts) {
  const real = console.log;
  console.log = () => {};
  try {
    return await resolveDirPath(client, dirName, opts);
  } finally {
    console.log = real;
  }
}

test('单级：已存在时直接返回，且从根目录查找', async () => {
  const c = makeClient({ '0/A': 'fa' });
  assert.equal(await run(c, 'A'), 'fa');
  assert.deepEqual(c.calls, [['find', 'A', '0']]);
});

test('单级：不存在时在根目录创建', async () => {
  const c = makeClient();
  assert.equal(await run(c, 'A'), 'new1');
  assert.deepEqual(c.calls, [['find', 'A', '0'], ['create', 'A', '0']]);
});

test('两级：子级建在父级的 fid 下（不是根目录）', async () => {
  const c = makeClient({ '0/A': 'fa' });
  assert.equal(await run(c, 'A/B'), 'new1');
  const creates = c.calls.filter(x => x[0] === 'create');
  assert.deepEqual(creates, [['create', 'B', 'fa']]);
});

test('两级都不存在时逐级创建', async () => {
  const c = makeClient();
  assert.equal(await run(c, 'A/B'), 'new2');
  assert.deepEqual(c.calls.filter(x => x[0] === 'create'), [
    ['create', 'A', '0'],
    ['create', 'B', 'new1'],
  ]);
});

test('三级全部新建时父目录正确串联', async () => {
  const c = makeClient();
  assert.equal(await run(c, 'A/B/C'), 'new3');
  assert.deepEqual(c.calls.filter(x => x[0] === 'create'), [
    ['create', 'A', '0'],
    ['create', 'B', 'new1'],
    ['create', 'C', 'new2'],
  ]);
});

test('冗余斜杠与首尾空格都被忽略', async () => {
  const c = makeClient({ '0/A': 'fa', 'fa/B': 'fb' });
  assert.equal(await run(c, '/A//B/'), 'fb');
  assert.equal(c.calls.filter(x => x[0] === 'create').length, 0);

  const c2 = makeClient({ '0/A': 'fa', 'fa/B': 'fb' });
  assert.equal(await run(c2, ' A / B '), 'fb');
  assert.equal(c2.calls.filter(x => x[0] === 'create').length, 0);
});

test('空名称或只有斜杠时视为根目录，且不发起任何查询', async () => {
  for (const v of ['', '/', '//', '   ']) {
    const c = makeClient();
    assert.equal(await run(c, v), '0', `${JSON.stringify(v)} 应回落到根目录`);
    assert.equal(c.calls.length, 0);
  }
});

test('"." 与 ".." 没有特殊含义，按普通名字创建', async () => {
  const c = makeClient();
  assert.equal(await run(c, '../A'), 'new2');
  assert.deepEqual(c.calls.filter(x => x[0] === 'create').map(x => x[1]), ['..', 'A']);
});

test('创建拿不到 fid 时抛错（否则会把余下层级建到错误位置）', async () => {
  const c = makeClient({}, () => true);
  await assert.rejects(() => run(c, 'A'), /未返回 fid/);
});

test('多级中途失败立即中断，不再继续往下建', async () => {
  const c = makeClient({}, name => name === 'B');
  await assert.rejects(() => run(c, 'A/B/C'), /未返回 fid/);
  assert.deepEqual(c.calls.map(x => x[0]), ['find', 'create', 'find', 'create']);
});

test('dryRun：目录不存在时只提示、不创建，并返回 null', async () => {
  const c = makeClient({ '0/A': 'fa' });
  assert.equal(await run(c, 'A/B', { dryRun: true }), null);
  assert.equal(c.calls.filter(x => x[0] === 'create').length, 0);
});
