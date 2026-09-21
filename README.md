# LAN Reader

私人 EPUB 书架与阅读器，使用严格 TypeScript、React 19、Express、SQLite 和 epub.js 0.3.93。支持上传、搜索、书架/文件夹整理、分页与目录导航、图片查看、主题字体设置和每本书独立保存阅读位置。

这是可独立运行的 TypeScript 重构项目。所有安装、构建与启动命令在 **本项目根目录**执行，使用根 `package-lock.json`；不要到子包内单独安装，不依赖原项目目录或其数据卷。项目没有内置认证，远程使用请自行配置可信网络或有认证的 HTTPS 代理。

## 本地启动

开发与质量检查建议使用 **Node 22.13+（22 系列）或 Node 24**。根清单声明的运行时下限为 22.12，但当前 ESLint 10 的 Node 22 工具链下限为 22.13。容器以 Node 22 构建；本次本机实测环境为 Windows / Node 24.19.0 / npm 11.17.0，Docker/Node 22 实机验收仍待完成。

PowerShell 示例使用新项目独立数据目录和端口：

```powershell
cd D:\Projects\lan-reader
npm ci
npm run build
$env:HOST = '127.0.0.1'
$env:PORT = '4081'
$env:NODE_ENV = 'production'
$env:EPUB_DATA_DIR = 'D:\Projects\lan-reader\data-lan-reader'
$env:DATABASE_PATH = 'D:\Projects\lan-reader\data-lan-reader\library.sqlite'
npm start
```

打开 `http://localhost:4081`。`npm run build` 依次编译 shared、server、client，复制 SQL 至 `server/dist/db/migrations`，再将全部前端/PWA 产物复制至 `server/public`；`npm start` 运行编译后的 `server/dist/index.js`，同时提供 API 和静态页面。Ctrl+C 关闭本次服务并释放 watcher、HTTP 和数据库。

Linux/macOS 在根目录完成 `npm ci`、`npm run build` 后，可用：

```bash
HOST=127.0.0.1 PORT=4081 NODE_ENV=production \
EPUB_DATA_DIR="$PWD/data-lan-reader" DATABASE_PATH="$PWD/data-lan-reader/library.sqlite" npm start
```

不要把数据放到 `.tmp` 等含点号开头目录段的路径中：Express 默认不下载这些路径中的 EPUB。上传文件名以点号开头也可能导致正文下载 404。

## 开发与检查

```powershell
npm ci
$env:HOST = '127.0.0.1'
$env:PORT = '4081'
$env:EPUB_API_URL = 'http://127.0.0.1:4081'
$env:EPUB_DATA_DIR = 'D:\Projects\lan-reader\data-lan-reader'
$env:DATABASE_PATH = 'D:\Projects\lan-reader\data-lan-reader\library.sqlite'
npm run dev
```

访问 Vite 输出的地址（通常为 `http://localhost:5173`）。`dev` 先构建 shared，再同时启动 tsx 后端和 Vite；修改 shared 后需重跑 `npm run build:shared`。分开运行 `dev:server` / `dev:client` 时先构建 shared。Vite 通过 `EPUB_API_URL` 代理 `/api` 和 `/covers`，生产服务无需此变量。

| 根命令 | 用途 |
|---|---|
| `npm ci` | 从根 lockfile 干净安装全部 workspaces |
| `npm run typecheck` | shared、server、client 应用及工具/本地测试严格类型检查 |
| `npm run lint` | 检查应用、配置及存在的本地测试 |
| `npm run build` | 生成可由 `npm start` 直接运行的全部产物 |
| `npm test` | 运行所有本地测试，需下述额外文件 |
| `npm run check` | typecheck → lint → build → test，完整本地质量门禁 |
| `npm start` | 启动编译后的服务，需先构建 |

**测试交付边界：** 按用户决定，`client/test`、`server/test`、`shared/test` 仅保留本地且被 Git 忽略，`docs`、`.trellis` 亦不纳入版本库。新克隆不含测试和 `server/test/support/isolateData.mjs`，需另行取得完整目录才能执行 `npm test` / `npm run check`。缺少测试不能解释为通过；不得去掉隔离预载后对真实书库运行测试。

