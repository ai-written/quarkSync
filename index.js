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

function cleanupOldLogs() {
  if (!fs.existsSync(LOG_FILE)) return;
  const content = fs.readFileSync(LOG_FILE, 'utf-8');
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const lines = content.split('\n');
  const kept = lines.filter(line => {
    const m = line.match(/^\[(\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2})\]/);
    if (!m) return true;
    const d = new Date(m[1]);
    return !isNaN(d) && d.getTime() > weekAgo;
  });
  if (kept.length !== lines.length) {
    fs.writeFileSync(LOG_FILE, kept.join('\n'), 'utf-8');
  }
}

function writeLog(level, message) {
  cleanupOldLogs();
  const line = `[${now()}] [${level}] ${message}\n`;
  const old = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf-8') : '';
  fs.writeFileSync(LOG_FILE, line + old, 'utf-8');
}

function log(message) {
  console.log(message);
  writeLog('INFO', message);
}

function logError(message) {
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
      } else {
        skipped++;
      }
    } catch {}
  }
  return { deleted, skipped };
}

function acquireLock(lockName, lockDir) {
  const lockFile = path.join(lockDir, lockName);
  if (fs.existsSync(lockFile)) {
    let pid;
    try { pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10); } catch { pid = 0; }
    if (pid) {
      try {
        process.kill(pid, 0);
        logError(`检测到另一个进程 (PID: ${pid}) 正在 "${lockName}" 中运行，已退出。`);
        process.exit(0);
      } catch {}
    }
    try { fs.unlinkSync(lockFile); } catch {}
  }
  fs.writeFileSync(lockFile, String(process.pid), 'utf-8');
  const release = () => { try { fs.unlinkSync(lockFile); } catch {} };
  process.once('exit', release);
  process.once('SIGINT', () => { release(); process.exit(0); });
  process.once('SIGTERM', () => { release(); process.exit(0); });
}

function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('错误: 找不到 config.json，请复制 config.example.json 并填写配置');
    process.exit(1);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    console.error('错误: config.json 格式不正确');
    process.exit(1);
  }
}

