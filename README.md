# Cebian Local Folder Service

Cebian 扩展“本地文件夹工作台”的独立本机服务。它只提供 WebSocket 文件服务，不依赖 Cebian 的 VFS、聊天后台或 AgentMesh，也不会执行文件内容。

## 环境要求

- Node.js 22.19 或更高版本
- Windows 10/11 推荐；系统文件夹选择器使用当前交互桌面的 PowerShell WinForms
- Chrome MV3 或 Firefox 扩展的准确来源 ID

## 开发启动

```powershell
cd D:\开源项目\cebian-local-folder-service
npm install
$env:CEBIAN_EXTENSION_ORIGINS = "chrome-extension://你的扩展ID"
npm run dev
```

Firefox 可将实际来源配置为 `moz-extension://<扩展UUID>`。支持多个精确来源，以逗号分隔。服务拒绝未列出的浏览器 Origin；不要填写通配符。默认只监听 `127.0.0.1:8765`，WebSocket 地址为 `ws://127.0.0.1:8765/ws`，健康检查为 `http://127.0.0.1:8765/health`。

服务启动后会在终端显示一次性配对码，5 分钟有效且只能使用一次。扩展先请求 `hello` 和 `pair/begin`，再把用户从本机终端读取的配对码提交给 `pair/complete`。服务返回的客户端凭据只显示在配对响应中；扩展应保存在扩展本地安全存储中，不能写进 URL 或普通日志。之后的新连接使用 `authenticate`，每次连接都要重新打开目录订阅。

页面通过 `folder/choose` 弹出 Windows 系统文件夹选择器来打开或切换目录；工作区不提供根目录字符串输入或最近目录直接打开入口。`subscription/open` 保留给受信任的本机管理客户端与自动化联调。扩展不得在后台静默选择或切换目录。

## Vue Demo 页面

```powershell
npm install
npm run demo
```

打开 **http://127.0.0.1:4173**，在“连接与配对”弹窗中连接服务，输入终端显示的配对码，再点击“选择文件夹”通过系统选择器授权目录。目录以可展开和收起的树形展示，使用不同图标区分目录和文件。该命令以开发模式同时启动后端和 Vite 页面服务，保存 Vue、JavaScript 或 CSS 后页面自动热更新，修改后端或 Demo 服务代码后自动重启。按 `Ctrl+C` 同时关闭两者。

根目录的 `.env` 是可直接使用的配置文件，后端和 demo 启动时会自动加载；可以直接修改其中的端口、扩展来源与文件限制，修改后手动重启命令。单独构建前端执行 `npm run demo:build`，复用已构建页面执行 `npm run demo:serve`，后者不监听源码变化。

后端自动重启后需要重新连接并授权目录；页面凭据丢失时使用终端最新的配对码。端口设为 `0` 时，重启后的地址可能变化，请使用终端最新输出的页面地址。

`npm run demo` 已包含后端，使用 demo 时只运行这一个命令即可。若提示 `8765` 端口被占用，请先在已有服务的终端按 `Ctrl+C` 再启动。需要另起一套服务时，修改 `.env` 中的 `LOCAL_FOLDER_PORT`；如果 demo 页面端口也被占用，同时修改 `DEMO_PORT`。

页面可浏览目录、分页、按名称搜索、读取和编辑 UTF-8 文件、新建文件/目录、重命名、确认删除、管理最近目录与忽略规则，并查看实时事件。保存携带读取版本；发生冲突时保留编辑内容，由用户决定是否重新读取。CRLF 和 BOM 会保留，混合换行或独立 CR 文件只读展示。

demo 仅绑定本机地址，并在本次进程中精确允许实际页面来源，仍需配对和目录授权。普通 `npm run dev` / `npm start` 不允许 demo 来源。凭据只保存在页面内存中，刷新页面后需重启服务取得新配对码；同一页面断线后可重新认证，但需重新打开目录。

后端端口沿用 `LOCAL_FOLDER_PORT`（默认 `8765`）；页面端口可通过 `DEMO_PORT` 修改（默认 `4173`），均支持 `0` 自动分配，实际地址会输出到终端。页面自动读取后端地址。不要直接以 `file://` 打开 `demo/index.html`。更多说明见 [demo/README.md](demo/README.md)。

## 命令

```powershell
npm run check
npm test
npm run admin -- list
npm run admin -- revoke <clientId>
npm run admin -- revoke-all
```

授权撤销后，服务会在最多约 2 秒内关闭对应活动连接。配对记录、最近目录和忽略规则默认保存在 `%LOCALAPPDATA%\Cebian\LocalFolderService\state.json`；文件内容和编辑草稿不保存在服务端。

默认读取与保存上限为 5 MiB。大目录返回截断标志，名称搜索最多扫描 20,000 项、返回 500 项或运行 5 秒。可直接修改根目录 `.env` 中的配置；进程环境变量优先于文件中的值。

## 协议与安全

WebSocket 消息、方法参数、事件和错误码见 [协议说明](docs/protocol.md)。路径只允许授权根目录内的正斜杠相对路径；默认拒绝符号链接及其子树。文件读取只接受有效 UTF-8，保存必须携带读取版本；旧版本不能覆盖磁盘变化。递归删除必须以服务返回的子树快照版本进行二次确认。

服务凭据文件依赖当前 Windows 用户配置目录继承的 ACL；Unix 类系统会尝试设置目录 `0700`、状态文件 `0600`。服务应以普通用户运行，不要用管理员权限启动，也不要把端口转发到局域网。

## 项目结构

```text
src/
  index.ts                   后端启动与信号关闭
  cli/admin.ts               本机授权查询与撤销命令
  config/index.ts            环境变量与配置校验
  server/service.ts          HTTP、WebSocket 连接与生命周期
  server/listen.ts           端口监听与启动错误提示
  protocol/
    types.ts                 协议与连接上下文类型
    router.ts                方法路由、配对与目录订阅
    responses.ts             响应和事件封装
    validation.ts            入站参数与请求限流校验
  filesystem/
    service.ts               文本读写、目录查询、搜索和文件操作
    paths.ts                 根目录解析、路径边界与名称校验
    rules.ts                 忽略规则校验与匹配
    types.ts                 文件系统领域类型
  storage/state-store.ts     配对凭据、最近目录和规则的本机存储
  watchers/registry.ts       共享目录监听与漏报校验
  platform/folder-picker.ts  Windows 系统目录选择器
  shared/errors.ts           统一服务错误与系统错误映射
demo/                        Vue 3 演示前端，与 src 同级
  index.ts                   demo 启动命令
  server.ts                  Vite 开发服务、构建产物服务和后端组合启动
  index.html                 Vue 挂载入口
  vite.config.ts             Vite 构建配置
  src/
    main.js                  Vue 应用入口
    App.vue                  单页工作台
    components/              连接、目录、编辑器、规则与日志面板
    composables/             响应式状态、文件操作与事件处理
    services/folder-client.js WebSocket 请求、超时与事件处理
    assets/styles.css        页面样式与响应式布局
  dist/                      前端构建产物，不纳入版本控制
tests/
  unit/                      配置、文件系统测试
  integration/               WebSocket、demo 集成测试
  helpers/                   协议测试工具
docs/
  Local-Folder-Backend-Requirements.md  需求来源
  protocol.md                WebSocket 协议说明
```

后端入口负责组装模块；协议层调用文件系统、持久化和监听服务；平台层封装操作系统交互。`src` 不依赖 `demo` 或 `tests`。新增功能优先放入对应职责目录，协议变更同步更新文档与集成测试。
