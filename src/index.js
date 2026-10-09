import axios from 'axios';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'node:async_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 源码在 src/ 下，而 config.json、sync.log 等运行期文件留在项目根目录：
// 这样本地已有配置无需搬动，Docker 里也能继续用 /app/config.json、/app/sync.log 两个软链
const ROOT = path.resolve(__dirname, '..');

// 版本号：供网页界面与启动日志显示用。读不到就留空，不影响运行
export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version || '';
  } catch {
    return '';
  }
})();

const LOG_FILE = path.join(ROOT, 'sync.log');
const DOWNLOADED_FILE = '.downloaded.json';

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

const LOG_RETENTION_DAYS = 7;
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10800000;
// 日志里的分隔线：正式运行用它分隔多个分享，试运行用它把文件清单围起来
const LOG_RULE = '═'.repeat(50);
let lastLogCleanupAt = 0;

// 日志时间戳为 Asia/Shanghai 显示值，按该时区（无夏令时）还原为 UTC 毫秒
function parseLogTime(line) {
  const m = line.match(/^\[(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{2}):(\d{2}):(\d{2})\]/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}

function readLogLines() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(l => l !== '');
}

// 从文件尾部读取最后 n 行，避免为看日志而全量加载
// 单次尾部读取最多扫描的字节数，避免对超大文件做无谓的全量扫描
const MAX_LOG_SCAN_BYTES = (() => {
  const n = Number(process.env.QUARK_LOG_MAX_SCAN_MB);
  return (Number.isFinite(n) && n > 0 ? n : 32) * 1024 * 1024;
})();
// 小于此大小的日志直接整体读取
const SMALL_LOG_BYTES = 4 * 1024 * 1024;

