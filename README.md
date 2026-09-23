<div align="center">
  <img src="./client/public/app-icon.png" width="96" height="96" alt="LAN Reader 图标">

  # LAN Reader

  **自托管的私人 EPUB 书架、阅读器与阅读记录。**

  上传、整理并阅读自己的 EPUB，记录每天读了多久、读了多少；书库和数据都保存在你自己的设备上。

  [![Release](https://img.shields.io/github/v/release/natumeAi/lan-reader?display_name=tag)](https://github.com/natumeAi/lan-reader/releases)
  [![Docker Pulls](https://img.shields.io/docker/pulls/lshym123/lan-reader)](https://hub.docker.com/r/lshym123/lan-reader)
  [![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)](#安装为-pwa)
  [![EPUB](https://img.shields.io/badge/format-EPUB-8B5CF6)](#功能)

  [快速开始](#快速开始) · [开始使用](#开始使用) · [阅读统计](#阅读统计) · [数据与备份](#数据与备份) · [源码开发](#源码开发)
</div>

> [!IMPORTANT]
> LAN Reader 面向个人或家庭局域网使用，没有账号系统和访问控制。不要把它直接暴露到公网；如需远程访问，请放在可信 VPN、零信任网络或带身份验证的 HTTPS 反向代理之后。

## 功能

- **首页**：「正在读」列出最近在读的书，封面、进度和上次阅读时间一目了然，点一下就从上次的位置继续。
- **阅读统计**：今日阅读时长与目标进度、近 7 日阅读时长、累计时长、累计字数、读过的书和今年读完的书。
- **阅读目标**：可自行设置每日阅读分钟数和年度读书本数（默认每天 10 分钟、每年 9 本）。
- **私人书库**：一次上传一本或多本 EPUB，自动提取书名、作者、简介和封面。
- **书架整理**：按书名、作者或文件夹搜索；按手动顺序、最近阅读、最近添加、书名或作者排序；拖动换位、把书拖到另一本书上创建文件夹、拖到删除区删除。
- **沉浸阅读**：分页阅读、目录跳转、章节页码与全书进度，插图可全屏查看并双指缩放。
- **阅读外观**：6 种字体（默认、苹方、微软雅黑、黑体、宋体、楷体），白色、暖色、护眼、夜间 4 种主题，以及字号、页边距、行距、字距。
- **自然翻页**：点按页面左右两侧、左右滑动或使用键盘方向键翻页，带推页动画；系统开启“减少动态效果”时自动关闭动画。
- **可靠续读**：每本书单独保存阅读位置；无法精确恢复时保留原记录，可以重试，也可以选择从本章开头继续，并可导出阅读诊断文件。
- **自动入库**：直接把 `.epub` 复制到数据目录的 `books/` 下，应用会自动导入；替换或删除文件也会同步到书库。
- **本地数据**：SQLite 数据库、EPUB 原文件和封面全部保存在挂载的数据目录中。

## 快速开始

### 使用 Docker Compose

准备一台安装了 Docker Engine 与 Docker Compose 的 Linux 主机或 WSL2，然后创建工作目录和数据目录：

```bash
mkdir -p lan-reader/data-lan-reader
cd lan-reader
sudo chown 1000:1000 data-lan-reader
```

容器以镜像内的 `node` 用户（UID 1000）运行，最后一行让它能写入数据目录。

新建 `docker-compose.yml`：

```yaml
name: lan-reader

services:
  lan-reader:
    image: lshym123/lan-reader:latest
    restart: unless-stopped
    init: true
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3000
      EPUB_DATA_DIR: /app/server/data
      DATABASE_PATH: /app/server/data/library.sqlite
    ports:
      - "4081:3000"
    volumes:
      - ./data-lan-reader:/app/server/data
```

启动服务：

```bash
docker compose pull
docker compose up -d --wait
docker compose ps
```

镜像自带健康检查。容器显示为 `healthy` 后，在浏览器打开：

```text
http://你的设备IP:4081
```

本机访问可以用 `http://localhost:4081`。

> [!TIP]
> `4081:3000` 左侧是浏览器访问端口，可以改成任何未被占用的端口；右侧的容器端口保持 `3000` 不变。

## 开始使用

1. 打开后先看到**首页**；点底部导航的**书架**，再点右上角的 **＋** 选择一本或多本 EPUB。
2. 等待校验、元数据和封面解析完成，书会出现在书架上。
3. 点封面开始阅读。点页面中央呼出工具栏，通过“目录”跳转，通过“Aa 设置”调整字体、主题和排版。
4. 读到哪里直接关闭即可，阅读位置会自动保存；回到首页，「正在读」里点一下就能继续。
5. 在书架上按住书并拖动可以调整顺序（手机上需长按约半秒再拖）；拖到另一本书上会合并成文件夹，拖到底部的删除区可以删除（需再次确认）。

如果你更习惯直接管理文件，也可以把完整的 `.epub` 复制到宿主机的 `data-lan-reader/books/`。应用会在文件写入完成后自动导入，并同步之后的替换和删除。

## 阅读统计

首页从上到下依次是：**正在读**、**今日目标**、**近 7 日与累计**、**今年读完的书**。

| 项目 | 含义 |
|---|---|
| 今日目标 | 今天的前台阅读时长和每日目标；超过目标后进度表停在满格，时间继续累计 |
| 近 7 日 | 截至今天的 7 天，每天一根柱子，没阅读的日子显示为横线 |
| 累计时长 | 所有书的阅读时长总和 |
| 累计字数 | 实际显示在屏幕上、读过的正文字数，同一段内容只算一次 |
| 读过 | 读完过的书的本数，每本书只算一次 |
| 今年 / 今年读完的书 | 今年读完的书的数量和封面，与年度目标对比 |

计数规则：

- **时长**只在阅读器打开、页面在前台、正文已加载时计算；打开目录或设置面板、切到后台、加载中或出错时都不计时。查看插图时照常计时。
- **字数**按字符计算：一个汉字、一个字母、一个数字或一个标点都算 1 个字，空格和换行不算。只统计实际显示在屏幕上的正文，回翻重读、调整字号或窗口大小后重新排版，都不会重复计数；翻页很快时，个别没有停稳的页可能不被计入。
- **读完**需要在阅读中翻到最后一页。只是重新打开停在末页的书不会再记一次；同一本书第二年再读完，会计入第二年。
- 日期以阅读设备的本地时间为准。
- 删除一本书会同时删除它的阅读统计；同一个 EPUB 上传两份会被当作两本不同的书分别统计。
- 统计从升级到 2.0 开始记录，不会补算升级前的阅读时长和字数；升级前已经读到 100% 的书会计入「读过」。

## 安装为 PWA

LAN Reader 可以安装到主屏幕，以独立窗口运行：

- **iPhone / iPad**：用 Safari 打开站点，点“分享” → “添加到主屏幕”。
- **Android**：用 Chrome 打开站点，在菜单中选择“安装应用”或“添加到主屏幕”。
- **桌面 Chrome / Edge**：打开站点后，使用地址栏中的安装按钮。

### HTTPS 要求

Service Worker 只能在安全上下文中运行：

- 本机通过 `localhost` 访问时可以使用 HTTP。
- 手机或其他电脑通过局域网 IP 访问时，需要配置 HTTPS 反向代理。
- 直接用 `http://192.168.x.x:4081` 访问可以正常在线阅读，但无法可靠地安装和缓存 PWA。

### 缓存范围

每台设备各自缓存：

- 应用界面；
- 最近一次成功加载的书架数据（离线时可先显示书架）；
- 看过的封面缩略图；
- 尚未上传的阅读进度和阅读记录，恢复网络后自动补传。

EPUB 正文不会离线缓存，因此目前不是完整的离线阅读器。服务器上的书库是唯一的持久数据源，清除浏览器站点数据不会删除服务器上的书。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `3000` | 服务监听端口 |
| `EPUB_DATA_DIR` | `server/data` | EPUB、封面和上传临时目录的根路径 |
| `DATABASE_PATH` | `server/data/library.sqlite` | SQLite 数据库路径 |
| `EPUB_UPLOAD_MAX_MB` | `100` | 单个上传文件的大小上限（MiB） |
| `EPUB_MAX_ENTRIES` | `10000` | 单个 EPUB 压缩包内允许的最多文件数 |
| `EPUB_MAX_ENTRY_MB` | `100` | EPUB 内单个文件解压后的大小上限（MiB） |
| `EPUB_MAX_UNCOMPRESSED_MB` | `500` | EPUB 解压后的总大小上限（MiB） |

容器部署通常只需要调整端口和数据卷。如果修改了 `EPUB_DATA_DIR` 或 `DATABASE_PATH`，请确认运行用户对目标目录有读写权限，并把它持久化挂载到宿主机。

阅读外观设置保存在各自的浏览器中，按访问地址隔离：更换协议、主机名或端口后，需要重新设置一次。

## 数据与备份

数据目录结构：

```text
data-lan-reader/
├── library.sqlite
├── books/
├── covers/
│   └── thumbnails/
└── staging/
```

- `library.sqlite`：书籍信息、书架与文件夹顺序、阅读位置、阅读统计和阅读目标。数据库使用 WAL 模式，运行时旁边还会有 `-wal`、`-shm` 文件。
- `books/`：EPUB 原文件。
- `covers/`：原始封面和生成的 WebP 缩略图。
- `staging/`：上传校验期间的临时目录，过期文件会自动清理。

### 备份

为了得到一致的数据库备份，请先停止容器，再备份整个数据目录：

```bash
docker compose stop
tar -czf ../lan-reader-data-$(date +%Y%m%d).tar.gz data-lan-reader
docker compose start
```

### 恢复

```bash
docker compose down
mv data-lan-reader data-lan-reader.before-restore
tar -xzf ../lan-reader-data-20260923.tar.gz
docker compose up -d --wait
```

请把示例文件名换成实际的备份文件。确认恢复正常后，再自行处理 `data-lan-reader.before-restore`。

### 更新

更新前建议先备份，然后执行：

```bash
docker compose pull
docker compose up -d --wait
docker compose ps
```

数据库迁移会在启动时自动执行，不会移动或重命名已有的 EPUB 原文件。

### 清理旧版封面

新版会在后台为每本书生成 WebP 缩略图。确认缩略图已经生成、数据已备份、并且不再回退到旧镜像后，可以先预览可清理的旧封面：

```bash
docker compose exec lan-reader npm run covers:cleanup-legacy
```

确认后再显式删除：

```bash
docker compose exec lan-reader npm run covers:cleanup-legacy -- --apply
```

> [!WARNING]
> 旧封面清理无法由应用撤销。不执行清理也不影响正常使用。

## 源码开发

### 使用源码构建镜像

```bash
git clone https://github.com/natumeAi/lan-reader.git
cd lan-reader
git switch v2.0-dev
docker build -t lan-reader:local .
```

然后把 `docker-compose.yml` 中的 `image` 改为 `lan-reader:local`，再执行 `docker compose up -d --wait`。

### 本地开发

需要 Node.js 22.12 或更高版本。在仓库根目录执行：

```bash
npm ci
npm run dev
```

`npm run dev` 会先构建 `shared` 包，再同时启动服务端（`http://localhost:3000`）和 Vite 开发服务器（默认 `http://localhost:5173`）。Vite 会把 `/api` 和 `/covers` 请求代理到 `http://localhost:3000`，也可以用 `EPUB_API_URL` 指向其他服务端。

### 测试与构建

```bash
npm run check
```

它会依次执行类型检查、ESLint、生产构建和全部测试。也可以单独运行 `npm run typecheck`、`npm run lint`、`npm run build` 或 `npm test`。

## 健康检查与日志

健康检查地址：

```text
http://你的设备IP:4081/api/health
```

正常响应示例：

```json
{"status":"ok","service":"epub-reader-server","database":"ok"}
```

查看容器日志：

```bash
docker compose logs -f --tail=100
```

按 `Ctrl+C` 只会退出日志查看，不会停止容器。

## 常见问题

<details>
<summary><strong>浏览器无法打开应用</strong></summary>

运行 `docker compose ps` 确认容器状态，并检查宿主机防火墙是否放行映射端口。如果修改过 `4081:3000`，浏览器要使用冒号左侧的端口。

</details>

<details>
<summary><strong>在 WSL2 中部署，过一会儿就打不开了</strong></summary>

WSL2 在没有程序运行时会自动关机，其中的 Docker 和容器也会随之停止。可以在 Windows 的 `%USERPROFILE%\.wslconfig` 中关闭空闲关机，或保持一个 WSL 终端打开。WSL 重新启动后，设置了 `restart: unless-stopped` 的容器会自动恢复。

</details>

<details>
<summary><strong>重建容器后书籍不见了</strong></summary>

确认 Compose 仍把原来的数据目录挂载到 `/app/server/data`。相对路径取决于执行 `docker compose` 时所在的目录，从其他目录启动可能会创建一份新的空数据目录。

</details>

<details>
<summary><strong>复制 EPUB 后没有立即出现</strong></summary>

确认扩展名为 `.epub`、文件已经完整复制到 `books/`，然后稍等片刻。如果仍未出现，请查看容器日志中的解析或权限错误；超过 [配置](#配置) 中大小或文件数上限的 EPUB 会被拒绝。

</details>

<details>
<summary><strong>阅读统计的字数比预期少</strong></summary>

字数只统计实际显示在屏幕上的正文。翻页很快时，个别没有停稳的页可能不被计入；重新读到这些页时会补上。重复阅读已计入的内容不会再增加字数。

</details>

<details>
<summary><strong>手机可以访问但不能安装 PWA</strong></summary>

局域网 IP 上的普通 HTTP 不属于安全上下文。请通过带有效证书的 HTTPS 反向代理访问，并确认 `manifest.webmanifest` 与 `sw.js` 没有被代理规则拦截。

</details>

<details>
<summary><strong>可以直接暴露到公网吗？</strong></summary>

不建议。应用没有内置登录、权限或多用户隔离。请使用 VPN、零信任访问或带身份验证的反向代理。

</details>

## 技术栈

| 层级 | 技术 |
|---|---|
| 客户端 | React 19、Vite、foliate-js、dnd-kit |
| PWA | vite-plugin-pwa、Workbox |
| 服务端 | Node.js 22、Express 5 |
| 数据 | SQLite（better-sqlite3）、宿主机文件系统 |
| 图像 | Sharp、WebP 缩略图 |
| 文件监控 | chokidar |
| 部署 | Docker、Docker Compose |

## 版本

当前版本：**2.2**

完整变更记录与发布说明请查看 [GitHub Releases](https://github.com/natumeAi/lan-reader/releases)。
