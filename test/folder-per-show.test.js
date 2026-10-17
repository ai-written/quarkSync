// 按影视名称分文件夹：命名归一、旧文件迁移计划、本地清理的分文件夹与空文件夹处理
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildFileLines,
  cleanupLocalDuplicates,
  collectExistingForShare,
  deriveShowPrefix,
  downloadRecordKey,
  folderNameVariants,
  getDedupKey,
  migrateCloudFlatFiles,
  migrateLocalFlatFiles,
  normalizeLocalFolderNames,
  planFolderMigration,
  showFolderName,
  stripShowPrefix,
} from '../src/index.js';

// ---------- 纯函数 ----------

test('showFolderName：去掉非法字符、首尾点/空格，空结果返回空串', () => {
  assert.equal(showFolderName('灵境行者'), '灵境行者');
  assert.equal(showFolderName(' 灵境行者 '), '灵境行者');
  assert.equal(showFolderName('a/b:c*d?"e<f>g|h'), 'a_b_c_d__e_f_g_h');
  assert.equal(showFolderName('...剧名...'), '剧名');
  assert.equal(showFolderName(''), '');
  assert.equal(showFolderName('   '), '');
  assert.equal(showFolderName(undefined), '');
  assert.equal(showFolderName('长'.repeat(200)).length, 100);
});

test('stripShowPrefix：只剥自己那部剧的前缀', () => {
  assert.equal(stripShowPrefix('灵境行者-08.mkv', '灵境行者'), '08.mkv');
  assert.equal(stripShowPrefix('灵境行者-08.mkv', '灵境行者-'), '08.mkv');
  assert.equal(stripShowPrefix('遮天-08.mkv', '灵境行者'), '遮天-08.mkv');
  assert.equal(stripShowPrefix('08.mkv', '灵境行者'), '08.mkv');
  assert.equal(stripShowPrefix('08.mkv', ''), '08.mkv');
});

test('planFolderMigration：按前缀规划，文件名保留「影视名称-」前缀', () => {
  const files = [
    { file_name: '灵境行者-08.mkv' },
    { file_name: '灵境行者-ZLJZCSDR-09.mp4' },
    { file_name: '遮天2-08.mkv' },
    { file_name: '遮天-09.mkv' },
    { file_name: '未知文件.mkv' },
    { file_name: '灵境行者-' },   // 只剩前缀，没有文件名 → 不动
  ];
  const plan = planFolderMigration(files, ['灵境行者', '遮天', '遮天2']);
  assert.deepEqual(plan.map(p => [p.folder, p.newName]), [
    ['灵境行者', '灵境行者-08.mkv'],
    ['灵境行者', '灵境行者-ZLJZCSDR-09.mp4'],
    ['遮天2', '遮天2-08.mkv'],
    ['遮天', '遮天-09.mkv'],
  ]);
});

test('deriveShowPrefix：中文剧名能干净切开；标签/英文/纯数字一律不猜', () => {
  assert.deepEqual(deriveShowPrefix('大夏守墓人-1.mp4'), { prefix: '大夏守墓人', rest: '1.mp4' });
  assert.deepEqual(deriveShowPrefix('大王饶命-S03E01.mkv'), { prefix: '大王饶命', rest: 'S03E01.mkv' });
  assert.equal(deriveShowPrefix('凡人修仙传-194 4K.mkv').prefix, '凡人修仙传');
  assert.equal(deriveShowPrefix('灵境行者-ZLJZCSDR-08.mp4'), null);  // 前缀含上传标签
  assert.equal(deriveShowPrefix('10 4K.mp4'), null);                  // 没有剧名前缀
  assert.equal(deriveShowPrefix('FR.EP195.V2.4K SDR+.AVC-GM.mp4'), null); // 英文前缀不猜
  assert.equal(deriveShowPrefix('电影名.mkv'), null);                 // 识别不出集数
});

test('planFolderMigration：derive=true 时能反推没有 tip 的旧文件，并按「前缀-」重排名字', () => {
  const plan = planFolderMigration([
    { file_name: '大夏守墓人-1.mp4' },
    { file_name: '10 4K.mp4' },
    { file_name: '灵境行者-ZLJZCSDR-08.mp4' },
  ], [], { derive: true });
  assert.deepEqual(plan.map(p => [p.folder, p.newName]), [['大夏守墓人', '大夏守墓人-1.mp4']]);
});

