import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  readLogs,
  log,
  logError,
  runSync,
  runAlist,
  listScheduledTasks,
  registerScheduledTasks,
  getRunningTasks,
  isTaskRunning,
  isValidDuration,
} from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(__dirname, 'ui.html');
const ICON_FILE = path.join(__dirname, 'quark-sync.ico');

const COOKIE_NAME = 'qsid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const UNCHANGED = '__UNCHANGED__';

// 内存会话表：重启后失效，无需持久化
const sessions = new Map();

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession() {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  return sid;
}

function validSession(sid) {
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

function sweepSessions() {
  const now = Date.now();
  for (const [sid, exp] of sessions) if (now > exp) sessions.delete(sid);
}

// ---- 配置掩码：绝不下发真实 Cookie ----

function maskSecret(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function configForClient(config) {
  const copy = { ...config };
  const cookie = typeof copy.cookie === 'string' ? copy.cookie : '';
  copy.cookie = cookie ? maskSecret(cookie) : '';
  copy.__cookieSet = Boolean(cookie);
  const token = typeof copy.webToken === 'string' ? copy.webToken : '';
  copy.webToken = token ? maskSecret(token) : '';
  copy.__webTokenSet = Boolean(token);
  return copy;
}

// 前端回传掩码值时保留原值，避免把 "ab****yz" 写进配置
function mergeSecrets(incoming, current) {
  const out = { ...incoming };
  if (out.cookie === UNCHANGED || out.cookie === undefined || out.cookie === null) {
    out.cookie = current.cookie ?? '';
  } else if (typeof out.cookie === 'string' && out.cookie === maskSecret(current.cookie)) {
    out.cookie = current.cookie ?? '';
  }
  if (out.webToken === UNCHANGED || out.webToken === undefined || out.webToken === null) {
    out.webToken = current.webToken ?? '';
  } else if (typeof out.webToken === 'string' && out.webToken === maskSecret(current.webToken)) {
    out.webToken = current.webToken ?? '';
  }
  delete out.__cookieSet;
  delete out.__webTokenSet;
  return out;
}

// ---- 配置校验，避免写入结构非法的数据 ----

function validateConfig(c) {
  const errors = [];
  const isInt = v => typeof v === 'number' && Number.isInteger(v);
  const optionalInt = (k, min) => {
    if (c[k] === undefined) return;
    if (!isInt(c[k])) errors.push(`${k} 必须是整数`);
    else if (c[k] < min) errors.push(`${k} 不能小于 ${min}`);
  };
  const optionalBool = k => {
    if (c[k] === undefined) return;
    if (typeof c[k] !== 'boolean') errors.push(`${k} 必须是 true/false`);
  };
  const optionalStr = k => {
    if (c[k] === undefined) return;
    if (typeof c[k] !== 'string') errors.push(`${k} 必须是字符串`);
  };

  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    return ['配置必须是一个 JSON 对象'];
  }

  optionalStr('cookie');
  optionalStr('tip');
  optionalStr('password');
  optionalStr('targetDirName');
  optionalStr('targetDirFid');
  optionalStr('downloadDir');
  optionalStr('alistUrl');
  optionalStr('alistPath');
  optionalStr('alistToken');
  optionalStr('webToken');
  optionalStr('webHost');

  optionalBool('deleteAfterDownload');
  optionalBool('alistRefresh');
  optionalBool('runOnStartup');
  optionalBool('pruneDeadShares');
  optionalBool('downloadAfterSync');

  optionalInt('minFileSizeMB', 0);
  optionalInt('maxFilesPerShare', 0);
  optionalInt('cleanupAfterDays', 0);
  optionalInt('pollInterval', 0);
  optionalInt('webPort', 1);
  optionalInt('days', 0);

  // hours 支持单位写法（1h / 1d / 1w / 1mo / 1y / 30m）或纯数字（按小时）。
  // null 与空串在运行时被视为「未配置」（回退默认值），校验时同样放行，
  // 避免出现「能跑但存不了」的不一致。
  if (c.hours !== undefined && c.hours !== null && c.hours !== '' && !isValidDuration(c.hours)) {
    errors.push('hours 需要是数字（按小时）或时长写法，如 24、1h、1d、1w、1mo、1y、30m');
  }

  for (const key of ['syncCron', 'alistCron']) {
    const v = c[key];
    if (v === undefined) continue;
    const arr = Array.isArray(v) ? v : [v];
    if (!arr.every(x => typeof x === 'string' && x.trim())) {
      errors.push(`${key} 必须是非空字符串或字符串数组`);
    }
  }

  const su = c.shareUrls;
  if (su !== undefined && su !== null) {
    if (!Array.isArray(su)) errors.push('shareUrls 必须是数组');
    else {
      su.forEach((item, i) => {
        if (typeof item === 'string') return;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`shareUrls[${i}] 必须是字符串或对象`);
          return;
        }
        const u = item.url;
        if (u === undefined || u === null) {
          errors.push(`shareUrls[${i}] 缺少 url`);
        } else if (typeof u !== 'string' && !(Array.isArray(u) && u.every(x => typeof x === 'string'))) {
          errors.push(`shareUrls[${i}].url 必须是字符串或字符串数组`);
        }
        // 每项的 hours 同样支持单位写法；null / 空串视为未配置（继承全局）
        if (item.hours !== undefined && item.hours !== null && item.hours !== '' && !isValidDuration(item.hours)) {
          errors.push(`shareUrls[${i}].hours 需要是数字（按小时）或时长写法，如 6、12h、1d`);
        }
        for (const k of ['minFileSizeMB', 'maxFilesPerShare']) {
          if (item[k] !== undefined && !isInt(item[k])) errors.push(`shareUrls[${i}].${k} 必须是整数`);
        }
        for (const k of ['password', 'tip']) {
          if (item[k] !== undefined && typeof item[k] !== 'string') errors.push(`shareUrls[${i}].${k} 必须是字符串`);
        }
      });
    }
  } else if (c.shareUrl !== undefined && typeof c.shareUrl !== 'string' && !Array.isArray(c.shareUrl)) {
    errors.push('shareUrl 必须是字符串或数组');
  }

  return errors;
}

