# quark-sync

自动从夸克网盘分享链接中提取最近更新的文件并转存到自己的网盘，支持定时同步、本地下载和 AList 下载。（注：本项目完全使用DeepSeek V4 Pro生成。）

## 功能

- **自动转存** — 监控多个夸克网盘分享链接，将最近更新的文件自动转存到自己的网盘
- **网页管理界面** — 浏览器里维护配置、查看日志、手动触发任务，改完即时生效无需重启
- **过滤去重** — 按更新时间窗口过滤，按"文件名+大小"自动去重，避免重复转存
- **小文件过滤** — 支持按文件大小下限过滤（`minFileSizeMB`），小于指定 MB 的文件不转存，可按分享链接单独配置
- **数量限制** — 支持每分享链接最多转存 N 条最新文件（`maxFilesPerShare`），可按分享链接单独配置
- **文件重命名** — 支持为转存文件添加前缀（如 `遮天-`、`斗破苍穹-`），便于分类管理
- **定时调度** — 支持 cron 表达式定时执行同步和下载任务
- **夸克下载** — 将夸克网盘指定文件夹的文件下载到本地
- **AList 下载** — 支持从 AList 服务器下载文件到本地
- **进程锁 / 任务互斥** — 下载模式加文件锁防止并发损坏；同步与 AList 任务互斥，定时与手动触发不会重复转存

## 安装

```bash
git clone <repo-url>
cd quark-sync
npm install
```

## 配置

复制示例配置文件并修改：

```bash
cp config.example.json config.json
```

### 配置项说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `cookie` | string | 是 | 夸克网盘登录后的完整 Cookie 字符串 |
| `shareUrls` | array | 是 | 分享链接列表，每项包含 `url`（链接，可为字符串或数组作为备用链接，按序 failover）、`password`（提取码，可选）、`tip`（文件名前缀，可选），以及可选的 per-share 覆盖项 `hours`、`minFileSizeMB`、`maxFilesPerShare`（均优先于全局同名配置） |
| `shareUrl` | string | 否 | 单个分享链接（与 `shareUrls` 二选一） |
| `password` | string | 否 | 默认提取码 |
| `tip` | string | 否 | 默认文件名前缀 |
| `hours` | int/string | 否 | 时间窗口，默认 48 小时。支持单位写法：`30m` 分钟、`12h` 小时、`1d` 天、`1w` 周、`1mo` 月（30 天）、`1y` 年（365 天），也支持小数（`1.5d`）与纯数字（按小时）。可在 `shareUrls` 内单项覆盖 |
| `days` | int | 否 | 时间窗口（天），等价于 `hours = days * 24`；仅当未设置 `hours` 时生效（历史字段） |
| `minFileSizeMB` | int | 否 | 最小文件大小过滤（MB），小于此值的文件不转存，默认 0 不过滤。可在 `shareUrls` 内单项覆盖 |
| `maxFilesPerShare` | int | 否 | 每分享最多转存文件数，按更新时间倒序取最新 N 条，默认 0 不限制。可在 `shareUrls` 内单项覆盖 |
| `targetDirName` | string | 否 | 转存目标文件夹名称，默认 `来自：分享` |
| `targetDirFid` | string | 否 | 转存目标文件夹 ID（优先级高于 targetDirName） |
| `downloadDir` | string | 否 | 本地下载目录路径 |
| `deleteAfterDownload` | bool | 否 | 下载后是否删除云盘文件 |
| `cleanupAfterDays` | int | 否 | 定时任务触发时，自动删除 N 天前同步的文件（云端 + 本地下载），设为 0 禁用，默认 14 |
| `alistUrl` | string | 否 | AList 服务器地址 |
| `alistPath` | string | 否 | AList 下载路径 |
| `alistRefresh` | bool | 否 | AList 列出文件时是否绕过缓存（需管理员权限），默认 false |
| `alistToken` | string | 否 | AList 认证 Token |
| `syncCron` | string/array | 否 | 同步任务的 cron 表达式，支持数组 |
| `alistCron` | string/array | 否 | AList 下载任务的 cron 表达式，支持数组 |
| `pollInterval` | int | 否 | 任务轮询间隔（毫秒） |
| `pruneDeadShares` | bool | 否 | 任务执行后自动从配置中移除**确定失效**的分享链接，默认 false（仅报告）。临时网络故障、限流、提取码错误都不会误删 |
| `webPort` | int | 否 | 网页管理界面监听端口，默认 3000 |
| `webHost` | string | 否 | 网页监听地址，默认 `0.0.0.0`（局域网可访问）；设为 `127.0.0.1` 则仅本机 |
| `webToken` | string | 否 | 网页登录 Token，**留空则网页功能禁用**（防止无鉴权暴露 Cookie） |
| `runOnStartup` | bool | 否 | `web` 模式启动后是否立即跑一次同步与 AList 下载，默认 true；设为 false 可关闭 |

