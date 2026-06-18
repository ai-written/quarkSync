# quark-sync

自动从夸克网盘分享链接中提取最近更新的文件并转存到自己的网盘，支持定时同步、本地下载和 AList 下载。（注：本项目完全使用DeepSeek V4 Pro生成。）

## 功能

- **自动转存** — 监控多个夸克网盘分享链接，将最近更新的文件自动转存到自己的网盘
- **过滤去重** — 按更新时间窗口过滤，按“文件名+大小”自动去重，避免重复转存
- **文件重命名** — 支持为转存文件添加前缀（如 `遮天-`、`斗破苍穹-`），便于分类管理
- **定时调度** — 支持 cron 表达式定时执行同步和下载任务
- **夸克下载** — 将夸克网盘指定文件夹的文件下载到本地
- **AList 下载** — 支持从 AList 服务器下载文件到本地

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
|---|---|---|---|
| `cookie` | string | 是 | 夸克网盘登录后的完整 Cookie 字符串 |
| `shareUrls` | array | 是 | 分享链接列表，每项包含 `url`（链接）、`password`（提取码，可选）、`tip`（文件名前缀，可选） |
| `shareUrl` | string | 否 | 单个分享链接（与 `shareUrls` 二选一） |
| `password` | string | 否 | 默认提取码 |
| `tip` | string | 否 | 默认文件名前缀 |
| `hours` | int | 否 | 时间窗口（小时），只转存该时间范围内的文件，默认 48 |
| `targetDirName` | string | 否 | 转存目标文件夹名称，默认 `来自：分享` |
| `targetDirFid` | string | 否 | 转存目标文件夹 ID（优先级高于 targetDirName） |
| `downloadDir` | string | 否 | 本地下载目录路径 |
| `deleteAfterDownload` | bool | 否 | 下载后是否删除云盘文件 |
| `alistUrl` | string | 否 | AList 服务器地址 |
| `alistPath` | string | 否 | AList 下载路径 |
| `alistRefresh` | bool | 否 | AList 列出文件时是否绕过缓存（需管理员权限），默认 false |
| `alistToken` | string | 否 | AList 认证 Token |
| `syncCron` | string | 否 | 同步任务的 cron 表达式 |
| `alistCron` | string | 否 | AList 下载任务的 cron 表达式 |
| `pageSize` | int | 否 | API 分页大小 |
| `pollInterval` | int | 否 | 任务轮询间隔（毫秒） |

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
  "targetDirName": "来自：分享",
  "shareUrls": [
    {
      "url": "https://pan.quark.cn/s/xxxxxxxx",
      "password": "提取码",
      "tip": "遮天-"
    },
    {
      "url": "https://pan.quark.cn/s/yyyyyyyy",
      "tip": "斗破苍穹-"
    }
  ]
}
```

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
  "alistCron": "5 20 * * *"
}
```

以上配置表示每天 20:00 执行同步，20:05 执行 AList 下载。

## 工作流程

### 同步模式
1. 加载 `config.json` 并验证 Cookie 有效性
2. 遍历 `shareUrls` 中的每个分享链接，获取目录树
3. 筛选出 `hours` 时间窗口内更新的文件
4. 与目标文件夹已有文件比对去重（按文件名 + 文件大小）
5. 分批（每批 20 个）将新文件转存到目标文件夹
6. 若配置了 `tip` 前缀，自动重命名转存后的文件

### 下载模式
1. 列出网盘目标文件夹中的所有文件
2. 从 `.downloaded.json` 加载已下载记录，跳过已完成的文件（按文件名+大小匹配）
3. 分批（每批 10 个）获取下载地址，并行下载（并发 3 个）
4. 每个文件下载成功后立即写入 `.downloaded.json`，即使中途中断也不会重复下载
5. 若启用 `deleteAfterDownload`，下载后从网盘删除文件

## 日志

所有运行日志写入项目根目录的 `sync.log`，包含时间戳和日志级别。

## 依赖

- [axios](https://github.com/axios/axios) — HTTP 客户端
- [node-cron](https://github.com/node-cron/node-cron) — Cron 定时调度

## 许可

MIT
