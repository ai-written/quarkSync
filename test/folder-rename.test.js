// 改影视名称后自动重命名文件夹（云端 + 本地）并替换文件名前缀
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  downloadRecordKey,
  folderRenameName,
  loadShowFolderMap,
  recordShowFolderTipChanges,
  renameCloudShowFolder,
  renameLocalShowFolder,
} from '../src/index.js';

function withTempTree(create, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-rename-'));
  try {
    create(dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(dir, rel, size = 10) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size, 1));
}

test('folderRenameName：旧前缀换新前缀，裸名补新前缀，已是新前缀的不动', () => {
  assert.equal(folderRenameName('旧剧-08.mkv', '旧剧', '新剧'), '新剧-08.mkv');
  assert.equal(folderRenameName('旧剧-ZLJZCSDR-09.mp4', '旧剧', '新剧'), '新剧-ZLJZCSDR-09.mp4');
  assert.equal(folderRenameName('08.mkv', '旧剧', '新剧'), '新剧-08.mkv');
  assert.equal(folderRenameName('新剧-08.mkv', '旧剧', '新剧'), '新剧-08.mkv');
  assert.equal(folderRenameName('别的剧-08.mkv', '旧剧', '新剧'), '新剧-别的剧-08.mkv');
});

test('loadShowFolderMap：读不到/格式不对时返回空对象，能读回映射', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-map-'));
  try {
    const file = path.join(dir, '.show-folders.json');
    assert.deepEqual(loadShowFolderMap(file), {});
    fs.writeFileSync(file, JSON.stringify({ 'share-1': '旧剧' }));
    assert.deepEqual(loadShowFolderMap(file), { 'share-1': '旧剧' });
    fs.writeFileSync(file, '[1,2]');
    assert.deepEqual(loadShowFolderMap(file), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renameLocalShowFolder：预览不动，apply 时文件夹改名 + 文件换前缀 + 平铺文件搬入 + 记录键更新', () => {
  withTempTree(dir => {
    writeFile(dir, '旧剧/旧剧-08.mkv', 100);
    writeFile(dir, '旧剧/旧剧-09.mkv', 200);
    writeFile(dir, '旧剧/裸名-10.mkv', 300);
    writeFile(dir, '旧剧-11.mkv', 400);                 // 当层旧前缀平铺文件
    fs.writeFileSync(path.join(dir, '.downloaded.json'), JSON.stringify({
      [downloadRecordKey('旧剧-08.mkv', '旧剧')]: true,
      [downloadRecordKey('旧剧-11.mkv', '')]: true,
    }));
  }, dir => {
    const preview = renameLocalShowFolder(dir, '旧剧', '新剧', { apply: false });
    assert.equal(preview.renamedFolder, true);
    assert.equal(preview.renames.length, 3);            // 08/09/裸名 都换前缀
    assert.equal(preview.moves.length, 1);              // 当层 旧剧-11 搬入
    assert.equal(fs.existsSync(path.join(dir, '旧剧')), true);

    const applied = renameLocalShowFolder(dir, '旧剧', '新剧', { apply: true });
    assert.equal(applied.renamedFolder, true);
    assert.equal(fs.existsSync(path.join(dir, '旧剧')), false);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-08.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-09.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-裸名-10.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-11.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '旧剧-11.mkv')), false);

    const record = JSON.parse(fs.readFileSync(path.join(dir, '.downloaded.json'), 'utf-8'));
    assert.equal(record[downloadRecordKey('旧剧-08.mkv', '旧剧')], undefined);
    assert.equal(record[downloadRecordKey('旧剧-11.mkv', '')], undefined);
    assert.equal(record[downloadRecordKey('新剧-08.mkv', '新剧')], true);
    assert.equal(record[downloadRecordKey('新剧-11.mkv', '新剧')], true);
  });
});

test('renameLocalShowFolder：新旧文件夹同时存在时只记冲突，不动任何文件', () => {
  withTempTree(dir => {
    writeFile(dir, '旧剧/旧剧-08.mkv', 100);
    writeFile(dir, '新剧/新剧-09.mkv', 100);
  }, dir => {
    const r = renameLocalShowFolder(dir, '旧剧', '新剧', { apply: true });
    assert.equal(r.renamedFolder, false);
    assert.equal(r.conflicts.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '旧剧', '旧剧-08.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-09.mkv')), true);
  });
});

test('renameLocalShowFolder：只有平铺旧文件、没有旧文件夹时，也搬进新文件夹并换前缀', () => {
  withTempTree(dir => {
    writeFile(dir, '旧剧-08.mkv', 100);
    writeFile(dir, '旧剧-09.mkv', 200);
    writeFile(dir, '.downloaded.json', 5);
  }, dir => {
    const preview = renameLocalShowFolder(dir, '旧剧', '新剧', { apply: false });
    assert.equal(preview.renamedFolder, false);
    assert.equal(preview.moves.length, 2);
    assert.equal(fs.existsSync(path.join(dir, '新剧')), false);   // 预览不创建目录

    const applied = renameLocalShowFolder(dir, '旧剧', '新剧', { apply: true });
    assert.equal(applied.moves.length, 2);
    assert.equal(fs.existsSync(path.join(dir, '旧剧-08.mkv')), false);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-08.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-09.mkv')), true);
  });
});