test('downloadRecordKey：根目录沿用旧键，子目录带目录前缀', () => {
  assert.equal(downloadRecordKey('凡人修仙传-194 4K.mkv', ''), getDedupKey({ file_name: '凡人修仙传-194 4K.mkv' }));
  assert.equal(
    downloadRecordKey('08.mkv', '灵境行者'),
    `dir:灵境行者|${getDedupKey({ file_name: '08.mkv' })}`,
  );
  // 不同剧的同名文件必须落到不同记录键，否则会被当成「已下载」互相覆盖
  assert.notEqual(downloadRecordKey('08.mkv', '灵境行者'), downloadRecordKey('08.mkv', '遮天'));
  // 路径分隔符与首尾斜杠归一
  assert.equal(downloadRecordKey('08.mkv', '/灵境行者/'), downloadRecordKey('08.mkv', '灵境行者'));
});

test('collectExistingForShare：文件夹内文件补前缀，平铺旧文件也算，别家文件不算', async () => {
  const client = {
    async listAllUserFiles(fid) {
      return fid === 'folder' ? [{ file_name: '08.mkv', size: 1 }] : [];
    },
    async listTopLevelEntries(fid) {
      return fid === 'base' ? [
        { file_name: '灵境行者-08.mkv', size: 2 },
        { file_name: '遮天-08.mkv', size: 3 },
        { dir: true, file_name: '灵境行者', fid: 'folder' },
      ] : [];
    },
  };
  const files = await collectExistingForShare(client, {
    baseFid: 'base', folderFid: 'folder', prefix: '灵境行者-', folderPerShow: true,
  });
  assert.deepEqual(files.map(f => f.file_name).sort(), ['灵境行者-08.mkv', '灵境行者-08.mkv']);
  // 关闭分文件夹时退回原来的递归列表
  const flat = await collectExistingForShare(client, {
    baseFid: 'folder', folderFid: null, prefix: '灵境行者-', folderPerShow: false,
  });
  assert.deepEqual(flat, [{ file_name: '08.mkv', size: 1 }]);
});

// ---------- 本地清理：分文件夹 + 空文件夹 ----------

function withTempTree(create, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-folder-'));
  try {
    create(dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(dir, rel, size) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size, 1));
}

function makeTree(dir) {
  writeFile(dir, '凡人修仙传-194 4K.mkv', 100);
  writeFile(dir, '凡人修仙传-194 4K (2).mkv', 200);
  writeFile(dir, '灵境行者/灵境行者-08.mkv', 100);
  writeFile(dir, '灵境行者/灵境行者-08 (2).mkv', 200);
  writeFile(dir, '遮天/遮天-08.mkv', 100);          // 与灵境行者同集数，但不是同一部剧
  writeFile(dir, '.downloaded.json', 5);
  writeFile(dir, '灵境行者/没下完.mkv.part', 999);   // 半成品不参与
  fs.mkdirSync(path.join(dir, '空剧'));              // 空文件夹：清理时应被删掉
}

test('cleanupLocalDuplicates：preview 只报告，不动文件、不删空目录', () => {
  withTempTree(makeTree, dir => {
    const r = cleanupLocalDuplicates(dir, { apply: false, folders: true });
    assert.equal(r.sets.length, 2);                 // 根目录 1 组 + 灵境行者 1 组
    assert.equal(r.scanned, 5);
    assert.equal(r.deleted.length, 2);
    assert.ok(r.sets.every(s => s.keep && s.drop.length >= 1));
    assert.ok(fs.existsSync(path.join(dir, '空剧')));
    assert.ok(fs.existsSync(path.join(dir, '灵境行者', '灵境行者-08 (2).mkv')));
  });
});

