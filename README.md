<div align="center">
  <img src="./client/public/icon-192.png" width="96" height="96" alt="EPUB Reader 图标">

  # EPUB Reader

  **为手机阅读和家庭自托管打造的私人 EPUB 书架。**

  上传、整理并阅读自己的 EPUB 收藏，数据始终保存在你的设备上。

  [![Release](https://img.shields.io/github/v/release/natumeAi/epub-reader?display_name=tag)](https://github.com/natumeAi/epub-reader/releases)
  [![Docker Pulls](https://img.shields.io/docker/pulls/lshym123/epub-reader)](https://hub.docker.com/r/lshym123/epub-reader)
  [![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)](#安装为-pwa)
  [![EPUB](https://img.shields.io/badge/format-EPUB-8B5CF6)](#功能)

  [快速开始](#快速开始) · [安装为 PWA](#安装为-pwa) · [数据与备份](#数据与备份) · [源码开发](#源码开发)
</div>

> [!NOTE]
> **本仓库正在进行 TypeScript 重构。** 下文的目录结构和开发命令描述的是重构前的形态，
> 由第 5 步负责更新。当前可用的命令、工程约定和基线数据见
> [docs/migration/engineering-conventions.md](docs/migration/engineering-conventions.md)
> 与 [docs/migration/step-01-baseline.md](docs/migration/step-01-baseline.md)。

> [!IMPORTANT]
> EPUB Reader 面向个人或家庭局域网使用，目前没有账号系统和访问控制。不要将它直接暴露到公网；如需远程访问，请放在可信 VPN、零信任网络或带身份验证的 HTTPS 反向代理之后。

## 功能

- **私人书库**：上传单本或多本 EPUB，自动提取书名、作者、标识符和封面。
- **书架整理**：搜索、排序、拖动换位、创建文件夹，以及在书架和文件夹之间移动书籍。
- **沉浸阅读**：分页阅读、目录跳转、章节页码、全书进度与继续阅读。
- **阅读外观**：字体、字号、页边距、行距、字距，以及白色、暖色、护眼和夜间主题。
- **自然翻页**：左右点按、横向拖动、键盘方向键，并针对长章节和低性能设备提供可靠降级。
- **稳定恢复**：自动保存阅读位置；PWA 从后台、锁屏或进程恢复后返回最后稳定页面。
- **移动优先**：针对手机和平板竖屏设计，可安装为独立窗口运行的 PWA。
- **本地数据**：SQLite、EPUB 原文件和封面全部存放在挂载的数据目录中。
- **自动入库**：也可直接把 `.epub` 文件复制到 `data/books/`，目录监控器会自动同步书库。

## 快速开始

### 使用 Docker Compose

准备一台安装了 Docker 与 Docker Compose 的主机，然后创建工作目录：

```bash
mkdir -p epub-reader
cd epub-reader
```

新建 `compose.yaml`：

```yaml
name: epub-reader

services:
  epub-reader:
    image: lshym123/epub-reader:latest
    container_name: epub-reader
    restart: unless-stopped
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3000
    ports:
      - "4080:3000"
    volumes:
      - ./data:/app/server/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

启动服务：

```bash
docker compose up -d
docker compose ps
```

容器显示为 `running` 或 `healthy` 后，打开：

```text
http://你的设备IP:4080
```

例如：`http://192.168.1.20:4080`。

> [!TIP]
> `4080:3000` 左侧是浏览器访问端口，可以改成其他未占用端口；右侧容器端口保持 `3000`。

## 开始使用

1. 点击书架右上角的 **＋**，选择一本或多本 EPUB。
2. 等待元数据和封面解析完成，书籍会出现在书架上。
3. 点击封面开始阅读；翻页后阅读位置会自动保存。
4. 长按并拖动书籍可调整顺序；拖到另一册书的中央可创建文件夹。
5. 阅读时点击页面中央呼出控制栏，通过“目录”和“Aa 设置”调整阅读体验。

如果你更习惯直接管理文件，也可以把完整的 EPUB 文件复制到宿主机的 `data/books/`。应用会监控该目录并同步新增、更新或删除的书籍。

## 安装为 PWA

EPUB Reader 可以安装到主屏幕，并以独立应用窗口运行：

- **iPhone / iPad**：使用 Safari 打开站点，点击“分享” → “添加到主屏幕”。
- **Android**：使用 Chrome 打开站点，在菜单中选择“安装应用”或“添加到主屏幕”。
- **桌面 Chrome / Edge**：打开站点后使用地址栏中的安装按钮。

### HTTPS 要求

Service Worker 只能在安全上下文中运行：

- `localhost` 开发访问可使用 HTTP。
- 手机或其他电脑通过局域网 IP 访问时，应配置 HTTPS 反向代理。
- 直接使用 `http://192.168.x.x:4080` 可以在线阅读，但不保证 PWA 安装和缓存能力完整可用。

### 缓存范围

每台设备会独立缓存：

- 应用外壳；
- 最近成功加载的书架快照；
- 已访问的封面缩略图。

EPUB 正文默认不进入离线缓存，因此当前版本不是完整的离线阅读器。服务器中的书库仍是唯一持久数据源；浏览器清理站点数据不会删除服务器上的书籍。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT` | `3000` | 服务监听端口 |
| `EPUB_DATA_DIR` | `server/data` | EPUB、封面与临时上传目录的根路径 |
| `DATABASE_PATH` | `server/data/library.sqlite` | SQLite 数据库路径 |
| `EPUB_UPLOAD_MAX_MB` | `100` | 单个上传文件的大小上限（MiB） |

容器部署通常只需要配置端口和数据卷。若自定义 `EPUB_DATA_DIR` 或 `DATABASE_PATH`，请确保运行用户对目标目录具有读写权限，并把相应路径持久化挂载到宿主机。

## 数据与备份

默认数据目录结构：

```text
data/
├── library.sqlite
├── books/
├── covers/
│   └── thumbnails/
└── staging/
```

- `library.sqlite`：书架、文件夹、阅读进度和阅读设置。
- `books/`：EPUB 原文件。
- `covers/`：原始封面和生成的 WebP 缩略图。
- `staging/`：上传校验期间使用的临时目录；过期文件会自动清理。

### 备份

为了获得一致的数据库备份，先停止写入，再备份整个数据目录：

```bash
docker compose stop
tar -czf ../epub-reader-data-$(date +%Y%m%d).tar.gz data
docker compose start
```

### 恢复

```bash
docker compose down
mv data data.before-restore
tar -xzf ../epub-reader-data-20260811.tar.gz
docker compose up -d
```

请把示例文件名替换成实际备份。确认恢复正常后，再自行处理 `data.before-restore`。

### 更新

更新前建议先备份，然后执行：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

数据库迁移会在启动时自动执行，不会移动或重命名已有 EPUB 原文件。

### 清理旧版封面

新版会在后台逐本生成 384px 和 768px WebP 缩略图。确认缩略图回填完成、已经备份且不再回滚到旧镜像后，可以先预览可清理内容：

```bash
docker compose exec epub-reader npm run covers:cleanup-legacy
```

确认后再显式删除：

```bash
docker compose exec epub-reader npm run covers:cleanup-legacy -- --apply
```

> [!WARNING]
> 旧封面清理不可由应用自动撤销。不执行清理不会影响新版使用。

## 源码开发

### 使用源码构建容器

```bash
git clone https://github.com/natumeAi/epub-reader.git
cd epub-reader
docker compose up -d --build
```

仓库中的 `docker-compose.yml` 默认使用 `http://localhost:3000`，并把 `./server/data` 挂载到容器中。

### 本地开发

需要 Node.js 22 或更高版本。

终端一：

```bash
cd server
npm ci
npm run dev
```

终端二：

```bash
cd client
npm ci
npm run dev
```

打开 `http://localhost:5173`。Vite 会把 `/api` 和 `/covers` 请求代理到 `http://localhost:3000`。

### 测试与构建

```bash
cd client
npm test
npm run build

cd ../server
npm test
```

## 健康检查与日志

健康检查地址：

```text
http://你的设备IP:4080/api/health
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

运行 `docker compose ps` 确认容器状态，并检查宿主机防火墙是否放行映射端口。若修改过 `4080:3000`，浏览器应使用冒号左侧的端口。

</details>

<details>
<summary><strong>重建容器后书籍不见了</strong></summary>

确认 Compose 仍把原来的数据目录挂载到 `/app/server/data`。相对路径取决于执行 `docker compose` 时所在的目录，从其他目录启动可能会创建一份新的空数据卷。

</details>

<details>
<summary><strong>复制 EPUB 后没有立即出现</strong></summary>

确认扩展名为 `.epub`，文件已经完整复制到 `data/books/`，然后稍等片刻。若仍未出现，请检查容器日志中的解析或权限错误。

</details>

<details>
<summary><strong>手机可以访问但不能安装 PWA</strong></summary>

局域网 IP 上的普通 HTTP 不属于安全上下文。请通过带有效证书的 HTTPS 反向代理访问，并确认 `manifest.webmanifest` 与 `sw.js` 没有被代理规则拦截。

</details>

<details>
<summary><strong>可以直接暴露到公网吗？</strong></summary>

不建议。当前应用没有内置登录、权限或多用户隔离。请使用 VPN、零信任访问或带身份验证的反向代理。

</details>

## 技术栈

| 层级 | 技术 |
|---|---|
| 客户端 | React 19、Vite、epub.js、dnd-kit |
| PWA | vite-plugin-pwa、Workbox |
| 服务端 | Node.js、Express |
| 数据 | SQLite、宿主机文件系统 |
| 图像 | Sharp、WebP 缩略图 |
| 部署 | Docker、Docker Compose |

## 版本

当前版本：**v0.9.5**

完整变更记录与发布说明请查看 [GitHub Releases](https://github.com/natumeAi/epub-reader/releases)。
