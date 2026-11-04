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

服务可通过 `folder/choose` 弹出 Windows 文件夹选择器；用户也可在页面输入绝对路径并通过 `subscription/open` 授权。扩展不得在后台静默选择或切换目录。

## 命令

```powershell
npm run check
npm test
npm run admin -- list
npm run admin -- revoke <clientId>
npm run admin -- revoke-all
```

授权撤销后，服务会在最多约 2 秒内关闭对应活动连接。配对记录、最近目录和忽略规则默认保存在 `%LOCALAPPDATA%\Cebian\LocalFolderService\state.json`；文件内容和编辑草稿不保存在服务端。

默认读取与保存上限为 5 MiB。大目录返回截断标志，名称搜索最多扫描 20,000 项、返回 500 项或运行 5 秒。可通过 `.env` 或进程环境变量覆盖 `.env.example` 中的限制。

## 协议与安全

WebSocket 消息、方法参数、事件和错误码见 [协议说明](docs/protocol.md)。路径只允许授权根目录内的正斜杠相对路径；默认拒绝符号链接及其子树。文件读取只接受有效 UTF-8，保存必须携带读取版本；旧版本不能覆盖磁盘变化。递归删除必须以服务返回的子树快照版本进行二次确认。

服务凭据文件依赖当前 Windows 用户配置目录继承的 ACL；Unix 类系统会尝试设置目录 `0700`、状态文件 `0600`。服务应以普通用户运行，不要用管理员权限启动，也不要把端口转发到局域网。

## 项目结构

```text
src/
  index.ts             服务启动与信号关闭
  server.ts            HTTP 健康检查和 WebSocket 协议路由
  filesystem.ts        路径边界、文本文件操作、版本与忽略规则
  watchers.ts          共享目录监听和漏报校验
  state.ts             配对凭据、最近目录和规则的本机存储
  admin.ts             本机授权查询与撤销
  *.test.ts            文件系统和协议集成测试
docs/protocol.md       WebSocket 协议说明
```
