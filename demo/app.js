import { FolderClient } from "./client.js";

const $ = (id) => document.getElementById(id);
const client = new FolderClient();
const state = {
  token: "", authenticated: false, subscription: null, directory: "", entries: [],
  nextOffset: undefined, truncated: false, searching: false, selected: null, loaded: null,
  original: "", stale: false, busy: false,
};
let refreshTimer;
let directoryGeneration = 0;
let closeNotice = "";

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function log(message, error = false) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.append(time, document.createTextNode(message));
  item.classList.toggle("log-error", error);
  $("event-log").prepend(item);
  while ($("event-log").children.length > 80) $("event-log").lastElementChild.remove();
}

const dirty = () => Boolean(state.loaded && $("editor").value !== state.original);
const canDiscard = () => !dirty() || confirm("当前文件有未保存修改，确定放弃这些修改吗？");
const report = (error) => { notice(`${error.code ? `${error.code}：` : ""}${error.message}`, true); };

function updateControls() {
  const connected = client.connected;
  const authorized = connected && state.authenticated;
  const subscribed = authorized && Boolean(state.subscription);
  const idle = !state.busy;
  $("connect").disabled = connected || !idle;
  $("disconnect").disabled = !connected || !idle;
  $("endpoint").disabled = connected || !idle;
  $("pair-code").disabled = !connected || state.authenticated || !idle;
  $("pair").disabled = !connected || state.authenticated || !idle;
  $("service-status").disabled = !authorized || !idle;
  $("folder-controls").disabled = !authorized || !idle;
  $("close-root").disabled = !subscribed;
  $("browse-controls").disabled = !subscribed || !idle;
  $("rule-controls").disabled = !subscribed || !idle;
  $("load-more").disabled = !subscribed || !idle;
  $("up").disabled = !state.directory;
  $("reload-file").disabled = !subscribed || !state.loaded || !idle;
  $("rename").disabled = !subscribed || !state.selected || !idle;
  $("delete").disabled = !subscribed || !state.selected || !idle;
  $("save").disabled = !subscribed || !state.loaded?.editable || !dirty() || !idle;
  $("editor").readOnly = !subscribed || !state.loaded?.editable || !idle;
  $("connection-state").textContent = !connected ? "未连接" : !authorized ? "已连接 · 待配对" : subscribed ? "已授权 · 已订阅" : "已配对 · 待授权";
  $("connection-state").classList.toggle("ready", authorized);
  $("edit-state").textContent = state.loaded ? `${dirty() ? "● 有未保存修改" : "已与读取版本同步"}${state.stale ? " · 磁盘可能已变化，请重新读取" : ""}` : "尚未打开文件";
}

async function run(action) {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  try { await action(); } catch (error) { report(error); }
  finally { state.busy = false; updateControls(); }
}

function clearEditor() {
  state.loaded = null; state.selected = null; state.original = ""; state.stale = false;
  $("editor").value = "";
  $("file-name").textContent = "选择一个文本文件";
  $("file-meta").textContent = "支持 UTF-8 · 显式保存 · 版本冲突保护";
}

function clearWorkspace(clearDraft = true) {
  clearTimeout(refreshTimer); directoryGeneration++;
  state.subscription = null; state.entries = []; state.directory = "";
  state.nextOffset = undefined; state.searching = false;
  $("root-label").textContent = "尚未授权目录";
  $("clear-search").hidden = true;
  if (clearDraft) clearEditor(); else if (state.loaded) state.stale = true;
  renderEntries(); updateControls();
}

function applyRules(rules) {
  $("hidden-rules").value = rules.hidden.join("\n");
  $("stopped-rules").value = rules.stopped.join("\n");
  $("rule-version").textContent = `当前版本 v${rules.version}`;
}

async function showRecents() {
  const { directories } = await client.request("recent/list");
  $("recent-list").replaceChildren();
  for (const directory of directories) {
    const row = document.createElement("div"); row.className = "recent-row";
    const open = document.createElement("button");
    open.textContent = `${directory.path}${directory.accessible ? "" : "（当前不可访问）"}`;
    open.addEventListener("click", () => void run(() => openRoot(directory.path)));
    const remove = document.createElement("button"); remove.textContent = "移除记录";
    remove.addEventListener("click", () => void run(async () => { await client.request("recent/remove", { path: directory.path }); await showRecents(); }));
    row.append(open, remove); $("recent-list").append(row);
  }
  if (!directories.length) $("recent-list").textContent = "暂无记录";
}

