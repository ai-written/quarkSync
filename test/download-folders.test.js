// 下载侧的分组：目标文件夹当层一组、每个一级子文件夹各一组。
// 只测 collectDownloadGroups（纯列目录逻辑，不触发下载/日志），
// 分组的去重与跳过判定复用 already-tested 的 deduplicateByEpisode / downloadRecordKey。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuarkClient } from '../src/index.js';

function fakeClient(entries, byFid) {
  const c = Object.create(QuarkClient.prototype);
  c.listTopLevelEntries = async () => entries;
  c.listAllUserFiles = async fid => byFid[fid] || [];
  return c;
}

test('collectDownloadGroups：当层文件 + 每个子文件夹分组，空目录忽略', async () => {
  const c = fakeClient(
    [
      { file_name: '当层文件.mkv', size: 1, fid: 'f0' },
      { file_name: '灵境行者', dir: true, fid: 'd1' },
      { file_name: '遮天', dir: true, fid: 'd2' },
      { file_name: '空文件夹', dir: true, fid: 'd3' },
    ],
    {
      d1: [{ file_name: '08.mkv', size: 100, fid: 'a1' }],
      d2: [{ file_name: '08.mkv', size: 200, fid: 'b1' }],
      d3: [],
    },
  );
  const groups = await c.collectDownloadGroups('root');
  assert.deepEqual(groups.map(g => g.relDir), ['', '灵境行者', '遮天']);
  assert.deepEqual(groups[0].files.map(f => f.file_name), ['当层文件.mkv']);
  assert.equal(groups[1].files[0].size, 100);
  assert.equal(groups[2].files[0].size, 200);
});

test('collectDownloadGroups：没有当层文件时第一组就是子文件夹', async () => {
  const c = fakeClient(
    [{ file_name: '灵境行者', dir: true, fid: 'd1' }],
    { d1: [{ file_name: '08.mkv', size: 1, fid: 'a1' }] },
  );
  const groups = await c.collectDownloadGroups('root');
  assert.deepEqual(groups.map(g => g.relDir), ['灵境行者']);
});

test('collectDownloadGroups：flatten=true 时递归列出全部文件、单组平铺（未开启分文件夹的旧行为）', async () => {
  const c = fakeClient([], {});
  c.listAllUserFiles = async () => [
    { file_name: '08.mkv', size: 1, fid: 'a1' },
    { file_name: '09.mkv', size: 2, fid: 'a2' },
  ];
  const groups = await c.collectDownloadGroups('root', { flatten: true });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].relDir, '');
  assert.equal(groups[0].files.length, 2);
});