// 从文件尾部最多读取 maxBytes 字节，避免为看日志而全量加载。
// 返回 { lines, hitByteCap }；块内容先收集到数组、最后一次性拼接，
// 且只统计新读入块的换行数，避免退化为 O(n²)。
function tailRawLines(fp, maxBytes = MAX_LOG_SCAN_BYTES, chunkSize = 64 * 1024) {
  const fd = fs.openSync(fp, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    let pos = size;
    let scanned = 0;
    const parts = []; // 由新到旧收集，最后反转
    while (pos > 0 && scanned < maxBytes) {
      const len = Math.min(chunkSize, pos, maxBytes - scanned);
      if (len <= 0) break;
      pos -= len;
      scanned += len;
      const chunk = Buffer.allocUnsafe(len);
      fs.readSync(fd, chunk, 0, len, pos);
      parts.push(chunk);
    }
    parts.reverse();
    let text = Buffer.concat(parts).toString('utf-8');
    if (pos > 0) {
      // 起点落在行中间（或触达字节上限），丢弃被截断的首行
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const hitByteCap = pos > 0 && scanned >= maxBytes;
    return { lines: text.split('\n').filter(l => l !== ''), hitByteCap };
  } finally {
    fs.closeSync(fd);
  }
}

// 判断日志是否为旧版倒序（最新在前）。
// 判据必须保守：误判会把本来正确的顺序文件反转，导致后续清理从错误的一端删除。
// 因此要求三个条件同时成立：
//   1) 有足够多的可比对相邻对（同一秒的重复时间戳不参与比较）
//   2) 递减对明显多于递增对
//   3) 首条时间戳确实晚于末条时间戳
function looksReversed(tsList) {
  if (tsList.length < 2) return false;
  let asc = 0, desc = 0;
  for (let i = 1; i < tsList.length; i++) {
    if (tsList[i] > tsList[i - 1]) asc++;
    else if (tsList[i] < tsList[i - 1]) desc++;
  }
  const comparable = asc + desc;
  // 证据不足（多数时间戳相同）时不反转，宁可漏迁移也不破坏顺序
  if (comparable < 3) return false;
  if (desc <= asc * 2) return false;
  return tsList[0] > tsList[tsList.length - 1];
}

// 把日志行按「记录」分组：每条带时间戳的行连同其后的续行（无时间戳）算一条记录。
// 多行消息（message 内含 \n）会写出一行时间戳 + 若干续行，它们必须整体处理，
// 否则反转顺序或按行删除都会让续行与所属记录错位。
function groupLogRecords(lines) {
  const groups = [];
  let orphan = [];   // 文件开头没有归属的续行（理论上是迁移残留）
  for (const line of lines) {
    if (parseLogTime(line) !== null) {
      groups.push({ ts: parseLogTime(line), lines: [line] });
    } else if (groups.length > 0) {
      groups[groups.length - 1].lines.push(line);
    } else {
      orphan.push(line);
    }
  }
  return { groups, orphan };
}

function cleanupOldLogs() {
  let lines;
  try {
    lines = readLogLines();
  } catch {
    return;
  }
  if (lines.length === 0) return;

  let changed = false;

  // 旧版本为倒序写入（最新在前），此处做一次性顺序迁移。
  // 迁移在「记录」粒度上进行，避免把续行翻到其所属记录之前。
  const first = groupLogRecords(lines);
  const tsList = first.groups.map(g => g.ts);
  if (tsList.length >= 2 && looksReversed(tsList)) {
    const rebuilt = [];
    if (first.orphan.length > 0) rebuilt.push(...first.orphan);
    for (let i = first.groups.length - 1; i >= 0; i--) rebuilt.push(...first.groups[i].lines);
    lines = rebuilt;
    changed = true;
  }

  // 重新分组（可能刚迁移过），然后丢弃头部所有过期记录。
  // 过期记录集中在文件头部，因此从头丢弃即可。
  const { groups, orphan } = groupLogRecords(lines);
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let dropGroups = 0;
  for (const g of groups) {
    if (g.ts >= cutoff) break;   // 遇到未过期记录：其后的全部保留
    dropGroups++;
  }
  if (dropGroups > 0) {
    // 只保留未过期的记录；开头的孤儿续行一并丢弃（它们没有可保留的归属）
    const kept = [];
    for (let i = dropGroups; i < groups.length; i++) kept.push(...groups[i].lines);
    if (kept.length === 0 && orphan.length > 0) kept.push(...orphan);
    lines = kept;
    changed = true;
  }

  if (!changed) return;
  try {
    fs.writeFileSync(LOG_FILE, lines.join('\n') + '\n', 'utf-8');
  } catch {}
}

function writeLog(level, message) {
  // 先清理/迁移，再追加：否则新行会让倒序检测误判为顺序
  if (Date.now() - lastLogCleanupAt > LOG_CLEANUP_INTERVAL_MS) {
    lastLogCleanupAt = Date.now();
    cleanupOldLogs();
  }
  // 消息首尾的空行（log('\n' + x) / log(x + '\n') 这类写法）只为在终端里把前后两块分开：
  // 开头的空行落盘后会把时间戳与级别单独占成一行空记录（读日志时白占一行），结尾的空行
  // 会在文件里留下空行，所以写文件前一律去掉，时间戳直接落在真正的内容行上；
  // 去掉后什么都不剩的（log('') 这种纯分隔）干脆不落盘。
  const ts = now();
  const text = String(message).replace(/^\n+/, '').replace(/\n+$/, '');
  // 少数消息自带时间戳（终端输出没有时间戳，只能写在消息里，如 cron 的「触发: …」）；
  // 行首已有同样的时间戳时把消息里那份去掉，否则文件里会出现 "[时间戳] [INFO] [时间戳] …"
  const dup = `[${ts}] `;
  const body = text.startsWith(dup) ? text.slice(dup.length) : text;
  if (body.trim() === '') return;
  const line = `[${ts}] [${level}] ${body}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {}
}

// ---- 日志视图 ----
// 网页「日志」页默认只看「下载清单」（view=result）：只留下载任务的结果与「已下载的文件列表」，
// 其它日志一概不显示 —— 包括报错，因为这是一个「只看下载了什么」的视图；
// 需要排查时切到「分享明细」（关键结论＋每个分享的筛选漏斗＋全部报错）、
// 「全部日志」（逐行明细），或「登录日志」看谁在什么时候登录过。
const LOG_VIEWS = ['result', 'summary', 'login', 'all'];

export function normalizeLogView(view) {
  const v = String(view || '').trim().toLowerCase();
  return LOG_VIEWS.includes(v) ? v : 'result';
}

// 「下载清单」（result，默认视图）的保留清单：只认下载任务的结果与「已下载的文件列表」。
// 这张表刻意保持极小：它是一个「只看下载了什么」的视图，其它日志（含报错与警告）一律不显示。
// 清单里的文件名不是靠这张表认出来的 —— 转存结果清单的文件行长得一模一样、缩进也一样，
// 只能靠「是否紧跟在本清单标题之后」判断，见下面的 downloadListFlags。
const DOWNLOAD_KEEP = [
  // 下载任务的标题：一次同步里下载跑两趟、或隔几次任务各下载一次时，
  // 只有它能让人看出「这段清单属于哪一次下载」（═ 分隔线只在转存侧，这里会出现孤立横线）
  /^=+ AList 下载到本地 =+ *$/m,
  /^=+ 夸克网盘下载到本地 =+ *$/m,
  /^\s*待下载: \d+/m,                  // 待下载: 5 个 (跳过 1 个已下载记录)
  /^\s*下载完成: \d+/m,                // 下载完成: 3/5 个
  /^\s*所有文件已下载过，无需下载/m,
  /^\s*已下载的文件列表:/m,
  // 清理重复副本的结果也放这里：这是用户点了按钮之后唯一会看的地方，
  // 删了什么、失败了没有，都必须在默认视图里看得见（细节仍可用「全部日志」翻）
  /^=+ .*(清理重复副本|重复副本清理).*=+ *$/m,
  /^\s*扫描 \d+ 个文件，发现 \d+ 组重复/m,
  /^\s*(将删除|🗑 删除) \d+ 个，保留 /m,   // 整组是一条多行记录，清单里的文件名跟着一起留
  /^\s*(已删除|待删除) \d+ 个重复副本/m,
  /^\s*✗ (云端|本地)(清理|删除|重命名)失败/m,   // 删除失败必须让人看到，不能悄悄消失
  /^\s*✗ .*重命名失败/m,                // 加前缀失败（含清理侧的云端重命名失败）：文件还在，名字不对
];

// 「分享明细」（summary）的保留清单：任务边界、结果统计、状态变更、文件清单与筛选漏斗。
// 判定以「记录」为单位（一条记录 = 一行带时间戳的日志 + 其后的续行），多行消息不会被截半。
// 新增日志时，如果它是「一眼就该看到」的结论，把特征补进这张表；拿不准就别加 ——
// 多一行只是啰嗦，少一条结论才是问题，所以下面的报错/警告兜底必须保留。
const SUMMARY_KEEP = [
  /^=+ .*=+ *$/m,                     // === 任务标题 / 结果汇总分隔线 ===
  /^═+$/m,                            // ═══ 分隔线：正式运行分隔各分享、试运行围住清单（LOG_RULE）
  /^\[启动任务\]/m,                    // web 启动后补跑的首次同步、下载
  /^网页/m,                            // 登录、退出、改配置、手动触发、任务结果
  /^正在关闭/m,
  /触发: /m,                           // 定时任务被触发
  /定时任务已启动/m,
  /定时任务已按新配置重载/m,
  /未配置 syncCron/m,
  /网页管理界面/m,
  // 启动时回显的 cron（"   ✓ 同步模式: …"）故意不进「分享明细」：「任务」页有带下次运行时间的同一信息，
  // 每次重启都重复三行纯属噪音
  /^处理第 \d+\/\d+ 个分享/m,          // 每个分享的边界
  /^分享 ID: /m,
  /^时间范围: /m,
  /✓ 共找到 \d+ 个项目/m,              // 筛选漏斗：从全部条目收敛到待转存
  /其中文件: \d+ 个/m,
  /时间窗口内 .*: \d+ 个/m,
  /过滤 <.*后剩余: \d+ 个/m,
  /⏭ 同名集去重: /m,                   // 同集多版本：留下哪份、丢了哪份（转存与下载都走这里）
  /→ 去重移除 \d+ 个较低画质版本/m,
  /限制每分享最多 \d+ 个/m,
  /→ 候选文件: \d+ 个/m,
  /跳过 \d+ 个已存在的文件/m,
  /→ 需要转存: \d+ 个/m,
  /没有找到符合条件的文件/m,
  /所有文件已存在，无需转存/m,
  /所有文件已下载过，无需下载/m,
  /待转存文件列表:/m,                  // 试运行清单
  /会被转存/m,
  /^\s+- .+\(更新于: /m,               // 试运行清单里的文件名
  /^\[[^\[\]]+\]\s*$/m,                // 试运行清单里的分享分组标题
  /^成功: \d+ 个/m,
  /^失败: \d+ 个/m,
  /成功转存的文件(列表)?:/m,
  /失败的文件(列表)?:/m,
  /已下载的文件列表:/m,
  /共处理 \d+ 个分享/m,
  /同步完成: /m,
  /下载完成: \d+/m,
  /待下载: \d+/m,
  /✓ 共 \d+ 个文件/m,
  /清理网盘旧文件/m,
  /✓ 网盘清理完成/m,
  /没有超过保留期的文件/m,
  /✓ 删除完成/m,
  /从网盘中删除已下载的/m,
  /已从配置中清理/m,
  /失效的分享链接/m,
  /pruneDeadShares/m,
  /^执行清理 \(/m,
  /执行本地清理/m,
  /本地: 删除 \d+ 个/m,
  /^AList: /m,
  /^路径: /m,
  /保存到: /m,
  /AList下载完成/m,
  // 清单里的文件名（逐行 "  ✓ 片名 S01E01.mkv"）；重命名结果行带箭头，属于明细不保留
  /^\s*✓\s+(?!.*→).*\.\w{2,5}\s*$/m,
];

// 「登录」视图：网页登录 / 退出，以及夸克登录态校验相关的记录
const LOGIN_KEEP = [
  /网页登录/m,
  /网页退出/m,
  /登录状态/m,
  /登录失败/m,
  /Cookie 无效或已过期/m,
];

// 两个视图都是热路径（每条记录都要判一次），各自把整张表合成一个正则，避免逐条试几十个模式。
// 注意：合成后捕获组会统一编号，所以这里新增的模式不要写反向引用（\1 之类），
// 需要「与」逻辑就单独在 logRecordKeeps 里判（例如文件清单排除带箭头的重命名行）。
const SUMMARY_RE = new RegExp(SUMMARY_KEEP.map(r => r.source).join('|'), 'm');
const DOWNLOAD_RE = new RegExp(DOWNLOAD_KEEP.map(r => r.source).join('|'), 'm');

// 记录里的「[时间戳] [级别]」前缀只出现在首行，去掉它，^ 锚点才表示「消息自身的开头」。
// 写日志的格式固定为「[时间戳] [级别] 消息」，因此这里只吃掉分隔用的那一个空格：
// 用 \s* 会把消息自己的缩进（"   ✓ …" 前导空格）也一起吃掉，缩进是消息的一部分。
// 续行是消息正文，不能动：试运行清单的分组标题就长成 "[影视名称]"
function stripLogPrefix(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  const rest = nl === -1 ? '' : text.slice(nl);
  return first.replace(/^\[[^\]]*\] (?:\[[A-Z]+\] )?/, '') + rest;
}

// 一条日志记录（可含续行，首行带 [时间戳] [级别] 前缀）在指定视图下是否保留。
// inDownloadList 是 downloadListFlags 算出来的「属于已下载的文件列表」标记（只有「下载清单」视图用得上）。
// 导出仅为测试用。
export function logRecordKeeps(recordText, view, inDownloadList = false) {
  const v = normalizeLogView(view);
  if (v === 'all') return true;
  const text = stripLogPrefix(recordText);
  if (v === 'login') return LOGIN_KEEP.some(re => re.test(text));
  // 「下载清单」只看下载了什么：报错也不显示（要找问题请切「分享明细」或「全部日志」）；
  // 带箭头的重命名行属于明细，即便落在清单块里也不显示
  if (v === 'result') return (inDownloadList && !/→/.test(text)) || DOWNLOAD_RE.test(text);
  // 「分享明细」可以少，但不能把问题藏起来：报错与警告一律保留（含 INFO 级别里的 ✗ / ⚠）
  if (/\[ERROR\]/.test(recordText) || /✗|⚠/.test(recordText)) return true;
  return SUMMARY_RE.test(text);
}

// ---- 「下载清单」视图的清单归属判定 ----
// 「已下载的文件列表:」标题之后的 ✓ 文件名行才算这份清单。为什么不直接把文件名写进
// DOWNLOAD_KEEP：转存结果清单（「成功转存的文件列表:」下的行）格式与缩进完全一样，
// 单看一行分不出它属于哪份清单，只能按位置认。
// 清单块到第一条非文件名记录为止（下载完接着是删除结果之类），后面的清单不会被前面的块认领。
const DOWNLOAD_LIST_HEAD = /^\s*已下载的文件列表:/m;
const LIST_FILE_LINE = /^\s*✓\s+(?!.*→).*\.\w{2,5}\s*$/m;

// 逐条给出「是否属于已下载的文件列表」：标题行与块内的文件名行为 true。
// 导出仅为测试用。
export function downloadListFlags(recordTexts) {
  const out = new Array(recordTexts.length).fill(false);
  let inList = false;
  for (let i = 0; i < recordTexts.length; i++) {
    const text = stripLogPrefix(recordTexts[i]);
    if (DOWNLOAD_LIST_HEAD.test(text)) { inList = true; out[i] = true; continue; }
    if (inList && LIST_FILE_LINE.test(text)) { out[i] = true; continue; }
    inList = false;
  }
  return out;
}

// 从尾部取记录凑够 want 行；以整条记录为单位，不把多行消息截成半截
function tailRecords(groups, want) {
  let start = groups.length;
  let total = 0;
  while (start > 0) {
    const len = groups[start - 1].lines.length;
    if (total > 0 && total + len > want) break;
    start--;
    total += len;
    if (total >= want) break;
  }
  const lines = [];
  for (let i = start; i < groups.length; i++) lines.push(...groups[i].lines);
  return { lines, dropped: start > 0 };
}

// file 只给测试用，默认读写项目根目录的 sync.log
export function readLogs({ maxLines = 500, level = '', keyword = '', view = '', file = LOG_FILE } = {}) {
  const want = Math.max(1, Math.min(5000, Number(maxLines) || 500));
  const v = normalizeLogView(view);
  if (!fs.existsSync(file)) return { lines: [], truncated: false, view: v, folded: 0 };

  const needle = String(keyword || '').toLowerCase();
  const lvl = String(level || '').toUpperCase();

  // 级别与关键字按整条记录匹配：命中续行时整条记录都在，不会只剩一行没有上下文的标题
  const passFilters = g => {
    const text = g.lines.join('\n');
    if (lvl && !text.toUpperCase().includes(`[${lvl}]`)) return false;
    if (needle && !text.toLowerCase().includes(needle)) return false;
    return true;
  };

  // 切成记录 -> 套「级别/关键字」与「视图」两层过滤，并统计被视图折叠掉的行数
  const select = lines => {
    const { groups, orphan } = groupLogRecords(lines);
    const all = orphan.length > 0 ? [{ lines: orphan }, ...groups] : groups;
    const texts = all.map(g => g.lines.join('\n'));
    // 清单归属要在「级别/关键字」过滤之前算好：标题行被关键字挡掉时，块内的文件名仍要认得出
    const dlist = v === 'result' ? downloadListFlags(texts) : null;
    const kept = [];
    let folded = 0;
    for (let i = 0; i < all.length; i++) {
      if (!passFilters(all[i])) continue;
      if (logRecordKeeps(texts[i], v, dlist ? dlist[i] : false)) kept.push(all[i]);
      else folded += all[i].lines.length;
    }
    return { kept, folded };
  };

  const finish = (picked, reachedStart) => {
    const { lines, dropped } = tailRecords(picked.kept, want);
    return {
      lines,
      // 两种截断：尾部取够 want 行后丢弃了更早的记录；或还没扫到文件开头
      truncated: dropped || !reachedStart,
      view: v,
      folded: picked.folded,
    };
  };

  const fileSize = (() => {
    try { return fs.statSync(file).size; } catch { return 0; }
  })();

  // 小文件直接整体读取，避免多次系统调用
  if (fileSize <= SMALL_LOG_BYTES) {
    return finish(select(tailRawLines(file, fileSize + 1).lines), true);
  }

  // 大文件：从尾部按窗口渐进放大，窗口上限受字节数约束（而非行数），
  // 保证最坏情况下的读取量有界。判断「够了没」要按视图过滤后剩下的行数算，
  // 否则下载清单视图会被一大堆即将折叠的明细行提前喂饱。
  let maxBytes = Math.min(256 * 1024, fileSize);
  let picked = { kept: [], folded: 0 };
  let reachedStart = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { lines, hitByteCap } = tailRawLines(file, maxBytes);
    picked = select(lines);
    // hitByteCap=false 表示已读到头，不可能再有更早的匹配记录
    reachedStart = !hitByteCap;
    const keptLines = picked.kept.reduce((n, g) => n + g.lines.length, 0);
    if (keptLines >= want || reachedStart) break;
    if (maxBytes >= MAX_LOG_SCAN_BYTES) break;
    maxBytes = Math.min(maxBytes * 4, MAX_LOG_SCAN_BYTES, fileSize);
  }
  return finish(picked, reachedStart);
}

// 试运行的输出只有「会转存哪些文件」，进度类日志（步骤、筛选计数、目录解析等）全部静音。
// 用 AsyncLocalStorage 限定作用域，而不是全局开关：否则同时运行的其它任务
// （sync 与 alist 用的是两把锁，可以并发）的日志也会被一起吞掉。
const quietLog = new AsyncLocalStorage();

// 不受静音影响的输出：试运行的最终清单走这里，既能上屏也写进 sync.log
function logAlways(message) {
  console.log(message);
  writeLog('INFO', message);
}

export function log(message) {
  if (quietLog.getStore()) return;
  logAlways(message);
}

export function logError(message) {
  console.error(message);
  writeLog('ERROR', message);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36 Core/1.94.225.400 QQBrowser/12.2.5544.400';
const UA_CLIENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch';

function loadDownloadedRecord(saveDir) {
  const fp = path.join(saveDir, DOWNLOADED_FILE);
  try {
    if (fs.existsSync(fp)) {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(fp, 'utf-8'))));
    }
  } catch {}
  return new Map();
}

function saveDownloadedRecord(saveDir, record) {
  const fp = path.join(saveDir, DOWNLOADED_FILE);
  fs.writeFileSync(fp, JSON.stringify(Object.fromEntries(record), null, 2), 'utf-8');
}

function cleanupLocalFiles(saveDir, maxAgeDays) {
  if (!maxAgeDays || maxAgeDays <= 0) return { deleted: 0, skipped: 0 };
  if (!fs.existsSync(saveDir)) return { deleted: 0, skipped: 0 };

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(saveDir);
  let deleted = 0, skipped = 0;
  const downloadedRecord = loadDownloadedRecord(saveDir);
  let recordChanged = false;

  for (const name of entries) {
    const fp = path.join(saveDir, name);
    try {
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) continue;
      if (name === DOWNLOADED_FILE) continue;
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        deleted++;
        log(`   🗑 清理旧文件: ${name}`);
        const epKey = getEpisodeKey(name);
        for (const [key] of downloadedRecord) {
          if (key.startsWith(`${name}|`) || (epKey && key === epKey)) {
            downloadedRecord.delete(key);
            recordChanged = true;
          }
        }
      } else {
        skipped++;
      }
    } catch {}
  }

  if (recordChanged) {
    saveDownloadedRecord(saveDir, downloadedRecord);
  }
  return { deleted, skipped };
}

// 进程内任务互斥：定时触发与网页手动触发共用，防止并发重复转存
const runningTasks = new Set();

export function getRunningTasks() {
  return [...runningTasks];
}

export function isTaskRunning(name) {
  return runningTasks.has(name);
}

async function withTaskLock(name, fn) {
  if (runningTasks.has(name)) {
    throw new Error(`任务 "${name}" 正在运行中，已跳过本次执行`);
  }
  runningTasks.add(name);
  try {
    return await fn();
  } finally {
    runningTasks.delete(name);
  }
}

const heldLocks = new Set();

// 尝试获取跨进程锁；失败返回 false（不退出进程，便于 CLI 与 web 复用）
function tryAcquireLock(lockName, lockDir) {
  const lockFile = path.join(lockDir, lockName);
  // 本进程已持有：互斥锁不可重入，直接失败，避免覆盖自己的锁
  if (heldLocks.has(lockFile)) return false;
  if (fs.existsSync(lockFile)) {
    let pid;
    try { pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10); } catch { pid = 0; }
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        logError(`检测到另一个进程 (PID: ${pid}) 正在 "${lockName}" 中运行。`);
        return false;
      } catch {}
    }
    try { fs.unlinkSync(lockFile); } catch {}
  }
  try {
    fs.writeFileSync(lockFile, String(process.pid), 'utf-8');
  } catch (e) {
    logError(`获取锁失败 "${lockName}": ${e.message}`);
    return false;
  }
  heldLocks.add(lockFile);
  return true;
}

function releaseAllLocks() {
  for (const lockFile of [...heldLocks]) {
    try { fs.unlinkSync(lockFile); } catch {}
    heldLocks.delete(lockFile);
  }
}

// CLI 模式：拿不到锁说明别的实例在跑，直接退出（保持原有行为）
function acquireLock(lockName, lockDir) {
  if (!tryAcquireLock(lockName, lockDir)) {
    process.exit(0);
  }
  process.once('exit', releaseAllLocks);
  process.once('SIGINT', () => { releaseAllLocks(); process.exit(0); });
  process.once('SIGTERM', () => { releaseAllLocks(); process.exit(0); });
}

export function loadConfig() {
  const configPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('找不到 config.json，请复制 docs/config.example.json 并填写配置');
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('config.json 格式不正确');
  }
}

export function getConfigPath() {
  return path.join(ROOT, 'config.json');
}

// 原子写入配置。Docker 下 config.json 是指向 /app/config/config.json 的软链接，
// 若直接 rename 覆盖会把软链接本身替换成普通文件、导致挂载卷内的配置不同步，
// 因此先解析真实路径，再对真实路径写入。
export function saveConfig(config) {
  const configPath = getConfigPath();
  let target = configPath;
  try {
    target = fs.realpathSync(configPath);
  } catch {
    // 配置不存在或非软链接：按原路径创建
    target = configPath;
  }

  const json = JSON.stringify(config, null, 2) + '\n';
  JSON.parse(json); // 保证可序列化且合法

  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json, 'utf-8');
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`写入配置失败: ${e.message}`);
  }
  return { path: target, isSymlink: target !== configPath };
}

function loadConfigOrExit() {
  try {
    return loadConfig();
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(1);
  }
}

function parseShareUrl(url) {
  const match = url.match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error('无法解析分享链接');
  return match[1].split('#')[0].split('?')[0];
}

// 判断分享是否真的失效（区别于网络抖动/限流等临时故障）。
// 只认明确表示「分享不存在/已失效」的文案；拿不准一律按临时故障处理，
// 避免把可用的链接误删。
function isShareDead(msg) {
  const s = String(msg || '');
  const dead = [
    /分享.{0,6}(已)?(失效|过期|不存在|被删除|取消)/,
    /(失效|过期)的?(分享|链接)/,
    /链接.{0,6}(已)?(失效|过期|不存在|被删除|违规)/,
    /(分享|链接).{0,4}(违规|屏蔽|和谐)/,
    /share\s*(not\s*(found|exist)|expired|invalid|deleted)/i,
    /(pwd_id|pwdid).{0,10}(invalid|not\s*found)/i,
  ];
  if (dead.some(re => re.test(s))) return true;
  // 提取码相关：链接本身没坏，不算失效
  if (/提取码|passcode|密码/.test(s)) return false;
  // 明确的临时性故障：网络、超时、限流、服务端错误
  if (/timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|限流|频率|23018|5\d\d/i.test(s)) return false;
  return false;
}

// 从配置里的分享项中剔除失效链接。
// - 备用链接组：只删失效的那条，保留可用项
// - 单链接或全部失效：把 url 清空（保留条目本身，便于手动修复）
// - 清理后无任何有效链接的条目会被标记，调用方可决定是否跳过
function pruneDeadUrls(shareUrls, deadPwdIds) {
  const removed = [];
  const result = [];
  for (const item of shareUrls) {
    const isStr = typeof item === 'string';
    const obj = isStr ? { url: item } : { ...item };
    const toIds = u => {
      try { return [parseShareUrl(u)]; } catch { return []; }
    };
    const urls = Array.isArray(obj.url) ? obj.url : (obj.url ? [obj.url] : []);
    const alive = urls.filter(u => !toIds(u).some(id => deadPwdIds.has(id)));

    if (alive.length === urls.length) {
      result.push(item);
      continue;
    }
    for (const u of urls) {
      if (!alive.includes(u)) removed.push({ url: u, tip: obj.tip });
    }
    if (alive.length === 0) {
      // 全部失效：清空 url 但保留条目
      if (isStr) result.push({ url: '' });
      else result.push({ ...obj, url: '' });
    } else {
      const keep = alive.length === 1 && !Array.isArray(obj.url) ? alive[0] : alive;
      result.push({ ...obj, url: keep });
    }
  }
  return { shareUrls: result, removed };
}

// 依次尝试候选链接；返回命中的那条，并记录判定为「已失效」的链接
async function tryShareUrls(client, pwdIds, passcode, tip, deadSet) {
  for (let i = 0; i < pwdIds.length; i++) {
    const pwdId = pwdIds[i];
    try {
      const stoken = await client.getShareToken(pwdId, passcode);
      const allFiles = await client.listAllShareFiles(pwdId, stoken);
      if (pwdIds.length > 1 && i > 0) {
        log(`   ✓ 备用链接 ${pwdId} 可用`);
      }
      return { stoken, allFiles, pwdId };
    } catch (e) {
      const label = tip ? ` (${tip})` : '';
      const dead = isShareDead(e.message);
      if (dead && deadSet) deadSet.add(pwdId);
      logError(`   ✗ 分享链接 ${pwdId}${label} 失败: ${e.message}`
        + (dead ? '  [判定为已失效]' : '  [按临时故障处理，保留]'));
    }
  }
  return null;
}

// 去掉「 (2)」「（3）」这类为避免重名自动加的序号后缀（只认扩展名前的 2..999）。
// 序号副本与原始文件是同一份内容，比对集数前必须先归一化，否则会被当成两集，
// 于是「同名集去重」永远合并不掉，下载与清理都看不出它们是重复的。
// 480/576/720/1080/2160 这几个数字排除掉：`剧名 (720).mkv` 里的 720 是分辨率写法，
// 不是自动序号，剥掉会让它连集数都解析不出来。
const RESOLUTION_NUMBERS = new Set([480, 576, 720, 1080, 2160]);

export function stripNumericSuffix(fileName) {
  const s = String(fileName ?? '');
  const dot = s.lastIndexOf('.');
  const base = dot > 0 ? s.slice(0, dot) : s;
  const ext = dot > 0 ? s.slice(dot) : '';
  const m = base.match(/^(.*?)[\s]*[（(](\d{1,3})[)）]$/);
  if (!m) return s;
  const n = Number(m[2]);
  if (n < 2 || RESOLUTION_NUMBERS.has(n)) return s;   // (0)/(1) 与分辨率写法都不当作自动序号
  return `${m[1].replace(/\s+$/, '')}${ext}`;
}

// 画质/编码标记不是集数：`凡人修仙传-194 1080p.mkv` 里的 1080 是画质，不是第 1080 集。
// 不先去掉它们，「取最长数字当集数」的启发式就会挑中 1080/2160/720，
// 于是同一集的 4K 与 1080p 被判成两集 —— 既不去重、也判不出「已存在」，重复就是这么来的。
const EPISODE_NOISE = /(\d{3,4}\s*[xX]\s*\d{3,4}|1080p|720p|2160p|480p|4k|8k|uhd|fhd|hdr10\+?|hdr|hevc|x265|x264|h264|avc|10bit|8bit|web-?dl|bluray|remux|aac|dts|60fps)/gi;

// parseEpisode 的内部版本：额外给出「季号是不是明确写出来的」。
// 灵境行者-S01E07.mkv（季 1）与 灵境行者-07.mkv（没写季）是同一集，可以合并；
// 但 第1季第7集 与 第2季第7集 不是同一集 —— 只有知道季号是否明确，才能安全地合并。
// keepNoise 只给 getEpisodeKey 用：那边的输出是 .downloaded.json 的记录键，
// 必须沿用历史算法，改了会让升级前的记录全部失配、触发全量重下（见 getEpisodeKey 的注释）。
function parseEpisodeInfo(fileName, { keepNoise = false } = {}) {
  const base = stripNumericSuffix(fileName).replace(/\.[^.]+$/, '');
  const name = keepNoise ? base : base.replace(EPISODE_NOISE, ' ');
  let m;

  m = name.match(/[Ss](\d+)\s*[Ee](?:\s*P\s*)?(\d+)/);
  if (m) return { season: +m[1], episode: +m[2], seasonKnown: true, notation: 'se' };

  m = name.match(/第?\s*(\d+)\s*季.*?第?\s*(\d+)\s*集/);
  if (m) return { season: +m[1], episode: +m[2], seasonKnown: true, notation: 'seasonCn' };

  // 「第1季-02」「第1季 02」「.第1季.E02」：季与集之间只有分隔符（没写「集」字）。
  // 不认这几种写法，它们就会掉进下面「取最长数字」的启发式 —— `第1季-02` 会算成第 1 集，
  // 于是同一季的 01/02/03 全被当成同一集（实测复现过：转存漏转、清理会误删）。
  m = name.match(/第?\s*(\d+)\s*季\s*[-_. ]\s*[Ee]?\s*(\d+)/);
  if (m) return { season: +m[1], episode: +m[2], seasonKnown: true, notation: 'seasonSep' };

  // 「1x02」：两侧都是 1~2 位数字，且不能是 `1920x1080` 这类分辨率
  m = name.match(/(?:^|[^\d])(\d{1,2})\s*[xX]\s*(\d{1,3})(?![\d])/);
  if (m) return { season: +m[1], episode: +m[2], seasonKnown: true, notation: 'x' };

  m = name.match(/第?\s*(\d+)\s*集/);
  if (m) return { season: 0, episode: +m[1], seasonKnown: false, notation: 'epCn' };

  // 只写了季、没写集（整季包）：宁可当作不认识，也不能让整季落进「取最长数字」而互相合并
  if (/[Ss]\d{1,2}(?![\d])|第\s*\d+\s*季/.test(name)) return null;

  const nums = [...name.matchAll(/(\d+)/g)].map(n => +n[1]);
  const nonYear = nums.filter(n => n < 1900 || n > 2099);
  if (nonYear.length > 0) {
    const best = nonYear.reduce((a, b) => String(a).length >= String(b).length ? a : b);
    return { season: 0, episode: best, seasonKnown: false, notation: 'bare' };
  }

  return null;
}

export function parseEpisode(fileName) {
  const info = parseEpisodeInfo(fileName);
  if (!info) return null;
  return { season: info.season, episode: info.episode };
}

export function sortByEpisode(a, b) {
  const pa = parseEpisode(a.file_name);
  const pb = parseEpisode(b.file_name);
  if (pa && pb) {
    if (pa.season !== pb.season) return pb.season - pa.season;
    return pb.episode - pa.episode;
  }
  if (pa) return -1;
  if (pb) return 1;
  return (b.updated_at || 0) - (a.updated_at || 0);
}

// 从文件名里剥出「剧名」：去掉季集标记、画质/编码等噪音与结尾的集数。
// hdr 必须排在 hd 前面，否则 "HDR" 会被 hd 咬掉一块、留下 "R" 这种残渣，
// 于是「择日飞升-14 4K HDR.mp4」与「择日飞升-14 4K.mp4」会被当成两部剧。
function episodeShow(fileName) {
  let show = stripNumericSuffix(fileName).replace(/\.[^.]+$/, '');
  show = show.replace(/[-_\s]*[Ss]\d+[-\s]*[Ee]\d+.*$/, '');
  show = show.replace(/[-_\s]*第?\s*\d+\s*季.*$/, '');
  show = show.replace(/[-_\s]*第?\s*\d+\s*集.*$/, '');
  show = show.replace(/(hdr10\+?|hdr|dolby\s*vision|4k|2160p|1080p|720p|高清|标清|hd|fhd|uhd|sd)/gi, '');
  show = show.replace(/[-_\s]*\d+\s*$/, '');
  show = show.replace(/[-_\s]+$/, '').trim();
  return show;
}

// 严格键：季号参与区分（S01E07 与 S02E07 是两个键）。.downloaded.json 用它，
// 所以不能把季号抹掉，否则升级后旧记录全部失配、触发全量重下。
// 集数同样按**历史算法**解析（keepNoise）：这条键的唯一职责是「和已有记录对得上」，
// 不是「算得对」。需要正确集数的地方（分组、去重、清理）走 getEpisodeGroup。
export function getEpisodeKey(fileName) {
  const info = parseEpisodeInfo(fileName, { keepNoise: true });
  if (!info) return null;
  return `ep_${episodeShow(fileName)}_S${info.season}_E${info.episode}`;
}

// 分组用的剧名：剥掉画质/编码词与季集标记、分隔符归一成单个空格、小写。
// 为什么不复用 episodeShow：那个函数的输出是 .downloaded.json 的记录键，只能保持历史行为；
// 分组要的是「算得对」，可以独立改进（改它不会动任何旧记录）。
//
// 几个刻意的取舍：
// - 只剥**被分隔符/边界包住**的画质与编码词：`SD高达`、`4K纪录片` 里的 SD/4K 是剧名的一部分，
//   剥掉会把两部不同的剧并成同一集 —— 清理重复副本就会误删其中一份（真实文件名验证过）
// - 结尾集数必须**带分隔符**才剥：`斗罗大陆2` 与 `斗罗大陆-02` 是两部剧，不能都归成「斗罗大陆」
// - 分隔符归一成空格而不是删掉：`Show-A` 与 `Showa` 要保持不同
function episodeShowLoose(fileName) {
  let s = stripNumericSuffix(fileName).replace(/\.[^.]+$/, '');
  s = s.replace(
    /(^|[-_.\s[\]()（）])(hdr10\+?|hdr|dolby\s*vision|dolbyvision|8k|4k|2160p|1080p|720p|480p|uhd|fhd|hd|sd|hevc|x265|x264|h264|avc|10bit|8bit|web-?dl|bluray|remux|aac|dts|60fps)(?=$|[-_.\s[\]()（）])/gi,
    '$1',
  );
  s = s.replace(/[-_.\s]*[Ss]\d{1,2}(?:[-_.\s]*[Ee]\d{1,3})?.*$/, '');   // S01E07 / S01
  s = s.replace(/[-_.\s]*第?\s*\d+\s*季.*$/, '');
  s = s.replace(/[-_.\s]*第?\s*\d+\s*集.*$/, '');
  s = s.replace(/[-_.\s]*\d{1,2}\s*[xX]\s*\d{1,3}.*$/, '');              // 1x07
  s = s.replace(/[-_.\s]+\d+\s*$/, '');                                  // 结尾集数（必须带分隔符）
  return s.replace(/[.\-_\s]+/g, ' ').trim().toLowerCase();
}

// 宽松分组信息：loose 忽略季号，season 是明确季号（没写季号时为 null）。
// 「同一集」的判定都建立在它之上，见 groupByEpisode。
// 导出仅为测试用。
export function getEpisodeGroup(fileName) {
  const info = parseEpisodeInfo(fileName);
  if (!info) return null;
  return {
    loose: `ep_${episodeShowLoose(fileName)}_E${info.episode}`,
    season: info.seasonKnown ? info.season : null,
    // 季集写法（se / seasonCn / seasonSep / x / epCn / bare）：清理时的「为什么算重复」要用它
    notation: info.notation,
  };
}

const QUALITY_SCORE = { '4k': 5, '2160p': 4, 'uhd': 4, '1080p': 3, 'fhd': 3, '1080': 3, '720p': 2, 'hd': 2, '720': 2, '高清': 2, '标清': 1, 'sd': 1 };

export function getQualityScore(fileName) {
  const lower = fileName.toLowerCase();
  for (const [kw, score] of Object.entries(QUALITY_SCORE)) {
    if (lower.includes(kw)) return score;
  }
  return 0;
}

export function isHigherQuality(aName, aSize, bName, bSize) {
  const qA = getQualityScore(aName);
  const qB = getQualityScore(bName);
  if (qA !== qB) return qA > qB;
  return (aSize || 0) > (bSize || 0);
}

// 「留哪一份」的统一规则：画质高的优先，其次体积大的，再次名字没被加过序号的
// （避免只留下 凡人修仙传-194 4K (4).mkv 这种名字），最后留更新时间更早的那份。
// 返回负数表示 a 更该保留。去重、下载、清理三处共用同一套规则，结论才不会互相矛盾。
export function compareForKeep(a, b) {
  const aName = a.file_name || a.name;
  const bName = b.file_name || b.name;
  const aSize = a.size || 0;
  const bSize = b.size || 0;
  if (isHigherQuality(aName, aSize, bName, bSize)) return -1;
  if (isHigherQuality(bName, bSize, aName, aSize)) return 1;
  // 画质与体积都一样：优先留没被加过序号的名字，再留更新时间更早的那份
  const na = stripNumericSuffix(aName) === aName ? 0 : 1;
  const nb = stripNumericSuffix(bName) === bName ? 0 : 1;
  if (na !== nb) return na - nb;
  const ta = a.updated_at || 0;
  const tb = b.updated_at || 0;
  if (ta !== tb) return ta - tb;
  // 并列时按名字定序：否则「留哪一份」取决于 readdir / 接口返回顺序，同样的目录两次跑可能给出不同结果
  return String(aName).localeCompare(String(bName));
}

// 按「同一集」把文件分桶：loose 相同的先放一起，桶内再按明确季号区分。
// 无法识别集数的文件（电影、特别篇）不进任何桶 —— 它们永远不会被判成重复。
function collectEpisodeBuckets(files) {
  const buckets = new Map();
  for (const f of files) {
    const info = getEpisodeGroup(f.file_name || f.name);
    if (!info) continue;
    if (!buckets.has(info.loose)) buckets.set(info.loose, { known: new Map(), unknown: [] });
    const b = buckets.get(info.loose);
    if (info.season === null) {
      b.unknown.push(f);
    } else {
      if (!b.known.has(info.season)) b.known.set(info.season, []);
      b.known.get(info.season).push(f);
    }
  }
  return buckets;
}

// 把文件按「同一集」分组，返回 Map<分组键, 文件数组>。规则：
// - 双方都写了季号：季号不同就是不同集（S01E07 与 S02E07 不会被合并）
// - 只有一方写了季号：并成同一集（S01E07 与 07 是同一集）
// - 桶里既有多个明确季号、又有没写季号的：没写季号的无法判断归属，各自独立
//   —— 宁可漏合（多留一份），也绝不能误合（把另一集当成重复删掉）
export function groupByEpisode(files) {
  const out = new Map();
  for (const [loose, b] of collectEpisodeBuckets(files)) {
    const seasons = [...b.known.keys()];
    if (seasons.length === 0) {
      out.set(`${loose}#?`, b.unknown);
    } else if (seasons.length === 1) {
      out.set(`${loose}#S${seasons[0]}`, [...b.known.get(seasons[0]), ...b.unknown]);
    } else {
      for (const s of seasons) out.set(`${loose}#S${s}`, b.known.get(s));
      b.unknown.forEach((f, i) => out.set(`${loose}#?${i}`, [f]));
    }
  }
  return out;
}

