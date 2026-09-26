// 日志视图：汇总（只看总结果）/ 分享明细 / 全部 / 登录 的判定与记录级过滤
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logRecordKeeps, logSections, normalizeLogView, readLogs } from '../src/index.js';

const TS = '[2026/9/21 16:48:31]';
const RULE = '═'.repeat(50);
const rec = (level, msg) => `${TS} [${level}] ${msg}`;

// ---------- 视图归一化 ----------

test('normalizeLogView：默认与非法值都回退到「汇总」', () => {
  assert.equal(normalizeLogView(''), 'result');
  assert.equal(normalizeLogView(undefined), 'result');
  assert.equal(normalizeLogView('RESULT'), 'result');
  assert.equal(normalizeLogView('summary'), 'summary');
  assert.equal(normalizeLogView('login'), 'login');
  assert.equal(normalizeLogView('all'), 'all');
  assert.equal(normalizeLogView('明细'), 'result');
});

// ---------- 汇总 / 分享明细共用的保留清单 ----------

test('汇总与分享明细视图：任务边界、筛选漏斗与结果统计都保留', () => {
  const keep = [
    '=== 夸克网盘定时任务 v1.8.0 ===',
    '══════════════════════════════════════════════════',
    '[启动任务] 开始执行首次同步...',
    '处理第 1/3 个分享',
    '分享 ID: abc123  (前缀: 遮天-)',
    '时间范围: 最近 24 小时更新',
    '   ✓ 共找到 12 个项目 (含文件夹)',
    '时间窗口内 (最近 24 小时): 12 个',
    '   过滤 <100MB 后剩余: 8 个',
    '   → 候选文件: 8 个',
    '   ⏭ 跳过 6 个已存在的文件',
    '   → 需要转存: 2 个',
    '没有找到符合条件的文件（最近 24 小时内没有更新），无需转存。',
    '所有文件已存在，无需转存。',
    '所有文件已下载过，无需下载。',
    '=== 本分享转存结果 ===',
    '成功: 2 个',
    '失败: 0 个',
    '共处理 3 个分享，成功: 5 个，失败: 0 个',
    '   同步完成: 成功 5 失败 0',
    '   下载完成: 3/5 个',
    '   待下载: 5 个 (跳过 1 个已下载记录)',
    '   ✓ 共 5 个文件 (去重后 4 个)',
    '   ✓ 网盘清理完成: 3 个',
    '   ✓ 删除完成',
    '   ✓ 已从配置中清理 1 条失效链接',
    '发现 1 个已失效的分享链接: abc',
    '   本地: 删除 2 个，保留 8 个',
    '待转存文件列表:',
    '共 2 个文件会被转存（试运行，未做任何写入）',
    '[遮天-]',
    '网页登录成功 (来自 192.168.1.5)',
    '网页更新配置成功 (直接写入)',
    '网页手动触发任务: sync',
    '   定时任务已启动，等待触发...',
    '   网页管理界面: http://localhost:3000',
    '执行清理 (30天前的文件)...',
  ];
  for (const msg of keep) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'summary'), true, msg);
  }
});

test('汇总与分享明细视图：文件清单逐行保留，但重命名结果行（带箭头）属于明细', () => {
  assert.equal(logRecordKeeps(rec('INFO', '  ✓ Show.S01E01.4K.mkv'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('INFO', '     ✓ 我的文件 4K.mkv'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('INFO', '  - 遮天-182 4K.mp4  (更新于: 2026/9/21 10:00:00)'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('INFO', '   ✓ Show.S01E01.mkv → 遮天-Show.S01E01.mkv'), 'summary'), false);
});

test('汇总与分享明细视图：步骤进度、逐项明细与去重提示都被折叠', () => {
  const drop = [
    '0. 验证登录状态...',
    '2. 获取分享 token...',
    '4. 开始转存文件到自己的网盘...',
    '   ✓ 获取成功',
    '   ✓ 备用链接 abc 可用',
    '   列出目标文件夹中的文件...',
    '   检查目标文件夹中已存在的文件...',
    '   ⏭ 同名集去重: ep_Show._S1_E1 (2个版本, 保留 Show.S01E01.4K.mkv)',
    '   → 去重移除 1 个较低画质版本',
    '   🗑 清理旧文件: old.mkv',
    '   ⏭ 遮天-182 4K.mp4（已带前缀，跳过）',
    '   等待文件处理完成...',
    // 启动时回显的 cron 交给「任务」页展示，汇总里不再重复
    '   ✓ 同步模式: "0 11 * * *"',
    '   ✓ AList下载: "0 3 * * *"',
  ];
  for (const msg of drop) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'summary'), false, msg);
  }
});

