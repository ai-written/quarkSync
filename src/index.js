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
  const line = `[${now()}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {}
}

export function readLogs({ maxLines = 500, level = '', keyword = '' } = {}) {
  const want = Math.max(1, Math.min(5000, Number(maxLines) || 500));
  if (!fs.existsSync(LOG_FILE)) return { lines: [], truncated: false };

  const needle = String(keyword || '').toLowerCase();
  const lvl = String(level || '').toUpperCase();
  const match = l => {
    if (lvl && !l.includes(`[${lvl}]`)) return false;
    if (needle && !l.toLowerCase().includes(needle)) return false;
    return true;
  };

  const fileSize = (() => {
    try { return fs.statSync(LOG_FILE).size; } catch { return 0; }
  })();

  // 小文件直接整体读取，避免多次系统调用
  if (fileSize <= SMALL_LOG_BYTES) {
    const all = tailRawLines(LOG_FILE, fileSize + 1);
    const matched = all.lines.filter(match);
    return { lines: matched.slice(-want), truncated: matched.length > want };
  }

  // 大文件：从尾部按窗口渐进放大，窗口上限受字节数约束（而非行数），
  // 保证最坏情况下的读取量有界
  let maxBytes = Math.min(256 * 1024, fileSize);
  let matched = [];
  let reachedStart = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const { lines, hitByteCap } = tailRawLines(LOG_FILE, maxBytes);
    matched = lines.filter(match);
    // hitByteCap=false 表示已读到头，不可能再有更早的匹配行
    reachedStart = !hitByteCap;
    if (matched.length >= want || reachedStart) break;
    if (maxBytes >= MAX_LOG_SCAN_BYTES) break;
    maxBytes = Math.min(maxBytes * 4, MAX_LOG_SCAN_BYTES, fileSize);
  }

  return {
    lines: matched.slice(-want),
    // 返回行数被截断，或未扫描到文件开头（可能还有更早的匹配行）
    truncated: matched.length > want || !reachedStart,
  };
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

export function parseEpisode(fileName) {
  const name = fileName.replace(/\.[^.]+$/, '');
  let m;

  m = name.match(/[Ss](\d+)\s*[Ee](?:\s*P\s*)?(\d+)/);
  if (m) return { season: +m[1], episode: +m[2] };

  m = name.match(/第?\s*(\d+)\s*季.*?第?\s*(\d+)\s*集/);
  if (m) return { season: +m[1], episode: +m[2] };

  m = name.match(/第?\s*(\d+)\s*集/);
  if (m) return { season: 0, episode: +m[1] };

  const nums = [...name.matchAll(/(\d+)/g)].map(n => +n[1]);
  const nonYear = nums.filter(n => n < 1900 || n > 2099);
  if (nonYear.length > 0) {
    const best = nonYear.reduce((a, b) => String(a).length >= String(b).length ? a : b);
    return { season: 0, episode: best };
  }

  return null;
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

export function getEpisodeKey(fileName) {
  const ep = parseEpisode(fileName);
  if (!ep) return null;
  const name = fileName.replace(/\.[^.]+$/, '');
  let show = name;
  show = show.replace(/[-_\s]*[Ss]\d+[-\s]*[Ee]\d+.*$/, '');
  show = show.replace(/[-_\s]*第?\s*\d+\s*季.*$/, '');
  show = show.replace(/[-_\s]*第?\s*\d+\s*集.*$/, '');
  show = show.replace(/(4k|2160p|1080p|720p|高清|标清|hd|fhd|uhd|sd)/gi, '');
  show = show.replace(/[-_\s]*\d+\s*$/, '');
  show = show.replace(/[-_\s]+$/, '').trim();
  return `ep_${show}_S${ep.season}_E${ep.episode}`;
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

// 同名集去重：同集保留画质最高的那份（画质相同则取体积更大的）。
//
// 这里不直接写日志，而是通过 onSkip 回调交给调用方 —— 保持本函数是纯函数：
// 单测可以直接调用它，不会把测试输出写进真实的 sync.log。
export function deduplicateByEpisode(files, { onSkip } = {}) {
  const groups = new Map();
  const unkeyed = [];
  for (const f of files) {
    const name = f.file_name || f.name;
    const key = getEpisodeKey(name);
    if (key) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    } else {
      unkeyed.push(f);
    }
  }
  const deduped = [];
  let removed = 0;
  for (const [key, group] of groups) {
    group.sort((a, b) => {
      const aName = a.file_name || a.name;
      const bName = b.file_name || b.name;
      return isHigherQuality(bName, b.size || 0, aName, a.size || 0) ? 1 : -1;
    });
    deduped.push(group[0]);
    if (group.length > 1) {
      removed += group.length - 1;
      if (onSkip) onSkip(`   ⏭ 同名集去重: ${key} (${group.length}个版本, 保留 ${group[0].file_name || group[0].name})`);
    }
  }
  if (removed > 0 && onSkip) onSkip(`   → 去重移除 ${removed} 个较低画质版本\n`);
  deduped.push(...unkeyed);
  return deduped;
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

// 判断本地是否已有一份完整的副本（用于决定能否跳过下载）。
//
// 仅凭 .downloaded.json 里的记录判断是不够的：记录只说明"曾经下过"，
// 无法证明磁盘上那份是完整的。此前下载被截断却误报成功时，记录已经写下，
// 于是半成品会被永久跳过、永不自愈。这里按列表声明的大小再核对一次，
// 缺失或大小不符都视为需要重新下载。
function localCopyIsComplete(saveDir, name, expectedSize) {
  try {
    const st = fs.statSync(path.join(saveDir, name));
    if (!st.isFile()) return false;
    if (expectedSize > 0 && st.size !== expectedSize) return false;
    return true;
  } catch {
    return false;
  }
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
    while (true) {
      const { list, total } = await this.listUserFiles(pdirFid, page);
      for (const f of list) {
        if (!f.dir) result.push(f);
        if (f.dir && f.include_items > 0) {
          const sub = await this.listAllUserFiles(f.fid);
          result.push(...sub);
        }
      }
      if (list.length === 0 || result.length >= total) break;
      page++;
    }
    return result;
  }

  async getExistingFileMap(pdirFid = '0') {
    const files = await this.listAllUserFiles(pdirFid);
    const map = new Map();
    for (const f of files) {
      const key = `${f.file_name}|${f.size || ''}`;
      map.set(key, true);
    }
    return map;
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
    let incomplete = 0;
    const toDownload = skipExisting
      ? files.filter(f => {
        if (!downloadedRecord.has(getDedupKey(f))) return true;
        // 有记录也要确认本地那份是完整的，否则重新下载（自愈被截断的半成品）
        if (localCopyIsComplete(saveDir, f.file_name, f.size)) return false;
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

// 给刚转存的文件加上文件名前缀，返回实际使用的文件名数组（顺序与 names 一致）。
//
// 关于重名：若「前缀 + 原名」已被占用，不能简单跳过——那会留下一个没有前缀的
// 文件，既破坏前缀约定，用户也难以分辨哪份是本次转存的。能走到这一步说明转存前
// 的去重（按「名称|大小」比对）没有命中，即已有的那个是同名但大小不同的另一份
// 内容，不能丢弃。因此改为换用唯一名称（" (2)"、" (3)" …），既保住前缀又保留两份。
async function applyNamePrefix(client, targetDirFid, names, shareTip, opts = {}) {
  const out = [...names];
  if (!shareTip || names.length === 0) return out;

  const settleMs = opts.settleMs ?? 2000;
  const retryMs = opts.retryMs ?? 1000;
  const maxSuffix = opts.maxSuffix ?? 999;

  log('\n   等待文件处理完成...');
  await new Promise(r => setTimeout(r, settleMs));

  log('   添加文件名前缀...');
  const prefix = shareTip.endsWith('-') ? shareTip : `${shareTip}-`;

  let existingFiles = await client.listAllUserFiles(targetDirFid);
  const taken = new Set(existingFiles.map(f => f.file_name));
  let renamed = 0;
  let collided = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];

    // 分享里的文件可能本身就带这个前缀（例如 tip 与剧集名相同），
    // 此时不再叠加，否则会得到「遮天-遮天-01.mp4」这种名字
    if (name.startsWith(prefix)) {
      log(`   ⏭ ${name}（已带前缀，跳过）`);
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
        log(`   ✗ ${wanted} 已被占用，且 2..${maxSuffix} 的序号名也都已被占用，跳过重命名`);
        continue;
      }
    }

    let match = existingFiles.find(f => f.file_name === name);
    if (!match) {
      log(`   重试查找 ${name}...`);
      await new Promise(r => setTimeout(r, retryMs));
      existingFiles = await client.listAllUserFiles(targetDirFid);
      for (const f of existingFiles) taken.add(f.file_name);
      match = existingFiles.find(f => f.file_name === name);
    }
    if (!match) {
      log(`   ✗ ${name} 仍未找到，跳过重命名`);
      continue;
    }
    try {
      await client.renameFile(match.fid, target);
      renamed++;
      taken.add(target);
      out[i] = target;
      if (target === wanted) {
        log(`   ✓ ${name} → ${target}`);
      } else {
        collided++;
        log(`   ✓ ${name} → ${target}（${wanted} 已存在，加序号避免覆盖）`);
      }
    } catch (e) {
      log(`   ✗ ${name} 重命名失败: ${e.message}`);
    }
  }

  if (renamed > 0) log(`   已重命名 ${renamed} 个文件\n`);
  if (collided > 0) log(`   提示: 其中 ${collided} 个因重名改用带序号的文件名，两份都已保留\n`);
  return out;
}

// 统一的「文件 + 更新时间」行：正式运行逐条打印，试运行先收集、最后一次性打印
function buildFileLines(files) {
  return files.map(f => {
    const date = new Date(String(f.updated_at).length <= 10 ? f.updated_at * 1000 : f.updated_at);
    return `  - ${f.file_name}  (更新于: ${date.toLocaleString('zh-CN')})`;
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
      log(`\n${'═'.repeat(50)}`);
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
      const existingMap = targetDirFid ? await client.getExistingFileMap(targetDirFid) : new Map();
      const newFiles = largeFiles.filter(f => {
        const key = `${f.file_name}|${f.size || ''}`;
        if (existingMap.has(key)) return false;
        if (shareTip) {
          const prefix = shareTip.endsWith('-') ? shareTip : `${shareTip}-`;
          if (existingMap.has(`${prefix}${f.file_name}|${f.size || ''}`)) return false;
        }
        return true;
      });
      const skipped = recentFiles.length - newFiles.length;
      if (skipped > 0) {
        log(`   ⏭ 跳过 ${skipped} 个已存在的文件`);
      }
      log(`   → 需要转存: ${newFiles.length} 个\n`);

      if (newFiles.length === 0) {
        log('所有文件已存在，无需转存。');
        continue;
      }

      // 试运行：不在这里打印（进度已静音），改为收集起来，函数末尾一次性输出
      if (dryRun) {
        dryRunWouldTransfer += newFiles.length;
        dryRunEntries.push({
          label: shareTip || pwdIds[0] || `第 ${si + 1} 个分享`,
          lines: buildFileLines(newFiles),
        });
        continue;
      }

      log('待转存文件列表:');
      for (const line of buildFileLines(newFiles)) log(line);
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

  // 试运行到此为止：上面全程静音，这里只输出「会转存哪些文件」这一件事（错误日志照常输出）
  if (dryRun) {
    logAlways('待转存文件列表:');
    if (dryRunEntries.length === 0) {
      logAlways('  （没有需要转存的文件）');
    } else if (dryRunEntries.length === 1) {
      // 只有一个分享：直接平铺清单，最简洁
      for (const line of dryRunEntries[0].lines) logAlways(line);
    } else {
      // 多个分享时按分享分组，否则看不出哪个文件来自哪个分享
      for (const entry of dryRunEntries) {
        logAlways(`[${entry.label}]`);
        for (const line of entry.lines) logAlways(line);
      }
    }
    logAlways('');
    logAlways(`共 ${dryRunWouldTransfer} 个文件会被转存（试运行，未做任何写入）`);
    return {
      dryRun: true, wouldTransfer: dryRunWouldTransfer,
      totalSuccess: 0, totalFailed: 0, allSuccess: [], allFailed: [],
      deadPwdIds: [...deadPwdIds], prunedUrls: null,
    };
  }

  if (shareUrls.length > 1) {
    log(`\n${'═'.repeat(50)}`);
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
    let incomplete = 0;
    const toDownload = skipExisting
      ? files.filter(f => {
        if (!downloadedRecord.has(getDedupKey(f))) return true;
        // 有记录也要确认本地那份是完整的，否则重新下载（自愈被截断的半成品）
        if (localCopyIsComplete(saveDir, f.name, f.size)) return false;
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
  const alistUrl = config.alistUrl;
  if (!alistUrl) {
    logError('错误: 请在 config.json 中填写 alistUrl');
    process.exit(1);
  }

  const alistPath = config.alistPath || '/kuake/来自：分享';
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  acquireLock('.alist.lock', saveDir);

  log('=== AList 下载到本地 ===\n');
  log(`AList: ${alistUrl}`);
  log(`路径: ${alistPath}`);
  log(`保存到: ${saveDir}\n`);

  const skipExisting = !forceDownload;
  const client = new AlistClient(alistUrl, config.alistToken, config.alistRefresh);
  await client.downloadDir(alistPath, saveDir, skipExisting, config.deleteAfterDownload);

  if (config.cleanupAfterDays && config.cleanupAfterDays > 0) {
    log(`\n执行清理 (${config.cleanupAfterDays}天前的文件)...`);
    const localResult = cleanupLocalFiles(saveDir, config.cleanupAfterDays);
    log(`   本地: 删除 ${localResult.deleted} 个，保留 ${localResult.skipped} 个\n`);
  }
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

async function alistInternal(config) {
  const alistUrl = config.alistUrl;
  // alistMode(CLI) 自带校验，这里补上是为了让 cron、网页手动触发、启动补跑
  // 也都拿到可读提示，而不是 AlistClient 里 undefined.replace 的报错
  if (!alistUrl) {
    throw new Error('未配置 alistUrl，无法执行 AList 下载（请在配置页填写 AList 服务器地址）');
  }
  const alistPath = config.alistPath || '/kuake/来自：分享';
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const client = new AlistClient(alistUrl, config.alistToken, config.alistRefresh);
  await client.downloadDir(alistPath, saveDir, true, config.deleteAfterDownload);
  log(`   AList下载完成`);

  if (config.cleanupAfterDays && config.cleanupAfterDays > 0) {
    log(`   执行本地清理 (${config.cleanupAfterDays}天前的文件)...`);
    const localResult = cleanupLocalFiles(saveDir, config.cleanupAfterDays);
    log(`   本地: 删除 ${localResult.deleted} 个，保留 ${localResult.skipped} 个\n`);
  }
}

function main() {
  const mode = process.argv[2];
  const forceDownload = process.argv.includes('--force-download') || process.argv.includes('--no-skip');
  const dryRun = process.argv.includes('--dry-run');

  // --dry-run 目前只实现在同步模式：其他模式若静默忽略它，用户会误以为「没写入」
  const nonSyncModes = ['--download', 'download', '--schedule', 'schedule', '--alist', 'alist', '--web', 'web'];
  if (dryRun && nonSyncModes.includes(mode)) {
    logError('错误: --dry-run 只支持同步模式，例如: node src/index.js --dry-run（或 npm run sync-dry）');
    process.exit(1);
  }

  if (mode === '--download' || mode === 'download') {
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