// ---- HTTP 辅助 ----

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// 任务键 "sync:0"/"alist:0" 或手动键 "sync"/"alist" 都归一到同一实现
function isRunnableKey(key) {
  const k = String(key);
  if (k === 'sync' || k === 'alist') return true;
  return listScheduledTasks().some(t => t.key === k);
}

async function triggerTask(key) {
  const k = String(key);
  if (k === 'sync' || k.startsWith('sync:')) return runSync();
  if (k === 'alist' || k.startsWith('alist:')) return runAlist();
  throw new Error(`未知任务: ${key}`);
}

function createServer() {
  // 每次请求都从配置文件读取 Token，这样网页里改完 webToken 无需重启即可生效；
  // 读取失败时回退到最近一次已知值，避免配置文件损坏把所有人锁在外面。
  let lastKnownToken = '';
  try {
    lastKnownToken = String(loadConfig().webToken || '');
  } catch {}
  const currentToken = () => {
    try {
      const t = String(loadConfig().webToken || '');
      if (t) lastKnownToken = t;
      return t;
    } catch {
      return lastKnownToken;
    }
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      // ---- 静态页面 ----
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        let html;
        try {
          html = fs.readFileSync(UI_FILE, 'utf-8');
        } catch {
          sendJson(res, 500, { error: '找不到 ui.html' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(html);
        return;
      }

      // ---- 网站图标（浏览器请求 favicon 时不带会话，因此不做鉴权）----
      if (req.method === 'GET' && (p === '/favicon.ico' || p === '/quark-sync.ico')) {
        let icon;
        try {
          icon = fs.readFileSync(ICON_FILE);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('favicon not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'image/x-icon',
          'Content-Length': icon.length,
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(icon);
        return;
      }

      if (!p.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Not Found' });
        return;
      }

      // ---- 登录 ----
      if (p === '/api/login' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { error: '请求格式错误' });
          return;
        }
        const token = currentToken();
        if (!token) {
          sendJson(res, 503, { error: '未配置 webToken，网页功能已禁用' });
          return;
        }
        if (!body.token || !safeEqual(body.token, token)) {
          logError('网页登录失败：Token 不正确');
          sendJson(res, 401, { error: 'Token 不正确' });
          return;
        }
        const sid = createSession();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${COOKIE_NAME}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: true }));
        log('网页登录成功');
        return;
      }

      if (p === '/api/logout' && req.method === 'POST') {
        const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (sid) sessions.delete(sid);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (p === '/api/session' && req.method === 'GET') {
        const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
        const tk = currentToken();
        const ok = Boolean(tk) && validSession(sid);
        sendJson(res, 200, { authenticated: ok, authRequired: Boolean(tk) });
        return;
      }

      // ---- 以下接口需要登录 ----
      const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
      if (!currentToken() || !validSession(sid)) {
        sendJson(res, 401, { error: '未登录或登录已过期' });
        return;
      }
      sweepSessions();

      if (p === '/api/config' && req.method === 'GET') {
        const current = loadConfig();
        sendJson(res, 200, { config: configForClient(current), configPath: getConfigPath() });
        return;
      }

      if (p === '/api/config' && req.method === 'PUT') {
        const raw = await readBody(req);
        let incoming;
        try {
          incoming = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { error: 'JSON 格式错误' });
          return;
        }
        const current = loadConfig();
        const merged = mergeSecrets(incoming, current);
        const errors = validateConfig(merged);
        if (errors.length > 0) {
          sendJson(res, 400, { error: '配置校验失败', details: errors });
          return;
        }
        let saved;
        try {
          saved = saveConfig(merged);
        } catch (e) {
          sendJson(res, 500, { error: e.message });
          return;
        }
        log(`网页更新配置成功 (${saved.isSymlink ? '已解析软链接写入' : '直接写入'})`);
        const reg = registerScheduledTasks();
        log(`   定时任务已按新配置重载: ${reg.registered} 个${reg.errors.length ? `，${reg.errors.length} 个错误` : ''}`);
        sendJson(res, 200, {
          ok: true,
          savedTo: saved.path,
          isSymlink: saved.isSymlink,
          tasksRegistered: reg.registered,
          taskErrors: reg.errors,
          config: configForClient(loadConfig()),
        });
        return;
      }

      if (p === '/api/logs' && req.method === 'GET') {
        const result = readLogs({
          maxLines: url.searchParams.get('lines') || 500,
          level: url.searchParams.get('level') || '',
          keyword: url.searchParams.get('keyword') || '',
        });
        sendJson(res, 200, result);
        return;
      }

      if (p === '/api/tasks' && req.method === 'GET') {
        sendJson(res, 200, {
          tasks: listScheduledTasks(),
          running: getRunningTasks(),
          manual: [
            { key: 'sync', name: '同步模式', running: isTaskRunning('sync') },
            { key: 'alist', name: 'AList下载', running: isTaskRunning('alist') },
          ],
        });
        return;
      }

      if (p === '/api/run' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          sendJson(res, 400, { error: '请求格式错误' });
          return;
        }
        const key = String(body.key || '');
        if (!key) {
          sendJson(res, 400, { error: '缺少任务名' });
          return;
        }
        // 先校验任务名，避免非法键被当成 202 接受后才异步失败
        if (!isRunnableKey(key)) {
          sendJson(res, 400, { error: `未知任务: ${key}` });
          return;
        }
        if (isTaskRunning('sync') || isTaskRunning('alist')) {
          sendJson(res, 409, { error: '已有任务正在运行中，请稍后再试' });
          return;
        }
        // 立即返回，任务在后台跑；前端轮询 /api/tasks 获取状态
        log(`网页手动触发任务: ${key}`);
        triggerTask(key)
          .then(() => log(`网页任务 ${key} 执行完成`))
          .catch(e => logError(`网页任务 ${key} 执行失败: ${e.message}`));
        sendJson(res, 202, { ok: true, started: key });
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (e) {
      logError(`网页请求异常: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    }
  });
}

export async function startWebServer() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    logError(`错误: ${e.message}`);
    process.exit(1);
  }

  const token = String(config.webToken || '');
  if (!token) {
    logError('错误: 未配置 webToken，网页功能已禁用。');
    logError('   请在 config.json 中设置一个不易猜测的 webToken 后重试。');
    process.exit(1);
  }
  if (token.length < 8) {
    logError('错误: webToken 至少需要 8 个字符。');
    process.exit(1);
  }

  const port = Number(config.webPort) || 3000;
  const host = config.webHost || '0.0.0.0';

  log('=== 夸克网盘定时任务 ===\n');
  const reg = registerScheduledTasks();
  if (reg.registered === 0 && reg.errors.length === 0) {
    log('   （未配置 syncCron / alistCron，仅网页手动触发可用）');
  }

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  log(`\n   网页管理界面: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  if (host === '0.0.0.0') {
    logError('   ⚠ 当前监听 0.0.0.0，局域网内可访问；请确保 webToken 足够复杂。');
  }
  log('   定时任务已启动，等待触发...\n');

  // 启动后自动补跑一次同步与 AList 下载（可用 runOnStartup: false 关闭）。
  // 与 cron / 网页手动触发共用同一把进程内互斥锁，因此不会并发重复转存。
  if (config.runOnStartup !== false) {
    setTimeout(async () => {
      log('[启动任务] 开始执行首次同步...');
      try {
        await runSync();
        log('[启动任务] 首次同步完成');
      } catch (e) {
        logError(`[启动任务] 首次同步失败: ${e.message}`);
      }
      log('[启动任务] 开始执行首次 AList 下载...');
      try {
        await runAlist();
        log('[启动任务] 首次 AList 下载完成');
      } catch (e) {
        logError(`[启动任务] 首次 AList 下载失败: ${e.message}`);
      }
    }, 1000);
  }

  const shutdown = () => {
    log('正在关闭网页服务...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
}

export { createServer, maskSecret, mergeSecrets, validateConfig, configForClient };