test('汇总与分享明细视图：报错与警告一律保留（含 INFO 级别里的 ✗ / ⚠）', () => {
  assert.equal(logRecordKeeps(rec('ERROR', '[启动任务] 首次同步失败: 请在 config.json 中填写有效的 Cookie'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('ERROR', '   ⚠ hours 取值无法识别: "1x"，已回退为 48 小时'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('ERROR', '   ✗ 处理分享失败 - 所有链接均已失效'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('INFO', '   ✗ Show.S01E02.mkv 下载失败: timeout'), 'summary'), true);
});

test('汇总与分享明细视图：多行记录的续行跟着整条记录一起判定', () => {
  // 首行只有时间戳与级别，结论在续行上 —— 必须保留
  const err = `${TS} [ERROR] \n程序异常: 请在 config.json 中填写有效的 Cookie`;
  assert.equal(logRecordKeeps(err, 'summary'), true);

  const detail = rec('INFO', '   ⏭ 同名集去重: ep_Show._S1_E1 (2个版本)')
    + `\n${TS} [INFO]    → 去重移除 1 个较低画质版本`;
  assert.equal(logRecordKeeps(detail, 'summary'), false);
});

// ---------- 汇总视图：整段丢掉「每个分享自己的过程」 ----------

test('汇总视图：分享段里的处理过程一条不留（分享明细视图则保留）', () => {
  const share = [
    '处理第 1/3 个分享',
    '分享 ID: abc123  (前缀: 遮天-)',
    '时间范围: 最近 24 小时更新',
    '   ✓ 共找到 12 个项目 (含文件夹)',
    '   → 需要转存: 2 个',
    '=== 本分享转存结果 ===',
    '成功: 1 个',
    '失败: 1 个',
    '成功转存的文件:',
    '  ✓ Show.S01E01.4K.mkv',
  ];
  for (const msg of share) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'result', 'share'), false, '汇总里不该有: ' + msg);
    assert.equal(logRecordKeeps(rec('INFO', msg), 'summary', 'share'), true, '分享明细里应有: ' + msg);
  }
  // 重命名结果行带箭头，即便在分享段里也属于明细，两个视图都折叠
  const rename = rec('INFO', '   ✓ Show.S01E01.mkv → 遮天-Show.S01E01.mkv');
  assert.equal(logRecordKeeps(rename, 'result', 'share'), false);
  assert.equal(logRecordKeeps(rename, 'summary', 'share'), false);
});

test('汇总视图：总结果段照常保留（含文件清单与下载、清理结果）', () => {
  const aggregate = [
    '=== 全部转存结果汇总 ===',
    '共处理 3 个分享，成功: 5 个，失败: 0 个',
    '成功转存的文件列表:',
    '  ✓ Show.S01E01.4K.mkv',
    '   同步完成: 成功 5 失败 0',
    '   成功转存的文件:',
    '     ✓ Show.S01E01.4K.mkv',
    '下载完成: 3/5 个',
    '待下载: 5 个 (跳过 1 个已下载记录)',
    '   ✓ 网盘清理完成: 3 个',
    '   本地: 删除 2 个，保留 8 个',
    '   网页管理界面: http://localhost:3000',
  ];
  for (const msg of aggregate) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'result', 'aggregate'), true, msg);
  }
});