test('cleanupLocalDuplicates：分文件夹各自去重、不跨文件夹合并，删完删空目录', () => {
  withTempTree(makeTree, dir => {
    const r = cleanupLocalDuplicates(dir, { apply: true, folders: true });
    assert.equal(r.sets.length, 2);
    assert.equal(r.deleted.length, 2);
    assert.deepEqual(r.failed, []);
    assert.ok(r.kept.some(f => f.name === '凡人修仙传-194 4K (2).mkv'));
    assert.ok(r.kept.some(f => f.relDir === '灵境行者'));
    // 遮天只有一个文件，不能被灵境行者的同集数牵连
    assert.ok(fs.existsSync(path.join(dir, '遮天', '遮天-08.mkv')));
    // 空目录被删掉；有内容的文件夹保留
    assert.equal(fs.existsSync(path.join(dir, '空剧')), false);
    assert.equal(fs.existsSync(path.join(dir, '灵境行者')), true);
    assert.deepEqual(r.foldersRemoved, ['空剧']);
  });
});

test('cleanupLocalDuplicates：folders=false 时只看当层（保持旧行为）', () => {
  withTempTree(makeTree, dir => {
    const r = cleanupLocalDuplicates(dir, { apply: true, folders: false });
    assert.equal(r.sets.length, 1);
    assert.equal(r.scanned, 2);
    assert.ok(fs.existsSync(path.join(dir, '灵境行者', '灵境行者-08.mkv')));
    assert.ok(fs.existsSync(path.join(dir, '灵境行者', '灵境行者-08 (2).mkv')));
    assert.equal(fs.existsSync(path.join(dir, '空剧')), true);
  });
});

test('cleanupLocalDuplicates：folderNames 只圈定影视名称文件夹，用户自己的子目录不碰', () => {
  withTempTree(dir => {
    writeFile(dir, '灵境行者/08.mkv', 100);
    writeFile(dir, '灵境行者/08 (2).mkv', 200);
    writeFile(dir, '用户自建/别的-01.mkv', 100);
    writeFile(dir, '用户自建/别的-01 (2).mkv', 200);
    fs.mkdirSync(path.join(dir, '用户空目录'));
  }, dir => {
    const r = cleanupLocalDuplicates(dir, {
      apply: true,
      folders: true,
      folderNames: new Set(['灵境行者']),
    });
    assert.equal(r.sets.length, 1);
    assert.deepEqual(r.foldersRemoved, []);
    // 用户目录里的重复不能被清理，空目录也不能被删
    assert.ok(fs.existsSync(path.join(dir, '用户自建', '别的-01.mkv')));
    assert.ok(fs.existsSync(path.join(dir, '用户自建', '别的-01 (2).mkv')));
    assert.ok(fs.existsSync(path.join(dir, '用户空目录')));
    // 只清理影视名称文件夹：更大的那份留下，较小的被删
    assert.equal(fs.existsSync(path.join(dir, '灵境行者', '08.mkv')), false);
    assert.equal(fs.existsSync(path.join(dir, '灵境行者', '08 (2).mkv')), true);
  });
});

// ---------- 本地旧文件迁移 ----------

test('folderNameVariants：同一文件在文件夹里的裸名/带前缀写法都能认出来', () => {
  assert.deepEqual(folderNameVariants('08.mkv', '灵境行者'), [
    '08.mkv', '灵境行者-08.mkv',
  ]);
  assert.deepEqual(folderNameVariants('灵境行者-08.mkv', '灵境行者'), [
    '灵境行者-08.mkv', '08.mkv',
  ]);
  // 别的前缀不会被误认成本剧的前缀
  assert.deepEqual(folderNameVariants('遮天-08.mkv', '灵境行者'), [
    '遮天-08.mkv', '灵境行者-遮天-08.mkv',
  ]);
});