`.github/workflows/quality.yml` 仅做 Node 22/24 的安装、类型、lint 和构建，明确提示没有测试覆盖，不推送镜像、不发布、不部署。CI 配置已写入不代表远程工作流已经运行。npm 11 可能提示原生包安装脚本未获批准；应检查 `better-sqlite3` 与 `sharp` 是否实际可加载，不能把安装退出码 0 当作运行验证。原生模块需在目标系统/架构安装，禁止跨平台复制 `node_modules`。

## Docker Compose（待容器环境实测）

Dockerfile 从根 lockfile 做多阶段 workspace 构建，运行层包含生产依赖、shared 运行时、server dist/SQL、client 静态资源与 CJK 字体，以 `node` 用户运行；健康检查要求 `/api/health` 的 `database` 为 `ok`。不使用原项目发布镜像或容器标识。

Compose 项目/服务为 `lan-reader`，默认端口 **4081**，绑定 **本项目 `./data-lan-reader`** 至 `/app/server/data`，无固定 container_name。本机没有 Docker/Compose/Podman，以下命令是待在适当环境执行的操作说明，未宣称构建、配置解析或容器 smoke 通过。

```bash
# Linux 宿主机：先为镜像的 node 用户准备本项目的新目录；不要指向原书库。
mkdir -p data-lan-reader
sudo chown 1000:1000 data-lan-reader
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 lan-reader
```

访问 `http://localhost:4081`，局域网设备用宿主机 IP。Windows Docker Desktop 的绑定目录权限方式不同；确认容器用户有写入权限。修改端口只需改 `ports` 左侧。不要让另一个实例同时写入相同数据目录，不要使用原实例的 Compose 名称、端口或卷。此配置不会自动发布。

后续代码更新时，在本项目目录执行 `docker compose build`、`docker compose up -d`；更新前先备份新实例。`docker compose stop lan-reader` 只停止这个项目中的新服务。不要使用 `down -v` 删除持久数据。

## 配置

应用读取进程环境变量，不自动加载 `.env`。Compose 的 `.env` 插值也不意味着任意变量会传入容器；需显式添加到 Compose `environment`。路径建议写绝对路径，相对环境路径按进程当前工作目录解析，npm workspace 启动时为 `server`。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址；仅本机访问可设 `127.0.0.1` |
| `PORT` | `3000` | HTTP 端口；Compose 固定容器 3000、宿主 4081 |
| `NODE_ENV` | 未设置 | 部署设为 `production` |
| `EPUB_DATA_DIR` | 项目的 `server/data` | `books`、`covers`、`staging` 的根目录 |
| `DATABASE_PATH` | 项目的 `server/data/library.sqlite` | SQLite 文件；**不随 EPUB_DATA_DIR 改变** |
| `EPUB_UPLOAD_MAX_MB` | `100` | 单文件上传上限，单位 MiB；正数转字节后向下取整 |
| `EPUB_MAX_ENTRIES` | `10000` | EPUB ZIP 最大条目数 |
| `EPUB_MAX_UNCOMPRESSED_MB` | `500` | EPUB 解压后总大小上限，MiB |
| `EPUB_MAX_ENTRY_MB` | `100` | EPUB 单条目解压大小上限，MiB |
| `EPUB_API_URL` | `http://localhost:3000` | 仅 Vite dev/preview 的后端代理目标 |

四项 EPUB 大小/数量限制的无效、非正数值回落默认值；不要依赖错误配置扩大限制。数据库和文件根路径独立，改位置时必须设置两项，并分别持久化。容器默认将两者显式放在 `/app/server/data`。

## 数据副本迁移、备份与回退

数据布局如下；当前阅读外观设置保存在浏览器 localStorage，旧 `reader_settings` 数据表保留兼容，不是当前设置来源。

```text
data-lan-reader/
  library.sqlite        # 书籍、书架/文件夹、每本书阅读位置及迁移记录
  books/                # EPUB 原文件
  covers/               # 原封面及 thumbnails/ 中的 WebP 缩略图
  staging/              # 临时上传，非书库备份来源
```

迁移仅使用**一致性备份的副本**，本次工作不迁移真实数据、不替换原服务、不操作原数据卷。