test('汇总视图：分享段里的报错照常保留', () => {
  assert.equal(logRecordKeeps(rec('ERROR', '   ✗ 处理分享失败 (遮天-) - 所有链接均已失效'), 'result', 'share'), true);
  assert.equal(logRecordKeeps(rec('INFO', '   ✗ Show.S01E02.mkv: 转存失败'), 'result', 'share'), true);
  assert.equal(logRecordKeeps(rec('INFO', '   ⚠ 有 2 个文件本地副本缺失或大小不符，将重新下载'), 'result', 'share'), true);
});

// ---------- 段落判定 ----------

test('logSections：分隔线跟着它后面那条记录走', () => {
  const texts = [
    rec('INFO', '=== 夸克网盘自动同步工具 ==='),
    rec('INFO', `\n${RULE}`),                 // 旧格式：分隔线在续行上
    rec('INFO', '处理第 1/2 个分享'),
    rec('INFO', '分享 ID: aaa'),
    rec('INFO', '   ✓ 共找到 3 个项目 (含文件夹)'),
    rec('INFO', `\n${RULE}`),
    rec('INFO', '处理第 2/2 个分享'),
    rec('INFO', '分享 ID: bbb'),
    rec('INFO', `\n${RULE}`),
    rec('INFO', '=== 全部转存结果汇总 ==='),
    rec('INFO', '共处理 2 个分享，成功: 1 个，失败: 0 个'),
  ];
  assert.deepEqual(logSections(texts), [
    // 分享前的两条分隔线跟着分享走（在汇总视图里一起折叠），汇总前的那条跟着汇总保留
    'other', 'share', 'share', 'share', 'share',
    'share', 'share', 'share', 'aggregate', 'aggregate', 'aggregate',
  ]);
});

test('logSections：单分享没有「处理第 N/M」，从「分享 ID:」开始算分享段', () => {
  const texts = [
    rec('INFO', '=== 夸克网盘自动同步工具 ==='),
    rec('INFO', '分享 ID: aaa  (前缀: 遮天-)'),
    rec('INFO', '   ✓ 共找到 3 个项目 (含文件夹)'),
    rec('INFO', '   同步完成: 成功 1 失败 0'),
    rec('INFO', '   成功转存的文件:'),
    rec('INFO', '     ✓ a.mkv'),
  ];
  assert.deepEqual(logSections(texts), ['other', 'share', 'share', 'aggregate', 'aggregate', 'aggregate']);
});

test('logSections：试运行清单与下载任务不算分享段', () => {
  const texts = [
    rec('INFO', '=== 夸克网盘自动同步工具（试运行） ==='),
    rec('INFO', RULE),
    rec('INFO', '待转存文件列表:'),
    rec('INFO', '  - 遮天-182 4K.mp4  (更新于: 2026/9/21 10:00:00)'),
    rec('INFO', '共 1 个文件会被转存（试运行，未做任何写入）'),
    rec('INFO', RULE),
    rec('INFO', '=== AList 下载到本地 ==='),
    rec('INFO', '   待下载: 2/2 个 (跳过 0 个已下载记录)'),
  ];
  assert.deepEqual(logSections(texts), Array(8).fill('other'));
});

// ---------- 登录视图 ----------

test('登录视图：只看登录 / 退出 / 登录态校验', () => {
  const keep = [
    '网页登录成功 (来自 192.168.1.5)',
    '网页退出登录 (来自 192.168.1.5)',
    '0. 验证登录状态...',
    '   ✗ Cookie 无效或已过期！',
  ];
  for (const msg of keep) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'login'), true, msg);
  }
  assert.equal(logRecordKeeps(rec('ERROR', '网页登录失败：Token 不正确 (来自 10.0.0.9)'), 'login'), true);

  const drop = [
    '=== 夸克网盘定时任务 v1.8.0 ===',
    '   同步完成: 成功 5 失败 0',
    '网页更新配置成功 (直接写入)',
    '   ✓ Show.S01E01.4K.mkv',
    RULE,
  ];
  for (const msg of drop) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'login'), false, msg);
  }
});