// 目标文件夹的「已有集」索引：loose -> { seasons, unknown }。
// 与 groupByEpisode 同一套判定，所以「转存时跳过」与「分组去重」不会给出矛盾结论。
export function buildEpisodeIndex(files) {
  const index = new Map();
  for (const [loose, b] of collectEpisodeBuckets(files)) {
    index.set(loose, { seasons: new Set(b.known.keys()), unknown: b.unknown.length });
  }
  return index;
}

// fileName（带前缀的最终名）在目标文件夹里是否已有同一集。判定与 groupByEpisode 一致：
// 候选没写季号时，只有桶里明确季号不超过一个才能并；候选写了季号时，桶里有同季号才并。
export function indexHasSameEpisode(index, fileName) {
  const info = getEpisodeGroup(fileName);
  if (!info) return false;
  const hit = index.get(info.loose);
  if (!hit) return false;
  if (info.season === null) return hit.seasons.size <= 1;
  if (hit.seasons.size === 0) return hit.unknown > 0;
  return hit.seasons.has(info.season);
}

// 「凭什么说这几份是同一集的重复」—— 必须有可解释的证据才动手：
// - 有序号副本：名字里带自动加的 `(2)(3)`（`stripNumericSuffix` 能剥掉）
// - 画质不同：4K / 1080p 这类（保留画质高的那份）
// - 季集写法不同：`S01E07` 与 `07`、`第1季-07` 与 `第07集` 这类
// 三条都对不上时（只是名字凑巧被归一化成同一个键），一律**不动** ——
// 删除不可逆，而分组靠的是文件名启发式，两部剧名相近时完全可能撞到一起。
function duplicateEvidence(group, nameOf) {
  const names = group.map(nameOf);
  if (names.some(n => stripNumericSuffix(n) !== n)) return '有序号副本';
  if (new Set(names.map(getQualityScore)).size > 1) return '画质不同';
  const notations = new Set(group.map(f => getEpisodeGroup(nameOf(f))?.notation));
  if (notations.size > 1) return '季集写法不同';
  return null;
}

// 按「同一集」分组，并标出证据。返回 { groups, unexplained }：
// groups = [{ key, group, evidence }] 可以放心去重/删除；unexplained 只报告不处理。
function explainedGroups(files) {
  const nameOf = f => f.file_name || f.name;
  const groups = [];
  const unexplained = [];
  for (const [key, group] of groupByEpisode(files)) {
    if (group.length < 2) continue;
    const evidence = duplicateEvidence(group, nameOf);
    if (evidence) groups.push({ key, group, evidence });
    else unexplained.push({ key, group });
  }
  return { groups, unexplained };
}

// 找出「同一集留了多份」的组合，每组按保留优先级排好序（keep 是最该留的那份）。
// 解释不了为什么算重复的组放进 skipped，由调用方报告、不删。
// 云端清理与本地清理都用它；导出仅为测试用。
export function findDuplicateSets(files) {
  const { groups, unexplained } = explainedGroups(files);
  const sets = groups.map(({ key, group, evidence }) => {
    const sorted = [...group].sort(compareForKeep);
    return { key, keep: sorted[0], drop: sorted.slice(1), evidence };
  });
  return { sets, skipped: unexplained };
}

