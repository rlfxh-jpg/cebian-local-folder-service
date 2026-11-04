import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { createServer } from "vite";
import WebSocket from "ws";
import { startDemo } from "../../demo/server.ts";
import { useFolderWorkspace } from "../../demo/src/composables/useFolderWorkspace.js";
import { FolderClient } from "../../demo/src/services/folder-client.js";
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
    const client = new FolderClient();
    const request = client.request.bind(client);
    let pickerResult = "selected";
    const calls = [];
    // Stub only the native dialog boundary; directory authorization and file I/O use the real service.
    client.request = (method, params, timeout) => {
      calls.push(method);
      if (method === "folder/choose") {
        if (pickerResult === "cancelled") return Promise.resolve({ cancelled: true });
        if (pickerResult === "unavailable") return Promise.reject(Object.assign(new Error("选择器不可用"), { code: "PICKER_UNAVAILABLE" }));
        return request("subscription/open", { rootPath: root });
      }
      return request(method, params, timeout);
    };
    // Run the real composable in a Vue setup context without browser globals or mounting.
    await renderToString(createSSRApp({
      setup() { workspace = useFolderWorkspace(client); return () => null; },
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
    await workspace.chooseRoot();
    assert.ok(calls.includes("folder/choose"));
    assert.ok(!calls.includes("subscription/open"), "工作区只应请求系统选择器");
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

    const subscription = state.subscription;
    pickerResult = "cancelled";
    await workspace.chooseRoot();
    assert.equal(state.subscription, subscription);
    assert.equal(state.draft, "my draft\n");
    pickerResult = "unavailable";
    await assert.rejects(workspace.chooseRoot(), (error) => error.code === "PICKER_UNAVAILABLE");
    assert.equal(state.subscription, subscription);
    assert.equal(state.draft, "my draft\n");

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

test("目录树按需展开、分支分页、搜索返回及变更同步，Vue 模板展示类型图标", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "cebian-tree-test-"));
  const root = path.join(sandbox, "workspace");
  await mkdir(path.join(root, "alpha", "nested"), { recursive: true });
  await mkdir(path.join(root, "beta"));
  await writeFile(path.join(root, "alpha", "one.txt"), "one");
  await writeFile(path.join(root, "alpha", "two.txt"), "two");
  await writeFile(path.join(root, "alpha", "nested", "deep.txt"), "deep");
  await writeFile(path.join(root, "beta", "hidden.log"), "log");
  await writeFile(path.join(root, "root.txt"), "root");
  const demo = await startDemo(readConfig({ LOCAL_FOLDER_DATA_DIR: path.join(sandbox, "state"), LOCAL_FOLDER_PORT: "0", LOCAL_FOLDER_MAX_DIRECTORY_ENTRIES: "2" }), 0);
  const previousWebSocket = globalThis.WebSocket;
  const previousPrompt = globalThis.prompt;
  const previousConfirm = globalThis.confirm;
  globalThis.WebSocket = class extends WebSocket {
    constructor(url) { super(url, { origin: demo.url }); }
  };
  globalThis.confirm = () => true;
  let workspace;
  let templates;
  try {
    const client = new FolderClient();
    const request = client.request.bind(client);
    const queriedDirectories = [];
    client.request = (method, params, timeout) => {
      if (method === "folder/choose") return request("subscription/open", { rootPath: root });
      if (method === "directory/list") queriedDirectories.push(params.path);
      return request(method, params, timeout);
    };
    await renderToString(createSSRApp({ setup() { workspace = useFolderWorkspace(client); return () => null; } }));
    const { state } = workspace;
    state.endpoint = demo.service.url;
    await workspace.connect(); state.pairCode = demo.service.pairingCode; await workspace.pair();
    await workspace.chooseRoot();
    assert.deepEqual(queriedDirectories, [""], "选根目录时不能递归扫描子目录");
    assert.equal(state.directories[""].nextOffset, 2);
    await workspace.loadMore("");
    assert.equal(state.directories[""].entries.length, 3);

    const alpha = state.directories[""].entries.find((entry) => entry.name === "alpha");
    const beta = state.directories[""].entries.find((entry) => entry.name === "beta");
    await workspace.selectEntry(alpha);
    assert.equal(state.expanded.alpha, true);
    assert.equal(state.directories.alpha.nextOffset, 2);
    assert.equal(state.directories.beta, undefined);
    await workspace.loadMore("alpha");
    const nested = state.directories.alpha.entries.find((entry) => entry.name === "nested");
    await workspace.selectEntry(nested);
    await workspace.selectEntry(beta);
    assert.equal(state.expanded.alpha, true, "展开兄弟分支不能折叠已有分支");
    assert.equal(state.expanded["alpha/nested"], true);
    assert.equal(state.directories.alpha.entries.length, 3, "分页状态按目录保存");

    templates = await createServer({ configFile: path.resolve("demo/vite.config.ts"), server: { middlewareMode: true }, appType: "custom" });
    const Explorer = (await templates.ssrLoadModule("/src/components/DirectoryExplorer.vue")).default;
    const FolderPanel = (await templates.ssrLoadModule("/src/components/FolderPanel.vue")).default;
    const renderExplorer = () => renderToString(createSSRApp(Explorer, { workspace }));
    let html = await renderExplorer();
    assert.match(html, /工作区目录树/);
    assert.match(html, /tree-children/);
    assert.match(html, /deep\.txt/);
    assert.match(html, /icon-directory/);
    assert.match(html, /icon-file/);
    assert.match(html, /aria-expanded="true"/);
    const folderHtml = await renderToString(createSSRApp(FolderPanel, { workspace }));
    assert.match(folderHtml, /选择文件夹/);
    assert.doesNotMatch(folderHtml, /<input|id="open-root"|id="root-path"/);

    await workspace.selectEntry(alpha);
    assert.equal(state.expanded.alpha, false);
    html = await renderExplorer();
    assert.doesNotMatch(html, /deep\.txt/);
    await workspace.selectEntry(alpha);
    assert.equal(state.expanded["alpha/nested"], true);
    assert.match(await renderExplorer(), /deep\.txt/);
    await writeFile(path.join(root, "alpha", "new.txt"), "new");
    await workspace.refreshTree();
    assert.equal(state.expanded["alpha/nested"], true);
    assert.equal(state.directories[""].entries.length, 3, "刷新保留根目录已加载的分页");
    assert.ok(state.directories.alpha.entries.some((entry) => entry.name === "new.txt"));

    state.hiddenRules = "**/*.log"; await workspace.saveRules();
    assert.equal(workspace.entriesFor("beta").length, 0);
    state.showHidden = true;
    assert.equal(workspace.entriesFor("beta").length, 1);

    state.query = "deep"; await workspace.search();
    assert.equal(state.searching, true);
    await workspace.selectEntry(state.entries[0]);
    assert.equal(state.draft, "deep");
    await workspace.returnToTree();
    assert.equal(state.directory, "alpha/nested");
    assert.equal(state.expanded["alpha/nested"], true);
    assert.match(await renderExplorer(), /deep\.txt/);

    // Context-menu creation targets the clicked directory, independent of the open file.
    state.draft = "unsaved deep draft";
    const selectedPath = state.selected.path;
    globalThis.prompt = () => "context.txt";
    await workspace.createEntry("file", "beta");
    assert.equal(await readFile(path.join(root, "beta", "context.txt"), "utf8"), "");
    assert.equal(state.directory, "alpha/nested");
    assert.equal(state.selected.path, selectedPath);
    assert.equal(state.draft, "unsaved deep draft");
    globalThis.prompt = () => "context-folder";
    await workspace.createEntry("directory", "");
    assert.ok((await stat(path.join(root, "context-folder"))).isDirectory());
    assert.ok(workspace.entriesFor("beta").some((entry) => entry.name === "context.txt"));
    await workspace.refreshTree();
    assert.equal(state.draft, "unsaved deep draft", "目录刷新不能丢弃编辑草稿");

    // Rename/delete the context target while a different file has unsaved changes.
    globalThis.prompt = () => "renamed-context.txt";
    globalThis.confirm = (message) => {
      assert.ok(!message.includes("放弃"), "操作其他项目不应要求放弃当前草稿");
      assert.match(message, /beta\/renamed-context\.txt/);
      return true;
    };
    state.query = "context"; await workspace.search();
    await workspace.renameEntry({ path: "beta/context.txt", kind: "file" });
    assert.equal(await readFile(path.join(root, "beta", "renamed-context.txt"), "utf8"), "");
    assert.ok(state.entries.some((entry) => entry.path === "beta/renamed-context.txt"));
    assert.ok(!state.entries.some((entry) => entry.path === "beta/context.txt"));
    await workspace.deleteEntry({ path: "beta/renamed-context.txt", kind: "file" });
    await assert.rejects(stat(path.join(root, "beta", "renamed-context.txt")), { code: "ENOENT" });
    assert.ok(!state.entries.some((entry) => entry.path === "beta/renamed-context.txt"));
    assert.equal(state.selected.path, selectedPath);
    assert.equal(state.draft, "unsaved deep draft");
    await workspace.returnToTree();

    // Root actions and cancelling a discard must leave the open file intact.
    globalThis.prompt = () => { throw new Error("不应弹出重命名提示"); };
    globalThis.confirm = () => false;
    await workspace.renameEntry({ path: "", kind: "directory" });
    await workspace.deleteEntry({ path: "", kind: "directory" });
    await workspace.renameEntry({ path: "alpha/nested", kind: "directory" });
    await workspace.deleteEntry({ path: "alpha/nested", kind: "directory" });
    assert.equal(await readFile(path.join(root, "alpha", "nested", "deep.txt"), "utf8"), "deep");
    assert.equal(state.draft, "unsaved deep draft");
    globalThis.confirm = () => true;

    // A directory found through search opens its ancestor chain in the tree.
    await workspace.selectEntry(alpha);
    state.query = "nested"; await workspace.search();
    await workspace.selectEntry(state.entries[0]);
    assert.equal(state.searching, false);
    assert.equal(state.expanded.alpha, true);
    assert.equal(state.expanded["alpha/nested"], true);
    globalThis.prompt = () => "renamed";
    await workspace.renameEntry();
    assert.equal(state.directory, "alpha/renamed");
    assert.equal(state.expanded["alpha/renamed"], true);
    assert.equal(state.directories["alpha/nested"], undefined);
    assert.match(await renderExplorer(), /deep\.txt/);
    await workspace.selectEntry(state.directories.alpha.entries.find((entry) => entry.name === "renamed"));
    await workspace.deleteEntry();
    assert.equal(state.directories["alpha/renamed"], undefined);
    assert.doesNotMatch(await renderExplorer(), /deep\.txt/);
  } finally {
    workspace?.disconnect();
    await templates?.close();
    await demo.close();
    globalThis.WebSocket = previousWebSocket;
    if (previousPrompt === undefined) delete globalThis.prompt; else globalThis.prompt = previousPrompt;
    if (previousConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = previousConfirm;
    await rm(sandbox, { recursive: true, force: true });
  }
});
