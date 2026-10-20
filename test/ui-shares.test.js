// 分享表格的「收集 + 保存过滤」回归测试。
//
// 这段逻辑写在 src/ui.html 的内联脚本里（没有打包/模块化），这里按标记从 HTML 中
// 抽出 collectShares() 函数，用最小 DOM 桩执行，专门盯住一个真实事故：
// 清理失效链接后后端把 url 清空、条目仍在，以前前端收集时对空链接不写 url 字段，
// 保存时整行被过滤掉 —— 用户填的影视名称/提取码/筛选条件就没了。
// 另外盯住「周几更新」：勾选要收集成升序 updateDays，一个都没勾时不能写空数组字段
// （空 = 每天，写 [] 语义相同但会把手改的配置无意义地改回去）。
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

function makeRow({ url = '', tip = '', password = '', hours = '', minFileSizeMB = '', maxFilesPerShare = '', days = [] } = {}) {
  const values = { url, tip, password, hours, minFileSizeMB, maxFilesPerShare };
  // 周几更新的勾选框桩：checked 表示勾上，getAttribute('data-day') 回显 1..7。
  // 真实 DOM 走 dataset，这里只给 getAttribute —— checkedDays() 两种都兼容。
  const boxes = [];
  for (let day = 1; day <= 7; day += 1) {
    boxes.push({
      checked: days.includes(day),
      getAttribute: sel => (sel === 'data-day' ? String(day) : null),
    });
  }
  return {
    querySelector(sel) {
      const m = sel.match(/^\[data-f=(.+)\]$/);
      return m ? { value: values[m[1]] ?? '' } : null;
    },
    querySelectorAll(sel) {
      return sel === '[data-day]' ? boxes : [];
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

// ---- 周几更新（updateDays）的收集 ----

test('勾选的周几被收集成升序 updateDays 数组', () => {
  const saved = saveable([makeRow({ url: 'https://pan.quark.cn/s/aaa', days: [4, 1] })]);
  assert.deepEqual(saved, [{ url: 'https://pan.quark.cn/s/aaa', updateDays: [1, 4] }]);
});

test('没勾任何周几时不写 updateDays 字段（= 每天同步）', () => {
  const saved = saveable([makeRow({ url: 'https://pan.quark.cn/s/aaa', days: [] })]);
  // 只有 url 的行沿用字符串形式（旧配置兼容），也不会多出 updateDays
  assert.deepEqual(saved, ['https://pan.quark.cn/s/aaa']);
});

test('有其它字段的行：未勾周几同样不出现 updateDays 键', () => {
  const saved = saveable([makeRow({ tip: '某剧' })]);
  assert.deepEqual(saved, [{ url: '', tip: '某剧' }]);
  assert.equal('updateDays' in saved[0], false);
});

test('清理后剩空链接的行：影视名称与周几配置都保留', () => {
  const saved = saveable([makeRow({ url: '', tip: '大夏守墓人', days: [7] })]);
  assert.deepEqual(saved, [{ url: '', tip: '大夏守墓人', updateDays: [7] }]);
});

test('周几与原有筛选字段可以同时存在，互不影响', () => {
  const saved = saveable([makeRow({
    url: 'https://pan.quark.cn/s/aaa',
    tip: '遮天',
    hours: '12h',
    minFileSizeMB: '200',
    maxFilesPerShare: '2',
    days: [1, 4],
  })]);
  assert.deepEqual(saved, [{
    url: 'https://pan.quark.cn/s/aaa',
    tip: '遮天',
    hours: '12h',
    minFileSizeMB: 200,
    maxFilesPerShare: 2,
    updateDays: [1, 4],
  }]);
});