async function acceptSubscription(result) {
  if (result.cancelled) { notice("已取消目录选择。"); return; }
  clearWorkspace();
  state.subscription = result;
  $("root-label").textContent = result.rootPath;
  $("root-path").value = result.rootPath;
  applyRules(result.rules);
  await listDirectory("");
  await showRecents();
  notice(`已授权目录：${result.root}。点击文件查看，点击目录进入。`);
}

async function openRoot(rootPath) {
  if (!canDiscard()) return;
  if (!rootPath.trim()) throw new Error("请输入要授权的绝对目录路径。");
  await acceptSubscription(await client.request("subscription/open", { rootPath }));
}

async function listDirectory(path = state.directory, append = false) {
  const generation = ++directoryGeneration;
  const subscriptionId = state.subscription?.subscriptionId;
  const result = await client.request("directory/list", { path, offset: append ? state.nextOffset : 0 });
  if (generation !== directoryGeneration || state.subscription?.subscriptionId !== subscriptionId) return;
  state.directory = path; state.searching = false;
  state.entries = append ? [...state.entries, ...result.entries] : result.entries;
  state.nextOffset = result.nextOffset; state.truncated = result.truncated;
  $("clear-search").hidden = true;
  renderEntries();
  if (result.scanLimitReached) notice("目录扫描已达到后端上限，当前结果不完整。", true);
}

function renderEntries() {
  $("entries").replaceChildren();
  const entries = state.entries.filter((entry) => state.searching || $("show-hidden").checked || !entry.hiddenByRule);
  $("breadcrumb").textContent = state.searching ? `名称搜索：${$("search-query").value}` : `/${state.directory}`;
  $("list-info").textContent = `${entries.length} 个项目${state.truncated ? " · 结果不完整" : ""}`;
  $("load-more").hidden = state.searching || state.nextOffset === undefined;
  for (const entry of entries) {
    const button = document.createElement("button");
    button.className = "entry";
    button.classList.toggle("selected", state.selected?.path === entry.path);
    button.classList.toggle("hidden-entry", Boolean(entry.hiddenByRule));
    button.disabled = !["file", "directory"].includes(entry.kind);
    const icon = document.createElement("span"); icon.className = "entry-icon";
    icon.textContent = entry.kind === "directory" ? "DIR" : entry.kind === "file" ? "TXT" : "LNK";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span"); label.className = "entry-label"; label.textContent = entry.name;
    if (state.searching) { const small = document.createElement("small"); small.textContent = `${entry.path}${entry.hiddenByRule ? " · 隐藏项" : ""}`; label.append(small); }
    button.append(icon, label);
    button.addEventListener("click", () => void run(async () => {
      if (entry.kind === "directory") { state.selected = entry; await listDirectory(entry.path); }
      else await readFile(entry.path);
      renderEntries();
    }));
    $("entries").append(button);
  }
  if (!entries.length) {
    const empty = document.createElement("p"); empty.className = "empty";
    empty.textContent = !state.subscription ? "授权目录后，文件会显示在这里。" : state.searching ? "没有匹配的文件名。" : "此目录暂无可显示的项目。";
    $("entries").append(empty);
  }
}

async function readFile(path) {
  if (!canDiscard()) return;
  const file = await client.request("file/read", { path });
  const mixed = file.lineEnding === "mixed" || /\r(?!\n)/.test(file.content);
  state.loaded = { ...file, editable: file.writable && !mixed };
  state.selected = { path, kind: "file" }; state.stale = false;
  $("editor").value = file.content;
  state.original = $("editor").value;
  $("file-name").textContent = path;
  $("file-meta").textContent = `UTF-8${file.bom ? " BOM" : ""} · ${file.lineEnding.toUpperCase()} · ${file.version.size} 字节 · ${file.writable && !mixed ? "可编辑" : "只读"}`;
  notice(mixed ? "混合换行或独立 CR 文件以只读方式展示，防止文本框转换原有换行。" : `已读取 ${path}。保存时会校验磁盘版本。`);
}

