#!/usr/bin/env node
/**
 * 构建并推送多架构 Docker 镜像。
 *
 * 与直接写在 npm script 里的区别：
 *  - 从 package.json 读取版本号，同时打 latest 与版本 tag，避免两者不一致
 *  - 跨平台（Windows 的 cmd 与类 Unix 的 sh 对 $-变量 的展开规则不同，
 *    因此不在 script 里做 shell 变量替换）
 *
 * 用法：
 *   node scripts/docker-build.mjs                # 构建并推送 latest + <version>
 *   node scripts/docker-build.mjs --no-push      # 只本地构建，不推送（用于验证）
 *   node scripts/docker-build.mjs --tag dev      # 追加自定义 tag
 *   node scripts/docker-build.mjs --platform linux/amd64
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const IMAGE = 'hsiangleev/quark-sync';
const DEFAULT_PLATFORMS = 'linux/amd64,linux/arm64';

function fail(msg) {
  console.error(`\n错误: ${msg}`);
  process.exit(1);
}

// ---- 参数解析 ----
const argv = process.argv.slice(2);
let push = true;
let platforms = process.env.DOCKER_PLATFORMS || DEFAULT_PLATFORMS;
const extraTags = [];
const passthrough = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-push') push = false;
  else if (a === '--platform' || a === '-p') {
    const v = argv[++i];
    if (!v) fail('--platform 需要参数');
    platforms = v;
  } else if (a === '--tag' || a === '-t') {
    const v = argv[++i];
    if (!v) fail('--tag 需要参数');
    extraTags.push(v);
  } else if (a === '--help' || a === '-h') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').slice(1, 17).map(l => l.replace(/^\s*(\*|\/\*\*)?\s?/, '')).join('\n'));
    process.exit(0);
  } else passthrough.push(a);
}

// ---- 读取版本号 ----
const pkgPath = path.join(ROOT, 'package.json');
if (!fs.existsSync(pkgPath)) fail('找不到 package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`package.json 中的 version 不合法: ${JSON.stringify(pkg.version)}`);

// ---- 一致性检查：避免发布未提交的代码 ----
try {
  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }).trim();
  if (porcelain) {
    console.warn('⚠ 工作区有未提交的改动，镜像内容将包含这些改动：');
    for (const line of porcelain.split('\n').slice(0, 10)) console.warn('    ' + line);
    console.warn('  （如需发布已提交的版本，请先 commit）');
  }
  const headPkg = execFileSync('git', ['show', 'HEAD:package.json'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  const headVersion = JSON.parse(headPkg).version;
  if (headVersion !== version) {
    console.warn(`⚠ HEAD 中的版本 (${headVersion}) 与工作区 (${version}) 不一致，镜像内将写入 ${version}`);
  }
} catch {
  // 非 git 环境或缺少 git：不阻断构建
}

// ---- 组装 tag 与命令 ----
const tags = [`${IMAGE}:latest`, `${IMAGE}:${version}`, ...extraTags.map(t => `${IMAGE}:${t}`)];
const cmd = ['buildx', 'build', '--platform', platforms];
for (const t of tags) cmd.push('-t', t);
if (push) cmd.push('--push');
cmd.push(...passthrough, '.');

console.log('=== Docker 构建 ===');
console.log(`  版本   : ${version}`);
console.log(`  镜像   : ${tags.join(', ')}`);
console.log(`  平台   : ${platforms}`);
console.log(`  推送   : ${push ? '是' : '否（本地构建）'}`);
console.log('');

try {
  execFileSync('docker', cmd, { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  fail(`docker buildx 失败（退出码 ${e.status}）`);
}

console.log('\n=== 完成 ===');
for (const t of tags) console.log(`  ${t}`);
if (push) {
  console.log('\n可用 docker buildx imagetools inspect <tag> 校验远端 digest。');
}
