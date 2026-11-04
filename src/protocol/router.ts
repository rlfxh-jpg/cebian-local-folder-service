import { createHash, randomUUID } from "node:crypto";
import type { ServiceConfig } from "../config/index.ts";
import { asServiceError, ServiceError } from "../shared/errors.ts";
import { canonicalRootKey, selectRoot } from "../filesystem/paths.ts";
import { FileSystemService } from "../filesystem/service.ts";
import { StateStore, type IgnoreRules } from "../storage/state-store.ts";
import { WatcherRegistry } from "../watchers/registry.ts";

import { chooseFolder } from "../platform/folder-picker.ts";
import { protocolVersion, type Connection, type RequestMessage } from "./types.ts";
import { sendEvent } from "./responses.ts";
import { requiredString, safeEqual } from "./validation.ts";

interface RouterContext {
  config: ServiceConfig;
  state: StateStore;
  watchers: WatcherRegistry;
  connections: Set<Connection>;
  pairingCode: string;
  getPort: () => number;
  closeConnection: (connection: Connection, code?: number, reason?: string) => void;
}

export function createRouter({ config, state, watchers, connections: connectionMap, pairingCode, getPort, closeConnection }: RouterContext) {
  const pairingExpiresAt = Date.now() + 5 * 60_000;
  let pairingUsed = false;
  let pairingFailures = 0;
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
        return { protocolVersion, status: "running", host: config.host, port: getPort(), connectionCount: connectionMap.size, subscriptionCount: [...connectionMap].filter((item) => item.subscriptionId).length, limits: { maxFileBytes: config.maxFileBytes, maxMessageBytes: config.maxMessageBytes, maxDirectoryEntries: config.maxDirectoryEntries, maxSearchEntries: config.maxSearchEntries, maxSearchResults: config.maxSearchResults, maxRequestsPerMinute: config.maxRequestsPerMinute } };
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


  return { dispatch, closeSubscription };
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
function ignoreKey(clientId: string, root: string): string { return `${clientId}:${createHash("sha256").update(canonicalRootKey(root)).digest("hex")}`; }