async function saveFile() {
  if (!state.loaded?.editable || !dirty() || !state.subscription) return;
  const loaded = state.loaded;
  const content = loaded.lineEnding === "crlf" ? $("editor").value.replace(/\n/g, "\r\n") : $("editor").value;
  try {
    const result = await client.request("file/save", { path: loaded.path, content, expectedVersion: loaded.version.token, bom: loaded.bom });
    loaded.version = result.version; loaded.content = content;
    state.original = $("editor").value; state.stale = false;
    $("file-meta").textContent = `UTF-8${loaded.bom ? " BOM" : ""} · ${loaded.lineEnding.toUpperCase()} · ${result.bytes} 字节 · 可编辑`;
    notice(`已保存 ${loaded.path}，共 ${result.bytes} 字节。`);
    await listDirectory();
  } catch (error) {
    if (error.code === "VERSION_CONFLICT") state.stale = true;
    throw error;
  }
}

client.onRequest = (method, code, duration) => log(`${method} · ${code ?? "OK"} · ${duration} ms`, Boolean(code));
client.onClose = () => {
  state.authenticated = false;
  clearWorkspace(false);
  notice(closeNotice || "连接已断开。未保存文本仍留在编辑器中；请先复制需要保留的修改，再重新连接并授权目录。", true);
  closeNotice = "";
  log("连接关闭"); updateControls();
};
client.onEvent = (event) => {
  log(`${event.event}${event.path ? ` · ${event.path}` : ""}`);
  if (event.event === "auth.revoked") {
    state.token = ""; state.authenticated = false; clearWorkspace();
    closeNotice = "授权已撤销，已清除当前页面凭据与编辑内容。请重新配对。";
    notice(closeNotice, true);
    return;
  }
  if (event.event === "service.shutting-down") { notice("服务正在关闭。", true); return; }
  if (!state.subscription || (event.subscriptionId && event.subscriptionId !== state.subscription.subscriptionId)) return;
  if (state.loaded && [event.path, event.oldPath].includes(state.loaded.path)) { state.stale = true; updateControls(); }
  if (["entry.changed", "entry.deleted", "entry.renamed", "directory.changed", "resync.required", "ignore.changed"].includes(event.event)) {
    clearTimeout(refreshTimer);
    const refresh = async () => {
      if (!client.connected || !state.subscription) return;
      if (state.busy) { refreshTimer = setTimeout(refresh, 300); return; }
      await run(async () => {
        if (event.event === "ignore.changed") applyRules(await client.request("ignore/get"));
        // Watcher echoes may describe our own save. Compare versions without replacing the draft.
        if (state.loaded && state.stale) {
          try {
            const disk = await client.request("file/read", { path: state.loaded.path });
            state.stale = disk.version.token !== state.loaded.version.token;
          } catch { state.stale = true; }
        }
        if (!state.searching) await listDirectory();
        else notice("搜索期间目录或规则发生变化，请重新搜索获取最新结果。");
      });
    };
    refreshTimer = setTimeout(refresh, 300);
  }
};

