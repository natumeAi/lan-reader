# LAN Reader 1.0.0

LAN Reader 是一个面向个人与可信局域网环境的自托管 EPUB 书架和阅读器。它使用 React、Express、SQLite 与 epub.js 构建，提供同源的网页界面与 API；无需依赖原项目目录、原数据卷或子工作区的单独安装。

本文件是 1.0.0 的发布与运维说明。当前交付已经完成本机 WSL2 Docker 冒烟验证，但尚未登录 Docker Hub、创建远程仓库或推送镜像。

## 功能

- 导入 EPUB、管理书架、搜索书籍并使用文件夹整理内容。
- 在阅读器中使用分页、目录导航、图片查看、主题与字体设置。
- 将每本书的阅读位置保存在服务器数据中；浏览器外观设置、活动会话和缓存仍受浏览器 origin 限制。
- 提供 Service Worker 应用外壳、书架快照与封面缓存；EPUB 正文不会自动完整离线缓存。

## Docker Compose 快速启动

需要 Docker Engine 与 Docker Compose。在 WSL2/Linux 中，从本项目根目录执行：

```bash
mkdir -p data-lan-reader
sudo chown 1000:1000 data-lan-reader

docker compose config
docker compose build
docker compose up -d --wait
curl -i http://localhost:4081/api/health
docker compose ps
```

健康检查成功时，接口返回 HTTP 200，且 JSON 的 `database` 为 `"ok"`。在浏览器中访问 `http://localhost:4081`。

Compose 服务名为 `lan-reader`：容器监听 `3000`，默认映射宿主机 `4081`，并将本项目的 `./data-lan-reader` 绑定到容器中的 `/app/server/data`。容器以非 root 的 `node` 用户运行，因此绑定目录必须对该用户可写。Windows Docker Desktop 的目录权限机制不同，部署前应确认该目录可写。

查看日志或停止这一个服务：

```bash
docker compose logs --tail=100 lan-reader
docker compose stop lan-reader
```

不要让两个实例同时写入同一数据目录。停止服务不会删除数据；不要使用 `docker compose down -v`，除非数据删除已被明确确认。

## 本地开发

请使用根目录的单一 `package-lock.json`，不要在 `client`、`server` 或 `shared` 中单独安装依赖。开发和质量检查建议使用 Node.js 22.13+（22 系列）或 Node.js 24；根清单声明的最低运行时为 Node.js 22.12.0。

PowerShell 示例：

```powershell
cd D:\Projects\lan-reader
npm ci

$env:HOST = '127.0.0.1'
$env:PORT = '4081'
$env:EPUB_API_URL = 'http://127.0.0.1:4081'
$env:EPUB_DATA_DIR = 'D:\Projects\lan-reader\data-lan-reader'
$env:DATABASE_PATH = 'D:\Projects\lan-reader\data-lan-reader\library.sqlite'

npm run dev
```

`npm run dev` 会先构建 shared，再同时启动 tsx 后端和 Vite 前端；Vite 通常监听 `http://localhost:5173`，并通过 `EPUB_API_URL` 代理 `/api` 与 `/covers`。生产模式使用以下构建与启动流程：

```powershell
npm run build
npm start
```

`npm run build` 依次构建 shared、server、client，复制 SQL migration，并将完整客户端/PWA 产物复制到 `server/public`。不要把 Windows 上安装的 `node_modules` 复制进 Linux 容器；原生依赖必须在目标系统与架构中安装。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按根 lockfile 安装全部 workspaces |
| `npm run typecheck` | 严格类型检查 shared、server 与 client |
| `npm run lint` | 检查应用与配置 |
| `npm run build` | 生成可由 `npm start` 运行的完整产物 |
| `npm test` | 运行本地测试套件；测试目录按项目约定未纳入版本库 |
| `npm run check` | typecheck → lint → build → test |

## 配置

