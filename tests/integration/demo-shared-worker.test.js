import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MessageChannel, Worker } from "node:worker_threads";
import test from "node:test";
import { startDemo } from "../../demo/server.ts";
import { readConfig } from "../../src/config/index.ts";
import { FolderClient } from "../../demo/src/services/folder-client.js";

function storageCopy(source = new Map()) {
  const values = new Map(source);
  return { values, getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
}
async function eventually(check, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  assert.fail(message);
}

test("SharedWorker 连接跨页面恢复、多标签页订阅与事件隔离、凭据复用和撤销", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "cebian-shared-worker-"));
  const rootA = path.join(sandbox, "a");
  const rootB = path.join(sandbox, "b");
  await mkdir(rootA); await mkdir(rootB);
  await writeFile(path.join(rootA, "same.txt"), "A");
  await writeFile(path.join(rootB, "same.txt"), "B");
  const demo = await startDemo(readConfig({ LOCAL_FOLDER_DATA_DIR: path.join(sandbox, "state"), LOCAL_FOLDER_PORT: "0" }), 0);
  const thread = new Worker(new URL("../helpers/shared-folder-worker.js", import.meta.url), {
    workerData: { origin: demo.url, graceMs: 500 },
  });
  const clients = [];
  const createClient = (storage) => {
    const client = new FolderClient({ storage, workerFactory: () => {
      const { port1, port2 } = new MessageChannel();
      thread.postMessage(port2, [port2]);
      return { port: port1 };
    } });
    clients.push(client);
    return client;
  };
  try {
    const storageA = storageCopy();
    const a = createClient(storageA);
    await a.connect(demo.service.url);
    const paired = await a.request("pair/complete", { code: demo.service.pairingCode, clientName: "SharedWorker test" });
    assert.equal(paired.token, undefined, "Worker 不得向页面返回配对凭据");
    const subscriptionA = await a.request("subscription/open", { rootPath: rootA });

    // A duplicated browser tab starts with a copy of sessionStorage.
    const b = createClient(storageCopy(storageA.values));
    const sessionB = await b.connect(demo.service.url);
    assert.notEqual(sessionB.sessionId, a.sessionId, "复制标签页不得抢占活动连接");
    assert.equal(sessionB.authenticated, true, "同源标签页通过 Worker 内存中的凭据自动认证");
    assert.equal(sessionB.subscription, null, "新标签页必须独立授权目录");
    const subscriptionB = await b.request("subscription/open", { rootPath: rootB });
    assert.notEqual(subscriptionB.subscriptionId, subscriptionA.subscriptionId);
    const [fileA, fileB] = await Promise.all([a.request("file/read", { path: "same.txt" }), b.request("file/read", { path: "same.txt" })]);
    assert.equal(fileA.content, "A"); assert.equal(fileB.content, "B");

    // Refresh detaches the page port, not its WebSocket. Reattaching must not create a third socket.
    const originalId = a.sessionId;
    a.release(); await delay(30);
    const refreshed = createClient(storageA);
    const restored = await refreshed.restore();
    assert.equal(restored.connected, true);
    assert.equal(restored.authenticated, true);
    assert.equal(restored.sessionId, originalId);
    assert.equal(restored.subscription.subscriptionId, subscriptionA.subscriptionId);
    const status = await refreshed.request("service/status");
    assert.equal(status.connectionCount, 2); assert.equal(status.subscriptionCount, 2);
    assert.equal((await refreshed.request("file/read", { path: "same.txt" })).content, "A");

    const eventsA = []; const eventsB = [];
    refreshed.onEvent = (event) => eventsA.push(event);
    b.onEvent = (event) => eventsB.push(event);
    await writeFile(path.join(rootB, "same.txt"), "B external");
    await eventually(() => eventsB.some((event) => event.path === "same.txt"), "B 应收到其目录变更");
    assert.ok(!eventsA.some((event) => event.path === "same.txt"), "B 的目录事件不得串到 A");
    assert.ok(eventsB.every((event) => !event.subscriptionId || event.subscriptionId === subscriptionB.subscriptionId));

    b.disconnect(); await eventually(() => !b.connected, "显式断开应关闭 B 的连接");
    assert.equal((await refreshed.request("service/status")).connectionCount, 1);
    assert.equal((await refreshed.request("file/read", { path: "same.txt" })).content, "A");
    const reconnectedB = await b.connect(demo.service.url);
    assert.equal(reconnectedB.authenticated, true); assert.equal(reconnectedB.subscription, null);

    refreshed.release(); await delay(650);
    const expired = createClient(storageA);
    assert.equal((await expired.restore()).connected, false, "保留时间过后应释放旧连接");
    assert.equal((await b.request("service/status")).connectionCount, 1);
    const reconnected = await expired.connect(demo.service.url);
    assert.equal(reconnected.authenticated, true); assert.equal(reconnected.subscription, null);
    assert.ok([...storageA.values.values()].every((value) => /^[\w-]+$/.test(value)), "浏览器存储只能有随机标签页 ID");

    await demo.service.state.revoke(paired.clientId);
    await eventually(() => !b.connected && !expired.connected, "撤销授权应断开共享凭据的所有连接");
    const afterRevocation = createClient(storageCopy());
    assert.equal((await afterRevocation.connect(demo.service.url)).authenticated, false, "撤销后不能复用旧凭据");
  } finally {
    for (const client of clients) client.release();
    await thread.terminate();
    await demo.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
