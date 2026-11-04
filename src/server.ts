import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import type { ServiceConfig } from "./config.ts";
import { asServiceError, ServiceError } from "./errors.ts";
import { canonicalRootKey, FileSystemService, selectRoot } from "./filesystem.ts";
import { StateStore, type IgnoreRules } from "./state.ts";
import { WatcherRegistry } from "./watchers.ts";

type RequestMessage = { protocolVersion: "1.0"; type: "request"; requestId: string; method: string; params?: Record<string, unknown> };
interface Connection {
  ws: WebSocket;
  clientId?: string;
  subscriptionId?: string;
  root?: string;
  rules?: IgnoreRules;
  fs?: FileSystemService;
  requestTimes: number[];
  searches: Map<string, AbortController>;
  paired?: boolean;
  pairAttempts: number;
  activeRequests: number;
  activeRequestIds: Set<string>;
  alive: boolean;
}

const protocolVersion = "1.0" as const;
const connectionMap = new Set<Connection>();

export async function startService(config: ServiceConfig): Promise<{ close: () => Promise<void>; url: string; pairingCode: string; state: StateStore }> {
  const state = new StateStore(config.dataDir);
  await state.load();
  const pairingCode = randomBytes(5).toString("hex").toUpperCase();
  const pairingExpiresAt = Date.now() + 5 * 60_000;
  let pairingUsed = false;
  let pairingFailures = 0;
  const watchers = new WatcherRegistry();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "Cebian Local Folder Service", protocolVersion, status: "running", host: config.host, port: getListeningPort(server, config.port) }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false });

  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (!isLoopback(request) || (origin && !config.allowedOrigins.has(origin)) || request.url !== "/ws" || connectionMap.size >= config.maxConnections) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    const connection: Connection = { ws, requestTimes: [], searches: new Map(), pairAttempts: 0, activeRequests: 0, activeRequestIds: new Set(), alive: true };
    connectionMap.add(connection);
    ws.on("message", (raw) => void onMessage(connection, raw.toString()));
    ws.on("pong", () => { connection.alive = true; });
    ws.on("close", () => closeConnection(connection));
    ws.on("error", () => closeConnection(connection));
  });

  const heartbeat = setInterval(() => {
    for (const connection of connectionMap) {
      if (connection.ws.readyState !== WebSocket.OPEN) continue;
      if (!connection.alive) { connection.ws.terminate(); continue; }
      connection.alive = false;
      try { connection.ws.ping(); } catch { connection.ws.terminate(); }
    }
  }, 30_000).unref();

  const syncRevokedConnections = async () => {
    try {
      await state.refresh();
      const current = new Set(state.clients.map((client) => client.id));
      for (const connection of connectionMap) {
        if (connection.clientId && !current.has(connection.clientId)) {
          sendEvent(connection, { event: "auth.revoked" });
          closeConnection(connection, 4003, "authorization revoked");
        }
      }
    } catch (error) { console.error(`[LocalFolder] 无法检查授权状态：${String(error)}`); }
  };
  const stateWatcher = watch(config.dataDir, (_event, filename) => {
    if (filename?.toString() === "state.json") void syncRevokedConnections();
  });
  stateWatcher.on("error", (error) => console.error(`[LocalFolder] 授权变更监听失败：${error.message}`));
  const revokePoll = setInterval(() => void syncRevokedConnections(), 2000).unref();

  async function onMessage(connection: Connection, raw: string): Promise<void> {
    let message: RequestMessage;
    try {
      const parsed = JSON.parse(raw) as RequestMessage;
      if (parsed?.protocolVersion !== protocolVersion) throw new ServiceError("PROTOCOL_VERSION_UNSUPPORTED", "客户端与服务端协议版本不兼容。");
      if (parsed?.type !== "request" || typeof parsed.requestId !== "string" || !parsed.requestId || parsed.requestId.length > 128 || typeof parsed.method !== "string" || !isRecord(parsed.params ?? {})) {
        throw new ServiceError("INVALID_REQUEST", "WebSocket 请求格式无效或协议版本不受支持。");
      }
      message = parsed;
    } catch (error) {
      const problem = error instanceof ServiceError ? error : new ServiceError("INVALID_REQUEST", "请求必须是有效的 JSON 消息。");
      sendResponse(connection, "", undefined, problem);
      return;
    }
    if (!consumeRate(connection, config.maxRequestsPerMinute)) { sendResponse(connection, message.requestId, undefined, new ServiceError("RATE_LIMITED", "请求过于频繁，请稍后重试。", true)); return; }
    if (connection.activeRequestIds.has(message.requestId)) { sendResponse(connection, message.requestId, undefined, new ServiceError("DUPLICATE_REQUEST_ID", "requestId 正在使用中，必须为每个活动请求生成唯一 ID。")); return; }
    if (connection.activeRequests >= 32) { sendResponse(connection, message.requestId, undefined, new ServiceError("RESOURCE_LIMIT", "该连接的并发请求已达上限。", true)); return; }
    await state.refresh();
    if (connection.clientId && !state.clients.some((client) => client.id === connection.clientId)) {
      sendEvent(connection, { event: "auth.revoked" });
      closeConnection(connection, 4003, "authorization revoked");
      return;
    }
    const params = message.params ?? {};
    connection.activeRequests++;
    connection.activeRequestIds.add(message.requestId);
    try {
      const result = await dispatch(connection, message, params);
      sendResponse(connection, message.requestId, result);
    } catch (error) {
      sendResponse(connection, message.requestId, undefined, error);
    } finally { connection.activeRequests--; connection.activeRequestIds.delete(message.requestId); }
  }

  async function dispatch(connection: Connection, message: RequestMessage, params: Record<string, unknown>): Promise<unknown> {
    switch (message.method) {
      case "hello":
        return { protocolVersion, service: "Cebian Local Folder Service", authenticated: Boolean(connection.clientId), limits: { maxFileBytes: config.maxFileBytes, maxMessageBytes: config.maxMessageBytes, maxDirectoryEntries: config.maxDirectoryEntries, maxSearchResults: config.maxSearchResults } };
      case "pair/begin":
        if (connection.clientId) throw new ServiceError("ALREADY_AUTHENTICATED", "此连接已经完成认证。");
        return { required: true, codeSource: "service-console", expiresInSeconds: Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000)) };
      case "pair/complete": {
        if (connection.clientId) throw new ServiceError("ALREADY_AUTHENTICATED", "此连接已经完成认证。");
        if (pairingUsed || Date.now() > pairingExpiresAt) throw new ServiceError("PAIRING_EXPIRED", "本次配对码已失效，请重启服务获取新配对码。");
        connection.pairAttempts++;
        if (connection.pairAttempts > 5) { closeConnection(connection, 4001, "too many pairing attempts"); throw new ServiceError("PAIRING_RATE_LIMITED", "配对尝试次数过多。"); }
        if (pairingFailures >= 10) { pairingUsed = true; throw new ServiceError("PAIRING_RATE_LIMITED", "本次配对码因多次错误尝试已失效，请重启服务。"); }
        if (typeof params.code !== "string" || !safeEqual(params.code.toUpperCase(), pairingCode)) {
          pairingFailures++;
          if (pairingFailures >= 10) pairingUsed = true;
          throw new ServiceError("PAIRING_REQUIRED", "配对码不正确。");
        }
        if (typeof params.clientName !== "string" || !params.clientName.trim()) throw new ServiceError("INVALID_REQUEST", "客户端名称不能为空。");
        const result = await state.addClient(params.clientName);
        pairingUsed = true;
        connection.clientId = result.client.id;
        connection.paired = true;
        return { clientId: result.client.id, token: result.token, expiresAt: null };
      }
      case "authenticate": {
        if (connection.clientId) throw new ServiceError("ALREADY_AUTHENTICATED", "此连接已经完成认证。");
        if (typeof params.token !== "string" || params.token.length < 32) throw new ServiceError("UNAUTHORIZED", "客户端凭据无效。");
        const client = state.findClient(params.token);
        if (!client) throw new ServiceError("UNAUTHORIZED", "客户端凭据已撤销或无效，请重新配对。");
        connection.clientId = client.id;
        return { clientId: client.id, authenticated: true };
      }
      case "service/status":
        requireAuth(connection);
        return { protocolVersion, status: "running", host: config.host, port: getListeningPort(server, config.port), connectionCount: connectionMap.size, subscriptionCount: [...connectionMap].filter((item) => item.subscriptionId).length, limits: { maxFileBytes: config.maxFileBytes, maxMessageBytes: config.maxMessageBytes, maxDirectoryEntries: config.maxDirectoryEntries, maxSearchEntries: config.maxSearchEntries, maxSearchResults: config.maxSearchResults, maxRequestsPerMinute: config.maxRequestsPerMinute } };
      case "folder/choose": {
        requireAuth(connection);
        const chosen = await chooseFolder();
        if (!chosen) return { cancelled: true, subscriptionId: connection.subscriptionId ?? null };
        const folder = await selectRoot(chosen);
        return openSubscription(connection, folder.canonicalPath);
      }
      case "subscription/open": {
        requireAuth(connection);
        if (typeof params.rootPath !== "string") throw new ServiceError("INVALID_REQUEST", "缺少要授权的目录路径。");
        const folder = await selectRoot(params.rootPath);
        return openSubscription(connection, folder.canonicalPath);
      }
      case "subscription/close":
        requireAuth(connection);
        closeSubscription(connection);
        return { closed: true };
      case "directory/list": {
        const fs = requireSubscription(connection);
        if (typeof params.path !== "string") throw new ServiceError("INVALID_REQUEST", "缺少相对目录路径。");
        const result = await fs.list(params.path, typeof params.offset === "number" ? params.offset : 0);
        watchers.noteDirectory(connection.subscriptionId!, connection.root!, params.path, result.version);
        return result;
      }
      case "directory/refresh": {
        const fs = requireSubscription(connection);
        if (typeof params.path !== "string") throw new ServiceError("INVALID_REQUEST", "缺少相对目录路径。");
        const result = await fs.list(params.path, typeof params.offset === "number" ? params.offset : 0);
        watchers.noteDirectory(connection.subscriptionId!, connection.root!, params.path, result.version);
        return result;
      }
      case "file/read": {
        const fs = requireSubscription(connection);
        return fs.read(requiredString(params.path, "path"));
      }
      case "file/save": {
        const fs = requireSubscription(connection);
        const result = await fs.save(requiredString(params.path, "path"), requiredString(params.content, "content", true), requiredString(params.expectedVersion, "expectedVersion"), params.bom === true);
        sendEvent(connection, { event: "entry.changed", path: params.path, version: result.version.token, source: "service" });
        return result;
      }
      case "file/create": {
        const fs = requireSubscription(connection);
        const result = await fs.create(requiredString(params.path, "path"), params.kind === "directory" ? "directory" : "file");
        sendEvent(connection, { event: "entry.changed", path: result.path, source: "service" });
        return result;
      }
      case "entry/rename": {
        const fs = requireSubscription(connection);
        const result = await fs.rename(requiredString(params.path, "path"), requiredString(params.newName, "newName"));
        sendEvent(connection, { event: "entry.renamed", path: result.path, oldPath: result.oldPath, source: "service" });
        return result;
      }
      case "entry/inspect-delete": {
        const fs = requireSubscription(connection);
        return fs.inspectDelete(requiredString(params.path, "path"));
      }
      case "entry/delete": {
        const fs = requireSubscription(connection);
        const result = await fs.delete(requiredString(params.path, "path"), typeof params.confirmationVersion === "string" ? params.confirmationVersion : undefined);
        sendEvent(connection, { event: "entry.deleted", path: result.deleted, source: "service" });
        return result;
      }
      case "search/name": {
        const fs = requireSubscription(connection);
        const controller = new AbortController();
        connection.searches.set(message.requestId, controller);
        try { return await fs.search(requiredString(params.query, "query"), typeof params.limit === "number" ? params.limit : undefined, controller.signal); }
        finally { connection.searches.delete(message.requestId); }
      }
      case "search/cancel": {
        requireSubscription(connection);
        const target = requiredString(params.requestId, "requestId");
        connection.searches.get(target)?.abort();
        return { cancelled: connection.searches.has(target) };
      }
      case "recent/list": {
        requireAuth(connection);
        const directories = await Promise.all(state.getRecents(connection.clientId!).map(async (recent) => {
          try {
            await selectRoot(recent.path);
            return { ...recent, exists: true, accessible: true };
          } catch (error) {
            const problem = asServiceError(error);
            return { ...recent, exists: problem.code !== "NOT_FOUND", accessible: false, errorCode: problem.code };
          }
        }));
        return { directories };
      }
      case "recent/remove":
        requireAuth(connection);
        await state.removeRecent(connection.clientId!, requiredString(params.path, "path"));
        return { removed: true };
      case "ignore/get":
        requireSubscription(connection);
        return connection.rules;
      case "ignore/update": {
        requireSubscription(connection);
        const validated = connection.fs!.validateRules(params.hidden, params.stopped);
        connection.rules = await state.setIgnores(ignoreKey(connection.clientId!, connection.root!), validated.hidden, validated.stopped);
        connection.fs = makeFs(connection.root!, () => connection.rules!, config);
        watchers.updateRules(connection.root!, connection.clientId!, connection.rules);
        return connection.rules;
      }
      default: throw new ServiceError("METHOD_NOT_FOUND", "不支持此请求方法。");
    }
  }

  async function openSubscription(connection: Connection, root: string): Promise<unknown> {
    const id = randomUUID();
    const canonical = canonicalRootKey(root);
    const rules = state.getIgnores(ignoreKey(connection.clientId!, canonical));
    const nextFs = makeFs(root, () => connection.rules ?? rules, config);
    watchers.acquire({ id, clientId: connection.clientId!, root, fs: nextFs, rules: () => connection.rules ?? rules, setRules: (next) => { connection.rules = next; }, send: (event) => sendEvent(connection, { ...event, subscriptionId: id }) });
    closeSubscription(connection);
    connection.subscriptionId = id;
    connection.root = root;
    connection.rules = rules;
    connection.fs = nextFs;
    const label = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
    void state.addRecent(connection.clientId!, { path: root, label, lastOpenedAt: Date.now() }).catch((error) => console.error(`[LocalFolder] 无法保存最近目录：${String(error)}`));
    return { subscriptionId: id, root: label, rootPath: root, version: 1, rules };
  }

  function closeSubscription(connection: Connection): void {
    if (connection.subscriptionId) watchers.release(connection.subscriptionId, connection.root);
    connection.subscriptionId = undefined;
    connection.root = undefined;
    connection.rules = undefined;
    connection.fs = undefined;
  }

  function closeConnection(connection: Connection, code?: number, reason?: string): void {
    closeSubscription(connection);
    for (const controller of connection.searches.values()) controller.abort();
    connection.searches.clear();
    connectionMap.delete(connection);
    if (connection.ws.readyState === WebSocket.OPEN && code) connection.ws.close(code, reason);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    clearInterval(heartbeat);
    clearInterval(revokePoll);
    stateWatcher.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    throw error;
  }
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : config.port;
  const url = `ws://${config.host === "::1" ? `[${config.host}]` : config.host}:${actualPort}/ws`;
  const close = async () => {
    clearInterval(revokePoll);
    clearInterval(heartbeat);
    stateWatcher.close();
    const sockets = [...connectionMap].map((connection) => connection.ws);
    for (const connection of [...connectionMap]) {
      sendEvent(connection, { event: "service.shutting-down" });
      closeConnection(connection, 1001, "service shutting down");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return { close, url, pairingCode, state };
}

function makeFs(root: string, rules: () => IgnoreRules, config: ServiceConfig): FileSystemService {
  return new FileSystemService(root, rules, config.maxFileBytes, config.maxDirectoryEntries, config.maxSearchEntries, config.maxSearchResults);
}
function requireAuth(connection: Connection): void { if (!connection.clientId) throw new ServiceError("UNAUTHORIZED", "请先完成配对或客户端认证。"); }
function requireSubscription(connection: Connection): FileSystemService {
  requireAuth(connection);
  if (!connection.subscriptionId || !connection.fs || !connection.root) throw new ServiceError("SUBSCRIPTION_REQUIRED", "请先选择并授权一个本地目录。");
  return connection.fs;
}
function sendResponse(connection: Connection, requestId: string, result?: unknown, error?: unknown): void {
  if (connection.ws.readyState !== WebSocket.OPEN) return;
  const payload = error ? asServiceError(error) : undefined;
  let details: unknown;
  if (payload?.code === "CONFIRMATION_REQUIRED") { try { details = JSON.parse(payload.message); } catch { /* retain the safe fallback message */ } }
  connection.ws.send(JSON.stringify({ protocolVersion, type: "response", requestId, ...(payload ? { error: { code: payload.code, message: details ? "删除操作需要确认。" : payload.message, retryable: payload.retryable, ...(details ? { details } : {}) } } : { result }) }));
}
function sendEvent(connection: Connection, event: Record<string, unknown>): void {
  if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(JSON.stringify({ protocolVersion, type: "event", eventId: randomUUID(), ...event }));
}
function consumeRate(connection: Connection, limit: number): boolean {
  const now = Date.now();
  connection.requestTimes = connection.requestTimes.filter((time) => now - time < 60_000);
  if (connection.requestTimes.length >= limit) return false;
  connection.requestTimes.push(now);
  return true;
}
function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > 16 * 1024 * 1024) throw new ServiceError("INVALID_REQUEST", `参数 ${name} 无效。`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
function ignoreKey(clientId: string, root: string): string { return `${clientId}:${createHash("sha256").update(canonicalRootKey(root)).digest("hex")}`; }
async function chooseFolder(): Promise<string | null> {
  if (process.platform !== "win32") throw new ServiceError("PICKER_UNAVAILABLE", "此版本的系统文件夹选择器仅支持 Windows；请在页面输入绝对路径。");
  const script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择 Cebian 本地文件夹工作台的根目录'; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($d.SelectedPath) }";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new ServiceError("PICKER_TIMEOUT", "系统文件夹选择器超时。", true)); }, 5 * 60_000).unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.once("error", () => { clearTimeout(timeout); reject(new ServiceError("PICKER_UNAVAILABLE", "无法启动系统文件夹选择器。")); });
    child.once("close", (code) => { clearTimeout(timeout); if (code !== 0) reject(new ServiceError("PICKER_FAILED", "系统文件夹选择器未能完成。")); else resolve(output.trim() || null); });
  });
}
function getListeningPort(server: ReturnType<typeof createServer>, fallback: number): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : fallback;
}
