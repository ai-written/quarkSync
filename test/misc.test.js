// 重命名序号、分享清单行与 shareUrls 归一化
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withNumericSuffix, normalizeShareUrls, normalizePrefix, buildFileLines } from '../src/index.js';

test('withNumericSuffix：序号插在扩展名之前', () => {
  assert.equal(withNumericSuffix('a.mp4', 2), 'a (2).mp4');
  assert.equal(withNumericSuffix('a.b.c.mkv', 2), 'a.b.c (2).mkv');
  assert.equal(withNumericSuffix('Show.S01E01 (2).mkv', 3), 'Show.S01E01 (2) (3).mkv');
});

test('withNumericSuffix：点开头或没有扩展名时直接追加（.gitignore 不会被截断）', () => {
  assert.equal(withNumericSuffix('.gitignore', 2), '.gitignore (2)');
  assert.equal(withNumericSuffix('noext', 3), 'noext (3)');
  assert.equal(withNumericSuffix('trailing.', 2), 'trailing (2).');
});

test('normalizeShareUrls：字符串项转成对象，对象项原样保留', () => {
  const item = { url: 'u2', tip: '前缀', hours: '12h' };
  assert.deepEqual(
    normalizeShareUrls({ shareUrls: ['u1', item] }),
    [{ url: 'u1' }, item],
  );
});

test('normalizeShareUrls：单个 shareUrl 支持字符串与数组', () => {
  assert.deepEqual(normalizeShareUrls({ shareUrl: 'u1' }), [{ url: 'u1' }]);
  assert.deepEqual(normalizeShareUrls({ shareUrl: ['u1', 'u2'] }), [{ url: 'u1' }, { url: 'u2' }]);
});

test('normalizeShareUrls：shareUrls 优先；为空数组时回落到 shareUrl', () => {
  assert.deepEqual(
    normalizeShareUrls({ shareUrls: ['a'], shareUrl: 'b' }),
    [{ url: 'a' }],
  );
  assert.deepEqual(normalizeShareUrls({ shareUrls: [], shareUrl: 'b' }), [{ url: 'b' }]);
});

test('normalizeShareUrls：都没有时返回空数组', () => {
  assert.deepEqual(normalizeShareUrls({}), []);
});

test('normalizeShareUrls：保留备用链接组的数组 url', () => {
  const out = normalizeShareUrls({ shareUrls: [{ url: ['m1', 'm2'], tip: 't' }] });
  assert.deepEqual(out, [{ url: ['m1', 'm2'], tip: 't' }]);
});

test('normalizePrefix：tip 末尾没有 - 时补一个，已有则不重复补', () => {
  assert.equal(normalizePrefix('遮天'), '遮天-');
  assert.equal(normalizePrefix('遮天-'), '遮天-');
  assert.equal(normalizePrefix(''), '');
  assert.equal(normalizePrefix(undefined), '');
});

test('buildFileLines：清单里的文件名是加完影视名称前缀之后的最终名', () => {
  const files = [{ file_name: '182 4K.mp4', updated_at: 1758538907 }];
  const [line] = buildFileLines(files, { prefix: '影视名称' });
  assert.match(line, /^ {2}- 影视名称-182 4K\.mp4 {2}\(更新于: /);
});

test('buildFileLines：已带前缀不叠加；没设影视名称时保持原名', () => {
  const one = name => [{ file_name: name, updated_at: 1758538907 }];
  assert.match(
    buildFileLines(one('影视名称-182 4K.mp4'), { prefix: '影视名称-' })[0],
    /- 影视名称-182 4K\.mp4 {2}\(/,
  );
  assert.match(buildFileLines(one('182 4K.mp4'))[0], /- 182 4K\.mp4 {2}\(/);
});
