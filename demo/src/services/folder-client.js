import { SocketClient } from "./socket-client.js";

const sessionKey = "cebian-folder-session";
function defaultWorker() {
  return new SharedWorker(new URL("./folder-connection.worker.js", import.meta.url), {
    type: "module", name: "cebian-folder-connections-v1", extendedLifetime: true,
  });
}

/** Page-side RPC facade. Socket state and credentials stay in SharedWorker memory. */
export class FolderClient {
  onEvent = () => {};
  onClose = () => {};
  onRequest = () => {};
  pending = new Map();
  active = false;

  constructor({ workerFactory = typeof SharedWorker === "undefined" ? null : defaultWorker, storage } = {}) {
    this.workerFactory = workerFactory;
    this.connectionMode = workerFactory ? "shared-worker" : "page";
    try { this.storage = storage ?? globalThis.sessionStorage; this.sessionId = this.storage?.getItem(sessionKey); } catch { /* Storage may be disabled. */ }
    this.hadSession = Boolean(this.sessionId);
    this.sessionId ||= crypto.randomUUID();
    this.pagehide = (event) => { if (!event.persisted) this.release(); };
    globalThis.addEventListener?.("pagehide", this.pagehide);
    if (!workerFactory) {
      this.direct = new SocketClient();
      this.direct.onEvent = (event) => this.onEvent(event);
      this.direct.onClose = () => this.onClose();
      this.direct.onRequest = (...args) => this.onRequest(...args);
    }
  }
  get connected() { return this.direct ? this.direct.connected : this.active; }

  async attach() {
    if (!this.workerFactory) return null;
    if (this.attaching) return this.attaching;
    const worker = this.workerFactory();
    this.worker = worker; this.port = worker.port;
    this.port.onmessage = ({ data }) => {
      if (data.replyTo) {
        const pending = this.pending.get(data.replyTo);
        if (!pending) return;
        this.pending.delete(data.replyTo); clearTimeout(pending.timer);
        if (data.error) pending.reject(Object.assign(new Error(data.error.message), data.error));
        else pending.resolve(data.result);
      } else if (data.type === "event") this.onEvent(data.event);
      else if (data.type === "request-log") this.onRequest(data.method, data.code, data.duration);
      else if (data.type === "closed") {
        this.active = false;
        this.rejectPending(new Error("连接已断开，请重新连接并授权目录。"));
        this.onClose();
      }
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      this.release();
      this.onClose();
    };
    this.port.start();
    this.attaching = this.rpc("attach", { sessionId: this.sessionId }).then((session) => {
      this.forked = session.sessionId !== this.sessionId;
      this.sessionId = session.sessionId; this.active = session.connected;
      try { this.storage?.setItem(sessionKey, this.sessionId); } catch { /* Only an opaque tab ID is stored. */ }
      return session;
    }).catch((error) => { this.release(); throw error; });
    return this.attaching;
  }
  rpc(type, data = {}, timeout = 15_000) {
    if (!this.port) return Promise.reject(new Error("SharedWorker 连接不可用。"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`SharedWorker 请求超时：${data.method || type}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.port.postMessage({ ...data, type, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async restore() {
    if (this.direct) return null;
    await this.attach();
    const session = await this.rpc("snapshot");
    this.active = session.connected;
    return { ...session, recoveryMissed: this.hadSession && !this.forked && !session.connected };
  }
  async connect(url) {
    if (this.direct) return this.direct.connect(url);
    await this.attach();
    const session = await this.rpc("connect", { url }, 15_000);
    this.active = session.connected;
    return session;
  }
  request(method, params = {}, timeout = 30_000) {
    if (this.direct) return this.direct.request(method, params, timeout);
    if (!this.connected) return Promise.reject(new Error("请先连接后端服务。"));
    return this.rpc("request", { method, params, timeout }, timeout + 1000);
  }
  disconnect() {
    if (this.direct) this.direct.disconnect();
    else if (this.port) void this.rpc("disconnect").catch(() => {});
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  // Navigation releases the MessagePort, allowing the worker to retain the socket for 30 seconds.
  release() {
    if (this.port) { this.port.postMessage({ type: "detach" }); this.port.close(); }
    this.port = this.worker = this.attaching = null; this.active = false;
    this.rejectPending(new Error("页面已离开，连接由 SharedWorker 暂时保留。"));
    this.direct?.disconnect();
    globalThis.removeEventListener?.("pagehide", this.pagehide);
  }
}
