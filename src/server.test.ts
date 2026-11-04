import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { startService } from "./server.ts";
import type { ServiceConfig } from "./config.ts";

test("WebSocket 配对、目录授权、文件读取和撤销授权闭环", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "cebian-service-test-"));
  const root = path.join(sandbox, "workspace");
  const dataDir = path.join(sandbox, "data");
  await mkdir(root);
  await writeFile(path.join(root, "hello.txt"), "hello\r\n");
  const config: ServiceConfig = {
    host: "127.0.0.1", port: 0, dataDir, allowedOrigins: new Set(), maxConnections: 8, maxMessageBytes: 1024 * 1024,
    maxFileBytes: 1024 * 1024, maxDirectoryEntries: 100, maxSearchEntries: 1000, maxSearchResults: 50, maxRequestsPerMinute: 100,
  };
  const service = await startService(config);
  const socket = new WebSocket(service.url);
  await once(socket, "open");
  let secondSocket: WebSocket | undefined;
  try {
    const denied = await request(socket, "directory/list", { path: "" });
    assert.equal(denied.error?.code, "UNAUTHORIZED");
    const hello = await request(socket, "hello", {});
    assert.equal(hello.result?.protocolVersion, "1.0");
    const paired = await request(socket, "pair/complete", { code: service.pairingCode, clientName: "test page" });
    const token = String(paired.result?.token);
    const clientId = String(paired.result?.clientId);
    assert.ok(token.length >= 32);
    const opened = await request(socket, "subscription/open", { rootPath: root });
    assert.ok(opened.result?.subscriptionId);
    const file = await request(socket, "file/read", { path: "hello.txt" });
    assert.equal(file.result?.content, "hello\r\n");
    assert.equal(file.result?.lineEnding, "crlf");
    secondSocket = new WebSocket(service.url);
    await once(secondSocket, "open");
    await request(secondSocket, "authenticate", { token });
    await request(secondSocket, "subscription/open", { rootPath: root });
    const firstEvent = waitEvent(socket, "entry.changed");
    const secondEvent = waitEvent(secondSocket, "entry.changed");
    await writeFile(path.join(root, "external.txt"), "external");
    assert.equal((await firstEvent).path, "external.txt");
    assert.equal((await secondEvent).path, "external.txt");
    await service.state.revoke(clientId);
    await Promise.race([Promise.all([once(socket, "close"), once(secondSocket, "close")]), new Promise((_, reject) => setTimeout(() => reject(new Error("授权撤销未关闭活动连接")), 3000))]);
    assert.equal(service.state.findClient(token), undefined);
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    if (secondSocket && secondSocket.readyState !== WebSocket.CLOSED) secondSocket.terminate();
    await service.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

function request(socket: WebSocket, method: string, params: Record<string, unknown>): Promise<{ result?: Record<string, any>; error?: { code: string } }> {
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

function waitEvent(socket: WebSocket, eventName: string): Promise<{ path?: string }> {
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
