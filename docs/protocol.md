# WebSocket 协议 1.0

WebSocket 端点为 `ws://127.0.0.1:8765/ws`。服务默认只监听 IPv4 回环地址；实际地址以 `/health` 返回为准。所有消息均为 UTF-8 JSON。

## 消息包络

请求：

```json
{
  "protocolVersion": "1.0",
  "type": "request",
  "requestId": "页面生成的唯一 ID",
  "method": "directory/list",
  "params": { "path": "src" }
}
```

成功响应包含相同 `requestId` 与 `result`；失败响应包含稳定 `error.code`、可读 `message`、`retryable`，删除需要确认时还会包含 `details`。事件使用 `type: "event"`、独立 `eventId`、`event` 名称、事件序号 `sequence` 和数据。每连接最多 32 个并发请求；消息、连接和速率限制见 `service/status`。

协议主版本不匹配、无效 JSON、非法请求 ID、未知方法和未知字段类型应作为协议错误处理。请求 ID 建议使用 UUID，单个连接内不得重用仍在处理的 ID。

## 连接、配对与授权

### `hello`

不需要认证。返回服务名称、协议版本、认证状态和主要限制。

### `pair/begin`

不需要认证。返回需要配对、配对码来源和当前有效秒数；配对码只在服务进程终端显示。

### `pair/complete`

不需要认证。参数：`{ "code": "终端显示的配对码", "clientName": "Cebian 本地文件夹页面" }`。只接受当前进程生成的一次性配对码。成功返回 `{ clientId, token, expiresAt: null }`。`token` 是长期凭据，仅此响应返回明文。

### `authenticate`

不需要已认证。参数 `{ "token": "长期凭据" }`。成功后当前 WebSocket 连接与该客户端身份绑定。凭据不能从其他来源、其他客户端或最近目录记录推导。

### `service/status`

需要认证。返回监听地址、连接与订阅数量、协议版本和资源限制。

### `auth.revoked` 事件

服务端撤销客户端授权时先推送该事件，然后关闭连接。客户端应清除凭据及授权范围内草稿的恢复入口，并重新配对。

## 目录订阅

### `folder/choose`

需要认证。打开系统目录选择器；取消时返回 `{ cancelled: true }` 并保持已有订阅。当前 Windows 实现使用 PowerShell WinForms 选择器。

### `subscription/open`

需要认证。参数 `{ "rootPath": "本机绝对目录路径" }`，由页面明确的用户选择/输入动作调用。服务校验真实路径并打开订阅。返回 `subscriptionId`、目录标签、根目录路径及忽略规则。此方法只用于首次选择或切换根目录；订阅内请求统一使用相对路径。

若切换失败，旧订阅保持有效；切换成功后旧订阅被关闭。一个 WebSocket 连接同时只有一个订阅。多个页面可以有独立连接并共享相同真实根目录的底层 watcher。

### `subscription/close`

需要认证。关闭当前连接的订阅；不影响其他页面或客户端。

### `directory/list`、`directory/refresh`

参数 `{ "path": "", "offset": 0 }` 或授权根目录内的相对目录路径。返回直接子项、目录版本、`truncated`、可选 `nextOffset` 和 `scanLimitReached`。若有 `nextOffset`，客户端继续请求相同路径并传入该偏移量。子项字段为 `name`、`path`、`kind`、`size`、`modifiedAt`、`readable`、`writable`、`hiddenByRule`。类型包括 `file`、`directory`、`symlink`、`other`。符号链接可显示但不能跟随访问。

## 文件操作

### `file/read`

参数 `{ "path": "notes.txt" }`。返回 `content`、`bom`、`lineEnding`、`trailingNewline`、`writable`、字节数及 `version.token`。版本标识不透明，页面保存时原样回传。

### `file/save`

参数 `{ "path": "notes.txt", "content": "...", "expectedVersion": "读取返回的 token", "bom": true }`。旧版本返回 `VERSION_CONFLICT`；内容超过限制返回 `FILE_TOO_LARGE`。成功返回新版本和写入字节数。文本中的 CRLF/LF 字符及 BOM 按传入内容/标志保留；页面须保持读入的混合换行格式。

