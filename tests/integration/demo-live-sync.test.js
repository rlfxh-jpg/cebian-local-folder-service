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
import { FolderClient } from "../../demo/src/services/folder-client.js";
import { readConfig } from "../../src/config/index.ts";

async function eventually(check, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("网页与本地双向自动同步：连续输入、输入法、串行写入、冲突恢复与断线保护", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "cebian-live-sync-"));
  const root = path.join(sandbox, "workspace");
  await mkdir(root);
  const filePath = path.join(root, "live.txt");
  await writeFile(filePath, "\ufeffinitial\r\n");
  await writeFile(path.join(root, "other.txt"), "other");
  await writeFile(path.join(root, "mixed.txt"), "one\r\ntwo\n");
  const demo = await startDemo(readConfig({ LOCAL_FOLDER_DATA_DIR: path.join(sandbox, "state"), LOCAL_FOLDER_PORT: "0" }), 0);
  const previousWebSocket = globalThis.WebSocket;
  const previousConfirm = globalThis.confirm;
  globalThis.WebSocket = class extends WebSocket {
    constructor(url) { super(url, { origin: demo.url }); }
  };
  globalThis.confirm = () => true;
  let workspace;
  let holdSave;
  let activeGate;
  try {
    const client = new FolderClient();
    const request = client.request.bind(client);
    const writes = [];
    let activeWrites = 0;
    let maxWrites = 0;
    let failWrite = false;
    client.request = async (method, params, timeout) => {
      if (method === "folder/choose") return request("subscription/open", { rootPath: root });
      if (method !== "file/save") return request(method, params, timeout);
      activeWrites++; maxWrites = Math.max(maxWrites, activeWrites); writes.push(params.content);
      try {
        if (holdSave) {
          activeGate = holdSave; holdSave = undefined;
          activeGate.entered.resolve(); await activeGate.release.promise;
        }
        if (failWrite) throw Object.assign(new Error("文件只读"), { code: "PERMISSION_DENIED" });
        return await request(method, params, timeout);
      } finally { activeWrites--; }
    };
    await renderToString(createSSRApp({ setup() { workspace = useFolderWorkspace(client); return () => null; } }));
    const { state } = workspace;
    state.endpoint = demo.service.url;
    await workspace.connect(); state.pairCode = demo.service.pairingCode; await workspace.pair();
    await workspace.chooseRoot();
    await workspace.selectEntry({ path: "live.txt", kind: "file" });
    const disk = () => readFile(filePath, "utf8");
    const isSaved = async (text) => await disk() === `\ufeff${text.replace(/\n/g, "\r\n")}` && !workspace.dirty.value && !state.saving;

    workspace.updateDraft("web\n");
    await eventually(() => isSaved("web\n"), "网页输入应自动写入磁盘，保留 BOM 和 CRLF");
    await writeFile(filePath, "\ufefflocal\r\n");
    await eventually(() => state.draft === "local\n", "本地修改应通过真实 watcher 自动更新网页");
    assert.equal(state.conflict, false);

    const beforeBurst = writes.length;
    workspace.updateDraft("partial\n"); await delay(50); workspace.updateDraft("latest\n");
    await eventually(() => isSaved("latest\n"), "快速输入应写入最新文本");
    assert.equal(writes.length, beforeBurst + 1, "短时间输入应合并写入");

    workspace.setComposing(true); workspace.updateDraft("拼");
    await delay(400); assert.equal(await disk(), "\ufefflatest\r\n", "不能写入输入法组合中的文本");
    workspace.updateDraft("拼音\n"); workspace.setComposing(false);
    await eventually(() => isSaved("拼音\n"), "输入法提交后自动同步");

    holdSave = { entered: deferred(), release: deferred() };
    const serialGate = holdSave;
    workspace.updateDraft("first\n"); await serialGate.entered.promise;
    workspace.updateDraft("during request\n"); serialGate.release.resolve();
    await eventually(() => isSaved("during request\n"), "保存期间输入的文本必须接着写入");
    assert.equal(maxWrites, 1, "写请求必须串行，防止版本竞态与旧文本回写");
    await delay(450); assert.equal(state.conflict, false, "自己的写入事件不能造成冲突");

    holdSave = { entered: deferred(), release: deferred() };
    const conflictGate = holdSave;
    workspace.updateDraft("web conflict\n"); await conflictGate.entered.promise;
    await writeFile(filePath, "\ufeffdisk conflict\r\n"); conflictGate.release.resolve();
    await eventually(() => state.conflict && !state.saving, "并发修改应暂停自动同步");
    assert.equal(state.draft, "web conflict\n");
    assert.equal(await disk(), "\ufeffdisk conflict\r\n");
    workspace.updateDraft("web conflict edited\n");
    const pausedWrites = writes.length;
    await delay(400); assert.equal(writes.length, pausedWrites, "冲突时不得继续自动覆盖磁盘");
    await workspace.resolveConflict(false);
    assert.equal(state.draft, "disk conflict\n"); assert.equal(state.conflict, false);

    // Retry uses the latest disk version and never bypasses backend version checks.
    failWrite = true; workspace.updateDraft("retry\n");
    await eventually(() => state.syncError && !state.saving, "写入错误应保留网页内容并显示错误");
    assert.equal(state.draft, "retry\n"); assert.equal(await disk(), "\ufeffdisk conflict\r\n");
    failWrite = false; await workspace.retrySync();
    assert.equal(await disk(), "\ufeffretry\r\n"); assert.equal(state.syncError, "");

    holdSave = { entered: deferred(), release: deferred() };
    const overwriteGate = holdSave;
    workspace.updateDraft("keep web\n"); await overwriteGate.entered.promise;
    await writeFile(filePath, "\ufeffsecond disk conflict\r\n"); overwriteGate.release.resolve();
    await eventually(() => state.conflict && !state.saving, "第二次并发修改应暂停");
    await workspace.resolveConflict(true);
    assert.equal(await disk(), "\ufeffkeep web\r\n"); assert.equal(state.conflict, false);

    workspace.updateDraft("before switch\n");
    await workspace.selectEntry({ path: "other.txt", kind: "file" });
    assert.equal(await disk(), "\ufeffbefore switch\r\n", "切换文件前完成待同步写入");
    assert.equal(state.draft, "other");
    await delay(400); assert.equal(state.draft, "other", "旧文件事件不能覆盖新文件");

    await workspace.selectEntry({ path: "mixed.txt", kind: "file" });
    assert.equal(state.loaded.editable, false);
    await writeFile(path.join(root, "mixed.txt"), "changed\r\nagain\n");
    await eventually(() => state.draft === "changed\nagain\n", "只读文本也应自动同步本地变更");
    assert.equal(state.loaded.editable, false);

    await workspace.selectEntry({ path: "live.txt", kind: "file" });
    workspace.updateDraft("offline draft\n"); workspace.disconnect();
    await eventually(() => !state.connected, "断线应结束当前同步");
    await delay(400); assert.equal(state.draft, "offline draft\n");
    assert.equal(await disk(), "\ufeffbefore switch\r\n", "断线取消待写入任务");
  } finally {
    activeGate?.release.resolve(); holdSave?.release.resolve();
    workspace?.disconnect(); await demo.close();
    globalThis.WebSocket = previousWebSocket;
    if (previousConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = previousConfirm;
    await rm(sandbox, { recursive: true, force: true });
  }
});