test('全部视图：什么都不折叠', () => {
  assert.equal(logRecordKeeps(rec('INFO', '   ⏭ 同名集去重: ep_Show._S1_E1 (2个版本)'), 'all', 'share'), true);
  assert.equal(logRecordKeeps(rec('INFO', '2. 获取分享 token...'), 'all', 'share'), true);
  assert.equal(logRecordKeeps(rec('INFO', RULE), 'all', 'share'), true);
});

// ---------- readLogs 整体行为 ----------

// 一份单分享运行的日志（没有「处理第 N/M 个分享」这一行，正是真实格式）
const FIXTURE = [
  '[2026/9/21 10:00:00] [INFO] === 夸克网盘定时任务 v1.8.0 ===',
  '[2026/9/21 10:00:00] [INFO]    ✓ 同步模式: "0 11 * * *"',
  '[2026/9/21 10:00:00] [INFO] 网页登录成功 (来自 192.168.1.5)',
  '[2026/9/21 10:00:01] [INFO] 分享 ID: abc123  (前缀: 遮天-)',
  '[2026/9/21 10:00:01] [INFO] 时间范围: 最近 24 小时更新',
  '[2026/9/21 10:00:05] [INFO] 2. 获取分享 token...',
  '[2026/9/21 10:00:06] [INFO]    ✓ 获取成功',
  '[2026/9/21 10:00:09] [INFO]    ✓ 共找到 12 个项目 (含文件夹)',
  '[2026/9/21 10:00:09] [INFO]    → 需要转存: 2 个',
  '[2026/9/21 10:00:10] [INFO] === 本分享转存结果 ===',
  '[2026/9/21 10:00:10] [INFO] 成功: 1 个',
  '[2026/9/21 10:00:10] [INFO] 失败: 1 个',
  '[2026/9/21 10:00:10] [INFO] 成功转存的文件:',
  '[2026/9/21 10:00:10] [INFO]   ✓ Show.S01E01.4K.mkv',
  '[2026/9/21 10:00:10] [ERROR]   ✗ Show.S01E02.mkv: 转存失败',
  '[2026/9/21 10:00:11] [INFO]    同步完成: 成功 1 失败 1',
  '[2026/9/21 10:00:11] [INFO]    成功转存的文件:',
  '[2026/9/21 10:00:11] [INFO]      ✓ Show.S01E01.4K.mkv',
  '[2026/9/21 10:00:11] [INFO]    失败的文件:',
  '[2026/9/21 10:00:11] [INFO]      ✗ Show.S01E02.mkv',
  '[2026/9/21 10:00:12] [ERROR] ',
  '程序异常: 请在 config.json 中填写有效的 Cookie',
  '[2026/9/21 10:00:13] [INFO] 网页退出登录 (来自 192.168.1.5)',
].join('\n') + '\n';