test('buildFileLines：分文件夹时清单显示「影视名称/影视名称-原名」', () => {
  const lines = buildFileLines(
    [{ file_name: '08.mkv', updated_at: 1700000000000 }],
    { prefix: '灵境行者', folder: '灵境行者' },
  );
  assert.match(lines[0], /^  - 灵境行者\/灵境行者-08\.mkv {2}\(更新于: /);
  // 平铺模式保持原样（不带目录）
  const flat = buildFileLines([{ file_name: '08.mkv', updated_at: 1700000000000 }], { prefix: '灵境行者' });
  assert.match(flat[0], /^  - 灵境行者-08\.mkv {2}\(更新于: /);
});

test('migrateLocalFlatFiles：预览只列清单，apply 才移动（保留「影视名称-」前缀）并更新记录键', () => {
  const oldKey = getDedupKey({ file_name: '灵境行者-08.mkv' });
  withTempTree(dir => {
    writeFile(dir, '灵境行者-08.mkv', 100);
    writeFile(dir, '灵境行者-ZLJZCSDR-09.mp4', 200);
    writeFile(dir, '未知文件.mkv', 50);
    fs.writeFileSync(path.join(dir, '.downloaded.json'), JSON.stringify({
      [oldKey]: true,
      '灵境行者-08.mkv|100': true,
    }));
  }, dir => {
    const preview = migrateLocalFlatFiles(dir, ['灵境行者'], { apply: false });
    assert.equal(preview.moves.length, 2);
    assert.equal(fs.existsSync(path.join(dir, '灵境行者-08.mkv')), true);

    const applied = migrateLocalFlatFiles(dir, ['灵境行者'], { apply: true });
    assert.equal(applied.moves.length, 2);
    assert.equal(fs.existsSync(path.join(dir, '灵境行者-08.mkv')), false);
    assert.equal(fs.existsSync(path.join(dir, '灵境行者', '灵境行者-08.mkv')), true);
    assert.equal(fs.existsSync(path.join(dir, '灵境行者', '灵境行者-ZLJZCSDR-09.mp4')), true);
    assert.equal(fs.existsSync(path.join(dir, '未知文件.mkv')), true);

    const record = JSON.parse(fs.readFileSync(path.join(dir, '.downloaded.json'), 'utf-8'));
    assert.equal(record[oldKey], undefined);
    assert.equal(record['灵境行者-08.mkv|100'], undefined);
    assert.equal(record[downloadRecordKey('灵境行者-08.mkv', '灵境行者')], true);
  });
});

test('migrateLocalFlatFiles：目标文件已存在时不覆盖，只记冲突', () => {
  withTempTree(dir => {
    writeFile(dir, '灵境行者-08.mkv', 100);
    writeFile(dir, '灵境行者/灵境行者-08.mkv', 100);
  }, dir => {
    const r = migrateLocalFlatFiles(dir, ['灵境行者'], { apply: true });
    assert.equal(r.moves.length, 0);
    assert.equal(r.conflicts.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '灵境行者-08.mkv')), true);
    assert.equal(fs.readFileSync(path.join(dir, '灵境行者', '灵境行者-08.mkv')).length, 100);
  });
});

test('migrateLocalFlatFiles：文件夹里已有裸名同集时也算冲突（不重复搬）', () => {
  withTempTree(dir => {
    writeFile(dir, '灵境行者-08.mkv', 100);
    writeFile(dir, '灵境行者/08.mkv', 100);   // 早期版本迁进去的裸名
  }, dir => {
    const r = migrateLocalFlatFiles(dir, ['灵境行者'], { apply: true });
    assert.equal(r.moves.length, 0);
    assert.equal(r.conflicts.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '灵境行者-08.mkv')), true);
  });
});

test('migrateLocalFlatFiles：没有 tip 时也能按文件名反推迁移（derive=true），反推不了的原位不动', () => {
  withTempTree(dir => {
    writeFile(dir, '大夏守墓人-1.mp4', 100);
    writeFile(dir, '10 4K.mp4', 50);
  }, dir => {
    const applied = migrateLocalFlatFiles(dir, [], { apply: true, derive: true });
    assert.equal(applied.moves.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '大夏守墓人', '大夏守墓人-1.mp4')), true);
    assert.equal(fs.existsSync(path.join(dir, '10 4K.mp4')), true);
  });
});

// ---------- 影视名称文件夹里的裸名文件补前缀 ----------

