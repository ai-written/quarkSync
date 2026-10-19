import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  QuarkClient,
  cleanupLocalDuplicates,
  findDuplicateSets,
  isVideoFile,
  shouldKeepFile,
  sortByEpisode,
} from '../src/index.js';

test('shouldKeepFile：默认只处理视频；videoOnly=false 关闭过滤，videoExtensions 可覆盖', () => {
  assert.equal(shouldKeepFile('斗破苍穹-213 4K.mp4'), true);
  assert.equal(shouldKeepFile('A.MKV'), true);
  assert.equal(shouldKeepFile('斗破苍穹-S05E212.DDP2.0.zip'), false);
  assert.equal(shouldKeepFile('poster.jpg'), false);
  assert.equal(shouldKeepFile('Show.S01E07.srt'), false);
  assert.equal(shouldKeepFile('noext'), false);
  // 想保留字幕/其它类型：自己加扩展名
  assert.equal(shouldKeepFile('Show.S01E07.srt', { videoExtensions: ['srt'] }), true);
  assert.equal(shouldKeepFile('Show.S01E07.ass', { videoExtensions: ['srt', '.ASS'] }), true);
  // 完全关闭类型过滤（恢复旧行为）
  assert.equal(shouldKeepFile('data.zip', { videoOnly: false }), true);
  assert.equal(isVideoFile('A.MKV'), true);
  assert.equal(isVideoFile('A.zip'), false);
});

test('sortByEpisode：一方没写季号时按集数比较，S05E212 不会挤到 215 前面', () => {
  const files = [
    { file_name: '斗破苍穹-S05E212.DDP2.0.zip', updated_at: 1 },
    { file_name: '斗破苍穹-215 4K.mp4', updated_at: 2 },
    { file_name: '斗破苍穹-213 4K.mp4', updated_at: 3 },
  ];
  const order = files.slice().sort(sortByEpisode).map(f => f.file_name);
  assert.deepEqual(order, [
    '斗破苍穹-215 4K.mp4',
    '斗破苍穹-213 4K.mp4',
    '斗破苍穹-S05E212.DDP2.0.zip',
  ]);

  // 两边都明确写了季号时，仍然按季号降序
  const two = [
    { file_name: 'Show.S01E05.mkv', updated_at: 1 },
    { file_name: 'Show.S02E01.mkv', updated_at: 2 },
  ].sort(sortByEpisode).map(f => f.file_name);
  assert.deepEqual(two, ['Show.S02E01.mkv', 'Show.S01E05.mkv']);
});

test('downloadAllFromFolder：非视频文件不参与下载', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-media-'));
  const c = Object.create(QuarkClient.prototype);
  c.listTopLevelEntries = async () => [
    { file_name: '斗破苍穹-213 4K.mp4', fid: 'v1', size: 100, dir: false },
    { file_name: '斗破苍穹-S05E212.DDP2.0.zip', fid: 'z1', size: 100, dir: false },
  ];
  c.listAllUserFiles = async () => [];
  const requested = [];
  c.getDownloadUrls = async fids => {
    requested.push(...fids);
    return fids.map(fid => ({ fid, file_name: 'x', download_url: 'u', size: 100 }));
  };
  c.downloadFilesParallel = async () => [];

  await c.downloadAllFromFolder('root', dir, false, false, { flatten: false, keepFile: name => shouldKeepFile(name, {}) });
  assert.deepEqual(requested, ['v1']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同集去重只比较视频：S05E212.zip 不会跟 212 正片组成重复', () => {
  const { sets, skipped } = findDuplicateSets([
    { file_name: '斗破苍穹-S05E212.DDP2.0.zip', size: 500 },
    { file_name: '斗破苍穹-212 4K.mp4', size: 100 },
  ]);
  assert.deepEqual(sets, []);
  assert.deepEqual(skipped, []);
});

test('cleanupLocalDuplicates：keepFile 过滤后非视频不参与同集去重', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-media-clean-'));
  const w = (name, size) => fs.writeFileSync(path.join(dir, name), Buffer.alloc(size));
  w('斗破苍穹-213 4K.mp4', 100);
  w('斗破苍穹-213 4K SDR.mkv', 50);
  w('斗破苍穹-S05E213.DDP2.0.zip', 500);   // 名字里带 S05E213，但不是视频
  try {
    const filtered = cleanupLocalDuplicates(dir, { keepFile: name => shouldKeepFile(name, {}) });
    assert.equal(filtered.scanned, 2);
    assert.equal(filtered.sets.length, 1);

    const all = cleanupLocalDuplicates(dir, { keepFile: name => shouldKeepFile(name, { videoOnly: false }) });
    assert.equal(all.scanned, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