function withFixtureLog(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-logview-'));
  const file = path.join(dir, 'sync.log');
  fs.writeFileSync(file, FIXTURE, 'utf-8');
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const has = (lines, part) => lines.some(l => l.includes(part));

test('readLogs：默认「汇总」只给总结果，分享自己的过程整段折叠', () => {
  withFixtureLog(file => {
    const r = readLogs({ file });
    assert.equal(r.view, 'result');
    assert.equal(r.truncated, false);

    for (const part of ['=== 夸克网盘定时任务', '   同步完成: 成功 1 失败 1', '失败的文件:',
      '✗ Show.S01E02.mkv', '程序异常: 请在 config.json', '网页登录成功 (来自 192.168.1.5)',
      '网页退出登录 (来自 192.168.1.5)']) {
      assert.ok(has(r.lines, part), '汇总里应有: ' + part);
    }

    for (const part of ['分享 ID: abc123', '时间范围: 最近 24 小时更新', '2. 获取分享 token...',
      '✓ 获取成功', '✓ 共找到 12 个项目', '=== 本分享转存结果 ===', '成功: 1 个', '失败: 1 个',
      '✓ 同步模式']) {
      assert.ok(!has(r.lines, part), '汇总里不该有: ' + part);
    }

    // 成功文件清单只留总结果里那份（"     ✓ " 比分享里的 "  ✓ " 多缩进），分享里那份被丢掉
    const okLines = r.lines.filter(l => l.includes('✓ Show.S01E01.4K.mkv'));
    assert.equal(okLines.length, 1, '成功清单只应来自总结果');
    assert.match(okLines[0], /\[INFO\] {6}✓ Show\.S01E01\.4K\.mkv$/);
    assert.ok(r.folded > 0);
  });
});

test('readLogs：分享明细视图保留每个分享的筛选漏斗', () => {
  withFixtureLog(file => {
    const r = readLogs({ file, view: 'summary' });
    assert.equal(r.view, 'summary');
    for (const part of ['分享 ID: abc123', '✓ 共找到 12 个项目', '→ 需要转存: 2 个',
      '=== 本分享转存结果 ===', '成功: 1 个']) {
      assert.ok(has(r.lines, part), '分享明细里应有: ' + part);
    }
    // 分享里一份 + 总结果里一份
    assert.equal(r.lines.filter(l => l.includes('✓ Show.S01E01.4K.mkv')).length, 2);
  });
});

test('readLogs：登录视图只给登录相关记录', () => {
  withFixtureLog(file => {
    const r = readLogs({ file, view: 'login' });
    assert.equal(r.view, 'login');
    assert.deepEqual(r.lines, [
      '[2026/9/21 10:00:00] [INFO] 网页登录成功 (来自 192.168.1.5)',
      '[2026/9/21 10:00:13] [INFO] 网页退出登录 (来自 192.168.1.5)',
    ]);
  });
});

test('readLogs：全部视图不折叠，行数够就截断并给出标记', () => {
  withFixtureLog(file => {
    const all = readLogs({ file, view: 'all' });
    assert.equal(all.view, 'all');
    assert.equal(all.folded, 0);
    assert.ok(has(all.lines, '2. 获取分享 token...'));
    assert.ok(has(all.lines, '✓ 获取成功'));

    const few = readLogs({ file, view: 'all', maxLines: 2 });
    assert.equal(few.truncated, true);
    // 截断以整条记录为单位：上一条是两行的报错记录，宁可少给一行也不切成半截
    assert.equal(few.lines.length, 1);
    assert.equal(few.lines[0], '[2026/9/21 10:00:13] [INFO] 网页退出登录 (来自 192.168.1.5)');
  });
});

test('readLogs：关键字命中续行时整条记录都返回', () => {
  withFixtureLog(file => {
    const r = readLogs({ file, view: 'all', keyword: '程序异常' });
    // 首行只有 "[时间戳] [ERROR] "，结论在续行上；两行必须一起给出
    assert.equal(r.lines.length, 2);
    assert.ok(r.lines[0].includes('[ERROR]'));
    assert.equal(r.lines[1], '程序异常: 请在 config.json 中填写有效的 Cookie');
  });
});

test('readLogs：级别过滤不会打乱段落判定', () => {
  withFixtureLog(file => {
    // 只看 INFO 时「分享 ID:」仍在，它后面的分享日志依旧整段折叠
    const r = readLogs({ file, level: 'INFO' });
    assert.ok(!has(r.lines, '时间范围: 最近 24 小时更新'));
    assert.ok(has(r.lines, '   同步完成: 成功 1 失败 1'));
  });
});

test('readLogs：日志文件不存在时返回空结果', () => {
  const r = readLogs({ file: path.join(os.tmpdir(), 'quark-logview-not-exist.log') });
  assert.deepEqual(r, { lines: [], truncated: false, view: 'result', folded: 0 });
});
