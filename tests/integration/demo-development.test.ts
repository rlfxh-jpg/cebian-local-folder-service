import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { startDemo } from "../../demo/server.ts";
import { readConfig } from "../../src/config/index.ts";

test("Demo 开发模式提供 Vue 源码并通过同一页面端口推送 CSS 热更新", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "cebian-demo-dev-"));
  const name = `hmr-${randomUUID()}.css`;
  const stylesheet = new URL(`../../demo/src/${name}`, import.meta.url);
  let demo: Awaited<ReturnType<typeof startDemo>> | undefined;
  let socket: WebSocket | undefined;
  try {
    await writeFile(stylesheet, ".hmr-test { color: red; }\n");
    demo = await startDemo(readConfig({ LOCAL_FOLDER_DATA_DIR: sandbox, LOCAL_FOLDER_PORT: "0" }), 0, { development: true });
    const page = await fetch(demo.url);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /\/@vite\/client/);
    assert.match(html, /\/src\/main.js/);
    assert.match(page.headers.get("content-security-policy") ?? "", /style-src 'self' 'unsafe-inline'/);
    const config = await (await fetch(`${demo.url}/config.json`)).json() as { websocketUrl: string };
    assert.equal(config.websocketUrl, demo.service.url);
    const component = await fetch(`${demo.url}/src/App.vue`);
    assert.equal(component.status, 200);
    assert.match(await component.text(), /import.meta.hot/);

    const client = await (await fetch(`${demo.url}/@vite/client`)).text();
    const token = client.match(/const wsToken = "([^"]+)"/)?.[1];
    assert.ok(token, "Vite 客户端应提供 HMR 连接令牌");
    socket = new WebSocket(`${demo.url.replace("http:", "ws:")}/?token=${token}`, "vite-hmr", { origin: demo.url });
    const connected = once(socket, "message");
    await once(socket, "open");
    assert.equal(JSON.parse(String((await connected)[0])).type, "connected");
    const style = await fetch(`${demo.url}/src/${name}`);
    assert.equal(style.status, 200);
    assert.match(await style.text(), /color: red/);

    const activeSocket = socket;
    const update = new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); activeSocket.off("message", onMessage); };
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(String(raw)) as { type: string; updates?: { path: string }[] };
        if (message.type === "update" && message.updates?.some((entry) => entry.path.includes(name))) {
          cleanup(); resolve();
        }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("未收到 CSS 热更新通知")); }, 10000);
      activeSocket.on("message", onMessage);
    });
    await Promise.all([update, writeFile(stylesheet, ".hmr-test { color: blue; }\n")]);
    assert.match(await (await fetch(`${demo.url}/src/${name}`)).text(), /color: blue/);
  } finally {
    socket?.terminate();
    await demo?.close();
    await rm(stylesheet, { force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
});
