import { computed, onMounted, onUnmounted, reactive } from "vue";
import { FolderClient } from "../services/folder-client.js";

export function useFolderWorkspace(client = new FolderClient()) {
  const state = reactive({
    endpoint: "ws://127.0.0.1:8765/ws", pairCode: "", connected: false,
    authenticated: false, subscription: null, busy: false,
    directory: "", entries: [], recents: [], directories: Object.create(null), expanded: Object.create(null),
    nextOffset: undefined, truncated: false, searching: false, query: "", showHidden: false,
    selected: null, loaded: null, draft: "", original: "", stale: false,
    hiddenRules: "", stoppedRules: "", ruleVersion: null,
    notice: "准备就绪。点击顶部“连接与配对”，连接本机服务后开始使用。", noticeError: false, logs: [],
  });
  // Credentials stay outside the reactive UI and never enter browser storage or logs.
  let token = "";
  let refreshTimer;
  let directoryGeneration = 0;
  let closeNotice = "";
  let disposed = false;
  let rulesChanged = false;
  const authorized = computed(() => state.connected && state.authenticated);
  const subscribed = computed(() => authorized.value && Boolean(state.subscription));
  const dirty = computed(() => Boolean(state.loaded && state.draft !== state.original));
  const canSave = computed(() => subscribed.value && state.loaded?.editable && dirty.value && !state.busy);
  const visibleEntries = computed(() => state.entries.filter((entry) => state.searching || state.showHidden || !entry.hiddenByRule));
  const entriesFor = (path) => (state.directories[path]?.entries ?? []).filter((entry) => state.showHidden || !entry.hiddenByRule);
  const status = computed(() => !state.connected ? "未连接" : !authorized.value ? "已连接 · 待配对" : subscribed.value ? "已授权 · 已订阅" : "已配对 · 待授权");
  const fileMeta = computed(() => {
    const file = state.loaded;
    return file ? `UTF-8${file.bom ? " BOM" : ""} · ${file.lineEnding.toUpperCase()} · ${file.version.size} 字节 · ${file.editable ? "可编辑" : "只读"}` : "支持 UTF-8 · 显式保存 · 版本冲突保护";
  });

  function notice(message, error = false) { state.notice = message; state.noticeError = error; }
  function report(error) { notice(`${error.code ? `${error.code}：` : ""}${error.message}`, true); }
  function log(message, error = false) {
    state.logs.unshift({ id: crypto.randomUUID(), time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), message, error });
    state.logs.splice(80);
  }
  const canDiscard = () => !dirty.value || confirm("当前文件有未保存修改，确定放弃这些修改吗？");
  async function run(action) {
    if (state.busy || disposed) return;
    state.busy = true;
    try { await action(); } catch (error) { report(error); }
    finally { state.busy = false; }
  }
  function clearEditor() {
    state.loaded = null; state.selected = null; state.original = ""; state.draft = ""; state.stale = false;
  }
  function clearWorkspace(clearDraft = true) {
    clearTimeout(refreshTimer); directoryGeneration++; rulesChanged = false;
    state.subscription = null; state.entries = []; state.directory = "";
    state.directories = Object.create(null); state.expanded = Object.create(null);
    state.nextOffset = undefined; state.searching = false; state.truncated = false;
    state.hiddenRules = ""; state.stoppedRules = ""; state.ruleVersion = null;
    if (clearDraft) clearEditor(); else if (state.loaded) state.stale = true;
  }
  function applyRules(rules) {
    state.hiddenRules = rules.hidden.join("\n"); state.stoppedRules = rules.stopped.join("\n"); state.ruleVersion = rules.version;
  }
  async function showRecents() { state.recents = (await client.request("recent/list")).directories; }
  async function removeRecent(path) { await client.request("recent/remove", { path }); await showRecents(); }
  async function acceptSubscription(result) {
    if (result.cancelled) { notice("已取消目录选择。"); return; }
    clearWorkspace(); state.subscription = result;
    applyRules(result.rules); await listDirectory(""); await showRecents();
    notice(`已授权目录：${result.rootPath}。点击目录展开或收起，点击文件查看。`);
  }
  async function chooseRoot() {
    if (canDiscard()) await acceptSubscription(await client.request("folder/choose", {}, 6 * 60_000));
  }
  async function closeRoot() {
    if (!canDiscard()) return;
    await client.request("subscription/close"); clearWorkspace(); notice("已关闭目录订阅。");
  }
  async function fetchDirectory(path, append = false) {
    const generation = directoryGeneration;
    const subscriptionId = state.subscription?.subscriptionId;
    if (!subscriptionId) return;
    const previous = state.directories[path];
    const targetCount = append ? 0 : previous?.entries.length ?? 0;
    let offset = append ? previous?.nextOffset : 0;
    if (append && offset === undefined) return;
    const entries = append ? [...previous.entries] : [];
    let result;
    do {
      result = await client.request("directory/list", { path, offset });
      if (generation !== directoryGeneration || state.subscription?.subscriptionId !== subscriptionId) return;
      entries.push(...result.entries);
      offset = result.nextOffset;
    } while (!append && offset !== undefined && entries.length < targetCount);
    if (generation !== directoryGeneration || state.subscription?.subscriptionId !== subscriptionId) return;
    state.directories[path] = { entries, nextOffset: result.nextOffset, truncated: result.truncated };
    if (path === state.directory && !state.searching) syncCurrentDirectory();
    if (result.scanLimitReached) notice("目录扫描已达到后端上限，当前结果不完整。", true);
  }
  function syncCurrentDirectory() {
    const listing = state.directories[state.directory];
    state.entries = listing?.entries ?? [];
    state.nextOffset = listing?.nextOffset; state.truncated = listing?.truncated ?? false;
  }
  async function revealDirectory(path) {
    const generation = directoryGeneration;
    const segments = path ? path.split("/") : [];
    for (let index = 0; index <= segments.length; index++) {
      const parent = segments.slice(0, index).join("/");
      if (!state.directories[parent] || state.directories[parent].error) await fetchDirectory(parent);
      if (generation !== directoryGeneration || !state.subscription) return;
      state.expanded[parent] = true;
      const child = segments.slice(0, index + 1).join("/");
      while (index < segments.length && !state.directories[parent]?.entries.some((entry) => entry.path === child) && state.directories[parent]?.nextOffset !== undefined) await fetchDirectory(parent, true);
    }
  }
  async function listDirectory(path = state.directory) {
    const generation = directoryGeneration;
    await fetchDirectory(path);
    if (generation !== directoryGeneration || !state.subscription) return;
    await revealDirectory(path);
    if (generation !== directoryGeneration) return;
    state.directory = path; state.searching = false;
    syncCurrentDirectory();
  }
  async function refreshTree() {
    const generation = directoryGeneration;
    if (!state.subscription) return;
    const reachable = new Set();
    const queue = [""];
    while (queue.length) {
      const path = queue.shift();
      reachable.add(path);
      try { await fetchDirectory(path); }
      catch (error) {
        if (generation !== directoryGeneration) return;
        if (!path) throw error;
        state.directories[path] = { entries: [], error: error.message };
        continue;
      }
      if (generation !== directoryGeneration) return;
      for (const entry of state.directories[path]?.entries ?? []) {
        if (entry.kind === "directory") {
          reachable.add(entry.path);
          if (state.expanded[entry.path] && (state.showHidden || !entry.hiddenByRule)) queue.push(entry.path);
        }
      }
    }
    for (const path of new Set([...Object.keys(state.directories), ...Object.keys(state.expanded)])) {
      if (!reachable.has(path)) { delete state.directories[path]; delete state.expanded[path]; }
    }
    if (!reachable.has(state.directory)) state.directory = "";
    if (state.selected && !state.searching) {
      const parent = state.selected.path.split("/").slice(0, -1).join("/");
      const listing = state.directories[parent];
      if (state.selected.path && listing && listing.nextOffset === undefined && !listing.truncated && !listing.entries.some((entry) => entry.path === state.selected.path)) state.selected = null;
    }
    if (!state.searching) syncCurrentDirectory();
  }
  async function returnToTree() {
    await revealDirectory(state.directory);
    state.searching = false; syncCurrentDirectory();
    await refreshTree();
  }
  async function selectEntry(entry) {
    const generation = directoryGeneration;
    if (entry.kind === "directory") {
      if (state.searching) { await revealDirectory(entry.path); state.searching = false; }
      else if (state.expanded[entry.path]) state.expanded[entry.path] = false;
      else {
        await fetchDirectory(entry.path);
        if (generation !== directoryGeneration) return;
        state.expanded[entry.path] = true;
      }
      if (generation !== directoryGeneration) return;
      state.directory = entry.path; state.selected = entry.path ? entry : null; syncCurrentDirectory();
    } else if (entry.kind === "file") await readFile(entry.path);
  }
  async function readFile(path) {
    if (!canDiscard()) return;
    const file = await client.request("file/read", { path });
    const mixed = file.lineEnding === "mixed" || /\r(?!\n)/.test(file.content);
    state.loaded = { ...file, editable: file.writable && !mixed };
    state.selected = { path, kind: "file" }; state.stale = false;
    state.directory = path.split("/").slice(0, -1).join("/");
    if (!state.searching) syncCurrentDirectory();
    state.draft = file.content.replace(/\r\n?/g, "\n"); state.original = state.draft;
    notice(mixed ? "混合换行或独立 CR 文件以只读方式展示，防止文本框转换原有换行。" : `已读取 ${path}。保存时会校验磁盘版本。`);
  }
  async function saveFile() {
    if (!subscribed.value || !state.loaded?.editable || !dirty.value) return;
    const loaded = state.loaded;
    const draft = state.draft;
    const content = loaded.lineEnding === "crlf" ? draft.replace(/\n/g, "\r\n") : draft;
    try {
      const result = await client.request("file/save", { path: loaded.path, content, expectedVersion: loaded.version.token, bom: loaded.bom });
      if (state.loaded !== loaded || !subscribed.value) return;
      loaded.version = result.version; loaded.content = content;
      loaded.lineEnding = content.includes("\r\n") ? "crlf" : content.includes("\n") ? "lf" : "none";
      state.original = draft; state.stale = false;
      notice(`已保存 ${loaded.path}，共 ${result.bytes} 字节。`); await refreshTree();
    } catch (error) {
      if (error.code === "VERSION_CONFLICT") state.stale = true;
      throw error;
    }
  }
  async function connect() {
    const url = new URL(state.endpoint);
    if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error("请输入本机 WebSocket 地址，不要在地址中携带凭据。");
    await client.connect(url.href); state.connected = true;
    await client.request("hello");
    if (token) {
      try { await client.request("authenticate", { token }); state.authenticated = true; await showRecents(); notice("已重新认证，请重新授权目录。"); }
      catch (error) { if (error.code === "UNAUTHORIZED") token = ""; throw error; }
    } else { await client.request("pair/begin"); notice("连接成功。请输入服务启动终端中显示的一次性配对码。"); }
  }
  async function pair() {
    const code = state.pairCode.trim();
    if (!code) throw new Error("请输入启动终端中的配对码。");
    const result = await client.request("pair/complete", { code, clientName: "Cebian Vue Demo" });
    token = result.token; state.authenticated = true; state.pairCode = "";
    await showRecents(); notice("配对成功。请通过系统选择器选择并授权文件夹。");
  }
  async function serviceStatus() {
    const result = await client.request("service/status");
    notice(`服务运行中 · 协议 ${result.protocolVersion} · ${result.connectionCount} 个连接 · ${result.subscriptionCount} 个订阅 · 文件上限 ${Math.round(result.limits.maxFileBytes / 1024 / 1024)} MiB`);
  }
  async function search() {
    const query = state.query.trim();
    if (!query) { await returnToTree(); return; }
    const result = await client.request("search/name", { query });
    state.searching = true; state.entries = result.results; state.nextOffset = undefined; state.truncated = result.truncated;
    notice(result.truncated ? "搜索触及后端上限，结果不完整。可缩小关键词后重试。" : `搜索完成，找到 ${result.results.length} 个项目。`);
  }
  async function createEntry(kind, directory = state.directory) {
    const name = prompt(`${kind === "file" ? "新建空 UTF-8 文件" : "新建目录"}（目标目录：/${directory}），输入单个名称：`);
    if (name === null) return;
    if (!name || /[/\\]/.test(name)) throw new Error("请输入单个名称，不能包含路径分隔符。");
    const path = [directory, name].filter(Boolean).join("/");
    await client.request("file/create", { path, kind });
    await revealDirectory(directory); await refreshTree(); notice(`已创建 ${path}。`);
  }
  const contains = (parent, child) => child === parent || child.startsWith(`${parent}/`);
  async function renameEntry(selected = state.selected) {
    if (!subscribed.value || !selected?.path || !["file", "directory"].includes(selected.kind)) return;
    if (state.loaded && contains(selected.path, state.loaded.path) && !canDiscard()) return;
    const newName = prompt(`重命名 ${selected.path}（只修改名称）：`, selected.path.split("/").at(-1));
    if (newName === null) return;
    const result = await client.request("entry/rename", { path: selected.path, newName });
    if (state.loaded && contains(selected.path, state.loaded.path)) clearEditor();
    if (state.selected && contains(selected.path, state.selected.path)) state.selected = null;
    if (contains(selected.path, state.directory)) state.directory = result.path + state.directory.slice(selected.path.length);
    for (const path of Object.keys(state.expanded)) {
      if (contains(selected.path, path)) {
        state.expanded[result.path + path.slice(selected.path.length)] = state.expanded[path];
        delete state.expanded[path]; delete state.directories[path];
      }
    }
    await refreshTree();
    if (state.searching) await search();
    notice(`已重命名为 ${result.path}。`);
  }
  async function deleteEntry(selected = state.selected) {
    if (!subscribed.value || !selected?.path || !["file", "directory"].includes(selected.kind)) return;
    if (state.loaded && contains(selected.path, state.loaded.path) && !canDiscard()) return;
    const inspection = await client.request("entry/inspect-delete", { path: selected.path });
    if (!confirm(`将永久删除 ${selected.path}\n范围：${inspection.itemCount} 个项目（包括目标自身）${inspection.recursive ? "，含目录中的所有内容" : ""}。\n确定继续吗？`)) return;
    await client.request("entry/delete", { path: selected.path, confirmationVersion: inspection.version });
    if (state.loaded && contains(selected.path, state.loaded.path)) clearEditor();
    if (state.selected && contains(selected.path, state.selected.path)) state.selected = null;
    if (contains(selected.path, state.directory)) state.directory = selected.path.split("/").slice(0, -1).join("/");
    await refreshTree();
    if (state.searching) await search();
    notice(`已删除 ${selected.path}。`);
  }
  async function saveRules() {
    const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    applyRules(await client.request("ignore/update", { hidden: lines(state.hiddenRules), stopped: lines(state.stoppedRules) }));
    await refreshTree(); notice("忽略规则已更新。");
  }

  client.onRequest = (method, code, duration) => log(`${method} · ${code ?? "OK"} · ${duration} ms`, Boolean(code));
  client.onClose = () => {
    state.connected = false; state.authenticated = false; state.recents = []; clearWorkspace(false);
    notice(closeNotice || "连接已断开。未保存文本仍留在编辑器中；请先复制需要保留的修改，再重新连接并授权目录。", true);
    closeNotice = ""; log("连接关闭");
  };
  client.onEvent = (event) => {
    log(`${event.event}${event.path ? ` · ${event.path}` : ""}`);
    if (event.event === "auth.revoked") {
      token = ""; state.authenticated = false; state.pairCode = ""; state.recents = []; clearWorkspace();
      closeNotice = "授权已撤销，已清除当前页面凭据与编辑内容。请重新配对。";
      notice(closeNotice, true); return;
    }
    if (event.event === "service.shutting-down") { notice("服务正在关闭。", true); return; }
    if (!state.subscription || (event.subscriptionId && event.subscriptionId !== state.subscription.subscriptionId)) return;
    if (state.loaded && [event.path, event.oldPath].includes(state.loaded.path)) state.stale = true;
    if (["entry.changed", "entry.deleted", "entry.renamed", "directory.changed", "resync.required", "ignore.changed"].includes(event.event)) {
      if (event.event === "ignore.changed") rulesChanged = true;
      clearTimeout(refreshTimer);
      const refresh = async () => {
        if (disposed || !subscribed.value) return;
        if (state.busy) { refreshTimer = setTimeout(refresh, 300); return; }
        await run(async () => {
          if (rulesChanged) { rulesChanged = false; applyRules(await client.request("ignore/get")); }
          if (state.loaded && state.stale) {
            const loaded = state.loaded;
            try {
              const disk = await client.request("file/read", { path: loaded.path });
              if (state.loaded === loaded) state.stale = disk.version.token !== loaded.version.token;
            } catch { if (state.loaded === loaded) state.stale = true; }
          }
          if (!state.searching) await refreshTree();
          else notice("搜索期间目录或规则发生变化，请重新搜索获取最新结果。");
        });
      };
      refreshTimer = setTimeout(refresh, 300);
    }
  };
  function onKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); if (canSave.value) void run(saveFile);
    }
  }
  function beforeUnload(event) { if (dirty.value) { event.preventDefault(); event.returnValue = ""; } }
  onMounted(async () => {
    document.addEventListener("keydown", onKeydown); window.addEventListener("beforeunload", beforeUnload);
    try {
      const response = await fetch("/config.json");
      if (!response.ok) throw new Error("无法读取 demo 配置，请确认通过 npm run demo 启动页面。");
      state.endpoint = (await response.json()).websocketUrl;
    } catch (error) { report(error); }
  });
  onUnmounted(() => {
    disposed = true; clearTimeout(refreshTimer);
    document.removeEventListener("keydown", onKeydown); window.removeEventListener("beforeunload", beforeUnload);
    client.onEvent = client.onClose = client.onRequest = () => {}; client.disconnect(); token = "";
  });

  return {
    state, authorized, subscribed, dirty, canSave, visibleEntries, entriesFor, status, fileMeta, run,
    connect, disconnect: () => client.disconnect(), pair, serviceStatus, chooseRoot, closeRoot,
    showRecents, removeRecent, listDirectory, selectEntry, search, createEntry, renameEntry, deleteEntry,
    saveFile, reloadFile: () => state.loaded && readFile(state.loaded.path), saveRules,
    refreshTree, returnToTree, loadMore: (path) => fetchDirectory(path, true),
  };
}
