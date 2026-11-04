import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import WebSocket from "ws";
import { startDemo } from "../../demo/server.ts";
import { useFolderWorkspace } from "../../demo/src/composables/useFolderWorkspace.js";
import { readConfig } from "../../src/config/index.ts";

test("Vue 工作区与真实后端联调：配对、编辑、版本冲突、搜索与断线草稿", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "cebian-vue-test-"));
  const root = path.join(sandbox, "workspace");
  await mkdir(root);
  await writeFile(path.join(root, "hello.txt"), "\ufeffhello\r\n");
  await writeFile(path.join(root, "hidden.log"), "log");
  const demo = await startDemo(readConfig({ LOCAL_FOLDER_DATA_DIR: path.join(sandbox, "state"), LOCAL_FOLDER_PORT: "0" }), 0);
  const previousWebSocket = globalThis.WebSocket;
  const previousConfirm = globalThis.confirm;
  // ws provides the browser event API while allowing this Node test to supply Origin.
  globalThis.WebSocket = class extends WebSocket {
    constructor(url) { super(url, { origin: demo.url }); }
  };
  globalThis.confirm = () => true;
  let workspace;
  try {
    // Run the real composable in a Vue setup context without browser globals or mounting.
    await renderToString(createSSRApp({
      setup() { workspace = useFolderWorkspace(); return () => null; },
    }));
    const { state } = workspace;
    state.endpoint = demo.service.url;
    await workspace.connect();
    assert.equal(state.connected, true);
    assert.equal(workspace.authorized.value, false);
    state.pairCode = demo.service.pairingCode;
    await workspace.pair();
    assert.equal(workspace.authorized.value, true);
    assert.equal(state.pairCode, "");
    assert.ok(!JSON.stringify(state).includes(demo.service.pairingCode));
    await workspace.openRoot(root);
    assert.equal(workspace.subscribed.value, true);
    assert.equal(state.entries.length, 2);
    assert.ok(state.notice.includes(root));

    await workspace.selectEntry(state.entries.find((entry) => entry.name === "hello.txt"));
    assert.equal(state.draft, "hello\n");
    state.draft = "changed\n";
    assert.equal(workspace.dirty.value, true);
    assert.equal(workspace.canSave.value, true);
    await workspace.saveFile();
    assert.equal(await readFile(path.join(root, "hello.txt"), "utf8"), "\ufeffchanged\r\n");
    assert.equal(workspace.dirty.value, false);

    await writeFile(path.join(root, "hello.txt"), "external\n");
    state.draft = "my draft\n";
    await assert.rejects(workspace.saveFile(), (error) => error.code === "VERSION_CONFLICT");
    assert.equal(state.draft, "my draft\n");
    assert.equal(state.stale, true);
    assert.equal(await readFile(path.join(root, "hello.txt"), "utf8"), "external\n");

    state.hiddenRules = "*.log";
    await workspace.saveRules();
    assert.equal(workspace.visibleEntries.value.length, 1);
    state.showHidden = true;
    assert.equal(workspace.visibleEntries.value.length, 2);
    state.query = "hello";
    await workspace.search();
    assert.equal(state.searching, true);
    assert.equal(state.entries[0].name, "hello.txt");

    workspace.disconnect();
    for (let attempt = 0; state.connected && attempt < 100; attempt++) await delay(10);
    assert.equal(state.connected, false);
    assert.equal(workspace.subscribed.value, false);
    assert.equal(state.draft, "my draft\n");
    await workspace.connect();
    assert.equal(state.authenticated, true, "同一页面重连应自动认证");
    assert.equal(state.subscription, null, "重连后仍需重新授权目录");
  } finally {
    workspace?.disconnect();
    await demo.close();
    globalThis.WebSocket = previousWebSocket;
    if (previousConfirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = previousConfirm;
    await rm(sandbox, { recursive: true, force: true });
  }
});
