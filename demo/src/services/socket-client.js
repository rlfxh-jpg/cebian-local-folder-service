/** Small protocol client shared by every demo action. Credentials never enter logs. */
export class FolderClient {
  socket;
  pending = new Map();
  onEvent = () => {};
  onClose = () => {};
  onRequest = () => {};

  get connected() { return this.socket?.readyState === WebSocket.OPEN; }

  async connect(url) {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) throw new Error("请先断开当前连接。");
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("message", ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === "event") { this.onEvent(message); return; }
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      this.onRequest(pending.method, message.error?.code, Date.now() - pending.started);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("连接已断开，请重新连接并授权目录。"));
      }
      this.pending.clear();
      this.onClose();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("连接超时，请确认后端已启动。")); }, 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("连接失败，请检查服务地址与来源授权。")); }, { once: true });
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("服务已关闭连接。")); }, { once: true });
    });
  }

  request(method, params = {}, timeout = 30_000) {
    if (!this.connected) return Promise.reject(new Error("请先连接后端服务。"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`请求超时：${method}`));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer, method, started: Date.now() });
      try { this.socket.send(JSON.stringify({ protocolVersion: "1.0", type: "request", requestId, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  disconnect() { this.socket?.close(1000, "demo disconnect"); }
}