// 同名集去重：同集保留画质最高的那份（画质相同则取体积更大的）。
// 只处理能解释清楚为什么算重复的组（见 duplicateEvidence）：解释不了的整组保留 ——
// 漏下一份可以补，删错/漏掉一集就麻烦得多。
//
// 这里不直接写日志，而是通过 onSkip 回调交给调用方 —— 保持本函数是纯函数：
// 单测可以直接调用它，不会把测试输出写进真实的 sync.log。
export function deduplicateByEpisode(files, { onSkip } = {}) {
  const kept = new Set();
  const grouped = new Set();
  let removed = 0;
  const { groups, unexplained } = explainedGroups(files);
  for (const { key, group } of groups) {
    const sorted = [...group].sort(compareForKeep);
    for (const f of group) grouped.add(f);
    kept.add(sorted[0]);
    if (sorted.length > 1) {
      removed += sorted.length - 1;
      const dropped = sorted.slice(1).map(f => f.file_name || f.name).join(', ');
      if (onSkip) onSkip(`   ⏭ 同名集去重: ${key} (${sorted.length}个版本, 保留 ${sorted[0].file_name || sorted[0].name}，丢弃 ${dropped})`);
    }
  }
  if (removed > 0 && onSkip) onSkip(`   → 去重移除 ${removed} 个较低画质版本\n`);
  for (const { key, group } of unexplained) {
    const names = group.map(f => f.file_name || f.name).join(' / ');
    if (onSkip) onSkip(`   ⚠ 名字相近但无法确认是同一集的重复，都保留: ${names} (${key})\n`);
  }
  // 输出保持输入顺序：调用方拿到的顺序与接口返回一致。
  // 识别不出集数的文件（电影、特别篇）不属于任何分组，原样保留。
  return files.filter(f => !grouped.has(f) || kept.has(f));
}

export function getDedupKey(fileItem) {
  const name = fileItem.file_name || fileItem.name;
  const epKey = getEpisodeKey(name);
  return epKey || `${name}|${fileItem.size || ''}`;
}

function dt() {
  return Math.floor(Math.random() * 9000) + 100;
}

function ts13() {
  return String(Date.now());
}

