// 日志视图：下载清单（默认，只留下载记录）/ 分享明细 / 全部 / 登录 的判定与记录级过滤
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { downloadListFlags, logRecordKeeps, normalizeLogView, readLogs } from '../src/index.js';

const TS = '[2026/9/21 16:48:31]';
const RULE = '═'.repeat(50);
const rec = (level, msg) => `${TS} [${level}] ${msg}`;

// ---------- 视图归一化 ----------

test('normalizeLogView：默认与非法值都回退到「下载清单」', () => {
  assert.equal(normalizeLogView(''), 'result');
  assert.equal(normalizeLogView(undefined), 'result');
  assert.equal(normalizeLogView('RESULT'), 'result');
  assert.equal(normalizeLogView('summary'), 'summary');
  assert.equal(normalizeLogView('login'), 'login');
  assert.equal(normalizeLogView('all'), 'all');
  assert.equal(normalizeLogView('明细'), 'result');
});

// ---------- 「分享明细」视图的保留清单 ----------

test('分享明细视图：任务边界、筛选漏斗与结果统计都保留', () => {
  const keep = [
    '=== 夸克网盘定时任务 v1.9.0 ===',
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

test('分享明细视图：文件清单逐行保留，但重命名结果行（带箭头）属于明细', () => {
  assert.equal(logRecordKeeps(rec('INFO', '  ✓ Show.S01E01.4K.mkv'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('INFO', '     ✓ 我的文件 4K.mkv'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('INFO', '  - 遮天-182 4K.mp4  (更新于: 2026/9/21 10:00:00)'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('INFO', '   ✓ Show.S01E01.mkv → 遮天-Show.S01E01.mkv'), 'summary'), false);
});

test('分享明细视图：步骤进度、逐项明细与去重提示都被折叠', () => {
  const drop = [
    '0. 验证登录状态...',
    '2. 获取分享 token...',
    '4. 开始转存文件到自己的网盘...',
    '   ✓ 获取成功',
    '   ✓ 备用链接 abc 可用',
    '   列出目标文件夹中的文件...',
    '   检查目标文件夹中已存在的文件...',
    '   🗑 清理旧文件: old.mkv',
    '   ⏭ 遮天-182 4K.mp4（已带前缀，跳过）',
    '   等待文件处理完成...',
    // 启动时回显的 cron 交给「任务」页展示，这里不再重复
    '   ✓ 同步模式: "0 11 * * *"',
    '   ✓ AList下载: "0 3 * * *"',
  ];
  for (const msg of drop) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'summary'), false, msg);
  }
});

test('分享明细视图：同集去重的结论要保留（回答「为什么这份没转存」）', () => {
  const keep = [
    '   ⏭ 同名集去重: ep_Show_S1_E1 (2个版本, 保留 Show.S01E01.4K.mkv，丢弃 Show.S01E01.1080p.mkv)',
    '   → 去重移除 1 个较低画质版本',
  ];
  for (const msg of keep) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'summary'), true, msg);
  }
});

test('分享明细视图：报错与警告一律保留（含 INFO 级别里的 ✗ / ⚠）', () => {
  assert.equal(logRecordKeeps(rec('ERROR', '[启动任务] 首次同步失败: 请在 config.json 中填写有效的 Cookie'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('ERROR', '   ⚠ hours 取值无法识别: "1x"，已回退为 48 小时'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('ERROR', '   ✗ 处理分享失败 - 所有链接均已失效'), 'summary'), true);
  assert.equal(logRecordKeeps(rec('INFO', '   ✗ Show.S01E02.mkv 下载失败: timeout'), 'summary'), true);
});

test('分享明细视图：多行记录的续行跟着整条记录一起判定', () => {
  // 首行只有时间戳与级别，结论在续行上 —— 必须保留
  const err = `${TS} [ERROR] \n程序异常: 请在 config.json 中填写有效的 Cookie`;
  assert.equal(logRecordKeeps(err, 'summary'), true);

  const detail = rec('INFO', '   列出目标文件夹中的文件...')
    + `\n${TS} [INFO]   等待文件处理完成...`;
  assert.equal(logRecordKeeps(detail, 'summary'), false);
});

// ---------- 「下载清单」视图：只留下载记录 ----------

test('下载清单视图：只留下载结果与「已下载的文件列表」', () => {
  const keep = [
    '   待下载: 5 个 (跳过 1 个已下载记录)',
    '   待下载: 2/2 个 (跳过 0 个已下载记录)',
    '   下载完成: 3/5 个',
    '   所有文件已下载过，无需下载。',
    '   已下载的文件列表:',
  ];
  for (const msg of keep) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'result'), true, msg);
  }

  const drop = [
    // 转存侧的一切都不算「下载清单」
    '=== 夸克网盘定时任务 v1.9.0 ===',
    '处理第 1/3 个分享',
    '分享 ID: abc123  (前缀: 遮天-)',
    '   ✓ 共找到 12 个项目 (含文件夹)',
    '   → 需要转存: 2 个',
    '=== 本分享转存结果 ===',
    '成功: 2 个',
    '失败: 0 个',
    '成功转存的文件列表:',
    '共处理 3 个分享，成功: 5 个，失败: 0 个',
    '   同步完成: 成功 5 失败 0',
    '待转存文件列表:',
    '共 2 个文件会被转存（试运行，未做任何写入）',
    // 下载之外的收尾与状态类日志
    '   列出目标文件夹中的文件...',
    '   从网盘中删除已下载的 3 个文件...',
    '   ✓ 删除完成',
    'AList下载完成',
    '网页登录成功 (来自 192.168.1.5)',
    '网页手动触发任务: alist',
    '   定时任务已启动，等待触发...',
  ];
  for (const msg of drop) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'result'), false, msg);
  }
});

