import axios from 'axios';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_FILE = path.join(__dirname, 'sync.log');
const DOWNLOADED_FILE = '.downloaded.json';

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

const LOG_RETENTION_DAYS = 7;
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
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
// 用相邻时间戳的升降配对投票，而不是只看首尾：迁移前若已追加过新行，
// 首尾启发式会被尾部的新行带偏而漏判。
function looksReversed(tsList) {
  let asc = 0, desc = 0;
  for (let i = 1; i < tsList.length; i++) {
    if (tsList[i] > tsList[i - 1]) asc++;
    else if (tsList[i] < tsList[i - 1]) desc++;
  }
  return desc > asc;
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

  // 旧版本为倒序写入（最新在前），此处做一次性顺序迁移
  const tsList = lines.map(parseLogTime).filter(t => t !== null);
  if (tsList.length >= 2 && looksReversed(tsList)) {
    lines.reverse();
    changed = true;
  }

  // 顺序写入后，过期记录集中在文件头部，丢弃前缀即可
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let drop = 0;
  while (drop < lines.length) {
    const t = parseLogTime(lines[drop]);
    if (t === null || t >= cutoff) break;
    drop++;
  }
  if (drop > 0) {
    lines = lines.slice(drop);
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

export function readLogs({ maxLines = 200, level = '', keyword = '' } = {}) {
  const want = Math.max(1, Math.min(5000, Number(maxLines) || 200));
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

export function log(message) {
  console.log(message);
  writeLog('INFO', message);
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
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('找不到 config.json，请复制 config.example.json 并填写配置');
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('config.json 格式不正确');
  }
}

export function getConfigPath() {
  return path.join(__dirname, 'config.json');
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

function parseEpisode(fileName) {
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

function sortByEpisode(a, b) {
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

function getEpisodeKey(fileName) {
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

function getQualityScore(fileName) {
  const lower = fileName.toLowerCase();
  for (const [kw, score] of Object.entries(QUALITY_SCORE)) {
    if (lower.includes(kw)) return score;
  }
  return 0;
}

function isHigherQuality(aName, aSize, bName, bSize) {
  const qA = getQualityScore(aName);
  const qB = getQualityScore(bName);
  if (qA !== qB) return qA > qB;
  return (aSize || 0) > (bSize || 0);
}

function deduplicateByEpisode(files) {
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
      log(`   ⏭ 同名集去重: ${key} (${group.length}个版本, 保留 ${group[0].file_name || group[0].name})`);
    }
  }
  if (removed > 0) log(`   → 去重移除 ${removed} 个较低画质版本\n`);
  deduped.push(...unkeyed);
  return deduped;
}

function getDedupKey(fileItem) {
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

  async resolveTargetDir(config) {
    if (config.targetDirFid && config.targetDirFid !== '0') {
      return config.targetDirFid;
    }
    if (!config.targetDirName) {
      return '0';
    }
    console.log(`   查找目标文件夹: "${config.targetDirName}"...`);
    let fid = await this.findFolderByName(config.targetDirName);
    if (fid) {
      console.log(`   ✓ 已存在，fid: ${fid}\n`);
      return fid;
    }
    console.log(`   文件夹不存在，正在创建...`);
    fid = await this.createFolder(config.targetDirName);
    console.log(`   ✓ 已创建，fid: ${fid}\n`);
    return fid;
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

  async downloadFile(downloadUrl, savePath) {
    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(savePath);
      axios.get(downloadUrl, {
        headers: { 'User-Agent': UA_CLIENT, 'Cookie': this.cookie, 'Referer': 'https://pan.quark.cn/' },
        responseType: 'stream',
        timeout: 10800000,
        validateStatus: () => true,
      }).then(resp => {
        if (resp.status >= 400) {
          writer.close();
          fs.unlinkSync(savePath);
          reject(new Error(`HTTP ${resp.status}`));
          return;
        }
        const total = parseInt(resp.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const name = path.basename(savePath);
        resp.data.on('data', chunk => {
          downloaded += chunk.length;
        });
        const timer = setInterval(() => {
          if (total > 0) {
            const pct = Math.round(downloaded / total * 100);
            const mb = (downloaded / 1048576).toFixed(1);
            process.stdout.write(`\r   ${name}: ${pct}% (${mb} MB)`);
          }
        }, 1000);
        resp.data.pipe(writer);
        writer.on('finish', () => { clearInterval(timer); process.stdout.write('\n'); resolve(); });
        writer.on('error', e => { clearInterval(timer); reject(e); });
      }).catch(reject);
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
          await this.downloadFile(item.download_url, savePath);
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
    files = deduplicateByEpisode(files);
    if (files.length < rawCount) {
      log(`   ✓ 共 ${rawCount} 个文件 (去重后 ${files.length} 个)\n`);
    } else {
      log(`   ✓ 共 ${files.length} 个文件\n`);
    }

    const downloadedRecord = skipExisting ? loadDownloadedRecord(saveDir) : new Map();
    const toDownload = skipExisting
      ? files.filter(f => !downloadedRecord.has(getDedupKey(f)))
      : files;

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

function filterByHours(files, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return files.filter(f => {
    if (f.dir) return false;
    let ts = f.updated_at;
    if (String(ts).length <= 10) ts *= 1000;
    return ts >= cutoff;
  });
}

// 统一同步实现：CLI(sync 模式) 与 cron/网页触发共用同一份逻辑
async function syncInternal(config) {
  if (!config.cookie || config.cookie === '从浏览器复制的完整 Cookie 字符串') {
    throw new Error('请在 config.json 中填写有效的 Cookie');
  }

  const shareUrls = normalizeShareUrls(config);
  if (shareUrls.length === 0) {
    throw new Error('请在 config.json 中填写 shareUrl 或 shareUrls');
  }

  const hours = config.hours ?? (config.days ? config.days * 24 : 48);
  const pollInterval = config.pollInterval || 1000;

  const client = new QuarkClient(config.cookie);

  log('0. 验证登录状态...');
  const nickname = await client.checkLogin();
  if (!nickname) {
    throw new Error('Cookie 无效或已过期！请重新从浏览器获取 Cookie');
  }

  log('1. 确定保存目标文件夹...');
  const targetDirFid = await client.resolveTargetDir(config);

  let totalSuccess = 0;
  let totalFailed = 0;
  const allSuccess = [];
  const allFailed = [];
  // 任务期间判定为已失效的分享 ID，用于按需清理配置
  const deadPwdIds = new Set();
  let prunedUrls = null;

  for (let si = 0; si < shareUrls.length; si++) {
    const { url, password, tip, hours: itemHours, minFileSizeMB: itemMinSizeMB, maxFilesPerShare: itemMaxFiles } = shareUrls[si];
    const shareTip = tip || config.tip;
    const shareHours = itemHours ?? hours;
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
      log(`分享 ID: ${pwdIds.join(', ')}`);
    } else {
      log(`分享 ID: ${pwdIds.join(', ')}`);
    }
    log(`时间范围: 最近 ${shareHours} 小时更新\n`);

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

      const recentFiles = filterByHours(allFiles, shareHours);
      const minSizeMB = itemMinSizeMB ?? config.minFileSizeMB ?? 0;
      let largeFiles = minSizeMB > 0
        ? recentFiles.filter(f => (f.size || 0) >= minSizeMB * 1048576)
        : recentFiles;
      if (minSizeMB > 0) {
        log(`   过滤 <${minSizeMB}MB 文件: 剩余 ${largeFiles.length} 个\n`);
      }

      const maxPerShare = itemMaxFiles ?? config.maxFilesPerShare ?? 0;
      let capped = false;
      if (maxPerShare > 0 && largeFiles.length > maxPerShare) {
        largeFiles = [...largeFiles].sort(sortByEpisode).slice(0, maxPerShare);
        capped = true;
      }
      log(`   最近 ${shareHours} 小时更新的文件: ${recentFiles.length} 个` +
        (capped ? ` → 限制取最新 ${maxPerShare} 个` : '') + '\n');

      if (largeFiles.length === 0) {
        log('没有找到符合条件的文件，无需转存。');
        continue;
      }

      log('   检查目标文件夹中已存在的文件...');
      const existingMap = await client.getExistingFileMap(targetDirFid);
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

      log('待转存文件列表:');
      for (const f of newFiles) {
        const date = new Date(String(f.updated_at).length <= 10 ? f.updated_at * 1000 : f.updated_at);
        log(`  - ${f.file_name}  (更新于: ${date.toLocaleString('zh-CN')})`);
      }
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

      let renamedNames = results.success;
      if (shareTip && results.success.length > 0) {
        renamedNames = [];
        log('\n   等待文件处理完成...');
        await new Promise(r => setTimeout(r, 2000));

        log('   添加文件名前缀...');
        const prefix = shareTip.endsWith('-') ? shareTip : `${shareTip}-`;

        let existingFiles = await client.listAllUserFiles(targetDirFid);
        let existingNames = new Set(existingFiles.map(f => f.file_name));
        let renamed = 0;

        for (const name of results.success) {
          const newName = `${prefix}${name}`;
          if (existingNames.has(newName)) {
            log(`   ⏭ ${name} (${newName} 已存在)`);
            renamedNames.push(newName);
            continue;
          }
          let match = existingFiles.find(f => f.file_name === name);
          if (!match) {
            log(`   重试查找 ${name}...`);
            await new Promise(r => setTimeout(r, 1000));
            existingFiles = await client.listAllUserFiles(targetDirFid);
            existingNames = new Set(existingFiles.map(f => f.file_name));
            match = existingFiles.find(f => f.file_name === name);
          }
          if (!match) {
            log(`   ✗ ${name} 仍未找到，跳过重命名`);
            renamedNames.push(name);
            continue;
          }
          try {
            await client.renameFile(match.fid, newName);
            renamed++;
            log(`   ✓ ${name} → ${newName}`);
            renamedNames.push(newName);
          } catch (e) {
            log(`   ✗ ${name} 重命名失败: ${e.message}`);
            renamedNames.push(name);
          }
        }
        if (renamed > 0) log(`   已重命名 ${renamed} 个文件\n`);
      }

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
    await client.cleanupOldFiles(targetDirFid, config.cleanupAfterDays);
    const localResult = cleanupLocalFiles(path.resolve(config.downloadDir || '.'), config.cleanupAfterDays);
    if (localResult.deleted > 0) {
      log(`   ✓ 本地清理完成: 删除 ${localResult.deleted} 个，保留 ${localResult.skipped} 个\n`);
    }
  }

  return { totalSuccess, totalFailed, allSuccess, allFailed, deadPwdIds: [...deadPwdIds], prunedUrls };
}

// CLI 入口：保持原有日志与退出语义
async function syncMode() {
  log('=== 夸克网盘自动同步工具 ===\n');
  const config = loadConfigOrExit();
  await withTaskLock('sync', () => syncInternal(config));
}

// cron / 网页触发入口：每次执行前重新读取配置（支持热更新）
export async function runSync(config) {
  return withTaskLock('sync', () => syncInternal(config ?? loadConfig()));
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
    cleanupLocalFiles(saveDir, config.cleanupAfterDays);
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

  async downloadFile(filePath, savePath) {
    const data = await this._post('fs/get', { path: filePath, password: '' });
    const downloadUrl = data.raw_url;
    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(savePath);
      axios.get(downloadUrl, {
        responseType: 'stream',
        timeout: 10800000,
        validateStatus: () => true,
      }).then(resp => {
        if (resp.status >= 400) {
          writer.close();
          fs.unlinkSync(savePath);
          reject(new Error(`HTTP ${resp.status}`));
          return;
        }
        const total = parseInt(resp.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const name = path.basename(savePath);
        const startTime = Date.now();
        resp.data.on('data', chunk => { downloaded += chunk.length; });
        const timer = setInterval(() => {
          if (total > 0) {
            const pct = Math.round(downloaded / total * 100);
            const mb = (downloaded / 1048576).toFixed(1);
            const speed = (downloaded / 1048576 / ((Date.now() - startTime) / 1000)).toFixed(1);
            process.stdout.write(`\r   ${name}: ${pct}% (${mb} MB, ${speed} MB/s)`);
          }
        }, 1000);
        resp.data.pipe(writer);
        writer.on('finish', () => { clearInterval(timer); process.stdout.write('\n'); resolve(); });
        writer.on('error', e => { clearInterval(timer); reject(e); });
      }).catch(reject);
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
    files = deduplicateByEpisode(files);
    if (files.length < rawCount) {
      log(`   ✓ 共 ${rawCount} 个文件 (去重后 ${files.length} 个)\n`);
    } else {
      log(`   ✓ 共 ${files.length} 个文件\n`);
    }

    const downloadedRecord = skipExisting ? loadDownloadedRecord(saveDir) : new Map();
    const toDownload = skipExisting
      ? files.filter(f => !downloadedRecord.has(getDedupKey(f)))
      : files;

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
          await this.downloadFile(f.path, savePath);
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
    cleanupLocalFiles(saveDir, config.cleanupAfterDays);
  }
}

function normalizeShareUrls(config) {
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

  const specs = [
    ...syncCrons.map((c, i) => ({ key: `sync:${i}`, name: '同步模式', cron: c, fn: () => runSync(loadConfig()) })),
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
  const alistPath = config.alistPath || '/kuake/来自：分享';
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const client = new AlistClient(alistUrl, config.alistToken, config.alistRefresh);
  await client.downloadDir(alistPath, saveDir, true, config.deleteAfterDownload);
  log(`   AList下载完成`);

  if (config.cleanupAfterDays && config.cleanupAfterDays > 0) {
    log(`   执行本地清理 (${config.cleanupAfterDays}天前的文件)...`);
    const localResult = cleanupLocalFiles(saveDir, config.cleanupAfterDays);
    if (localResult.deleted > 0) {
      log(`   ✓ 本地清理完成: 删除 ${localResult.deleted} 个，保留 ${localResult.skipped} 个\n`);
    }
  }
}

function main() {
  const mode = process.argv[2];
  const forceDownload = process.argv.includes('--force-download') || process.argv.includes('--no-skip');
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
    syncMode().catch(err => {
      logError('\n程序异常: ' + err.message);
      process.exit(1);
    });
  }
}

// 仅在被直接执行时运行 CLI，被 web.js import 时不触发
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
