import WebSocket from "ws";

export function request(socket: WebSocket, method: string, params: Record<string, unknown>): Promise<{ result?: Record<string, any>; error?: { code: string } }> {
  const requestId = `${Date.now()}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`请求超时：${method}`)); }, 3000);
    const onMessage = (raw: WebSocket.RawData) => {
      const response = JSON.parse(raw.toString()) as { type: string; requestId: string; result?: Record<string, any>; error?: { code: string } };
      if (response.type === "response" && response.requestId === requestId) { cleanup(); resolve(response); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    function cleanup(): void { clearTimeout(timeout); socket.off("message", onMessage); socket.off("error", onError); }
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.send(JSON.stringify({ protocolVersion: "1.0", type: "request", requestId, method, params }));
  });
}

export function waitEvent(socket: WebSocket, eventName: string): Promise<{ path?: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`事件超时：${eventName}`)); }, 3000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as { type: string; event?: string; path?: string };
      if (message.type === "event" && message.event === eventName) { cleanup(); resolve(message); }
    };
    function cleanup(): void { clearTimeout(timeout); socket.off("message", onMessage); }
    socket.on("message", onMessage);
  });
}