// 下载单个文件并校验完整性，返回实际写入的字节数。
//
// 为什么不能只用 writer 的 'finish' 判定成功：
// 'finish' 只表示写入端已关闭，**上游提前结束也会触发它**。尤其当服务端用
// chunked（不带 Content-Length）时，连接中途断开在客户端看来就是"正常结束"，
// 于是截断的文件被当成成功，接着被记入 .downloaded.json，下次运行直接跳过，
// 永远不会重下——表现为「网盘里 3G，本地只有 300M」且不再自愈。
//
// 因此这里三重校验：响应是否完整收完、Content-Length 是否吻合、
// 以及列表里声明的文件大小是否吻合。任一不符即删除半成品并抛错，
// 让调用方不计入"已下载"，下次运行自动重试。
//
// 另外写入 .part 临时文件、校验通过后再改名，避免半成品冒充成品，
// 也避免重新下载失败时把上一次的好文件毁掉。
async function downloadToFile({ url, headers = {}, savePath, expectedSize = 0, label = '' }) {
  const partPath = `${savePath}.part`;
  const name = label || path.basename(savePath);
  const drop = () => { try { fs.rmSync(partPath, { force: true }); } catch {} };

  let resp;
  try {
    resp = await axios.get(url, {
      headers,
      responseType: 'stream',
      timeout: DOWNLOAD_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (e) {
    throw new Error(`请求失败: ${e.message}`);
  }
  if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);

  const declared = parseInt(resp.headers['content-length'] || '0', 10) || 0;
  // 有 Content-Length 用它算进度；没有（chunked）就用列表里的大小，至少能显示百分比
  const totalForPct = declared > 0 ? declared : (expectedSize > 0 ? expectedSize : 0);
  const stream = resp.data;
  let received = 0;
  const startTime = Date.now();

  const timer = setInterval(() => {
    const mb = (received / 1048576).toFixed(1);
    const speed = (received / 1048576 / Math.max((Date.now() - startTime) / 1000, 0.001)).toFixed(1);
    const pct = totalForPct > 0 ? `${Math.round(received / totalForPct * 100)}% ` : '';
    process.stdout.write(`\r   ${name}: ${pct}(${mb} MB, ${speed} MB/s)`);
  }, 1000);

  const writer = fs.createWriteStream(partPath);
  try {
    await new Promise((resolve, reject) => {
      stream.on('data', c => { received += c.length; });
      stream.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      stream.pipe(writer);
    });
  } catch (e) {
    clearInterval(timer);
    process.stdout.write('\n');
    try { writer.destroy(); } catch {}
    drop();
    throw new Error(`传输中断: ${e.message}`);
  }
  clearInterval(timer);
  process.stdout.write('\n');

  // 完整性校验：任一不符都视为失败，删掉半成品让下次重下
  const complete = typeof stream.complete === 'boolean' ? stream.complete : true;
  const fail = msg => { drop(); throw new Error(msg); };

  if (!complete) {
    fail(`连接被提前中断（只收到 ${received} 字节）`);
  }
  if (declared > 0 && received !== declared) {
    fail(`字节数不符：收到 ${received}，响应声明 ${declared}`);
  }
  if (expectedSize > 0 && received !== expectedSize) {
    fail(`大小不符：收到 ${received}，列表声明 ${expectedSize}`);
  }
  if (received === 0) {
    fail('收到 0 字节');
  }

  fs.renameSync(partPath, savePath);
  return received;
}

// 本地已有文件的「同一集 + 季号 + 体积」索引，键形如 `ep_凡人修仙传_E194|S0|3328599654`。
// 为什么需要它：清理重复副本会把云端留下的那份**改回不带序号的名字**，本地那份有意不改名，
// 于是云端的 `X.mkv` 对应本地的 `X (2).mkv` —— 按同名找不到，会被误判成「本地没有」而重下一遍。
// 同一集、同季号、体积完全一致就是同一份内容。
//
// 键用分组键 + **季号**（这是内存索引，不涉及 .downloaded.json 的兼容）：
// - 不带季号会让本地的 S02E07 证明云端的 S01E07 已下载 —— 那是静默漏下，谁也不会发现
// - 用分组键而不是记录键，还能兼容「同一集的不同季集写法」：`第1季-01`、`1x01`、`.第1季.E01`
//   归一后是同一个键，不必因为写法不同就重下一遍
// 点文件与 `.part` 半成品一律跳过：半成品体积可能正好等于声明大小，会把残缺文件判成完整。
// 导出仅为测试用。
export function buildLocalEpisodeIndex(saveDir) {
  const index = new Set();
  let entries;
  try {
    entries = fs.readdirSync(saveDir);
  } catch {
    return index;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name.endsWith('.part')) continue;
    const info = getEpisodeGroup(name);
    if (!info) continue;
    let size = -1;
    try {
      const st = fs.statSync(path.join(saveDir, name));
      if (st.isFile()) size = st.size;
    } catch {}
    if (size >= 0) index.add(`${info.loose}|S${info.season ?? '?'}|${size}`);
  }
  return index;
}

// 仅凭 .downloaded.json 里的记录判断是不够的：记录只说明"曾经下过"，
// 无法证明磁盘上那份是完整的。此前下载被截断却误报成功时，记录已经写下，
// 于是半成品会被永久跳过、永不自愈。这里按列表声明的大小再核对一次，
// 缺失或大小不符都视为需要重新下载。
// localIndex 由 buildLocalEpisodeIndex 预先算好：同名找不到时再按「同一集 + 同体积」找一遍，
// 兼容清理重复副本改过名的情形（改了名不等于没下过）。
// 导出仅为测试用。
export function localCopyIsComplete(saveDir, name, expectedSize, localIndex = null) {
  const sizeOf = n => {
    try {
      const st = fs.statSync(path.join(saveDir, n));
      return st.isFile() ? st.size : -1;
    } catch {
      return -1;
    }
  };

  const exact = sizeOf(name);
  if (exact >= 0 && (!(expectedSize > 0) || exact === expectedSize)) return true;

  // 体积未知（接口没给 size）时不做「同一集」推断：没有体积就没有可核对的凭据
  if (!(expectedSize > 0)) return false;
  // 索引键与 buildLocalEpisodeIndex 必须完全一致：分组键 + 季号 + 体积
  const info = getEpisodeGroup(name);
  if (!info) return false;
  const key = `${info.loose}|S${info.season ?? '?'}|${expectedSize}`;

  if (localIndex) return localIndex.has(key);
  return buildLocalEpisodeIndex(saveDir).has(key);
}

class QuarkClient {
  constructor(cookie) {
    this.base = 'https://drive-pc.quark.cn';
    this.shareBase = 'https://drive.quark.cn';
    this.cookie = cookie;
  }

  headers() {
    return {
      'User-Agent': UA,
      'Origin': 'https://pan.quark.cn',
      'Referer': 'https://pan.quark.cn/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Cookie': this.cookie,
    };
  }

  async _post(url, body) {
    const resp = await axios.post(url, body, { headers: this.headers(), timeout: 30000, validateStatus: () => true });
    const d = resp.data;
    if (resp.status >= 400 || (d && d.status >= 400)) {
      const msg = typeof d === 'string' ? d.substring(0, 500) : JSON.stringify(d).substring(0, 500);
      throw new Error(`API 返回错误 [${resp.status}]: ${msg}`);
    }
    return d;
  }

  async _get(url) {
    const resp = await axios.get(url, { headers: this.headers(), timeout: 30000, validateStatus: () => true });
    const d = resp.data;
    if (resp.status >= 400 || (d && d.status >= 400)) {
      const msg = typeof d === 'string' ? d.substring(0, 500) : JSON.stringify(d).substring(0, 500);
      throw new Error(`API 返回错误 [${resp.status}]: ${msg}`);
    }
    return d;
  }

  async checkLogin() {
    const url = 'https://pan.quark.cn/account/info?fr=pc&platform=pc';
    const data = await this._get(url);
    if (data.data?.nickname) {
      console.log(`   ✓ 已登录: ${data.data.nickname}\n`);
      return data.data.nickname;
    }
    return null;
  }

  async listUserFiles(pdirFid = '0', page = 1, pageSize = 100) {
    const params = `pr=ucpro&fr=pc&uc_param_str=&pdir_fid=${pdirFid}&_page=${page}&_size=${pageSize}&_fetch_total=1&_fetch_sub_dirs=1&_sort=file_type:asc,file_name:asc&__dt=${dt()}&__t=${ts13()}`;
    const url = `${this.base}/1/clouddrive/file/sort?${params}`;
    const data = await this._get(url);
    if (data.status !== 200) {
      throw new Error(`列出网盘文件失败: ${data.message || JSON.stringify(data).substring(0, 200)}`);
    }
    return { list: data.data?.list || [], total: data.metadata?._total || 0 };
  }

  async listAllUserFiles(pdirFid = '0') {
    const result = [];
    let page = 1;
    // 本目录已列出的条目数（含子目录）。不能拿 result.length 去比 total：result 里还含
    // 递归进来的子目录文件，会比 total 先变大而提前 break，把后面的当层文件整页漏掉。
    let seen = 0;
    while (true) {
      const { list, total } = await this.listUserFiles(pdirFid, page);
      seen += list.length;
      for (const f of list) {
        if (!f.dir) result.push(f);
        if (f.dir && f.include_items > 0) {
          const sub = await this.listAllUserFiles(f.fid);
          result.push(...sub);
        }
      }
      if (list.length === 0 || seen >= total) break;
      page++;
    }
    return result;
  }

  // 只列当层的文件（不递归）。清理重复副本时用它：本项目转存进来的文件都在当层，
  // 子文件夹里的东西是用户自己放的，不该被当成「重复副本」删掉。
  async listTopLevelFiles(pdirFid = '0') {
    const result = [];
    let page = 1;
    while (true) {
      const { list } = await this.listUserFiles(pdirFid, page);
      for (const f of list) if (!f.dir) result.push(f);
      if (list.length < 100) break;
      page++;
    }
    return result;
  }

  async findFolderByName(name, pdirFid = '0') {
    let page = 1;
    while (true) {
      const { list } = await this.listUserFiles(pdirFid, page);
      for (const f of list) {
        if (f.dir && f.file_name === name) {
          return f.fid;
        }
      }
      if (list.length < 100) break;
      page++;
    }
    return null;
  }

  async createFolder(name, pdirFid = '0') {
    const url = `${this.base}/1/clouddrive/file?pr=ucpro&fr=pc&uc_param_str=&__dt=${dt()}&__t=${ts13()}`;
    const data = await this._post(url, {
      pdir_fid: pdirFid,
      file_name: name,
      dir_path: '',
      dir_init_lock: false,
    });
    if (data.status !== 200 && data.code !== 0) {
      throw new Error(`创建文件夹失败: ${data.message || JSON.stringify(data).substring(0, 200)}`);
    }
    return data.data?.fid;
  }

  async renameFile(fid, newName) {
    const url = `${this.base}/1/clouddrive/file/rename?pr=ucpro&fr=pc&uc_param_str=&__dt=${dt()}&__t=${ts13()}`;
    const data = await this._post(url, { fid, file_name: newName });
    if (data.status !== 200 && data.code !== 0) {
      throw new Error(`重命名失败: ${data.message || JSON.stringify(data).substring(0, 200)}`);
    }
  }

  async findFilesByName(pdirFid, names) {
    const result = [];
    let page = 1;
    const nameSet = new Set(names);
    while (true) {
      const { list } = await this.listUserFiles(pdirFid, page);
      for (const f of list) {
        if (nameSet.has(f.file_name)) result.push(f);
      }
      if (list.length < 100) break;
      page++;
    }
    return result;
  }

  async resolveTargetDir(config, opts = {}) {
    if (config.targetDirFid && config.targetDirFid !== '0') {
      return config.targetDirFid;
    }
    if (!config.targetDirName) {
      return '0';
    }
    return resolveDirPath(this, config.targetDirName, opts);
  }

  async getDownloadUrls(fids) {
    const url = `${this.base}/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=2.5.56&ut=&guid=&__dt=${dt()}&__t=${ts13()}`;
    for (const ua of [UA, UA_CLIENT]) {
      const hdrs = { ...this.headers(), 'User-Agent': ua };
      const resp = await axios.post(url, { fids }, { headers: hdrs, timeout: 30000, validateStatus: () => true });
      if (resp.data?.code === 23018) continue;
      if (resp.data?.status !== 200 || !resp.data?.data) {
        throw new Error(`获取下载地址失败: ${resp.data?.message || JSON.stringify(resp.data).substring(0, 200)}`);
      }
      return resp.data.data;
    }
    throw new Error('获取下载地址失败: 所有 UA 均被限制');
  }

  async downloadFile(downloadUrl, savePath, expectedSize = 0) {
    return downloadToFile({
      url: downloadUrl,
      headers: { 'User-Agent': UA_CLIENT, 'Cookie': this.cookie, 'Referer': 'https://pan.quark.cn/' },
      savePath,
      expectedSize,
      label: path.basename(savePath),
    });
  }

  async deleteFiles(fids) {
    const url = `${this.base}/1/clouddrive/file/delete?pr=ucpro&fr=pc&uc_param_str=&__dt=${dt()}&__t=${ts13()}`;
    const data = await this._post(url, { action_type: 2, filelist: fids, exclude_fids: [] });
    if (data.status !== 200 && data.code !== 0) {
      throw new Error(`删除失败: ${data.message || JSON.stringify(data).substring(0, 200)}`);
    }
  }

  async downloadFilesParallel(downloadUrls, saveDir, concurrency = 3) {
    const queue = [...downloadUrls];
    const success = [];
    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        const savePath = path.join(saveDir, item.file_name);
        try {
          // 传入列表里声明的文件大小，下载后据此校验是否被截断
          await this.downloadFile(item.download_url, savePath, item.size || 0);
          success.push({ fid: item.fid, file_name: item.file_name, size: item.size });
        } catch (e) {
          log(`   ✗ ${item.file_name} 下载失败: ${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return success;
  }

  async cleanupOldFiles(pdirFid, maxAgeDays) {
    if (!maxAgeDays || maxAgeDays <= 0) return { deleted: 0 };
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const files = await this.listAllUserFiles(pdirFid);
    const oldFiles = files.filter(f => {
      let ts = f.created_at || f.updated_at || 0;
      if (String(ts).length <= 10) ts *= 1000;
      return ts < cutoff;
    });
    if (oldFiles.length === 0) return { deleted: 0 };

    log(`   清理网盘旧文件 (${maxAgeDays}天前): ${oldFiles.length} 个...`);
    const batchSize = 30;
    let deleted = 0;
    for (let i = 0; i < oldFiles.length; i += batchSize) {
      const batch = oldFiles.slice(i, i + batchSize);
      try {
        await this.deleteFiles(batch.map(f => f.fid));
        deleted += batch.length;
        for (const f of batch) {
          log(`   🗑 已删除: ${f.file_name}`);
        }
      } catch (e) {
        log(`   ✗ 删除批次失败: ${e.message}`);
      }
    }
    log(`   ✓ 网盘清理完成: ${deleted} 个\n`);
    return { deleted };
  }

  async downloadAllFromFolder(pdirFid, saveDir, skipExisting = true, deleteAfter = false) {
    log(`   列出目标文件夹中的文件...`);
    let files = await this.listAllUserFiles(pdirFid);
    const rawCount = files.length;
    files = deduplicateByEpisode(files, { onSkip: log });
    if (files.length < rawCount) {
      log(`   ✓ 共 ${rawCount} 个文件 (去重后 ${files.length} 个)\n`);
    } else {
      log(`   ✓ 共 ${files.length} 个文件\n`);
    }

    const downloadedRecord = skipExisting ? loadDownloadedRecord(saveDir) : new Map();
    // 预先算一次：清理重复副本改过名时，靠它按「同一集 + 同体积」认出本地那份
    const localIndex = skipExisting ? buildLocalEpisodeIndex(saveDir) : null;
    let incomplete = 0;
    const toDownload = skipExisting
      ? files.filter(f => {
        if (!downloadedRecord.has(getDedupKey(f))) return true;
        // 有记录也要确认本地那份是完整的，否则重新下载（自愈被截断的半成品）
        if (localCopyIsComplete(saveDir, f.file_name, f.size, localIndex)) return false;
        incomplete++;
        return true;
      })
      : files;
    if (incomplete > 0) {
      log(`   ⚠ 有 ${incomplete} 个文件本地副本缺失或大小不符，将重新下载`);
    }

    if (toDownload.length === 0) {
      log(`   所有文件已下载过，无需下载。`);
      return;
    }

    const skipped = files.length - toDownload.length;
    log(`   待下载: ${toDownload.length} 个 (跳过 ${skipped} 个已下载记录)\n`);

    const batchSize = 10;
    let downloaded = 0;
    const downloadedFids = [];
    const downloadedNames = [];
    for (let i = 0; i < toDownload.length; i += batchSize) {
      const batch = toDownload.slice(i, i + batchSize);
      const fids = batch.map(f => f.fid);
      const range = `${i + 1}-${Math.min(i + batchSize, toDownload.length)}`;
      let urls;
      try {
        urls = await this.getDownloadUrls(fids);
      } catch (e) {
        log(`   ✗ 获取下载地址失败 (${range}): ${e.message}`);
        continue;
      }
      const success = await this.downloadFilesParallel(urls, saveDir, 3);
      downloaded += success.length;
      downloadedFids.push(...success.map(s => s.fid));
      downloadedNames.push(...success.map(s => s.file_name));
      if (skipExisting) {
        for (const s of success) {
          downloadedRecord.set(getDedupKey(s), true);
        }
        saveDownloadedRecord(saveDir, downloadedRecord);
      }
    }
    log(`\n   下载完成: ${downloaded}/${toDownload.length} 个`);
    if (downloadedNames.length > 0) {
      log('   已下载的文件列表:');
      for (const name of downloadedNames) log(`     ✓ ${name}`);
    }

    if (deleteAfter && downloadedFids.length > 0) {
      log(`   从网盘中删除已下载的 ${downloadedFids.length} 个文件...`);
      const delBatchSize = 30;
      for (let i = 0; i < downloadedFids.length; i += delBatchSize) {
        const batch = downloadedFids.slice(i, i + delBatchSize);
        try {
          await this.deleteFiles(batch);
        } catch (e) {
          log(`   ✗ 删除批次失败: ${e.message}`);
        }
      }
      log(`   ✓ 删除完成`);
    }
    log('');
  }

  async getShareToken(pwdId, passcode = '') {
    const url = `${this.base}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=&__dt=${dt()}&__t=${ts13()}`;
    const data = await this._post(url, { pwd_id: pwdId, passcode: passcode || '' });
    if (data.status !== 200 || !data.data?.stoken) {
      throw new Error(`获取分享 token 失败: ${data.message || JSON.stringify(data).substring(0, 200)}`);
    }
    return data.data.stoken;
  }

  async listShareFiles(pwdId, stoken, pdirFid = '0', page = 1, pageSize = 50) {
    const params = `pr=ucpro&fr=pc&uc_param_str=&pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=${pdirFid}&force=0&_page=${page}&_size=${pageSize}&_sort=file_type:asc%2Cupdated_at:desc&__dt=${dt()}&__t=${ts13()}`;
    const url = `${this.base}/1/clouddrive/share/sharepage/detail?${params}`;
    const data = await this._get(url);
    if (data.status !== 200) {
      throw new Error(`列出文件失败: ${data.message || JSON.stringify(data).substring(0, 200)}`);
    }
    const list = data.data?.list || [];
    const total = data.metadata?._total || 0;
    return { list, total };
  }

  async listAllShareFiles(pwdId, stoken, pdirFid = '0') {
    const allFiles = [];
    let page = 1;
    const pageSize = 100;
    let collectedThisDir = 0;
    let totalThisDir = 0;

    while (true) {
      const { list, total } = await this.listShareFiles(pwdId, stoken, pdirFid, page, pageSize);
      if (page === 1) totalThisDir = total;

      for (const file of list) {
        allFiles.push(file);
        collectedThisDir++;
        if (file.dir && file.include_items > 0) {
          const subFiles = await this.listAllShareFiles(pwdId, stoken, file.fid);
          allFiles.push(...subFiles);
        }
      }

      if (collectedThisDir >= totalThisDir || list.length < pageSize) break;
      page++;
    }
    return allFiles;
  }

  async saveFiles(pwdId, stoken, fidTokenPairs, toPdirFid = '0') {
    const fidList = fidTokenPairs.map(p => p.fid);
    const fidTokenList = fidTokenPairs.map(p => p.share_fid_token);
    const url = `${this.base}/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc&uc_param_str=&__dt=${dt()}&__t=${ts13()}`;
    const data = await this._post(url, {
      fid_list: fidList,
      fid_token_list: fidTokenList,
      to_pdir_fid: toPdirFid,
      pwd_id: pwdId,
      stoken: stoken,
      pdir_fid: '0',
      scene: 'link',
    });
    if (data.status !== 200) {
      throw new Error(`转存请求失败: ${data.message || JSON.stringify(data).substring(0, 200)}`);
    }
    return data.data?.task_id;
  }

  async pollTask(taskId, interval = 1000, timeout = 120000) {
    const start = Date.now();
    for (let i = 0; Date.now() - start < timeout; i++) {
      const url = `${this.base}/1/clouddrive/task?pr=ucpro&fr=pc&uc_param_str=&task_id=${taskId}&retry_index=${i}&__dt=${dt()}&__t=${ts13()}`;
      const data = await this._get(url);
      if (data.data?.status === 2) return true;
      if (data.data?.status === 3) return false;
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error('任务超时');
  }

  async saveFilesInBatches(pwdId, stoken, files, toPdirFid = '0', pollInterval = 1000) {
    const batchSize = 20;
    const results = { success: [], failed: [] };
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      console.log(`  转存批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(files.length / batchSize)} (${batch.length} 个文件)...`);
      try {
        const taskId = await this.saveFiles(pwdId, stoken, batch, toPdirFid);
        const ok = await this.pollTask(taskId, pollInterval);
        if (ok) {
          for (const f of batch) results.success.push(f.file_name);
        } else {
          for (const f of batch) results.failed.push(f.file_name);
        }
      } catch (e) {
        console.error(`  批次失败: ${e.message}`);
        for (const f of batch) results.failed.push(f.file_name);
      }
    }
    return results;
  }
}

// 逐级解析（必要时创建）目标文件夹，返回最终 fid。
//
// 只依赖 client 提供 findFolderByName / createFolder，因此不绑定 QuarkClient，
// 便于单元测试（不触网）。dryRun 为真时只查找、不创建：某级不存在就返回 null，
// 表示「正式运行时会创建」，调用方据此跳过与已存在文件的比对。
//
// 多级路径（如 "转存/来自：分享"）按 / 拆分后逐级查找，每级都以上一级的 fid 作为
// 父目录，因此只支持「从根目录往下」的相对层级；空段（开头、结尾或重复的 /）一律
// 忽略，"." 与 ".." 没有特殊含义，按普通名字处理。
export async function resolveDirPath(client, dirName, { dryRun = false } = {}) {
  const segments = String(dirName).split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) {
    return '0';
  }

  // 试运行不打印解析过程（只输出最后的文件清单），因此这里的三处进度一律加 dryRun 判断
  if (!dryRun) console.log(`   查找目标文件夹: "${dirName}"...`);
  let pdirFid = '0';
  for (const name of segments) {
    let fid = await client.findFolderByName(name, pdirFid);
    if (fid) {
      if (!dryRun) console.log(`   ✓ ${name} 已存在，fid: ${fid}`);
    } else if (dryRun) {
      // 目录尚不存在：返回 null 表示「正式运行时会创建」，调用方据此跳过比对
      return null;
    } else {
      console.log(`   ${name} 不存在，正在创建...`);
      fid = await client.createFolder(name, pdirFid);
      // 拿不到 fid 必须中断：否则下一级会以 undefined 作为父目录，
      // 服务端可能把它当作根目录，于是余下的层级被静默建到错误位置
      if (!fid) {
        throw new Error(`创建目标文件夹失败: ${name}（接口未返回 fid）`);
      }
      console.log(`   ✓ ${name} 已创建，fid: ${fid}`);
    }
    pdirFid = fid;
  }
  if (!dryRun) console.log('');
  return pdirFid;
}

// 时长单位（换算为小时）。注意 m = 分钟、mo = 月，两者含义不同：
// 按常见时长写法惯例，m 作分钟解释，月份用 mo 以免与分钟混淆。
const DURATION_UNITS = {
  m: 1 / 60,      // 分钟
  min: 1 / 60,
  h: 1,           // 小时
  hr: 1,
  d: 1 * 24,      // 天
  w: 7 * 24,      // 周
  mo: 30 * 24,    // 月（按 30 天计）
  y: 365 * 24,    // 年（按 365 天计）
};

// 校验时长写法是否合法（供配置校验使用，与 parseDurationHours 保持同一套规则）
export function isValidDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (typeof value !== 'string') return false;
  const s = value.trim().toLowerCase();
  if (s === '') return false;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) >= 0;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mo|min|m|h|hr|d|w|y)$/);
  if (!m) return false;
  return Number(m[1]) >= 0;
}

// 把时间窗口写法换算为小时数。
// 支持：纯数字（按小时，兼容旧配置）、单位写法（1h / 1d / 1w / 1mo / 1y / 30m）、
// 以及小数（1.5d、0.5w）。无法解析时返回 fallback。
export function parseDurationHours(value, fallback = 48) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  if (typeof value !== 'string') return fallback;

  const s = value.trim().toLowerCase();
  if (s === '') return fallback;

  // 纯数字：按小时（保持与旧配置兼容）
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  // 数字 + 单位；单位按长度优先匹配，避免 mo 被 m 抢先
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mo|min|m|h|hr|d|w|y)$/);
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2];
  const factor = DURATION_UNITS[unit];
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(factor)) return fallback;
  return n * factor;
}

// 人类可读的时长描述，用于日志（把小时数还原成易读形式）
export function formatHours(hours) {
  if (!Number.isFinite(hours)) return String(hours);
  if (hours === 0) return '0 小时';
  if (hours % (365 * 24) === 0) return `${hours / (365 * 24)} 年`;
  if (hours % (30 * 24) === 0) return `${hours / (30 * 24)} 个月`;
  if (hours % (7 * 24) === 0) return `${hours / (7 * 24)} 周`;
  if (hours % 24 === 0) return `${hours / 24} 天`;
  if (hours < 1) return `${Math.round(hours * 60)} 分钟`;
  return `${Number(hours.toFixed(2))} 小时`;
}

// 解决全局时间窗口：hours 优先，其次历史字段 days（按天），否则默认 48 小时。
// hours 支持单位写法；days 是旧配置里的纯数值（单位: 天）。
// 注意 days 沿用旧实现的三元判断语义（falsy 即视为未配置），因此 days:0
// 会回退到默认 48 小时 —— 这样既保持向后兼容，也避免误配成「0 天窗口」
// 导致什么都转存不了。
export function resolveWindowHours(config) {
  if (config.hours !== undefined && config.hours !== null && config.hours !== '') {
    return parseDurationHours(config.hours, 48);
  }
  if (config.days) {
    const n = Number(config.days);
    if (Number.isFinite(n) && n > 0) return n * 24;
  }
  return 48;
}

export function filterByHours(files, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return files.filter(f => {
    if (f.dir) return false;
    let ts = f.updated_at;
    if (String(ts).length <= 10) ts *= 1000;
    return ts >= cutoff;
  });
}

// 在扩展名前插入 " (n)"：a.mp4 -> a (2).mp4；无扩展名（含 .gitignore 这类）则直接追加
export function withNumericSuffix(name, n) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

// 前缀的规范化写法：tip 以 '-' 结尾就原样用，否则补一个 '-'。
// applyNamePrefix 与试运行预览共用同一份规则，避免两处漂移导致预览的名字与
// 实际转存后的名字对不上。
export function normalizePrefix(tip) {
  if (!tip) return '';
  return tip.endsWith('-') ? tip : `${tip}-`;
}

// 改名重试：夸克的改名接口偶发 `404 / code 14014 "illegal text"` 这类瞬时错误 ——
// 转存任务刚报完成时，文件在改名接口那侧可能还没就绪（线上真的遇到过，一次失败就永久没前缀）。
// 退避重试仍失败，再按 fid 复核一次：那个 fid 的文件名已经变成目标名，说明其实改成功了
// （接口回了假错误），按成功处理 —— 不能去报一个并不存在的失败。
// targetDirFid 只用于复核；复核失败（网络抖动）按失败处理，下次同步还能看到未加前缀的文件。
async function renameFileWithRetry(client, fid, target, { retries, delays, say, targetDirFid }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await client.renameFile(fid, target);
      return { ok: true };
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        const wait = delays[attempt] ?? delays[delays.length - 1] ?? 1000;
        say(`   ⚠ 改名失败（第 ${attempt + 1}/${retries + 1} 次），${Math.round(wait / 1000)} 秒后重试: ${e.message}`);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  try {
    const files = await client.listAllUserFiles(targetDirFid);
    const now = files.find(f => f.fid === fid);
    if (now && now.file_name === target) return { ok: true, verified: true };
  } catch {}
  return { ok: false, error: lastError };
}

// 给刚转存的文件加上文件名前缀，返回实际使用的文件名数组（顺序与 names 一致）。导出仅为测试用。
//
// 关于重名：若「前缀 + 原名」已被占用，不能简单跳过——那会留下一个没有前缀的
// 文件，既破坏前缀约定，用户也难以分辨哪份是本次转存的。能走到这一步说明转存前
// 的去重（按「名称|大小」比对）没有命中，即已有的那个是同名但大小不同的另一份
// 内容，不能丢弃。因此改为换用唯一名称（" (2)"、" (3)" …），既保住前缀又保留两份。
export async function applyNamePrefix(client, targetDirFid, names, shareTip, opts = {}) {
  const out = [...names];
  if (!shareTip || names.length === 0) return out;

  const settleMs = opts.settleMs ?? 2000;
  const retryMs = opts.retryMs ?? 1000;
  const maxSuffix = opts.maxSuffix ?? 999;
  const renameRetries = opts.renameRetries ?? 2;
  const renameRetryDelays = opts.renameRetryDelays ?? [1000, 3000];
  // 日志可注入：单测传空实现，就不会把测试输出写进真实的 sync.log
  const say = opts.log ?? log;
  const sayError = opts.logError ?? logError;

  say('\n   等待文件处理完成...');
  await new Promise(r => setTimeout(r, settleMs));

  say('   添加文件名前缀...');
  const prefix = normalizePrefix(shareTip);

  let existingFiles = await client.listAllUserFiles(targetDirFid);
  const taken = new Set(existingFiles.map(f => f.file_name));
  let renamed = 0;
  let collided = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];

    // 分享里的文件可能本身就带这个前缀（例如 tip 与剧集名相同），
    // 此时不再叠加，否则会得到「遮天-遮天-01.mp4」这种名字
    if (name.startsWith(prefix)) {
      say(`   ⏭ ${name}（已带前缀，跳过）`);
      continue;
    }

    const wanted = `${prefix}${name}`;

    // 目标名被占用时挑一个未被占用的序号名。
    // 若可用序号全部用尽则放弃本次重命名 —— 宁可不加前缀，
    // 也绝不能改名到一个已存在的文件上（可能覆盖别人的文件）。
    let target = wanted;
    if (taken.has(target)) {
      target = '';
      for (let n = 2; n <= maxSuffix; n++) {
        const cand = withNumericSuffix(wanted, n);
        if (!taken.has(cand)) { target = cand; break; }
      }
      if (!target) {
        say(`   ✗ ${wanted} 已被占用，且 2..${maxSuffix} 的序号名也都已被占用，跳过重命名`);
        continue;
      }
    }

    let match = existingFiles.find(f => f.file_name === name);
    if (!match) {
      say(`   重试查找 ${name}...`);
      await new Promise(r => setTimeout(r, retryMs));
      existingFiles = await client.listAllUserFiles(targetDirFid);
      for (const f of existingFiles) taken.add(f.file_name);
      match = existingFiles.find(f => f.file_name === name);
    }
    if (!match) {
      say(`   ✗ ${name} 仍未找到，跳过重命名`);
      continue;
    }

    const r = await renameFileWithRetry(client, match.fid, target, {
      retries: renameRetries, delays: renameRetryDelays, say, targetDirFid,
    });
    if (!r.ok) {
      // 目标名与 fid 都写进日志：否则事后只看到「重命名失败」，无法判断是名字问题还是瞬时问题
      sayError(`   ✗ ${name} 重命名失败（目标名: ${target}，fid: ${match.fid}）: ${r.error.message}`);
      continue;
    }
    renamed++;
    taken.add(target);
    out[i] = target;
    const suffixNote = target === wanted ? '' : `（${wanted} 已存在，加序号避免覆盖）`;
    if (target !== wanted) collided++;
    if (r.verified) {
      say(`   ✓ ${name} → ${target}（接口报了错，复核后确认已经改好）${suffixNote}`);
    } else {
      say(`   ✓ ${name} → ${target}${suffixNote}`);
    }
  }

  if (renamed > 0) say(`   已重命名 ${renamed} 个文件\n`);
  if (collided > 0) say(`   提示: 其中 ${collided} 个因重名改用带序号的文件名，两份都已保留\n`);
  return out;
}

// 统一的「文件 + 更新时间」行：正式运行逐条打印，试运行先收集、最后一次性打印。
// opts.prefix 是该分享的影视名称：列出的就是加前缀之后的最终文件名，与正式运行结束时
// 「成功转存的文件」一致。分享里本就带前缀的文件不会被叠加（同 applyNamePrefix 的判断）。
export function buildFileLines(files, { prefix = '' } = {}) {
  const p = normalizePrefix(prefix);
  return files.map(f => {
    const date = new Date(String(f.updated_at).length <= 10 ? f.updated_at * 1000 : f.updated_at);
    const name = p && !String(f.file_name).startsWith(p) ? `${p}${f.file_name}` : f.file_name;
    return `  - ${name}  (更新于: ${date.toLocaleString('zh-CN')})`;
  });
}

// 统一同步实现：CLI(sync 模式) 与 cron/网页触发共用同一份逻辑
async function syncInternal(config, opts = {}) {
  const { dryRun = false } = opts;
  // 试运行只回答「会转存哪些文件」：整个流程静音进度日志，只保留 logError 与函数末尾那份清单。
  // 这里自我包裹一次即可（第二遍进来时 store 已存在，不会递归）；
  // opts 原样透传，避免以后新增选项在这里被静默丢掉。
  if (dryRun && !quietLog.getStore()) {
    return quietLog.run(true, () => syncInternal(config, opts));
  }

  if (!config.cookie || config.cookie === '从浏览器复制的完整 Cookie 字符串') {
    throw new Error('请在 config.json 中填写有效的 Cookie');
  }

  const shareUrls = normalizeShareUrls(config);
  if (shareUrls.length === 0) {
    throw new Error('请在 config.json 中填写 shareUrl 或 shareUrls');
  }

  // 时间窗口支持 1h / 1d / 1w / 1mo / 1y / 30m 等单位写法（纯数字按小时，兼容旧配置）。
  // days 为历史字段（数值按天计），仅在没有 hours 时生效。
  const hours = resolveWindowHours(config);
  if (config.hours !== undefined && config.hours !== null && config.hours !== ''
      && !isValidDuration(config.hours)) {
    logError(`   ⚠ hours 取值无法识别: ${JSON.stringify(config.hours)}，已回退为 48 小时`
      + '（支持写法: 24、1h、1d、1w、1mo、1y、30m）');
  }
  const pollInterval = config.pollInterval || 1000;

  const client = new QuarkClient(config.cookie);

  log('0. 验证登录状态...');
  const nickname = await client.checkLogin();
  if (!nickname) {
    throw new Error('Cookie 无效或已过期！请重新从浏览器获取 Cookie');
  }

  log('1. 确定保存目标文件夹...');
  // 试运行时只查找、不创建：目录尚不存在会返回 null，表示正式运行时会创建它
  const targetDirFid = await client.resolveTargetDir(config, { dryRun });

  let totalSuccess = 0;
  let totalFailed = 0;
  const allSuccess = [];
  const allFailed = [];
  // 试运行模式下累计「本会转存多少文件」，并收集清单，用于最后统一输出
  let dryRunWouldTransfer = 0;
  const dryRunEntries = [];
  // 任务期间判定为已失效的分享 ID，用于按需清理配置
  const deadPwdIds = new Set();
  let prunedUrls = null;

  for (let si = 0; si < shareUrls.length; si++) {
    const { url, password, tip, hours: itemHours, minFileSizeMB: itemMinSizeMB, maxFilesPerShare: itemMaxFiles } = shareUrls[si];
    const shareTip = tip || config.tip;
    // 每项分享也可单独覆盖时间窗口，同样支持单位写法
    let shareHours = hours;
    if (itemHours !== undefined && itemHours !== null && itemHours !== '') {
      shareHours = parseDurationHours(itemHours, hours);
      if (!isValidDuration(itemHours)) {
        logError(`   ⚠ 第 ${si + 1} 个分享的 hours 无法识别: ${JSON.stringify(itemHours)}，`
          + `已回退为 ${formatHours(hours)}`);
      }
    }
    // 跳过空链接条目（可能是上次清理后留下的占位），并解析失败的链接，
    // 二者都不应中断整个循环
    const rawIds = Array.isArray(url) ? url : (url ? [url] : []);
    const pwdIds = [];
    for (const u of rawIds) {
      try {
        pwdIds.push(parseShareUrl(u));
      } catch {
        logError(`   ⚠ 无法解析链接，已跳过: ${String(u).slice(0, 60)}`);
      }
    }
    if (pwdIds.length === 0) {
      logError(`   ⚠ 第 ${si + 1} 个分享没有可用链接，已跳过`);
      continue;
    }
    const passcode = password || config.password || '';

    if (shareUrls.length > 1) {
      log(`\n${LOG_RULE}`);
      log(`处理第 ${si + 1}/${shareUrls.length} 个分享`);
      log(`分享 ID: ${pwdIds.join(', ')}${shareTip ? `  (前缀: ${shareTip})` : ''}`);
    } else {
      log(`分享 ID: ${pwdIds.join(', ')}${shareTip ? `  (前缀: ${shareTip})` : ''}`);
    }
    log(`时间范围: 最近 ${formatHours(shareHours)}更新\n`);

    try {
      log('2. 获取分享 token...');
      const best = await tryShareUrls(client, pwdIds, passcode, shareTip, deadPwdIds);
      if (!best) {
        logError(`   ✗ 处理分享失败 ${shareTip ? `(${shareTip}) ` : ''}- 所有链接均已失效`);
        totalFailed++;
        continue;
      }
      const { stoken, allFiles, pwdId } = best;
      log('   ✓ 获取成功\n');

      log('3. 列出分享文件 (递归获取所有子文件夹)...');
      log(`   ✓ 共找到 ${allFiles.length} 个项目 (含文件夹)\n`);

      const filesOnly = allFiles.filter(f => !f.dir);
      log(`   其中文件: ${filesOnly.length} 个`);

      // 日志顺序必须与处理顺序一致：先时间窗口、再体积过滤。
      // 若反过来，会出现「其中文件 12 个」紧跟「过滤 <100MB: 剩余 0 个」，
      // 让人误以为是体积过滤把文件全拦掉了，实际是时间窗口内本就没有文件。
      const recentFiles = filterByHours(allFiles, shareHours);
      log(`   时间窗口内 (最近 ${formatHours(shareHours)}): ${recentFiles.length} 个`);

      const minSizeMB = itemMinSizeMB ?? config.minFileSizeMB ?? 0;
      let largeFiles = recentFiles;
      if (minSizeMB > 0) {
        // size 缺失或为 0 的文件会被判为过小而被排除，单独统计以便察觉接口未返回 size
        const unknownSize = recentFiles.filter(f => !f.size).length;
        largeFiles = recentFiles.filter(f => (f.size || 0) >= minSizeMB * 1048576);
        log(`   过滤 <${minSizeMB}MB 后剩余: ${largeFiles.length} 个`
          + (unknownSize > 0 ? `（其中 ${unknownSize} 个大小未知，已按 0 排除）` : ''));
      }

      // 分享里同一集有多个版本时只留画质最好的那份（4K 优先；同画质取体积大的）。
      // 下载侧一直这么做（README 也是这么写的），但转存侧此前漏了 —— 一次同步就会把
      // 同一集的 4K 与 1080p 双双转进网盘，先造成重复，之后每轮还要靠去重兜着。
      largeFiles = deduplicateByEpisode(largeFiles, { onSkip: log });

      const maxPerShare = itemMaxFiles ?? config.maxFilesPerShare ?? 0;
      if (maxPerShare > 0 && largeFiles.length > maxPerShare) {
        largeFiles = [...largeFiles].sort(sortByEpisode).slice(0, maxPerShare);
        log(`   限制每分享最多 ${maxPerShare} 个（按集数取最新）`);
      }
      log(`   → 候选文件: ${largeFiles.length} 个\n`);

      if (largeFiles.length === 0) {
        // 指明是哪一步筛空的，避免只看到"没有符合条件"却不知原因
        const why = recentFiles.length === 0
          ? `该分享内没有最近 ${formatHours(shareHours)}内更新的文件`
          : `时间窗口内的 ${recentFiles.length} 个文件都小于 ${minSizeMB}MB`;
        log(`没有找到符合条件的文件（${why}），无需转存。`);
        continue;
      }

      log('   检查目标文件夹中已存在的文件...');
      // 试运行且目标文件夹尚不存在时无从比对，视为空目录（正式运行时它会是新建的空目录）
      const existingFiles = targetDirFid ? await client.listAllUserFiles(targetDirFid) : [];
      const existingMap = new Map(existingFiles.map(f => [`${f.file_name}|${f.size || ''}`, true]));
      // 「同一集是否已经转过」的索引：只看文件名，不看体积。
      // 只按「名称|大小」比对时，上游重新压制/重传（体积差几 MB）或已被加过序号副本的文件
      // 都会判成「新文件」，于是每跑一次同步就多出 (2)(3)(4)... 一份，永远停不下来。
      const episodeIndex = buildEpisodeIndex(existingFiles);
      const dedupEpisodes = config.dedupEpisodesInTarget !== false;
      const sharePrefix = shareTip ? normalizePrefix(shareTip) : '';
      const newFiles = largeFiles.filter(f => {
        const key = `${f.file_name}|${f.size || ''}`;
        if (existingMap.has(key)) return false;
        if (sharePrefix && existingMap.has(`${sharePrefix}${f.file_name}|${f.size || ''}`)) return false;
        // 最终文件名（加前缀后的那份）与目标文件夹比对：集数相同就不再转存，
        // 不论体积是否一致、也不论现存那份是不是带序号的副本
        if (dedupEpisodes) {
          const finalName = sharePrefix && !String(f.file_name).startsWith(sharePrefix)
            ? `${sharePrefix}${f.file_name}`
            : f.file_name;
          if (indexHasSameEpisode(episodeIndex, finalName)) {
            log(`   ⏭ 同名集已存在: ${finalName}`);
            return false;
          }
        }
        return true;
      });
      // 基数必须是「候选文件」：早先按 recentFiles 算，会把体积过滤掉的文件也算成「已存在」
      const skipped = largeFiles.length - newFiles.length;
      if (skipped > 0) {
        log(`   ⏭ 跳过 ${skipped} 个已存在的文件`);
      }
      log(`   → 需要转存: ${newFiles.length} 个\n`);

      if (newFiles.length === 0) {
        log('所有文件已存在，无需转存。');
        continue;
      }

      // 试运行：不在这里打印（进度已静音），改为收集起来，函数末尾一次性输出
      // 前缀一并传进去：清单里给的是加完前缀的最终文件名，而不是分享里的原始名
      if (dryRun) {
        dryRunWouldTransfer += newFiles.length;
        dryRunEntries.push({
          label: shareTip || pwdIds[0] || `第 ${si + 1} 个分享`,
          lines: buildFileLines(newFiles, { prefix: shareTip }),
        });
        continue;
      }

      log('待转存文件列表:');
      for (const line of buildFileLines(newFiles, { prefix: shareTip })) log(line);
      log('');

      log('4. 开始转存文件到自己的网盘...');
      const results = await client.saveFilesInBatches(pwdId, stoken, newFiles, targetDirFid, pollInterval);
      log('');

      log('=== 本分享转存结果 ===');
      log(`成功: ${results.success.length} 个`);
      log(`失败: ${results.failed.length} 个`);

      if (results.failed.length > 0) {
        log('失败的文件:');
        for (const name of results.failed) log(`  ✗ ${name}`);
      }
      if (results.success.length > 0) {
        log('成功转存的文件:');
        for (const name of results.success) log(`  ✓ ${name}`);
      }

      const renamedNames = await applyNamePrefix(client, targetDirFid, results.success, shareTip);

      totalSuccess += results.success.length;
      totalFailed += results.failed.length;
      allSuccess.push(...renamedNames);
      allFailed.push(...results.failed);
    } catch (e) {
      logError(`   ✗ 处理分享失败 ${shareTip ? `(${shareTip}) ` : ''}- ${e.message}`);
      totalFailed++;
      continue;
    }
  }

  // 试运行到此为止：上面全程静音，这里只输出「会转存哪些文件」这一件事（错误日志照常输出）。
  // 整块用分隔线围起来：紧挨着的都是其它时间点的日志（手动触发、任务完成等），
  // 不隔开就分不清清单从哪开始、到哪结束。
  if (dryRun) {
    logAlways(LOG_RULE);
    logAlways('待转存文件列表:');
    if (dryRunEntries.length === 0) {
      logAlways('  （没有需要转存的文件）');
    } else if (dryRunEntries.length === 1) {
      // 只有一个分享：直接平铺清单（文件名已带上该分享的影视名称），最简洁
      for (const line of dryRunEntries[0].lines) logAlways(line);
    } else {
      // 多个分享时按分享分组：某个分享没设影视名称时，靠分组才知道文件来自哪
      for (const entry of dryRunEntries) {
        logAlways(`[${entry.label}]`);
        for (const line of entry.lines) logAlways(line);
      }
    }
    logAlways('');
    logAlways(`共 ${dryRunWouldTransfer} 个文件会被转存（试运行，未做任何写入）`);
    logAlways(LOG_RULE);
    return {
      dryRun: true, wouldTransfer: dryRunWouldTransfer,
      totalSuccess: 0, totalFailed: 0, allSuccess: [], allFailed: [],
      deadPwdIds: [...deadPwdIds], prunedUrls: null,
    };
  }

  if (shareUrls.length > 1) {
    log(`\n${LOG_RULE}`);
    log('=== 全部转存结果汇总 ===');
    log(`共处理 ${shareUrls.length} 个分享，成功: ${totalSuccess} 个，失败: ${totalFailed} 个`);
    if (allSuccess.length > 0) {
      log('\n成功转存的文件列表:');
      for (const name of allSuccess) log(`  ✓ ${name}`);
    }
    if (allFailed.length > 0) {
      log('\n失败的文件列表:');
      for (const name of allFailed) log(`  ✗ ${name}`);
    }
  } else {
    log(`\n   同步完成: 成功 ${totalSuccess} 失败 ${totalFailed}`);
    if (allSuccess.length > 0) {
      log('   成功转存的文件:');
      for (const name of allSuccess) log(`     ✓ ${name}`);
    }
    if (allFailed.length > 0) {
      log('   失败的文件:');
      for (const name of allFailed) log(`     ✗ ${name}`);
    }
  }

  // 自动清理失效链接：仅在显式开启 pruneDeadShares 时写回配置，
  // 且只处理明确判定为「已失效」的链接（临时故障一律保留）
  if (deadPwdIds.size > 0) {
    log(`\n发现 ${deadPwdIds.size} 个已失效的分享链接: ${[...deadPwdIds].join(', ')}`);
  }

  if (deadPwdIds.size > 0 && config.pruneDeadShares === true) {
    const original = normalizeShareUrls({ ...config, shareUrls: config.shareUrls });
    const { shareUrls: pruned, removed } = pruneDeadUrls(original, deadPwdIds);
    if (removed.length > 0) {
      const next = { ...config, shareUrls: pruned };
      delete next.shareUrl;
      try {
        const saved = saveConfig(next);
        log(`   ✓ 已从配置中清理 ${removed.length} 条失效链接`);
        for (const r of removed) log(`     🗑 ${r.url}${r.tip ? ` (${r.tip})` : ''}`);
        log(`     配置已写入: ${saved.path}`);
        prunedUrls = pruned;
      } catch (e) {
        logError(`   ✗ 清理失效链接失败（配置未改动）: ${e.message}`);
      }
    }
  } else if (deadPwdIds.size > 0) {
    log('   （未开启 pruneDeadShares，仅报告不修改配置）');
  }

  if (config.cleanupAfterDays && config.cleanupAfterDays > 0) {
    log(`\n执行清理 (${config.cleanupAfterDays}天前的文件)...`);
    const cloudResult = await client.cleanupOldFiles(targetDirFid, config.cleanupAfterDays);
    const localResult = cleanupLocalFiles(path.resolve(config.downloadDir || '.'), config.cleanupAfterDays);
    // 无论有没有删除都要给出结论：否则只剩一行标题，
    // 无法区分「跑过了但没东西可删」和「中途失败/被跳过」
    if (cloudResult.deleted === 0) log('   网盘: 没有超过保留期的文件');
    log(`   本地: 删除 ${localResult.deleted} 个，保留 ${localResult.skipped} 个\n`);
  }

  return { totalSuccess, totalFailed, allSuccess, allFailed, deadPwdIds: [...deadPwdIds], prunedUrls };
}

// CLI 入口：保持原有日志与退出语义
async function syncMode(dryRun = false) {
  log(dryRun ? '=== 夸克网盘自动同步工具（试运行） ===\n' : '=== 夸克网盘自动同步工具 ===\n');
  const config = loadConfigOrExit();
  await withTaskLock('sync', () => syncInternal(config, { dryRun }));
}

// cron / 网页触发入口：每次执行前重新读取配置（支持热更新）
export async function runSync(config, opts) {
  return withTaskLock('sync', () => syncInternal(config ?? loadConfig(), opts));
}

// 同步 + AList 下载串联执行（供 downloadAfterSync 开启时的定时任务使用）。
//
// 为什么不沿用「syncCron 11:00 / alistCron 11:05」这种错开写法：
// sync 与 alist 用的是两把不同的任务锁，二者可以并发，错开几分钟只是靠猜
// 「同步要跑多久」——同步一旦超过这个间隔，AList 就会在同步还没结束时去列目录，
// 可能漏文件或拿到还没转存完的内容。串联执行是等同步真正跑完再开始下载，
// 不依赖任何时间猜测。
//
// 整个过程同时持有 sync 与 alist 两把锁，因此期间定时的独立 alist 任务、
// 或网页手动触发都不会插进来并发执行。
export async function runSyncThenDownload(config) {
  const cfg = config ?? loadConfig();
  return withTaskLock('sync', () => withTaskLock('alist', async () => {
    const syncResult = await syncInternal(cfg);

    if (!cfg.alistUrl) {
      logError('   ⚠ 已开启 downloadAfterSync 但未配置 alistUrl，跳过同步后的下载');
      return syncResult;
    }
    try {
      await alistInternal(cfg);
    } catch (e) {
      // 同步本身已经成功，下载失败不应让整个同步任务算作失败
      logError(`   ✗ 同步后的 AList 下载失败: ${e.message}`);
    }
    return syncResult;
  }));
}

async function downloadMode(forceDownload = false) {
  const config = loadConfig();
  const client = new QuarkClient(config.cookie);
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  acquireLock('.download.lock', saveDir);

  log('=== 夸克网盘下载到本地 ===\n');

  log('0. 验证登录状态...');
  const nickname = await client.checkLogin();
  if (!nickname) {
    logError('   ✗ Cookie 无效或已过期！');
    process.exit(1);
  }

  log('1. 确定目标文件夹...');
  const targetDirFid = await client.resolveTargetDir(config);
  log(`   保存到: ${saveDir}\n`);

  log('2. 开始下载...');
  const skipExisting = !forceDownload;
  await client.downloadAllFromFolder(targetDirFid, saveDir, skipExisting, config.deleteAfterDownload);

  if (config.cleanupAfterDays && config.cleanupAfterDays > 0) {
    log(`\n执行清理 (${config.cleanupAfterDays}天前的文件)...`);
    const localResult = cleanupLocalFiles(saveDir, config.cleanupAfterDays);
    log(`   本地: 删除 ${localResult.deleted} 个，保留 ${localResult.skipped} 个\n`);
  }
}

class AlistClient {
  constructor(baseUrl, token = '', refresh = false) {
    this.base = baseUrl.replace(/\/$/, '');
    this.token = token;
    this._wantRefresh = refresh;
    this._refreshOk = true;
  }

  async _post(path, body = {}) {
    const url = `${this.base}/api/${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = this.token;
    const resp = await axios.post(url, body, { headers, timeout: 30000, validateStatus: () => true });
    const d = resp.data;
    if (d.code === 403 && body.refresh && this._refreshOk) {
      log('   ⚠ 无权限刷新缓存，后续请求将使用缓存数据');
      this._refreshOk = false;
      delete body.refresh;
      return this._post(path, body);
    }
    if (d.code !== 200) {
      throw new Error(`AList API [${d.code}]: ${d.message || JSON.stringify(d)}`);
    }
    return d.data;
  }

  async listDir(dirPath, page = 1, perPage = 0) {
    return this._post('fs/list', { path: dirPath, password: '', page, per_page: perPage, refresh: this._refreshOk && this._wantRefresh });
  }

  async listAllFiles(dirPath) {
    const data = await this.listDir(dirPath);
    const content = Array.isArray(data.content) ? data.content : [];
    if (!Array.isArray(data.content)) {
      log(`   ⚠ AList 路径 "${dirPath}" 返回异常: ${JSON.stringify(data).substring(0, 200)}`);
    }
    const total = data.total || 0;
    const files = [];
    for (const item of content) {
      if (item.is_dir) {
        const sub = await this.listAllFiles(`${dirPath}/${item.name}`);
        files.push(...sub);
      } else {
        files.push({ name: item.name, size: item.size, path: `${dirPath}/${item.name}` });
      }
    }
    if (total > content.length) {
      const more = await this.listDir(dirPath, 2, total);
      const moreContent = Array.isArray(more.content) ? more.content : [];
      for (const item of moreContent) {
        if (item.is_dir) {
          const sub = await this.listAllFiles(`${dirPath}/${item.name}`);
          files.push(...sub);
        } else {
          files.push({ name: item.name, size: item.size, path: `${dirPath}/${item.name}` });
        }
      }
    }
    return files;
  }

  async downloadFile(filePath, savePath, expectedSize = 0) {
    const data = await this._post('fs/get', { path: filePath, password: '' });
    const downloadUrl = data.raw_url;
    if (!downloadUrl) throw new Error('AList 未返回下载地址 (raw_url)');
    return downloadToFile({
      url: downloadUrl,
      savePath,
      expectedSize,
      label: path.basename(savePath),
    });
  }

  async removeFile(filePath) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    const name = filePath.substring(filePath.lastIndexOf('/') + 1);
    await this._post('fs/remove', { names: [name], dir: dir || '/' });
  }

  async downloadDir(alistPath, saveDir, skipExisting = true, deleteAfter = false) {
    log(`   列出文件夹: ${alistPath} ...`);
    let files = await this.listAllFiles(alistPath);
    const rawCount = files.length;
    files = deduplicateByEpisode(files, { onSkip: log });
    if (files.length < rawCount) {
      log(`   ✓ 共 ${rawCount} 个文件 (去重后 ${files.length} 个)\n`);
    } else {
      log(`   ✓ 共 ${files.length} 个文件\n`);
    }

    const downloadedRecord = skipExisting ? loadDownloadedRecord(saveDir) : new Map();
    // 预先算一次：清理重复副本改过名时，靠它按「同一集 + 同体积」认出本地那份
    const localIndex = skipExisting ? buildLocalEpisodeIndex(saveDir) : null;
    let incomplete = 0;
    const toDownload = skipExisting
      ? files.filter(f => {
        if (!downloadedRecord.has(getDedupKey(f))) return true;
        // 有记录也要确认本地那份是完整的，否则重新下载（自愈被截断的半成品）
        if (localCopyIsComplete(saveDir, f.name, f.size, localIndex)) return false;
        incomplete++;
        return true;
      })
      : files;
    if (incomplete > 0) {
      log(`   ⚠ 有 ${incomplete} 个文件本地副本缺失或大小不符，将重新下载`);
    }

    if (toDownload.length === 0) {
      log(`   所有文件已下载过，无需下载。`);
      return;
    }

    const skipped = files.length - toDownload.length;
    log(`   待下载: ${toDownload.length}/${files.length} 个 (跳过 ${skipped} 个已下载记录)\n`);

    const concurrency = 3;
    const queue = [...toDownload];
    let completed = 0;
    const successPaths = [];
    const successNames = [];
    const worker = async () => {
      while (queue.length > 0) {
        const f = queue.shift();
        const savePath = path.join(saveDir, f.name);
        try {
          // 传入列表里声明的文件大小，下载后据此校验是否被截断
          await this.downloadFile(f.path, savePath, f.size || 0);
          completed++;
          successPaths.push(f.path);
          successNames.push(f.name);
          if (skipExisting) {
            downloadedRecord.set(getDedupKey(f), true);
            saveDownloadedRecord(saveDir, downloadedRecord);
          }
        } catch (e) {
          log(`   ✗ ${f.name}: ${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    log(`\n   下载完成: ${completed}/${toDownload.length} 个`);
    if (successNames.length > 0) {
      log('   已下载的文件列表:');
      for (const name of successNames) log(`     ✓ ${name}`);
    }

    if (deleteAfter && successPaths.length > 0) {
      log(`   从网盘中删除已下载的 ${successPaths.length} 个文件...`);
      for (const fp of successPaths) {
        try {
          await this.removeFile(fp);
        } catch (e) {
          log(`   ✗ 删除失败 ${fp}: ${e.message}`);
        }
      }
      log(`   ✓ 删除完成`);
    }
    log('');
  }
}

async function alistMode(forceDownload = false) {
  const config = loadConfig();
  if (!config.alistUrl) {
    logError('错误: 请在 config.json 中填写 alistUrl');
    process.exit(1);
  }

  // CLI 走自己的文件锁；下载与清理逻辑复用 alistInternal，避免两处漂移
  // （标题、来源回显、清理日志都只写一份）
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  acquireLock('.alist.lock', saveDir);

  await alistInternal(config, { skipExisting: !forceDownload });
}

export function normalizeShareUrls(config) {
  if (Array.isArray(config.shareUrls) && config.shareUrls.length > 0) {
    return config.shareUrls.map(u => typeof u === 'string' ? { url: u } : u);
  }
  if (Array.isArray(config.shareUrl)) {
    return config.shareUrl.map(u => typeof u === 'string' ? { url: u } : u);
  }
  if (config.shareUrl) {
    return [{ url: config.shareUrl }];
  }
  return [];
}

// 已注册的 cron 任务，供 web 层查询下次运行时间与手动触发
const scheduledTasks = [];

export function listScheduledTasks() {
  return scheduledTasks.map(t => {
    let nextRun = null;
    try {
      const n = t.task.getNextRun();
      nextRun = n ? n.toISOString() : null;
    } catch {}
    // 任务键形如 "sync:0"/"alist:0"，而互斥锁名为 "sync"/"alist"
    const lockName = t.key.startsWith('alist') ? 'alist' : 'sync';
    return {
      key: t.key,
      name: t.name,
      cron: t.cron,
      running: runningTasks.has(lockName),
      nextRun,
    };
  });
}

function clearScheduledTasks() {
  for (const t of scheduledTasks) {
    try { t.task.destroy(); } catch {}
  }
  scheduledTasks.length = 0;
}

// 依据当前配置注册定时任务；可重复调用以热更新
export function registerScheduledTasks({ quiet = false } = {}) {
  clearScheduledTasks();

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (!quiet) logError(`   无法读取配置，定时任务未注册: ${e.message}`);
    return { registered: 0, errors: [e.message] };
  }

  const syncCrons = [].concat(config.syncCron || []).filter(Boolean);
  const alistCrons = [].concat(config.alistCron || []).filter(Boolean);
  const errors = [];

  // downloadAfterSync：同步任务跑完接着做 AList 下载。
  // 任务 key 仍为 sync:N（保持网页手动触发与其它逻辑兼容），只改名称与执行体。
  const chained = config.downloadAfterSync === true;

  const specs = [
    ...syncCrons.map((c, i) => ({
      key: `sync:${i}`,
      name: chained ? '同步 + AList下载' : '同步模式',
      cron: c,
      fn: () => (chained ? runSyncThenDownload(loadConfig()) : runSync(loadConfig())),
    })),
    ...alistCrons.map((c, i) => ({ key: `alist:${i}`, name: 'AList下载', cron: c, fn: () => runAlist(loadConfig()) })),
  ];

  for (const s of specs) {
    if (!cron.validate(s.cron)) {
      errors.push(`无效 cron: ${s.cron}`);
      logError(`   ✗ 无效 cron: ${s.cron}`);
      continue;
    }
    const task = cron.schedule(s.cron, async () => {
      log(`\n[${now()}] 触发: ${s.name}`);
      try {
        await s.fn();
      } catch (e) {
        logError(`   异常: ${e.message}`);
      }
    });
    scheduledTasks.push({ ...s, task });
    log(`   ✓ ${s.name}: "${s.cron}"`);
  }

  return { registered: scheduledTasks.length, errors };
}

async function scheduleMode() {
  log('=== 夸克网盘定时任务 ===\n');

  // CLI 场景下由本函数统一输出错误，避免和 registerScheduledTasks 重复打印
  const config = loadConfigOrExit();
  const { registered } = registerScheduledTasks({ quiet: true });

  if (registered === 0) {
    const hasCron = [].concat(config.syncCron || [], config.alistCron || []).filter(Boolean).length > 0;
    if (!hasCron) {
      logError('错误: 请在 config.json 中配置 syncCron 或 alistCron');
    } else {
      logError('错误: syncCron / alistCron 中没有有效的 cron 表达式');
    }
    process.exit(1);
  }

  log('\n   定时任务已启动，等待触发...\n');
}

export async function runAlist(config) {
  return withTaskLock('alist', () => alistInternal(config ?? loadConfig()));
}

async function alistInternal(config, { skipExisting = true } = {}) {
  const alistUrl = config.alistUrl;
  // alistMode(CLI) 自带校验，这里补上是为了让 cron、网页手动触发、启动补跑
  // 也都拿到可读提示，而不是 AlistClient 里 undefined.replace 的报错
  if (!alistUrl) {
    throw new Error('未配置 alistUrl，无法执行 AList 下载（请在配置页填写 AList 服务器地址）');
  }
  const alistPath = config.alistPath || '/kuake/来自：分享';
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  // 任务标题与来源回显放在这里，而不是只放在 CLI 的 alistMode 里：
  // cron / 网页手动触发 / 启动补跑走的都是这个函数，没有标题就没法把几次下载分清楚
  log('=== AList 下载到本地 ===\n');
  log(`AList: ${alistUrl}`);
  log(`路径: ${alistPath}`);
  log(`保存到: ${saveDir}\n`);
  const client = new AlistClient(alistUrl, config.alistToken, config.alistRefresh);
  await client.downloadDir(alistPath, saveDir, skipExisting, config.deleteAfterDownload);
  log(`   AList下载完成`);

  if (config.cleanupAfterDays && config.cleanupAfterDays > 0) {
    log(`   执行本地清理 (${config.cleanupAfterDays}天前的文件)...`);
    const localResult = cleanupLocalFiles(saveDir, config.cleanupAfterDays);
    log(`   本地: 删除 ${localResult.deleted} 个，保留 ${localResult.skipped} 个\n`);
  }
}

// ---- 清理重复副本 ----
// 同一集在目标文件夹/本地留了多份（历年积累的序号副本、S01E07 与 07 这类不同命名）时，
// 保留最好的一份、删掉其余。**默认只报告不删除**（apply=false），必须显式要求才动文件：
// 删除是不可逆的，而分组靠的是文件名启发式，宁可让人先看一眼清单。
// 「留哪一份」与去重共用 compareForKeep，保证「去重后留下的」与「清理后留下的」是同一份。

// 本地下载目录里的重复：同一集留一份。返回 { sets, kept, deleted }。
// apply=false 时只统计不删（供预览）。导出仅为测试用。
export function cleanupLocalDuplicates(saveDir, { apply = false } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(saveDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`无法读取本地目录 ${saveDir}: ${e.message}`);
  }

  const files = [];
  for (const e of entries) {
    // 跳过点文件（.downloaded.json）与下载中的 .part 半成品：半成品体积可能比正常文件
    // 还大，混进分组会把真正完好的那份当成「多余的」删掉
    if (!e.isFile() || e.name.startsWith('.') || e.name.endsWith('.part')) continue;
    const full = path.join(saveDir, e.name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    files.push({ name: e.name, size: stat.size, updated_at: stat.mtimeMs, full });
  }

  const { sets, skipped } = findDuplicateSets(files);
  const deleted = [];
  const failed = [];
  for (const s of sets) {
    for (const f of s.drop) {
      if (!apply) { deleted.push(f); continue; }
      try {
        fs.unlinkSync(f.full);
        deleted.push(f);
      } catch (e) {
        failed.push(`${f.name}: ${e.message}`);
      }
    }
  }
  return { sets, skipped, kept: sets.map(s => s.keep), deleted, failed, scanned: files.length };
}

// 云端（转存目标文件夹当层）里的重复：同一集留一份。
async function cleanupCloudDuplicates(client, targetDirFid, { apply = false } = {}) {
  const files = await client.listTopLevelFiles(targetDirFid);
  const { sets, skipped } = findDuplicateSets(files);
  const deleted = [];
  const renamed = [];

  if (apply) {
    for (const s of sets) {
      for (let i = 0; i < s.drop.length; i += 30) {
        const batch = s.drop.slice(i, i + 30);
        try {
          await client.deleteFiles(batch.map(f => f.fid));
          deleted.push(...batch);
        } catch (e) {
          // 用 logError：删失败必须在默认「下载清单」视图里看得见，否则汇总数字对不上却查不到原因
          logError(`   ✗ 云端删除失败 (${batch[0].file_name} 等 ${batch.length} 个): ${e.message}`);
        }
      }
    }
    // 删完之后把带序号的赢家改回不带序号的名字（best-effort）：
    // 否则清理干净了，留下的大头却叫「凡人修仙传-194 4K (4).mkv」
    const removed = new Set(deleted);
    const remain = new Set(files.filter(f => !removed.has(f)).map(f => f.file_name));
    for (const s of sets) {
      const name = s.keep.file_name;
      const canonical = stripNumericSuffix(name);
      if (canonical === name || remain.has(canonical)) continue;
      try {
        await client.renameFile(s.keep.fid, canonical);
        remain.delete(name);
        remain.add(canonical);
        renamed.push(`${name} → ${canonical}`);
      } catch (e) {
        logError(`   ✗ 云端重命名失败 ${name}: ${e.message}`);
      }
    }
  } else {
    for (const s of sets) deleted.push(...s.drop);
  }

  return { sets, skipped, kept: sets.map(s => s.keep), deleted, renamed, scanned: files.length };
}

// 报告「名字相近但无法确认是同一集」的组：列表本身不动，只提示，避免静默地留着或删错
function logUnexplainedGroups(skipped, nameOf) {
  for (const { group } of skipped) {
    const names = group.map(nameOf).join(' / ');
    logError(`   ⚠ 名字相近但无法确认是同一集的重复，都保留: ${names}`);
  }
}

// 一组重复的清单做成**一条多行记录**：日志视图是按「记录」过滤的，
// 拆成多条独立记录的话，默认「下载清单」视图里会只剩标题、看不到到底要删哪些文件。
function dedupeGroupLine(apply, drop, keepName, nameOf) {
  const lines = drop.map(f => `      ${apply ? '✗' : '·'} ${nameOf(f)}`).join('\n');
  return `   ${apply ? '🗑 删除' : '将删除'} ${drop.length} 个，保留 ${keepName}\n${lines}`;
}

// 清理重复：cloud 清网盘目标文件夹（当层），local 清本地下载目录
async function dedupeInternal(config, { apply = false, cloud = true, local = true } = {}) {
  log(`=== 清理重复副本${apply ? '' : '（预览，不会删除任何文件）'} ===\n`);
  let totalDrop = 0;

  if (cloud) {
    if (!config.cookie) {
      logError('   ⚠ 未配置 cookie，跳过云端清理');
    } else {
      log('1. 检查网盘目标文件夹...');
      try {
        const client = new QuarkClient(config.cookie);
        const nickname = await client.checkLogin();
        if (!nickname) throw new Error('Cookie 无效或已过期！请重新从浏览器获取 Cookie');
        // 只查找不创建：文件夹不存在时没有任何东西可清
        const targetDirFid = await client.resolveTargetDir(config, { dryRun: true });
        if (targetDirFid === null) {
          log('   ✓ 目标文件夹不存在，无需清理');
        } else if (targetDirFid === '0' && apply) {
          // 没配目标文件夹时它是网盘根目录：那里什么都有，真删起来是灾难。
          // 预览仍然允许（只列清单），但执行删除直接拒绝。
          logError('   ✗ 未配置目标文件夹（targetDirName / targetDirFid），本功能只清目标文件夹，'
            + '拒绝在网盘根目录执行删除。请先在配置页填好目标文件夹。');
        } else {
          if (targetDirFid === '0') {
            logError('   ⚠ 未配置目标文件夹，将扫描网盘根目录（建议先在配置页填好目标文件夹）');
          }
          const r = await cleanupCloudDuplicates(client, targetDirFid, { apply });
          log(`   扫描 ${r.scanned} 个文件，发现 ${r.sets.length} 组重复，共 ${r.deleted.length} 个多余副本`);
          for (const s of r.sets) {
            log(dedupeGroupLine(apply, s.drop, s.keep.file_name, f => f.file_name));
          }
          logUnexplainedGroups(r.skipped, f => f.file_name);
          for (const line of r.renamed) log(`   ✓ 已改回不带序号的名字: ${line}`);
          totalDrop += r.deleted.length;
        }
      } catch (e) {
        logError(`   ✗ 云端清理失败: ${e.message}`);
      }
    }
  }

  if (local) {
    // 没配 downloadDir 时绝不去扫「.」：那会把项目目录当成下载目录
    const dir = String(config.downloadDir || '').trim();
    if (!dir) {
      logError('\n   ⚠ 未配置 downloadDir，跳过本地清理');
    } else if (!fs.existsSync(path.resolve(dir))) {
      // 目录还没建起来（从没下载过）：不是错误，别报成「本地清理失败」
      log(`\n2. 本地目录还不存在（${path.resolve(dir)}），无需清理`);
    } else {
      const saveDir = path.resolve(dir);
      log(`\n2. 检查本地目录 ${saveDir}...`);
      try {
        const r = cleanupLocalDuplicates(saveDir, { apply });
        log(`   扫描 ${r.scanned} 个文件，发现 ${r.sets.length} 组重复，共 ${r.deleted.length} 个多余副本`);
        for (const s of r.sets) {
          log(dedupeGroupLine(apply, s.drop, s.keep.name, f => f.name));
        }
        logUnexplainedGroups(r.skipped, f => f.name);
        for (const msg of r.failed) logError(`   ✗ 本地删除失败 ${msg}`);
        totalDrop += r.deleted.length;
      } catch (e) {
        logError(`   ✗ 本地清理失败: ${e.message}`);
      }
    }
  }

  log(`\n${apply ? '已删除' : '待删除'} ${totalDrop} 个重复副本`
    + (apply ? '' : '（预览模式，加 --yes 或点网页的「执行删除」才会真的删）'));
  return { apply, total: totalDrop };
}

// 清理会动文件，尤其本地清的是下载目录，所以进程内三把锁一起拿：
// - sync：云端清的是同步的目标文件夹
// - alist：本地清的是 downloadDir，AList 下载正往这里写
// - dedupe：让「任务」页显示的是清理而不是同步
// 顺序固定为 sync → alist → dedupe，与 runSyncThenDownload 的 sync → alist 一致，不会死锁。
// 注意 withTaskLock 只是**进程内**互斥；跨进程靠 CLI 那侧的锁文件（见 dedupeMode）。
export async function runDedupe(config, opts = {}) {
  return withTaskLock('sync', () => withTaskLock('alist', () => withTaskLock('dedupe',
    () => dedupeInternal(config ?? loadConfig(), opts))));
}

async function dedupeMode(apply, opts = {}) {
  log('=== 夸克网盘重复副本清理 ===\n');
  const config = loadConfigOrExit();

  // CLI 侧再加跨进程文件锁：本地清的是下载目录，别的实例（另一个终端 / 容器）可能正在下载。
  // 锁名与 downloadMode / alistMode 保持一致，才真的互斥；拿不到就按既有 CLI 语义直接退出。
  // 只清云端时不必占用下载锁，也不该在没配 downloadDir 时往项目目录里写锁文件。
  // 只有真的要删时才需要这些锁：预览不改任何文件，也不该顺手建目录、写锁文件
  const dir = String(config.downloadDir || '').trim();
  if (apply && opts.local !== false && dir) {
    const saveDir = path.resolve(dir);
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
    acquireLock('.download.lock', saveDir);
    acquireLock('.alist.lock', saveDir);
  }

  await runDedupe(config, { apply, ...opts });
  if (!apply) log('\n提示: 确认清单无误后执行删除：npm run dedupe-apply（或 node src/index.js dedupe --yes）\n');
}

function main() {
  const mode = process.argv[2];
  const forceDownload = process.argv.includes('--force-download') || process.argv.includes('--no-skip');
  const dryRun = process.argv.includes('--dry-run');
  // 清理重复副本：默认只预览；--yes 才真的删（--dry-run 与默认同为预览）
  const applyDedupe = process.argv.includes('--yes') && !dryRun;
  const cloudOnly = process.argv.includes('--cloud-only');
  const localOnly = process.argv.includes('--local-only');

  // --dry-run 目前只实现在同步模式：其他模式若静默忽略它，用户会误以为「没写入」
  const nonSyncModes = ['--download', 'download', '--schedule', 'schedule', '--alist', 'alist', '--web', 'web'];
  if (dryRun && nonSyncModes.includes(mode)) {
    logError('错误: --dry-run 只支持同步模式，例如: node src/index.js --dry-run（或 npm run sync-dry）');
    process.exit(1);
  }

  if (mode === '--dedupe' || mode === 'dedupe') {
    dedupeMode(applyDedupe, { cloud: !localOnly, local: !cloudOnly }).catch(err => {
      logError('\n程序异常: ' + err.message);
      process.exit(1);
    });
  } else if (mode === '--download' || mode === 'download') {
    downloadMode(forceDownload).catch(err => {
      logError('\n程序异常: ' + err.message);
      process.exit(1);
    });
  } else if (mode === '--schedule' || mode === 'schedule') {
    scheduleMode().catch(err => {
      logError('\n程序异常: ' + err.message);
      process.exit(1);
    });
  } else if (mode === '--alist' || mode === 'alist') {
    alistMode(forceDownload).catch(err => {
      logError('\n程序异常: ' + err.message);
      process.exit(1);
    });
  } else if (mode === '--web' || mode === 'web') {
    import('./web.js')
      .then(m => m.startWebServer())
      .catch(err => {
        logError('\n程序异常: ' + err.message);
        process.exit(1);
      });
  } else {
    syncMode(dryRun).catch(err => {
      logError('\n程序异常: ' + err.message);
      process.exit(1);
    });
  }
}

// 仅在被直接执行时运行 CLI，被 web.js import 时不触发
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
