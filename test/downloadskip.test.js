// 下载跳过判定：清理重复副本改过名之后，不能再把同一份内容重下一遍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildLocalEpisodeIndex, getDedupKey, getEpisodeGroup, localCopyIsComplete } from '../src/index.js';

function withTempDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-skip-'));
  try {
    for (const [name, size] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 1));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('localCopyIsComplete：同名同体积算已下过', () => {
  withTempDir({ '诛仙-10 4K.mp4': 100 }, dir => {
    assert.equal(localCopyIsComplete(dir, '诛仙-10 4K.mp4', 100), true);
  });
});

test('localCopyIsComplete：同名但体积不符 → 需要重下（自愈被截断的半成品）', () => {
  withTempDir({ '诛仙-10 4K.mp4': 100 }, dir => {
    assert.equal(localCopyIsComplete(dir, '诛仙-10 4K.mp4', 999), false);
  });
});

test('localCopyIsComplete：本地那份被清理改过名，但同一集同体积 → 仍算已下过', () => {
  // 清理重复副本把云端留下的那份改回不带序号的名字，本地那份有意不改名
  withTempDir({ '凡人修仙传-194 4K (2).mkv': 3300 }, dir => {
    const index = buildLocalEpisodeIndex(dir);
    assert.equal(localCopyIsComplete(dir, '凡人修仙传-194 4K.mkv', 3300, index), true);
    // 不传索引时也要能自己兜住
    assert.equal(localCopyIsComplete(dir, '凡人修仙传-194 4K.mkv', 3300), true);
  });
});

test('localCopyIsComplete：同一集但体积不同 → 还要重下', () => {
  withTempDir({ '凡人修仙传-194 4K (2).mkv': 3200 }, dir => {
    assert.equal(localCopyIsComplete(dir, '凡人修仙传-194 4K.mkv', 3300), false);
  });
});

test('localCopyIsComplete：不同集、只是体积凑巧一样 → 不算已下过', () => {
  withTempDir({ '凡人修仙传-195 4K.mkv': 3300 }, dir => {
    assert.equal(localCopyIsComplete(dir, '凡人修仙传-194 4K.mkv', 3300), false);
  });
});

test('localCopyIsComplete：识别不出集数的文件不做「同一集」推断', () => {
  withTempDir({ '某部电影.mkv': 3300 }, dir => {
    assert.equal(localCopyIsComplete(dir, '另一部电影.mkv', 3300), false);
  });
});

test('localCopyIsComplete：体积未知时只认同名文件', () => {
  withTempDir({ '诛仙-10 4K.mp4': 100 }, dir => {
    assert.equal(localCopyIsComplete(dir, '诛仙-10 4K.mp4', 0), true);
    assert.equal(localCopyIsComplete(dir, '诛仙-11 4K.mp4', 0), false);
  });
});

test('localCopyIsComplete：文件与目录都不存在时返回 false', () => {
  withTempDir({}, dir => {
    assert.equal(localCopyIsComplete(dir, '不存在.mkv', 100), false);
    assert.equal(localCopyIsComplete(path.join(dir, '压根没有这个目录'), 'a.mkv', 100), false);
  });
});

test('buildLocalEpisodeIndex：按「同一集 + 季号 + 体积」建索引，非剧集文件不入表', () => {
  withTempDir({
    '凡人修仙传-194 4K (2).mkv': 3300,
    '凡人修仙传-194 4K (3).mkv': 3300,
    '电影名.mkv': 100,
  }, dir => {
    const index = buildLocalEpisodeIndex(dir);
    assert.equal(index.size, 1, [...index].join(','));
    const g = getEpisodeGroup('凡人修仙传-194 4K.mkv');
    assert.ok(index.has(`${g.loose}|S${g.season ?? '?'}|3300`), [...index].join(','));
  });
});

test('buildLocalEpisodeIndex：季号参与索引，本地的 S02E07 不能证明 S01E07 已下载', () => {
  withTempDir({ 'Show.S02E07.mkv': 1000 }, dir => {
    const index = buildLocalEpisodeIndex(dir);
    assert.equal(localCopyIsComplete(dir, 'Show.S02E07.mkv', 1000, index), true);
    // 漏下比多下一次危险得多：季号不同就老老实实重下
    assert.equal(localCopyIsComplete(dir, 'Show.S01E07.mkv', 1000, index), false);
  });
});

test('buildLocalEpisodeIndex：同一集的不同季集写法（第1季-01 / 1x01）互相认得出来', () => {
  withTempDir({ '灵笼 1x01.mkv': 1000 }, dir => {
    const index = buildLocalEpisodeIndex(dir);
    assert.equal(localCopyIsComplete(dir, '灵笼 第1季-01.mkv', 1000, index), true);
    assert.equal(localCopyIsComplete(dir, '灵笼 第1季-02.mkv', 1000, index), false);
  });
});

test('buildLocalEpisodeIndex：.part 半成品与点文件都不入索引（否则残缺文件会被判成完整）', () => {
  withTempDir({
    'Show.S01E07.mkv': 10,          // 截断的成品
    'Show.S01E07.mkv.part': 1000,   // 正好等于声明大小的半成品
    '.downloaded.json': 5,
  }, dir => {
    const index = buildLocalEpisodeIndex(dir);
    assert.equal(index.size, 1, [...index].join(','));
    const g = getEpisodeGroup('Show.S01E07.mkv');
    assert.ok(index.has(`${g.loose}|S${g.season}|10`), [...index].join(','));
    assert.equal(localCopyIsComplete(dir, 'Show.S01E07.mkv', 1000, index), false);
  });
});

test('清理改名的完整链路：记录键一致 + 本地副本认得出来 → 不会重复下载', () => {
  // 清理前：云端/本地都叫 凡人修仙传-194 4K (2).mkv，下载记录键取自它
  const before = { file_name: '凡人修仙传-194 4K (2).mkv', size: 3300 };
  // 清理后：云端留下那份被改回不带序号的名字，本地那份没改
  const after = { file_name: '凡人修仙传-194 4K.mkv', size: 3300 };

  assert.equal(getDedupKey(before), getDedupKey(after), '.downloaded.json 的记录键必须一致，否则会全量重下');

  withTempDir({ '凡人修仙传-194 4K (2).mkv': 3300 }, dir => {
    const index = buildLocalEpisodeIndex(dir);
    assert.equal(localCopyIsComplete(dir, after.file_name, after.size, index), true);
  });
});