### `file/create`

参数 `{ "path": "new.txt", "kind": "file" }` 或 `kind: "directory"`。只创建一个空文件或一级目录，不递归创建父目录，不覆盖同名目标。

### `entry/rename`

参数 `{ "path": "old.txt", "newName": "new.txt" }`。只在同一目录内改名，不移动、不覆盖目标。

### `entry/inspect-delete`

参数 `{ "path": "folder" }`。返回 `{ version, itemCount, recursive }`，用于显示准确删除范围。

### `entry/delete`

参数 `{ "path": "folder", "confirmationVersion": "inspect-delete 返回的 version" }`。快照变化时返回 `CONFIRMATION_REQUIRED` 和新的范围信息，客户端必须再次展示并确认。根目录不可删除，包含符号链接的目录不能递归删除。

## 搜索与规则

### `search/name`

参数 `{ "query": "report", "limit": 100 }`。只搜索名称，不搜索文件内容。返回结果含相对路径、类型和隐藏状态；`truncated` 表示受限或结果不完整。

### `search/cancel`

参数 `{ "requestId": "正在运行的 search/name 请求 ID" }`。尽力取消同一连接上的搜索。

### `recent/list`、`recent/remove`

需要认证。最近目录按客户端身份隔离，移除只清除历史记录，不删除目录或撤销正在使用的订阅。最近目录不是授权凭据，打开时仍需重新校验并建立新订阅。

### `ignore/get`、`ignore/update`

需要活动订阅。规则使用 picomatch glob，路径以根目录为基准，按客户端和根目录保存，最多 100 条、单条不超过 256 字符。同一客户端的页面若订阅同一个根目录，会共享规则并收到更新事件。更新参数 `{ "hidden": ["*.log"], "stopped": ["node_modules", ".git"] }`。隐藏规则仅标记 `hiddenByRule`，不影响搜索或监听；停止规则会从列目录和名称搜索中排除匹配路径及其子树。更新会推送 `ignore.changed`。

## 推送事件

- `entry.changed`：文件系统项变化，包含相对 `path`；服务自身保存可能带 `source: "service"` 和新版本。
- `entry.renamed`：服务发起的同目录改名，包含 `oldPath` 和新 `path`。
- `entry.deleted`：服务发起的删除。
- `directory.changed`：已查询目录校验发现版本变化。
- `ignore.changed`：忽略规则版本改变。
- `resync.required`：监听溢出、路径不明或校验失败，需要重新查询受影响目录；缺少 `path` 时同步根目录。
- `auth.revoked`、`service.shutting-down`：授权撤销或服务关闭。

同目录多个客户端共享文件 watcher，但每个连接独立收到事件序号。watcher 事件不是文件内容，客户端应通过 `directory/list` 或 `file/read` 获取权威状态。

## 错误码

`UNAUTHORIZED`、`PAIRING_REQUIRED`、`PAIRING_EXPIRED`、`PAIRING_RATE_LIMITED`、`PERMISSION_DENIED`、`PATH_OUTSIDE_ROOT`、`INVALID_PATH`、`INVALID_NAME`、`NOT_FOUND`、`NOT_DIRECTORY`、`ALREADY_EXISTS`、`VERSION_CONFLICT`、`UNSUPPORTED_ENCODING`、`UNSUPPORTED_FILE_TYPE`、`FILE_TOO_LARGE`、`IGNORED_PATH`、`SYMLINK_NOT_ALLOWED`、`RATE_LIMITED`、`REQUEST_CANCELLED`、`SERVICE_SHUTTING_DOWN`、`RESYNC_REQUIRED`、`PROTOCOL_VERSION_UNSUPPORTED`、`CONFIRMATION_REQUIRED`、`RESOURCE_LIMIT` 和 `INTERNAL_ERROR`。