1. 由数据所有者通过原系统既有备份流程取得一致性快照，包含数据库与同期 `books`、`covers`。运行中的 SQLite 可能有 WAL；不要只复制正在写入的 `library.sqlite`。使用 SQLite 备份机制或在确认无写入的离线快照中保留完整文件集。
2. 保留该备份及原服务不变，将一份可丢弃副本放入新项目 `data-lan-reader`。确保数据库中的相对文件引用与文件树对应。不要配置任何指向原项目的路径或符号链接。
3. 使用新端口启动新实例。启动会按历史文件名自动应用未执行的 SQL migration，并在后台回填缩略图；旧原封面保留。核对书目数量、文件夹、下载、正文、图片和每本书的阅读位置。
4. 在独立浏览器 origin 验证后，由数据所有者另行决定是否切换入口。本任务没有执行切换。旧数据库 fixture 通过只能证明所覆盖格式，不能替代对实际书库副本的验收。
5. 回退时先停止**新实例**，保留新实例数据副本以便提取期间新增的书籍/阅读位置，再将入口恢复到仍保留的原服务。禁止把已升级的新数据库写回原服务；SQL migration 为前向迁移，没有 down 脚本。
6. 如需恢复新实例备份，停止新实例后把现有数据改名保留，将迁移前一致性备份复制到一个新目录，更新两项环境变量/新实例卷路径后再启动。回退不会自动合并新旧实例期间产生的内容和进度。

浏览器存储按 **协议、主机、端口** 隔离。相同格式不意味着跨 origin 自动迁移：服务器阅读位置随数据库副本保留；阅读主题、活动会话、快照缓存、离线待保存位置留在原浏览器 origin。切换前应在旧 origin 联机完成待保存进度。不要清除其站点数据来“修复”迁移；新 origin 的设置可能需要重设。同 origin 兼容仍需考虑实际浏览器缓存/Service Worker 更新。

日常备份新实例时停止新实例写入，复制数据库及整个 `books` / `covers` 文件树，再启动新实例。保留原封面有利于回退；默认不运行 `covers:cleanup-legacy --apply`。确需清理，应在已有备份、确认不回退后由所有者单独操作。

## PWA 与缓存范围

应用保留 Service Worker 外壳、IndexedDB 书架快照和封面缓存；EPUB 正文默认不缓存，离线时不能保证新打开一本书。缩略图缓存限制为 **500 个条目**，不是强制 100 MB 容量上限。读完 100% 后继续返回前文会更新当前位置；重复导入是独立 Book，阅读位置不合并。

PWA 需要安全上下文：本机 localhost 可用 HTTP，手机通过局域网 IP 则需有效 HTTPS。Safari 的“添加到主屏幕”、实际移动触控、系统后台回收后的恢复和 HTTPS 安装式 PWA 需要在目标设备另行验收；桌面 Chromium 或模拟 WebKit 事件不替代这些结果。

## 优化与验收边界

此次重构集中在可维护性和明确边界：shared DTO/解码器、统一 API transport、数据库行与 HTTP 输出分离、无副作用 app 导入、集中生命周期、EPUB 私有能力的局部类型，以及取消/销毁后不发布迟到结果。步骤 5 补齐生产静态资源复制、workspace 容器布局、保留 API/cover 404 的 SPA 回退和不发布 CI。

快照 ETag/304、gzip、可见封面渐进加载与 ReaderView 独立 chunk 继续保留。**没有同环境前后对照，就不宣称更快、节省多少内存或达到手机 500ms/800ms 指标。** Docker/Linux Node22、真实移动 Safari 和 HTTPS PWA 尚未实测，CI 文件尚不能当作远程运行证据。

本地完整记录位于被忽略的 `docs/migration/` 与 `.trellis/tasks/archive/2026-09/09-21-ts-05-delivery/verification.md`（新克隆不含这些记录）。最终完成项与未验收项以实际 verification 记录为准。本 README 保留独立安装、配置及迁移回退所需说明，不要求新克隆取得本地记录才能启动。

2026-09-21 本机最终 `npm run check` 通过，232 项测试、零失败/跳过；生产依赖副本及无测试的新克隆副本分别通过其对应检查。桌面浏览器完成上传、文件夹、阅读、保存刷新和删除路径。本轮手动夹内重排没有成功触发；主测试页出现一次无堆栈的 `MutationObserver.observe` 异常，新 origin 复查未复现，来源尚未确定。用户已确认按现有成果完成本次交付并归档；上述剩余项和未测环境作为后续验证保留，不表示所有平台交付通过。