test('下载清单视图：清单里的文件名单独一行不算，必须紧跟清单标题（inDownloadList）', () => {
  // 转存结果清单的文件行格式与下载清单完全一样，只有位置能区分
  assert.equal(logRecordKeeps(rec('INFO', '     ✓ Show.S01E01.4K.mkv'), 'result'), false);
  assert.equal(logRecordKeeps(rec('INFO', '     ✓ Show.S01E01.4K.mkv'), 'result', true), true);
  // 重命名结果行（带箭头）即便被标成清单内也不显示
  assert.equal(logRecordKeeps(rec('INFO', '     ✓ a.mkv → 遮天-a.mkv'), 'result', true), false);
});

test('下载清单视图：报错与警告同样不显示，切「分享明细」才看得到', () => {
  const cases = [
    ['ERROR', '程序异常: 请在 config.json 中填写有效的 Cookie'],
    ['ERROR', '   ✗ 处理分享失败 - 所有链接均已失效'],
    ['INFO', '   ✗ Show.S01E02.mkv 下载失败: timeout'],
    ['INFO', '   ⚠ 有 1 个文件本地副本缺失或大小不符，将重新下载'],
  ];
  for (const [level, msg] of cases) {
    assert.equal(logRecordKeeps(rec(level, msg), 'result'), false, msg);
    assert.equal(logRecordKeeps(rec(level, msg), 'summary'), true, msg);
  }
});

test('下载清单视图：清理重复副本的结果也保留（含要删的文件名与失败）', () => {
  const keep = [
    '=== 清理重复副本（预览，不会删除任何文件） ===',
    '   扫描 12 个文件，发现 1 组重复，共 3 个多余副本',
    // 整组是一条多行记录：标题与文件名一起保留
    '   将删除 3 个，保留 凡人修仙传-194 4K (2).mkv\n'
      + '      · 凡人修仙传-194 4K.mkv\n      · 凡人修仙传-194 4K (3).mkv',
    '   已删除 2 个重复副本',
    '   待删除 2 个重复副本（预览模式，加 --yes 或点网页的「执行删除」才会真的删）',
    // 删除失败属于「用户刚点的那个操作」，不能悄悄消失
    '   ✗ 云端清理失败: Cookie 无效或已过期！请重新从浏览器获取 Cookie',
    '   ✗ 云端删除失败 (凡人修仙传-194 4K (3).mkv 等 2 个): 删除失败',
    '   ✗ 本地删除失败 a.mkv: EPERM',
  ];
  for (const msg of keep) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'result'), true, msg);
  }
  // 清理之外的普通进度日志照旧不显示
  assert.equal(logRecordKeeps(rec('INFO', '   列出目标文件夹中的文件...'), 'result'), false);
  assert.equal(logRecordKeeps(rec('INFO', '   ✓ 共 4 个文件 (去重后 3 个)'), 'result'), false);
});

test('下载清单视图：转存成功但改名失败也要看得见（文件没加上前缀）', () => {
  const err = rec('ERROR', '   ✗ 10 4K.mp4 重命名失败（目标名: 诛仙-10 4K.mp4，fid: f9）: '
    + 'API 返回错误 [404]: {"status":404,"code":14014,"message":"illegal text"}');
  assert.equal(logRecordKeeps(err, 'result'), true);
  // 重试过程中的临时告警不算结论，留到「全部日志」里看
  assert.equal(logRecordKeeps(rec('INFO', '   ⚠ 改名失败（第 1/3 次），1 秒后重试: API 返回错误 [404]'), 'result'), false);
});