function parseShareUrl(url) {
  const match = url.match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error('无法解析分享链接');
  return match[1].split('#')[0].split('?')[0];
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
    const files = await this.listAllUserFiles(pdirFid);
    log(`   ✓ 共 ${files.length} 个文件\n`);

    const downloadedRecord = skipExisting ? loadDownloadedRecord(saveDir) : new Map();
    const toDownload = skipExisting
      ? files.filter(f => !downloadedRecord.has(`${f.file_name}|${f.size || ''}`))
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
          downloadedRecord.set(`${s.file_name}|${s.size || ''}`, true);
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

async function syncMode() {
  log('=== 夸克网盘自动同步工具 ===\n');

  const config = loadConfig();

  if (!config.cookie || config.cookie === '从浏览器复制的完整 Cookie 字符串') {
    logError('错误: 请在 config.json 中填写有效的 Cookie');
    process.exit(1);
  }

  const shareUrls = normalizeShareUrls(config);
  if (shareUrls.length === 0) {
    logError('错误: 请在 config.json 中填写 shareUrl 或 shareUrls');
    process.exit(1);
  }

  const hours = config.hours || (config.days ? config.days * 24 : 48);
  const pollInterval = config.pollInterval || 1000;

  const client = new QuarkClient(config.cookie);

  log('0. 验证登录状态...');
  const nickname = await client.checkLogin();
  if (!nickname) {
    logError('   ✗ Cookie 无效或已过期！请重新从浏览器获取 Cookie');
    logError('   步骤: 打开 pan.quark.cn 并登录 → F12 → Application → Cookies → 复制完整 Cookie 串');
    process.exit(1);
  }

  log('1. 确定保存目标文件夹...');
  const targetDirFid = await client.resolveTargetDir(config);

  let totalSuccess = 0;
  let totalFailed = 0;
  const allSuccess = [];
  const allFailed = [];

  for (let si = 0; si < shareUrls.length; si++) {
    const { url, password, tip, hours: itemHours } = shareUrls[si];
    const shareTip = tip || config.tip;
    const shareHours = itemHours || hours;
    const pwdId = parseShareUrl(url);
    const passcode = password || config.password || '';

    if (shareUrls.length > 1) {
      log(`\n${'═'.repeat(50)}`);
      log(`处理第 ${si + 1}/${shareUrls.length} 个分享`);
      log(`分享 ID: ${pwdId}`);
    } else {
      log(`分享 ID: ${pwdId}`);
    }
    log(`时间范围: 最近 ${shareHours} 小时更新\n`);

    try {
    log(`2. 获取分享 token (${pwdId})...`);
    const stoken = await client.getShareToken(pwdId, passcode);
    log('   ✓ 获取成功\n');

    log('3. 列出分享文件 (递归获取所有子文件夹)...');
    const allFiles = await client.listAllShareFiles(pwdId, stoken);
    log(`   ✓ 共找到 ${allFiles.length} 个项目 (含文件夹)\n`);

    const filesOnly = allFiles.filter(f => !f.dir);
    log(`   其中文件: ${filesOnly.length} 个`);

    const recentFiles = filterByHours(allFiles, shareHours);
    log(`   最近 ${shareHours} 小时更新的文件: ${recentFiles.length} 个\n`);

    if (recentFiles.length === 0) {
      log('没有找到符合条件的文件，无需转存。');
      continue;
    }

    log('   检查目标文件夹中已存在的文件...');
    const existingMap = await client.getExistingFileMap(targetDirFid);
    const newFiles = recentFiles.filter(f => {
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
  }

  if (config.cleanupAfterDays && config.cleanupAfterDays > 0) {
    log(`\n执行清理 (${config.cleanupAfterDays}天前的文件)...`);
    await client.cleanupOldFiles(targetDirFid, config.cleanupAfterDays);
    const downloadDir = path.resolve(config.downloadDir || '.');
    cleanupLocalFiles(downloadDir, config.cleanupAfterDays);
  }
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
    const files = await this.listAllFiles(alistPath);
    log(`   ✓ 共 ${files.length} 个文件\n`);

    const downloadedRecord = skipExisting ? loadDownloadedRecord(saveDir) : new Map();
    const toDownload = skipExisting
      ? files.filter(f => !downloadedRecord.has(`${f.name}|${f.size || ''}`))
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
            downloadedRecord.set(`${f.name}|${f.size || ''}`, true);
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

async function scheduleMode() {
  const config = loadConfig();
  const tasks = [];

  const syncCrons = [].concat(config.syncCron || []).filter(Boolean);
  const alistCrons = [].concat(config.alistCron || []).filter(Boolean);

  for (const c of syncCrons) {
    tasks.push({ name: '同步模式', cron: c, fn: () => runSync(config) });
  }
  for (const c of alistCrons) {
    tasks.push({ name: 'AList下载', cron: c, fn: () => runAlist(config) });
  }

  if (tasks.length === 0) {
    logError('错误: 请在 config.json 中配置 syncCron 或 alistCron');
    process.exit(1);
  }

  log('=== 夸克网盘定时任务 ===\n');
  for (const t of tasks) {
    if (!cron.validate(t.cron)) {
      logError(`   ✗ 无效 cron: ${t.cron}`);
      process.exit(1);
    }
    cron.schedule(t.cron, async () => {
      log(`\n[${now()}] 触发: ${t.name}`);
      try {
        await t.fn();
      } catch (e) {
        logError(`   异常: ${e.message}`);
      }
    });
    log(`   ✓ ${t.name}: "${t.cron}"`);
  }
  log('\n   定时任务已启动，等待触发...\n');
}

async function runSync(config) {
  const client = new QuarkClient(config.cookie);
  const nickname = await client.checkLogin();
  if (!nickname) { logError('   Cookie 无效'); return; }
  const dirFid = await client.resolveTargetDir(config);
  const hours = config.hours || (config.days ? config.days * 24 : 48);
  const pollInterval = config.pollInterval || 1000;
  const shareUrls = normalizeShareUrls(config);
  let totalSuccess = 0, totalFailed = 0;
  const allSuccess = [], allFailed = [];
  for (const { url, password, tip, hours: itemHours } of shareUrls) {
    const shareTip = tip || config.tip;
    const shareHours = itemHours || hours;
    const pwdId = parseShareUrl(url);
    const passcode = password || config.password || '';
    try {
      const stoken = await client.getShareToken(pwdId, passcode);
      const allFiles = await client.listAllShareFiles(pwdId, stoken);
      const recentFiles = filterByHours(allFiles, shareHours);

      if (recentFiles.length === 0) continue;
      const existingMap = await client.getExistingFileMap(dirFid);
      const newFiles = recentFiles.filter(f => {
        const key = `${f.file_name}|${f.size || ''}`;
        if (existingMap.has(key)) return false;
        if (shareTip) {
          const prefix = shareTip.endsWith('-') ? shareTip : `${shareTip}-`;
          if (existingMap.has(`${prefix}${f.file_name}|${f.size || ''}`)) return false;
        }
        return true;
      });
      if (newFiles.length === 0) continue;
      const results = await client.saveFilesInBatches(pwdId, stoken, newFiles, dirFid, pollInterval);
      let renamedNames = results.success;
      if (shareTip && results.success.length > 0) {
        renamedNames = [];
        await new Promise(r => setTimeout(r, 2000));
        const prefix = shareTip.endsWith('-') ? shareTip : `${shareTip}-`;
        let existingFiles = await client.listAllUserFiles(dirFid);
        let existingNames = new Set(existingFiles.map(f => f.file_name));
        for (const name of results.success) {
          const newName = `${prefix}${name}`;
          if (existingNames.has(newName)) { renamedNames.push(newName); continue; }
          let match = existingFiles.find(f => f.file_name === name);
          if (!match) {
            await new Promise(r => setTimeout(r, 1000));
            existingFiles = await client.listAllUserFiles(dirFid);
            existingNames = new Set(existingFiles.map(f => f.file_name));
            match = existingFiles.find(f => f.file_name === name);
          }
          if (!match) { renamedNames.push(name); continue; }
          try { await client.renameFile(match.fid, newName); renamedNames.push(newName); } catch { renamedNames.push(name); }
        }
      }
      totalSuccess += results.success.length;
      totalFailed += results.failed.length;
      allSuccess.push(...renamedNames);
      allFailed.push(...results.failed);
    } catch (e) {
      logError(`   ✗ 处理分享 "${url}" ${shareTip ? `(${shareTip}) ` : ''}失败: ${e.message}`);
      continue;
    }
  }
  log(`   同步完成: 成功 ${totalSuccess} 失败 ${totalFailed}`);
  if (allSuccess.length > 0) {
    log('   成功转存的文件:');
    for (const name of allSuccess) log(`     ✓ ${name}`);
  }
  if (allFailed.length > 0) {
    log('   失败的文件:');
    for (const name of allFailed) log(`     ✗ ${name}`);
  }

  if (config.cleanupAfterDays && config.cleanupAfterDays > 0) {
    log(`\n   执行清理 (${config.cleanupAfterDays}天前的文件)...`);
    await client.cleanupOldFiles(dirFid, config.cleanupAfterDays);
    const localResult = cleanupLocalFiles(path.resolve(config.downloadDir || '.'), config.cleanupAfterDays);
    if (localResult.deleted > 0) {
      log(`   ✓ 本地清理完成: 删除 ${localResult.deleted} 个，保留 ${localResult.skipped} 个\n`);
    }
  }
}

async function runAlist(config) {
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
} else {
  syncMode().catch(err => {
    logError('\n程序异常: ' + err.message);
    process.exit(1);
  });
}
