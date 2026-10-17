// 分享表格的「收集 + 保存过滤」回归测试。
//
// 这段逻辑写在 src/ui.html 的内联脚本里（没有打包/模块化），这里按标记从 HTML 中
// 抽出 collectShares() 函数，用最小 DOM 桩执行，专门盯住一个真实事故：
// 清理失效链接后后端把 url 清空、条目仍在，以前前端收集时对空链接不写 url 字段，
// 保存时整行被过滤掉 —— 用户填的影视名称/提取码/筛选条件就没了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui.html', import.meta.url), 'utf-8');

function loadCollectShares() {
  const start = html.indexOf('function collectShares()');
  const end = html.indexOf('// 一级卡片折叠');
  assert.ok(start >= 0 && end > start, 'ui.html 里找不到 collectShares()（标记变了就同步改这个测试）');
  const src = html.slice(start, end);
  return new Function('$', `${src}\nreturn collectShares;`);
}

function makeRow({ url = '', tip = '', password = '', hours = '', minFileSizeMB = '', maxFilesPerShare = '' } = {}) {
  const values = { url, tip, password, hours, minFileSizeMB, maxFilesPerShare };
  return {
    querySelector(sel) {
      const m = sel.match(/^\[data-f=(.+)\]$/);
      return m ? { value: values[m[1]] ?? '' } : null;
    },
  };
}

// 与保存按钮里的过滤保持一致（纯空行才丢弃）
function saveable(rows) {
  const collect = loadCollectShares()(() => ({ querySelectorAll: () => rows }));
  return collect().filter(s => {
    if (typeof s === 'string') return s !== '';
    return s.url !== undefined && !(Array.isArray(s.url) && s.url.length === 0);
  });
}

test('清理后剩空链接、但还有影视名称/提取码：保存时整行必须保留', () => {
  const saved = saveable([makeRow({ url: '', tip: '大夏守墓人', password: '1234' })]);
  assert.deepEqual(saved, [{ url: '', password: '1234', tip: '大夏守墓人' }]);
});

test('只填了影视名称、没填链接：保留用户输入', () => {
  const saved = saveable([makeRow({ tip: '某剧' })]);
  assert.deepEqual(saved, [{ url: '', tip: '某剧' }]);
});

test('纯空行（点了「添加」没填）仍然丢弃，不会写入空条目', () => {
  assert.deepEqual(saveable([makeRow({})]), []);
});

test('正常链接与备用组不受影响', () => {
  const saved = saveable([
    makeRow({ url: 'https://pan.quark.cn/s/aaa', tip: '遮天' }),
    makeRow({ url: 'https://pan.quark.cn/s/bbb\nhttps://pan.quark.cn/s/ccc' }),
  ]);
  assert.deepEqual(saved, [
    { url: 'https://pan.quark.cn/s/aaa', tip: '遮天' },
    { url: ['https://pan.quark.cn/s/bbb', 'https://pan.quark.cn/s/ccc'] },
  ]);
});