$("connect").addEventListener("click", () => void run(async () => {
  const url = new URL($("endpoint").value);
  if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error("请输入本机 WebSocket 地址，不要在地址中携带凭据。");
  await client.connect(url.href);
  await client.request("hello");
  if (state.token) {
    try { await client.request("authenticate", { token: state.token }); state.authenticated = true; await showRecents(); notice("已重新认证，请重新授权目录。"); }
    catch (error) { if (error.code === "UNAUTHORIZED") state.token = ""; throw error; }
  } else { await client.request("pair/begin"); notice("连接成功。请输入服务启动终端中显示的一次性配对码。"); }
}));
$("disconnect").addEventListener("click", () => client.disconnect());
$("pair").addEventListener("click", () => void run(async () => {
  const code = $("pair-code").value.trim();
  if (!code) throw new Error("请输入启动终端中的配对码。");
  const result = await client.request("pair/complete", { code, clientName: "Cebian Demo" });
  state.token = result.token; state.authenticated = true; $("pair-code").value = "";
  await showRecents(); notice("配对成功。输入目录路径或使用系统选择器建立授权。");
}));
$("service-status").addEventListener("click", () => void run(async () => {
  const result = await client.request("service/status");
  notice(`服务运行中 · 协议 ${result.protocolVersion} · ${result.connectionCount} 个连接 · ${result.subscriptionCount} 个订阅 · 文件上限 ${Math.round(result.limits.maxFileBytes / 1024 / 1024)} MiB`);
}));
$("open-root").addEventListener("click", () => void run(() => openRoot($("root-path").value)));
$("choose-root").addEventListener("click", () => void run(async () => {
  if (!canDiscard()) return;
  await acceptSubscription(await client.request("folder/choose", {}, 6 * 60_000));
}));
$("close-root").addEventListener("click", () => void run(async () => {
  if (!canDiscard()) return;
  await client.request("subscription/close"); clearWorkspace(); notice("已关闭目录订阅。");
}));
$("recents").addEventListener("toggle", () => { if ($("recents").open && state.authenticated) void run(showRecents); });
$("refresh").addEventListener("click", () => void run(() => listDirectory()));
$("up").addEventListener("click", () => void run(() => listDirectory(state.directory.split("/").slice(0, -1).join("/"))));
$("load-more").addEventListener("click", () => void run(() => listDirectory(state.directory, true)));
$("show-hidden").addEventListener("change", renderEntries);
$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const query = $("search-query").value.trim();
    if (!query) { await listDirectory(); return; }
    const result = await client.request("search/name", { query });
    state.searching = true; state.entries = result.results; state.nextOffset = undefined; state.truncated = result.truncated;
    $("clear-search").hidden = false; renderEntries();
    notice(result.truncated ? "搜索触及后端上限，结果不完整。可缩小关键词后重试。" : `搜索完成，找到 ${result.results.length} 个项目。`);
  });
});
$("clear-search").addEventListener("click", () => void run(() => listDirectory()));
for (const [id, kind] of [["new-file", "file"], ["new-folder", "directory"]]) {
  $(id).addEventListener("click", () => void run(async () => {
    const name = prompt(kind === "file" ? "新建空 UTF-8 文件，输入单个文件名：" : "新建目录，输入单个目录名：");
    if (name === null) return;
    if (!name || /[/\\]/.test(name)) throw new Error("请输入单个名称，不能包含路径分隔符。");
    const path = [state.directory, name].filter(Boolean).join("/");
    await client.request("file/create", { path, kind }); await listDirectory(); notice(`已创建 ${path}。`);
  }));
}
$("rename").addEventListener("click", () => void run(async () => {
  if (!state.selected || !canDiscard()) return;
  const selected = state.selected;
  const newName = prompt(`重命名 ${selected.path}（只修改名称）：`, selected.path.split("/").at(-1));
  if (newName === null) return;
  const result = await client.request("entry/rename", { path: selected.path, newName });
  if (state.loaded && (state.loaded.path === selected.path || state.loaded.path.startsWith(`${selected.path}/`))) clearEditor();
  state.selected = null;
  if (state.directory === selected.path || state.directory.startsWith(`${selected.path}/`)) state.directory = state.directory.replace(selected.path, result.path);
  await listDirectory(); notice(`已重命名为 ${result.path}。`);
}));
$("delete").addEventListener("click", () => void run(async () => {
  if (!state.selected || !canDiscard()) return;
  const selected = state.selected;
  const inspection = await client.request("entry/inspect-delete", { path: selected.path });
  if (!confirm(`将永久删除 ${selected.path}\n范围：${inspection.itemCount} 个项目（包括目标自身）${inspection.recursive ? "，含目录中的所有内容" : ""}。\n确定继续吗？`)) return;
  await client.request("entry/delete", { path: selected.path, confirmationVersion: inspection.version });
  if (state.loaded && (state.loaded.path === selected.path || state.loaded.path.startsWith(`${selected.path}/`))) clearEditor();
  state.selected = null;
  if (state.directory === selected.path || state.directory.startsWith(`${selected.path}/`)) state.directory = selected.path.split("/").slice(0, -1).join("/");
  await listDirectory(); notice(`已删除 ${selected.path}。`);
}));
$("editor").addEventListener("input", updateControls);
$("save").addEventListener("click", () => void run(saveFile));
$("reload-file").addEventListener("click", () => void run(async () => { if (state.loaded) await readFile(state.loaded.path); }));
$("save-rules").addEventListener("click", () => void run(async () => {
  const lines = (id) => $(id).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  applyRules(await client.request("ignore/update", { hidden: lines("hidden-rules"), stopped: lines("stopped-rules") }));
  await listDirectory(); notice("忽略规则已更新。");
}));
$("clear-log").addEventListener("click", () => $("event-log").replaceChildren());
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault(); if (!$("save").disabled) void run(saveFile);
  }
});
window.addEventListener("beforeunload", (event) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
try {
  const response = await fetch("/config.json");
  if (!response.ok) throw new Error("无法读取 demo 配置，请确认通过 npm run demo 启动页面。");
  $("endpoint").value = (await response.json()).websocketUrl;
} catch (error) { report(error); }
updateControls();
