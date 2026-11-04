import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { startDemo } from "../../demo/server.ts";
import { readConfig } from "../../src/config/index.ts";
import { request } from "../helpers/protocol.ts";

test("demo 仅提供固定静态资源，显式允许当前页面来源并保持配对和版本保护", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "cebian-demo-test-"));
  const root = path.join(sandbox, "workspace");
  await mkdir(root);
  await writeFile(path.join(root, "hello.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\r\n")]));
  const config = readConfig({ LOCAL_FOLDER_DATA_DIR: path.join(sandbox, "state"), LOCAL_FOLDER_PORT: "0" });
  const demo = await startDemo(config, 0);
  let socket: WebSocket | undefined;
  try {
    assert.equal(config.allowedOrigins.size, 0, "demo 不应修改调用方的生产配置");
    const page = await fetch(demo.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /本地文件工作台/);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    for (const asset of ["app.js", "client.js", "styles.css"]) {
      const response = await fetch(`${demo.url}/${asset}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const settings = await (await fetch(`${demo.url}/config.json`)).json() as { websocketUrl: string };
    assert.equal(settings.websocketUrl, demo.service.url);
    assert.equal((await fetch(`${demo.url}/src/index.ts`)).status, 404);
    assert.equal((await fetch(`${demo.url}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${demo.url}/`, { method: "POST" })).status, 405);

    const rejected = new WebSocket(demo.service.url, { origin: "http://127.0.0.1:9999" });
    await assert.rejects(once(rejected, "open"), /403/);
    socket = new WebSocket(demo.service.url, { origin: demo.url });
    await once(socket, "open");
    assert.equal((await request(socket, "directory/list", { path: "" })).error?.code, "UNAUTHORIZED");
    assert.ok((await request(socket, "pair/complete", { code: demo.service.pairingCode, clientName: "Demo test" })).result?.clientId);
    assert.ok((await request(socket, "subscription/open", { rootPath: root })).result?.subscriptionId);
    const listing = await request(socket, "directory/list", { path: "" });
    assert.equal(listing.result?.entries[0].name, "hello.txt");
    const loaded = (await request(socket, "file/read", { path: "hello.txt" })).result!;
    assert.equal(loaded.bom, true);
    const saved = await request(socket, "file/save", { path: "hello.txt", content: "changed\r\n", bom: true, expectedVersion: loaded.version.token });
    assert.ok(saved.result?.version.token);
    const stale = await request(socket, "file/save", { path: "hello.txt", content: "stale", bom: true, expectedVersion: loaded.version.token });
    assert.equal(stale.error?.code, "VERSION_CONFLICT");
    assert.deepEqual(await readFile(path.join(root, "hello.txt")), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("changed\r\n")]));
  } finally {
    socket?.terminate();
    await demo.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