应用读取进程环境变量，不自动加载 `.env`。Compose 的 `.env` 插值也不会自动把任意变量传入容器；需要时应在 Compose 的 `environment` 中显式声明。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP 监听地址；仅本机使用时可设为 `127.0.0.1` |
| `PORT` | `3000` | HTTP 端口；Compose 映射宿主 `4081` 到容器 `3000` |
| `NODE_ENV` | 未设置 | 部署时设为 `production` |
| `EPUB_DATA_DIR` | server 的 `data` 目录 | EPUB、封面与临时上传文件的根目录 |
| `DATABASE_PATH` | server 的 `data/library.sqlite` | SQLite 数据库路径；它独立于 `EPUB_DATA_DIR` |
| `EPUB_UPLOAD_MAX_MB` | `100` | 单个上传文件上限，单位为 MiB |
| `EPUB_MAX_ENTRIES` | `10000` | EPUB ZIP 最大条目数 |
| `EPUB_MAX_UNCOMPRESSED_MB` | `500` | EPUB 解压后总大小上限，单位为 MiB |
| `EPUB_MAX_ENTRY_MB` | `100` | EPUB 单个解压条目大小上限，单位为 MiB |
| `EPUB_API_URL` | `http://localhost:3000` | 仅供 Vite 开发/预览代理使用 |

无效或非正数的 EPUB 限制会回落到内置默认值。若更改数据位置，必须分别设置 `EPUB_DATA_DIR` 与 `DATABASE_PATH`，并分别持久化。数据目录路径不要包含以点号开头的目录段，否则 Express 可能拒绝提供 EPUB 文件。

## 数据、备份与回退

默认数据布局如下：

```text
data-lan-reader/
  library.sqlite
  books/
  covers/
    thumbnails/
  staging/
```

备份应在停止写入后进行，并包含 SQLite 数据库、`books/` 与 `covers/` 的同期副本。SQLite 可能使用 WAL；不要只复制一个正在写入的 `library.sqlite` 文件。使用 SQLite 备份机制，或在确认无写入时制作完整离线快照。 `staging/` 是临时上传目录，不应作为书库备份来源。

数据库 migration 会在启动时以前向顺序执行，项目没有 down migration。升级前请保留可恢复的完整备份；测试新版本时使用独立的数据副本和独立端口，不能替换原服务或让新实例直接写入原数据目录。

若需要回退：

1. 停止新实例，保留其数据副本以便需要时提取新增书籍或阅读位置。
2. 将入口恢复到仍保留的旧实例，或用已验证的一致性备份启动新的独立实例。
3. 不要把已升级的数据库直接写回旧服务，也不要期待回退自动合并两个实例期间产生的内容和进度。

浏览器存储按协议、主机和端口隔离。服务器端的阅读位置随数据库副本保留；主题设置、活动会话、快照缓存和离线待保存位置不会自动迁移到新 origin。

## 升级操作

在已经完成备份的前提下，从项目根目录执行：

```bash
docker compose build
docker compose up -d --wait
curl -i http://localhost:4081/api/health
```

确认 `database: "ok"` 后再切换日常入口。需要停止该服务时使用 `docker compose stop lan-reader`；不应以删除卷作为常规升级步骤。

## 安全与访问边界

LAN Reader **没有内置认证或授权机制**。只应部署在可信网络中；若要提供远程访问，请自行使用具有认证能力的 HTTPS 反向代理，并负责网络隔离、访问控制和备份。局域网 IP 上的 PWA 安装需要有效 HTTPS；`localhost` 是 HTTP 下的例外。

缓存用于改善可用性，不构成数据同步或完整离线阅读保证。未缓存的 EPUB 在断网时可能无法打开，封面缩略图缓存的上限是 500 个条目而非固定存储容量。

## 验证范围

2026-09-22 已在 Windows + WSL2 Ubuntu 环境、Docker Engine 29.8.1 与 Docker Compose 5.5.1 中完成以下本地验证：

- `docker compose config` 成功解析。
- Node 22 Linux 镜像构建成功，运行层中的 `better-sqlite3` 与 `sharp` 原生依赖可加载。
- 服务启动后保持 `healthy`，`GET http://localhost:4081/api/health` 返回 HTTP 200 和 `database: "ok"`。
- 同源静态入口返回 HTTP 200；测试服务随后已停止，镜像与绑定数据目录仍保留。

这不是移动设备、Safari、HTTPS/PWA 安装、远程 CI 或生产网络环境的验收。请在目标设备和部署环境中单独验证这些范围。

## Docker Hub 发布状态

本版本仅完成本地发布准备和 Docker 冒烟验证。尚未执行 `docker login`、镜像打标、创建 Docker Hub 仓库或 `docker push`。发布前仍需由维护者明确确认 Docker Hub 命名空间、仓库名称、可见性、标签策略与推送授权。