test('renameLocalShowFolder：merge=true 时把旧文件夹里的文件合并进新文件夹并删掉空旧目录', () => {
  withTempTree(dir => {
    writeFile(dir, '旧剧/旧剧-08.mkv', 100);
    writeFile(dir, '旧剧/旧剧-09.mkv', 200);
    writeFile(dir, '新剧/新剧-10.mkv', 300);
    fs.writeFileSync(path.join(dir, '.downloaded.json'), JSON.stringify({
      [downloadRecordKey('旧剧-08.mkv', '旧剧')]: true,
    }));
  }, dir => {
    const preview = renameLocalShowFolder(dir, '旧剧', '新剧', { apply: false, merge: true });
    assert.equal(preview.merged, true);
    assert.equal(preview.mergedFiles.length, 2);
    assert.equal(fs.existsSync(path.join(dir, '旧剧')), true);   // 预览不动

    const applied = renameLocalShowFolder(dir, '旧剧', '新剧', { apply: true, merge: true });
    assert.equal(applied.merged, true);
    assert.equal(fs.existsSync(path.join(dir, '旧剧')), false);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-08.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-09.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '新剧', '新剧-10.mkv')), true);

    const record = JSON.parse(fs.readFileSync(path.join(dir, '.downloaded.json'), 'utf-8'));
    assert.equal(record[downloadRecordKey('旧剧-08.mkv', '旧剧')], undefined);
    assert.equal(record[downloadRecordKey('新剧-08.mkv', '新剧')], true);
  });
});

