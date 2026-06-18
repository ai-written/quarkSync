import axios from 'axios';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_FILE = path.join(__dirname, 'sync.log');

function now() {
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function writeLog(level, message) {
  const line = `[${now()}] [${level}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf-8');
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
    const successFids = [];
    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        const savePath = path.join(saveDir, item.file_name);
        try {
          await this.downloadFile(item.download_url, savePath);
          successFids.push(item.fid);
        } catch (e) {
          log(`   ✗ ${item.file_name} 下载失败: ${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return successFids;
  }

  async downloadAllFromFolder(pdirFid, saveDir, skipExisting = true, deleteAfter = false) {
    log(`   列出目标文件夹中的文件...`);
    const files = await this.listAllUserFiles(pdirFid);
    log(`   ✓ 共 ${files.length} 个文件\n`);

    const toDownload = skipExisting
      ? files.filter(f => !fs.existsSync(path.join(saveDir, f.file_name)))
      : files;

    if (toDownload.length === 0) {
      log(`   所有文件已存在本地，无需下载。`);
      return;
    }

    log(`   待下载: ${toDownload.length} 个 (已跳过 ${files.length - toDownload.length} 个已存在的)\n`);

    const batchSize = 10;
    let downloaded = 0;
    const downloadedFids = [];
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
      const successFids = await this.downloadFilesParallel(urls, saveDir, 3);
      downloaded += successFids.length;
      downloadedFids.push(...successFids);
    }
    log(`\n   下载完成: ${downloaded}/${toDownload.length} 个`);

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

  for (let si = 0; si < shareUrls.length; si++) {
    const { url, password, tip } = shareUrls[si];
    const shareTip = tip || config.tip;
    const pwdId = parseShareUrl(url);
    const passcode = password || config.password || '';

    if (shareUrls.length > 1) {
      log(`\n${'═'.repeat(50)}`);
      log(`处理第 ${si + 1}/${shareUrls.length} 个分享`);
      log(`分享 ID: ${pwdId}`);
    } else {
      log(`分享 ID: ${pwdId}`);
    }
    log(`时间范围: 最近 ${hours} 小时更新\n`);

    log('2. 获取分享 token...');
    const stoken = await client.getShareToken(pwdId, passcode);
    log('   ✓ 获取成功\n');

    log('3. 列出分享文件 (递归获取所有子文件夹)...');
    const allFiles = await client.listAllShareFiles(pwdId, stoken);
    log(`   ✓ 共找到 ${allFiles.length} 个项目 (含文件夹)\n`);

    const filesOnly = allFiles.filter(f => !f.dir);
    log(`   其中文件: ${filesOnly.length} 个`);

    const recentFiles = filterByHours(allFiles, hours);
    log(`   最近 ${hours} 小时更新的文件: ${recentFiles.length} 个\n`);

    if (recentFiles.length === 0) {
      log('没有找到符合条件的文件，无需转存。');
      continue;
    }

    log('   检查目标文件夹中已存在的文件...');
    const existingMap = await client.getExistingFileMap(targetDirFid);
    const newFiles = recentFiles.filter(f => {
      const key = `${f.file_name}|${f.size || ''}`;
      return !existingMap.has(key);
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

    if (shareTip && results.success.length > 0) {
      log('\n   添加文件名前缀...');
      const prefix = shareTip.endsWith('-') ? shareTip : `${shareTip}-`;
      const existingFiles = await client.listAllUserFiles(targetDirFid);
      const existingNames = new Set(existingFiles.map(f => f.file_name));
      let renamed = 0;
      for (const name of results.success) {
        const newName = `${prefix}${name}`;
        if (existingNames.has(newName)) {
          log(`   ⏭ ${name} (${newName} 已存在)`);
          continue;
        }
        const match = existingFiles.find(f => f.file_name === name);
        if (!match) {
          log(`   ✗ ${name} 未找到，可能尚未完成处理`);
          continue;
        }
        try {
          await client.renameFile(match.fid, newName);
          renamed++;
          log(`   ✓ ${name} → ${newName}`);
        } catch (e) {
          log(`   ✗ ${name} 重命名失败: ${e.message}`);
        }
      }
      if (renamed > 0) log(`   已重命名 ${renamed} 个文件\n`);
    }

    totalSuccess += results.success.length;
    totalFailed += results.failed.length;
  }

  if (shareUrls.length > 1) {
    log(`\n${'═'.repeat(50)}`);
    log('=== 全部转存结果汇总 ===');
    log(`共处理 ${shareUrls.length} 个分享，成功: ${totalSuccess} 个，失败: ${totalFailed} 个`);
  }
}

async function downloadMode() {
  const config = loadConfig();
  const client = new QuarkClient(config.cookie);

  log('=== 夸克网盘下载到本地 ===\n');

  log('0. 验证登录状态...');
  const nickname = await client.checkLogin();
  if (!nickname) {
    logError('   ✗ Cookie 无效或已过期！');
    process.exit(1);
  }

  log('1. 确定目标文件夹...');
  const targetDirFid = await client.resolveTargetDir(config);
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  log(`   保存到: ${saveDir}\n`);

  log('2. 开始下载...');
  await client.downloadAllFromFolder(targetDirFid, saveDir, true, config.deleteAfterDownload);
}

class AlistClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  async _post(path, body = {}) {
    const url = `${this.base}/api/${path}`;
    const resp = await axios.post(url, body, { timeout: 30000, validateStatus: () => true });
    const d = resp.data;
    if (d.code !== 200) {
      throw new Error(`AList API [${d.code}]: ${d.message || JSON.stringify(d)}`);
    }
    return d.data;
  }

  async listDir(dirPath, page = 1, perPage = 0) {
    return this._post('fs/list', { path: dirPath, password: '', page, per_page: perPage, refresh: false });
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

    const toDownload = skipExisting
      ? files.filter(f => !fs.existsSync(path.join(saveDir, f.name)))
      : files;

    if (toDownload.length === 0) {
      log(`   所有文件已存在本地，无需下载。`);
      return;
    }

    log(`   待下载: ${toDownload.length}/${files.length} 个\n`);

    const concurrency = 3;
    const queue = [...toDownload];
    let completed = 0;
    const successPaths = [];
    const worker = async () => {
      while (queue.length > 0) {
        const f = queue.shift();
        const savePath = path.join(saveDir, f.name);
        try {
          await this.downloadFile(f.path, savePath);
          completed++;
          successPaths.push(f.path);
        } catch (e) {
          log(`   ✗ ${f.name}: ${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    log(`\n   下载完成: ${completed}/${toDownload.length} 个`);

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

async function alistMode() {
  const config = loadConfig();
  const alistUrl = config.alistUrl;
  if (!alistUrl) {
    logError('错误: 请在 config.json 中填写 alistUrl');
    process.exit(1);
  }

  const alistPath = config.alistPath || '/kuake/来自：分享';
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  log('=== AList 下载到本地 ===\n');
  log(`AList: ${alistUrl}`);
  log(`路径: ${alistPath}`);
  log(`保存到: ${saveDir}\n`);

  const client = new AlistClient(alistUrl);
  await client.downloadDir(alistPath, saveDir, true, config.deleteAfterDownload);
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

  if (config.syncCron) {
    tasks.push({ name: '同步模式', cron: config.syncCron, fn: () => runSync(config) });
  }
  if (config.alistCron) {
    tasks.push({ name: 'AList下载', cron: config.alistCron, fn: () => runAlist(config) });
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
  for (const { url, password, tip } of shareUrls) {
    const shareTip = tip || config.tip;
    const pwdId = parseShareUrl(url);
    const passcode = password || config.password || '';
    const stoken = await client.getShareToken(pwdId, passcode);
    const allFiles = await client.listAllShareFiles(pwdId, stoken);
    const recentFiles = filterByHours(allFiles, hours);
    if (recentFiles.length === 0) continue;
    const existingMap = await client.getExistingFileMap(dirFid);
    const newFiles = recentFiles.filter(f => !existingMap.has(`${f.file_name}|${f.size || ''}`));
    if (newFiles.length === 0) continue;
    const results = await client.saveFilesInBatches(pwdId, stoken, newFiles, dirFid, pollInterval);
    if (shareTip && results.success.length > 0) {
      const prefix = shareTip.endsWith('-') ? shareTip : `${shareTip}-`;
      const existingFiles = await client.listAllUserFiles(dirFid);
      const existingNames = new Set(existingFiles.map(f => f.file_name));
      for (const name of results.success) {
        const newName = `${prefix}${name}`;
        if (existingNames.has(newName)) continue;
        const match = existingFiles.find(f => f.file_name === name);
        if (!match) continue;
        try { await client.renameFile(match.fid, newName); } catch {}
      }
    }
    totalSuccess += results.success.length;
    totalFailed += results.failed.length;
  }
  log(`   同步完成: 成功 ${totalSuccess} 失败 ${totalFailed}`);
}

async function runAlist(config) {
  const alistUrl = config.alistUrl;
  const alistPath = config.alistPath || '/kuake/来自：分享';
  const saveDir = path.resolve(config.downloadDir || '.');
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const client = new AlistClient(alistUrl);
  await client.downloadDir(alistPath, saveDir, true, config.deleteAfterDownload);
  log(`   AList下载完成`);
}

const mode = process.argv[2];
if (mode === '--download' || mode === 'download') {
  downloadMode().catch(err => {
    logError('\n程序异常: ' + err.message);
    process.exit(1);
  });
} else if (mode === '--schedule' || mode === 'schedule') {
  scheduleMode().catch(err => {
    logError('\n程序异常: ' + err.message);
    process.exit(1);
  });
} else if (mode === '--alist' || mode === 'alist') {
  alistMode().catch(err => {
    logError('\n程序异常: ' + err.message);
    process.exit(1);
  });
} else {
  syncMode().catch(err => {
    logError('\n程序异常: ' + err.message);
    process.exit(1);
  });
}