test('normalizeLocalFolderNames：给文件夹里的裸名文件补「影视名称-」前缀并更新记录键', () => {
  withTempTree(dir => {
    writeFile(dir, '凡人修仙传/FR.EP195.V2.4K SDR+.AVC-GM.mp4', 100);
    writeFile(dir, '凡人修仙传/凡人修仙传-196 4K.mp4', 100);   // 已有前缀的不动
    writeFile(dir, '用户自建/别的-01.mkv', 100);               // 不在 folders 里 → 不动
    fs.writeFileSync(path.join(dir, '.downloaded.json'), JSON.stringify({
      [downloadRecordKey('FR.EP195.V2.4K SDR+.AVC-GM.mp4', '凡人修仙传')]: true,
    }));
  }, dir => {
    const preview = normalizeLocalFolderNames(dir, ['凡人修仙传'], { apply: false });
    assert.equal(preview.renames.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '凡人修仙传', 'FR.EP195.V2.4K SDR+.AVC-GM.mp4')), true);

    const applied = normalizeLocalFolderNames(dir, ['凡人修仙传'], { apply: true });
    assert.equal(applied.renames.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '凡人修仙传', '凡人修仙传-FR.EP195.V2.4K SDR+.AVC-GM.mp4')), true);
    assert.equal(fs.existsSync(path.join(dir, '凡人修仙传', '凡人修仙传-196 4K.mp4')), true);
    assert.equal(fs.existsSync(path.join(dir, '用户自建', '别的-01.mkv')), true);

    const record = JSON.parse(fs.readFileSync(path.join(dir, '.downloaded.json'), 'utf-8'));
    assert.equal(record[downloadRecordKey('FR.EP195.V2.4K SDR+.AVC-GM.mp4', '凡人修仙传')], undefined);
    assert.equal(record[downloadRecordKey('凡人修仙传-FR.EP195.V2.4K SDR+.AVC-GM.mp4', '凡人修仙传')], true);
  });
});

// ---------- 云端旧文件迁移（用假 client，不触网） ----------

function fakeCloudClient(entries, folders = {}) {
  const calls = { ensured: [], moved: [] };
  const byFid = () => Object.values(folders);
  const client = {
    calls,
    async listTopLevelEntries() { return entries; },
    async findFolderByName(name) {
      const f = folders[name];
      return f ? f.fid : null;
    },
    async listAllUserFiles(fid) {
      const f = byFid().find(x => x.fid === fid);
      return f ? f.files : [];
    },
    async ensureSubfolder(parent, name) {
      calls.ensured.push(name);
      if (!folders[name]) folders[name] = { fid: `new-${name}`, files: [] };
      return folders[name].fid;
    },
    async moveFiles(fids, fid) { calls.moved.push({ fids, fid }); },
  };
  return client;
}

test('migrateCloudFlatFiles：预览列出可迁移项，目标已有同名文件时记为未迁移', async () => {
  const client = fakeCloudClient(
    [
      { file_name: '灵境行者-08.mkv', fid: 'f1' },
      { file_name: '遮天-09.mkv', fid: 'f2' },
    ],
    { 灵境行者: { fid: 'd1', files: [{ file_name: '灵境行者-08.mkv' }] } },
  );
  const r = await migrateCloudFlatFiles(client, 'base', ['灵境行者', '遮天'], { apply: false });
  assert.deepEqual(r.moves.map(m => `${m.folder}/${m.newName}`), ['遮天/遮天-09.mkv']);
  assert.equal(r.conflicts.length, 1);
  assert.equal(client.calls.ensured.length, 0);
  assert.equal(client.calls.moved.length, 0);
});

test('migrateCloudFlatFiles：目标文件夹有裸名同集时也算冲突', async () => {
  const client = fakeCloudClient(
    [{ file_name: '灵境行者-08.mkv', fid: 'f1' }],
    { 灵境行者: { fid: 'd1', files: [{ file_name: '08.mkv' }] } },
  );
  const r = await migrateCloudFlatFiles(client, 'base', ['灵境行者'], { apply: true });
  assert.equal(r.moves.length, 0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(client.calls.moved.length, 0);
});

test('migrateCloudFlatFiles：apply 时才建文件夹并移动文件', async () => {
  const client = fakeCloudClient([
    { file_name: '灵境行者-08.mkv', fid: 'f1' },
    { file_name: '灵境行者-09.mkv', fid: 'f2' },
  ]);
  const r = await migrateCloudFlatFiles(client, 'base', ['灵境行者'], { apply: true });
  assert.equal(r.moves.length, 2);
  assert.equal(r.failed, 0);
  assert.deepEqual(client.calls.ensured, ['灵境行者']);
  assert.deepEqual(client.calls.moved.map(m => m.fids), [['f1', 'f2']]);
});