test('下载清单视图：保留下载任务的标题行，用来分隔几次下载', () => {
  assert.equal(logRecordKeeps(rec('INFO', '=== AList 下载到本地 ==='), 'result'), true);
  assert.equal(logRecordKeeps(rec('INFO', '=== 夸克网盘下载到本地 ==='), 'result'), true);

  // 转存侧的标题与分隔线在这个视图里正文会被折叠，留下空标题/孤立横线只会误导，所以不要
  assert.equal(logRecordKeeps(rec('INFO', '=== 全部转存结果汇总 ==='), 'result'), false);
  assert.equal(logRecordKeeps(rec('INFO', '=== 本分享转存结果 ==='), 'result'), false);
  assert.equal(logRecordKeeps(rec('INFO', '=== 夸克网盘自动同步工具 ==='), 'result'), false);
  assert.equal(logRecordKeeps(rec('INFO', RULE), 'result'), false);
});

test('下载清单视图：多行记录只在整条命中时才留下', () => {
  const ok = `${TS} [INFO] 下载完成: 1/2 个\n续行不该单独决定去留`;
  assert.equal(logRecordKeeps(ok, 'result'), true);
  const no = `${TS} [INFO] 同步完成: 成功 1 失败 1\n续行不该单独决定去留`;
  assert.equal(logRecordKeeps(no, 'result'), false);
});

// ---------- 清单归属判定 ----------

test('downloadListFlags：只有「已下载的文件列表:」之后的名才行属于清单', () => {
  const texts = [
    rec('INFO', '   成功转存的文件列表:'),
    rec('INFO', '     ✓ Show.S01E01.4K.mkv'),   // 转存结果里的清单：不算
    rec('INFO', '   已下载的文件列表:'),
    rec('INFO', '     ✓ 遮天-182 4K.mp4'),      // 清单内
    rec('INFO', '     ✓ 遮天-183 4K.mp4'),      // 清单内
    rec('INFO', '   ✓ 删除完成'),               // 遇到非文件名记录，清单块结束
    rec('INFO', '     ✓ 后面的清单.mkv'),        // 块外，不算
  ];
  assert.deepEqual(downloadListFlags(texts), [false, false, true, true, true, false, false]);
});

test('downloadListFlags：没有清单标题时任何文件名行都不算', () => {
  const texts = [
    rec('INFO', '     ✓ Show.S01E01.4K.mkv'),
    rec('INFO', '     ✓ Show.S01E02.4K.mkv'),
  ];
  assert.deepEqual(downloadListFlags(texts), [false, false]);
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
    '=== 夸克网盘定时任务 v1.9.0 ===',
    '   同步完成: 成功 5 失败 0',
    '网页更新配置成功 (直接写入)',
    '   ✓ Show.S01E01.4K.mkv',
    '   待下载: 5 个 (跳过 1 个已下载记录)',
    RULE,
  ];
  for (const msg of drop) {
    assert.equal(logRecordKeeps(rec('INFO', msg), 'login'), false, msg);
  }
});

test('全部视图：什么都不折叠', () => {
  assert.equal(logRecordKeeps(rec('INFO', '   ⏭ 同名集去重: ep_Show._S1_E1 (2个版本)'), 'all'), true);
  assert.equal(logRecordKeeps(rec('INFO', '2. 获取分享 token...'), 'all'), true);
  assert.equal(logRecordKeeps(rec('INFO', RULE), 'all'), true);
});

// ---------- readLogs 整体行为 ----------

// 一份单分享运行 + 一次下载的日志（没有「处理第 N/M 个分享」这一行，正是真实格式）
const FIXTURE = [
  '[2026/9/21 10:00:00] [INFO] === 夸克网盘定时任务 v1.9.0 ===',
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
  '[2026/9/21 10:00:13] [INFO]    列出目标文件夹中的文件...',
  '[2026/9/21 10:00:14] [INFO]    ✓ 共 4 个文件 (去重后 3 个)',
  '[2026/9/21 10:00:14] [INFO]    待下载: 2 个 (跳过 1 个已下载记录)',
  '[2026/9/21 10:00:15] [INFO]    ⚠ 有 1 个文件本地副本缺失或大小不符，将重新下载',
  '[2026/9/21 10:00:20] [INFO]    下载完成: 2/2 个',
  '[2026/9/21 10:00:20] [INFO]    已下载的文件列表:',
  '[2026/9/21 10:00:20] [INFO]      ✓ 遮天-182 4K.mp4',
  '[2026/9/21 10:00:21] [INFO]      ✓ 遮天-183 4K.mp4',
  '[2026/9/21 10:00:21] [INFO]    ✓ 删除完成',
  '[2026/9/21 10:00:22] [INFO] 网页退出登录 (来自 192.168.1.5)',
].join('\n') + '\n';