test('recordShowFolderTipChanges：网页改影视名称时把旧名字记进映射，供下次同步改名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-tip-'));
  try {
    const mapFile = path.join(dir, '.show-folders.json');
    const oldCfg = {
      shareUrls: [{ url: 'https://pan.quark.cn/s/abc123', tip: '旧剧' }],
    };
    const newCfg = {
      shareUrls: [{ url: 'https://pan.quark.cn/s/abc123', tip: '新剧' }],
    };
    const changes = recordShowFolderTipChanges(oldCfg, newCfg, { mapFile });
    assert.deepEqual(changes, [{ id: 'abc123', from: '旧剧', to: '新剧' }]);
    assert.deepEqual(loadShowFolderMap(mapFile), { abc123: '旧剧' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordShowFolderTipChanges：分享链接全换且名字无关时不乱猜；名字有包含关系时仍记录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-tip2-'));
  try {
    const mapFile = path.join(dir, '.show-folders.json');
    // 链接换了、名字也完全无关 → 不猜
    let changes = recordShowFolderTipChanges(
      { shareUrls: [{ url: 'https://pan.quark.cn/s/aaa', tip: '甲剧' }] },
      { shareUrls: [{ url: 'https://pan.quark.cn/s/bbb', tip: '乙剧' }] },
      { mapFile },
    );
    assert.deepEqual(changes, []);
    // 链接换了，但名字是「旧名 → 旧名+后缀」（典型改法）→ 记录旧名
    changes = recordShowFolderTipChanges(
      { shareUrls: [{ url: 'https://pan.quark.cn/s/aaa', tip: '斗破苍穹' }] },
      { shareUrls: [{ url: 'https://pan.quark.cn/s/bbb', tip: '斗破苍穹年番' }] },
      { mapFile },
    );
    assert.ok(changes.length > 0);
    assert.equal(changes[0].from, '斗破苍穹');
    assert.equal(changes[0].to, '斗破苍穹年番');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 云端（假 client，不触网） ----------

function fakeCloudClient(state) {
  // state.folders: { 文件夹名: { fid, files: [{ file_name, fid }] } }
  // state.flat:    [{ file_name, fid }]
  const calls = { renamedFolders: [], renamedFiles: [], moved: [], deleted: [] };
  const folderEntries = () => Object.entries(state.folders);
  const findFile = fid => {
    for (const [name, f] of folderEntries()) {
      const hit = f.files.find(x => x.fid === fid);
      if (hit) return { folder: name, file: hit };
    }
    const flat = state.flat.find(x => x.fid === fid);
    return flat ? { folder: null, file: flat } : null;
  };
  const client = {
    calls,
    async findFolderByName(name) { return state.folders[name]?.fid || null; },
    async renameFile(fid, target) {
      const folder = folderEntries().find(([, f]) => f.fid === fid);
      if (folder) {
        const [oldName, f] = folder;
        delete state.folders[oldName];
        state.folders[target] = f;
        calls.renamedFolders.push({ from: oldName, to: target });
        return;
      }
      const hit = findFile(fid);
      if (!hit) throw new Error('file not found');
      calls.renamedFiles.push({ from: hit.file.file_name, to: target });
      hit.file.file_name = target;
    },
    async listAllUserFiles(fid) {
      const f = folderEntries().find(([, x]) => x.fid === fid);
      return f ? f[1].files : [];
    },
    async listTopLevelEntries() {
      const dirs = folderEntries().map(([name, f]) => ({ dir: true, file_name: name, fid: f.fid }));
      return [...dirs, ...state.flat.map(x => ({ ...x, dir: false }))];
    },
    async ensureSubfolder(parent, name) {
      if (!state.folders[name]) state.folders[name] = { fid: `new-${name}`, files: [] };
      return state.folders[name].fid;
    },
    async moveFiles(fids, fid) {
      const target = folderEntries().find(([, x]) => x.fid === fid);
      for (const id of fids) {
        const hit = findFile(id);
        if (!hit) throw new Error('file not found');
        if (hit.folder) {
          const arr = state.folders[hit.folder].files;
          arr.splice(arr.findIndex(x => x.fid === id), 1);
        } else {
          state.flat = state.flat.filter(x => x.fid !== id);
        }
        target[1].files.push(hit.file);
      }
      calls.moved.push({ fids, fid });
    },
    async deleteFiles(fids) {
      for (const fid of fids) {
        const folder = folderEntries().find(([, x]) => x.fid === fid);
        if (folder) {
          calls.deleted.push(folder[0]);
          delete state.folders[folder[0]];
        } else {
          state.flat = state.flat.filter(x => x.fid !== fid);
        }
      }
    },
  };
  return client;
}

test('renameCloudShowFolder：旧文件夹改名 + 文件夹内/平铺文件换前缀', async () => {
  const state = {
    folders: {
      旧剧: {
        fid: 'd-old',
        files: [
          { file_name: '旧剧-08.mkv', fid: 'f8' },
          { file_name: '裸名-09.mkv', fid: 'f9' },
        ],
      },
    },
    flat: [{ file_name: '旧剧-10.mkv', fid: 'f10' }],
  };
  const client = fakeCloudClient(state);
  const r = await renameCloudShowFolder(client, 'root', '旧剧', '新剧');
  assert.equal(r.renamedFolder, true);
  assert.deepEqual(r.renames.map(x => x.to), ['新剧/新剧-08.mkv', '新剧/新剧-裸名-09.mkv', '新剧/新剧-10.mkv']);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(client.calls.renamedFolders, [{ from: '旧剧', to: '新剧' }]);
  assert.deepEqual(state.folders['新剧'].files.map(f => f.file_name), ['新剧-08.mkv', '新剧-裸名-09.mkv', '新剧-10.mkv']);
  assert.equal(state.flat.length, 0);
});

test('renameCloudShowFolder：merge=true 时把旧文件夹合并进新文件夹并删掉空旧目录', async () => {
  const state = {
    folders: {
      旧剧: {
        fid: 'd-old',
        files: [
          { file_name: '旧剧-08.mkv', fid: 'f8' },
          { file_name: '旧剧-09.mkv', fid: 'f9' },
        ],
      },
      新剧: { fid: 'd-new', files: [{ file_name: '新剧-10.mkv', fid: 'f10' }] },
    },
    flat: [],
  };
  const client = fakeCloudClient(state);
  const preview = await renameCloudShowFolder(client, 'root', '旧剧', '新剧', { merge: true, apply: false });
  assert.equal(preview.merged, true);
  assert.equal(preview.mergedFiles.length, 2);
  assert.deepEqual(client.calls.moved, []);           // 预览不动

  const applied = await renameCloudShowFolder(client, 'root', '旧剧', '新剧', { merge: true, apply: true });
  assert.equal(applied.merged, true);
  assert.deepEqual(applied.conflicts, []);
  assert.deepEqual(applied.failed, []);
  assert.equal(state.folders['旧剧'], undefined);
  assert.deepEqual(
    state.folders['新剧'].files.map(f => f.file_name).sort(),
    ['新剧-08.mkv', '新剧-09.mkv', '新剧-10.mkv'],
  );
  assert.deepEqual(client.calls.deleted, ['旧剧']);
});

test('renameCloudShowFolder：新旧文件夹同时存在且未开启 merge 时只记冲突，不改名不动文件', async () => {
  const state = {
    folders: {
      旧剧: { fid: 'd-old', files: [{ file_name: '旧剧-08.mkv', fid: 'f8' }] },
      新剧: { fid: 'd-new', files: [{ file_name: '新剧-09.mkv', fid: 'f9' }] },
    },
    flat: [],
  };
  const client = fakeCloudClient(state);
  const r = await renameCloudShowFolder(client, 'root', '旧剧', '新剧');
  assert.equal(r.renamedFolder, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(client.calls.renamedFolders.length, 0);
  assert.equal(client.calls.renamedFiles.length, 0);
  assert.deepEqual(state.folders['旧剧'].files.map(f => f.file_name), ['旧剧-08.mkv']);
});