### 获取 Cookie

1. 浏览器打开 [pan.quark.cn](https://pan.quark.cn) 并登录
2. 按 `F12` 打开开发者工具
3. 进入 `Application` → `Cookies` → 复制完整的 Cookie 字符串
4. 粘贴到 `config.json` 的 `cookie` 字段

### 配置示例

```json
{
  "cookie": "你的夸克Cookie字符串",
  "hours": 3,
  "minFileSizeMB": 100,
  "maxFilesPerShare": 3,
  "targetDirName": "来自：分享",
  "shareUrls": [
    {
      "url": "https://pan.quark.cn/s/xxxxxxxx",
      "password": "提取码",
      "tip": "遮天-",
      "hours": 6,
      "minFileSizeMB": 200,
      "maxFilesPerShare": 2
    },
    {
      "url": "https://pan.quark.cn/s/yyyyyyyy",
      "tip": "斗破苍穹-"
    },
    {
      "url": ["https://pan.quark.cn/s/main1", "https://pan.quark.cn/s/backup1"],
      "tip": "备用链接示例",
      "maxFilesPerShare": 0
    }
  ]
}
```

上例中第三个分享显式写 `"maxFilesPerShare": 0`，表示该链接**不受全局 `maxFilesPerShare: 3` 限制**（`0` 会覆盖全局值）；若想让某链接只做「不限制」覆盖，写法即如此。省略该字段则继承全局值。

> `hours`、`minFileSizeMB`、`maxFilesPerShare` 三者统一使用 `??`（nullish）合并，因此写 `0` 均为**显式覆盖**而非「未配置」。注意 `"hours": 0` 会把时间窗口设为 0 小时（即只转存"此刻及之后更新"的文件，实际等于不转存任何文件），通常不是你想要的结果；若只想沿用全局窗口，请直接省略该字段。

### 时间窗口的单位写法

`hours` 除纯数字（按小时）外，还支持带单位的写法，便于表达较长的窗口：

| 写法 | 含义 | 折算小时 |
| --- | --- | --- |
| `30m` | 30 分钟 | 0.5 |
| `12h` / `12hr` | 12 小时 | 12 |
| `1d` | 1 天 | 24 |
| `1w` | 1 周（7 天） | 168 |
| `1mo` | 1 个月（按 30 天计） | 720 |
| `1y` | 1 年（按 365 天计） | 8760 |

- 支持小数与混合大小写：`1.5d`、`0.5w`、`2D`、`"1 d"`（含空格）均可
- 纯数字仍按**小时**解释，因此旧的 `"hours": 24` 配置不受影响
- ⚠️ **`m` 表示分钟，月请用 `mo`**。这是有意区分的：`30m` 是 30 分钟，`30mo` 才是 30 个月
- `mo` 与 `y` 为固定折算（30 天 / 365 天），不按自然月或闰年计算
- 无法识别的写法（如 `1x`）会回退到默认值 48 小时；网页保存时会拒绝并提示

同样适用于 `shareUrls` 中每项的 `hours` 覆盖，例如：

```json
{
  "hours": "1d",
  "shareUrls": [
    { "url": "https://pan.quark.cn/s/xxxx", "tip": "日更-", "hours": "12h" },
    { "url": "https://pan.quark.cn/s/yyyy", "tip": "合集-", "hours": "1y" }
  ]
}
```

日志中会以可读形式回显实际窗口，例如 `时间范围: 最近 1 天更新`。

## 使用方法

### 同步模式（默认）

检查所有分享链接中最近更新的文件，转存到自己的网盘：

```bash
npm start
# 或
npm run sync
# 或
node index.js
```

### 下载模式

将夸克网盘指定文件夹的文件下载到本地：

```bash
npm run download
# 或
node index.js download
```

下载后会生成 `.downloaded.json` 记录已下载文件（按文件名+大小），下次运行时自动跳过已下载文件，防止重复下载。

如需强制重新下载所有文件，添加 `--force-download` 参数：

```bash
npm run download-force
# 或
node index.js download --force-download
```

### AList 模式

从 AList 服务器下载文件到本地：

```bash
npm run alist
# 或
node index.js alist
```

同样支持 `--force-download` 强制重新下载：

```bash
npm run alist-force
# 或
node index.js alist --force-download
```

### 定时调度模式

按 cron 表达式定时执行同步和/或 AList 下载任务，持续运行：

```bash
npm run schedule
# 或
node index.js schedule
```

Cron 配置示例：

```json
{
  "syncCron": "0 20 * * *",
  "alistCron": ["5 20 * * *"],
  "cleanupAfterDays": 14
}
```

`syncCron` 和 `alistCron` 支持**字符串或数组**：

```json
{
  "syncCron": ["0 11 * * *", "0 20 * * *"],
  "alistCron": ["5 11 * * *", "5 20 * * *"],
  "cleanupAfterDays": 14
}
```

### 网页管理界面（推荐）

`web` 模式同时启动 HTTP 管理界面和定时任务（同一进程），可以在浏览器里维护配置、查看日志、手动触发任务：

```bash
npm run web
# 或
node index.js web
```

启动前必须先在 `config.json` 里设置 `webToken`（至少 8 位），否则会拒绝启动 —— 因为配置中包含等同账号密码的 Cookie，不能无鉴权地暴露出去：

```json
{
  "webToken": "换成一个只有你知道的随机字符串",
  "webPort": 3000,
  "webHost": "0.0.0.0"
}
```

然后浏览器访问 `http://<主机IP>:3000`，输入 Token 登录。功能包括：

| 页面 | 能力 |
| --- | --- |
| **分享链接**（默认页） | 表格化维护 `shareUrls`：一行一个分享，链接格写多行即为「备用链接组」（按序 failover），每项可单独覆盖时间窗口 / 最小体积 / 数量限制。底部常驻保存栏在任何页面都可用 |
| **配置** | 表单化编辑其余全部配置项，按「账号与目标 / 同步与下载 / 服务与调度」三个可折叠分组组织；保存后**定时任务自动重载，无需重启** |
| **日志** | 按级别（INFO/ERROR）、关键字过滤，可调行数与自动刷新；只读取文件尾部，日志很大也不卡 |
| **任务** | 查看每个 cron 任务的状态与**下次运行时间**，并可立即手动执行同步 / AList 下载 |

几点安全与行为说明：

- **Cookie 不回显**：`GET /api/config` 只返回形如 `sk-a****wxyz` 的掩码值，完整 Cookie 永不下发到浏览器；保存时若回传掩码值，后端会保留磁盘上的原值，不会把掩码写进配置。
- **Token 可热更新**：在网页里修改 `webToken` 后立即生效，旧 Token 立刻失效，**不需要重启**（已登录的会话仍然有效）。
- **默认监听 `0.0.0.0`**，即局域网可访问（方便手机/其他设备打开）。如果只想本机使用，把 `webHost` 设为 `127.0.0.1`。注意 Docker 的 `ports` 映射会绕过这一层保护，**鉴权是唯一防线**，请务必使用足够复杂的 `webToken`。
- **任务互斥**：同步与 AList 任务同一时间只允许一个运行，定时触发与网页手动触发共用同一把锁，重复触发会返回「已有任务正在运行中」，因此不会并发重复转存。
- **启动任务**：进程启动后会先跑一次同步和 AList 下载（替代原先由 `docker-entrypoint.sh` 执行的启动任务），设置为 `"runOnStartup": false` 可关闭。

#### Docker 部署

`docker-compose.yml` 已经映射了 `3000:3000` 并设置 `TZ=Asia/Shanghai`，容器默认以 `web` 模式启动：

```bash
docker compose up -d
```

首次启动若 `config/config.json` 不存在，会从模板自动生成 —— 记得先填好 `cookie` 和 `webToken` 再重启容器。

#### 自行构建镜像

发布流程：**先改 `package.json` 的版本号并提交，再构建推送**，这样镜像内记录的版本与 tag 才一致。

```bash
npm run docker:build          # 构建 linux/amd64 + linux/arm64 并推送 latest 与 <版本号>
npm run docker:build:local    # 仅本地构建（单平台、不推送），用于验证
```

`docker:build` 会读取 `package.json` 的 `version`，同时打上 `latest` 与 `1.2.0` 这样的版本 tag；
发布前若工作区有未提交改动、或 HEAD 中的版本与工作区不一致，会给出警告。

## 工作流程

### 同步模式
1. 加载 `config.json` 并验证 Cookie 有效性
2. 遍历 `shareUrls` 中的每个分享链接，获取目录树（失效链接自动跳过）
3. 筛选出 `hours` 时间窗口内更新的文件（可每个链接单独配置）
4. 按 `minFileSizeMB` 过滤掉过小的文件（可每个链接单独配置）
5. 按 `maxFilesPerShare` 限制数量，只保留更新时间最新的 N 条（可每个链接单独配置）
6. 与目标文件夹已有文件比对去重（按文件名 + 文件大小）
7. 分批（每批 20 个）将新文件转存到目标文件夹
8. 若配置了 `tip` 前缀，自动重命名转存后的文件

### 下载模式
1. 列出网盘目标文件夹中的所有文件
2. 从 `.downloaded.json` 加载已下载记录，跳过已完成的文件（按文件名+大小匹配）
3. 分批（每批 10 个）获取下载地址，并行下载（并发 3 个）
4. 每个文件下载成功后立即写入 `.downloaded.json`，即使中途中断也不会重复下载
5. 若启用 `deleteAfterDownload`，下载后从网盘删除文件

## 日志

所有运行日志写入项目根目录的 `sync.log`，包含时间戳和日志级别。日志按时间**顺序追加**（旧 → 新），自动保留最近 7 天。

网页界面从文件尾部读取，因此日志文件很大时也只读取需要的部分。若检测到旧版本留下的倒序日志（最新在前），会在首次写入时自动迁移为顺序。

## 项目结构

| 文件 | 说明 |
| --- | --- |
| `index.js` | 核心逻辑：夸克/AList API 封装、同步、下载、cron 调度、CLI 入口 |
| `web.js` | 网页管理界面后端：HTTP 服务、鉴权、配置读写、日志与任务接口 |
| `ui.html` | 网页前端页面（零构建，单文件） |

## 依赖

- [axios](https://github.com/axios/axios) — HTTP 客户端
- [node-cron](https://github.com/node-cron/node-cron) — Cron 定时调度

网页界面基于 Node 内置 `node:http`，**不引入任何新的第三方依赖**。

## 许可

MIT