// 默认视图（下载清单）应当给出的就是这 5 行，一行不多一行不少
const FIXTURE_DOWNLOADS = [
  '[2026/9/21 10:00:14] [INFO]    待下载: 2 个 (跳过 1 个已下载记录)',
  '[2026/9/21 10:00:20] [INFO]    下载完成: 2/2 个',
  '[2026/9/21 10:00:20] [INFO]    已下载的文件列表:',
  '[2026/9/21 10:00:20] [INFO]      ✓ 遮天-182 4K.mp4',
  '[2026/9/21 10:00:21] [INFO]      ✓ 遮天-183 4K.mp4',
];

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

test('readLogs：默认「下载清单」只给下载记录，其余（含报错）一条不留', () => {
  withFixtureLog(file => {
    const r = readLogs({ file });
    assert.equal(r.view, 'result');
    assert.equal(r.truncated, false);
    assert.deepEqual(r.lines, FIXTURE_DOWNLOADS);
    assert.ok(r.folded > 0);

    // 转存清单里的文件行与下载清单同名同格式，不能因此混进下载清单
    assert.ok(!has(r.lines, 'Show.S01E01.4K.mkv'));
    for (const part of ['=== 夸克网盘定时任务', '同步完成: 成功 1 失败 1', '程序异常',
      '✗ Show.S01E02.mkv', '✓ 删除完成', '分享 ID: abc123', '网页登录成功']) {
      assert.ok(!has(r.lines, part), '下载清单里不该有: ' + part);
    }
  });
});

test('readLogs：下载清单视图按关键字筛选时，块内文件名仍认得出来', () => {
  withFixtureLog(file => {
    // 关键字只命中文件名行，标题行被关键字挡掉；归属在过滤前算好，所以文件名仍会显示
    const r = readLogs({ file, view: 'result', keyword: '遮天-182' });
    assert.deepEqual(r.lines, ['[2026/9/21 10:00:20] [INFO]      ✓ 遮天-182 4K.mp4']);
  });
});

test('readLogs：分享明细视图保留每个分享的筛选漏斗与全部报错', () => {
  withFixtureLog(file => {
    const r = readLogs({ file, view: 'summary' });
    assert.equal(r.view, 'summary');
    for (const part of ['分享 ID: abc123', '✓ 共找到 12 个项目', '→ 需要转存: 2 个',
      '=== 本分享转存结果 ===', '成功: 1 个', '程序异常', '已下载的文件列表:',
      '✓ 遮天-182 4K.mp4']) {
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
      '[2026/9/21 10:00:22] [INFO] 网页退出登录 (来自 192.168.1.5)',
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
    assert.deepEqual(few.lines, [
      '[2026/9/21 10:00:21] [INFO]    ✓ 删除完成',
      '[2026/9/21 10:00:22] [INFO] 网页退出登录 (来自 192.168.1.5)',
    ]);
  });
});

test('readLogs：截断以整条记录为单位，不把多行消息切成半截', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quark-logview-'));
  const file = path.join(dir, 'sync.log');
  fs.writeFileSync(file, [
    '[2026/9/21 10:00:00] [INFO] 普通一行',
    '[2026/9/21 10:00:01] [ERROR] ',
    '程序异常: 请在 config.json 中填写有效的 Cookie',
  ].join('\n') + '\n', 'utf-8');
  try {
    // want=2 而最后一条记录就有 2 行：宁可只给这一条，也不切掉它的续行
    const r = readLogs({ file, view: 'all', maxLines: 2 });
    assert.equal(r.truncated, true);
    assert.equal(r.lines.length, 2);
    assert.ok(r.lines[0].includes('[ERROR]'));
    assert.equal(r.lines[1], '程序异常: 请在 config.json 中填写有效的 Cookie');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('readLogs：下载清单视图下按级别过滤（这份 fixture 没有 ERROR 记录）', () => {
  withFixtureLog(file => {
    const info = readLogs({ file, level: 'INFO' });
    assert.deepEqual(info.lines, FIXTURE_DOWNLOADS);

    // 这份 fixture 里没有 ERROR 记录，所以按 ERROR 过滤为空。
    // 注意下载清单现在**会**保留少数 ERROR（改名失败、清理失败），别把这条当成「下载清单里没有 ERROR」
    const err = readLogs({ file, level: 'ERROR' });
    assert.deepEqual(err.lines, []);
    assert.ok(err.folded > 0);
  });
});

test('readLogs：日志文件不存在时返回空结果', () => {
  const r = readLogs({ file: path.join(os.tmpdir(), 'quark-logview-not-exist.log') });
  assert.deepEqual(r, { lines: [], truncated: false, view: 'result', folded: 0 });
});
