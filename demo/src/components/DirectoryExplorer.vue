<script setup>
import { nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import DirectoryTreeNode from "./DirectoryTreeNode.vue";
import FileIcon from "./FileIcon.vue";
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, subscribed, visibleEntries } = w;
const menu = shallowRef(null);
const menuElement = ref(null);
function closeMenu(restoreFocus = false) {
  const trigger = menu.value?.trigger;
  menu.value = null;
  if (restoreFocus) trigger?.focus();
}
async function openMenu({ entry, event }) {
  if (!subscribed.value || state.busy || !["file", "directory"].includes(entry.kind)) return;
  event.preventDefault();
  const trigger = event.currentTarget;
  const rect = trigger.getBoundingClientRect();
  const keyboard = event.type === "keydown" || (!event.clientX && !event.clientY);
  menu.value = { entry: { path: entry.path, name: entry.name, kind: entry.kind }, trigger,
    x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY };
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const bounds = menuElement.value.getBoundingClientRect();
  menu.value = { ...menu.value,
    x: Math.max(8, Math.min(menu.value.x, window.innerWidth - bounds.width - 8)),
    y: Math.max(8, Math.min(menu.value.y, window.innerHeight - bounds.height - 8)) };
  menuElement.value.querySelector("button")?.focus();
}
function runMenuAction(action) {
  const target = menu.value;
  closeMenu(true);
  if (target && subscribed.value && !state.busy) w.run(() => action(target.entry));
}
function openSearchMenu(entry, event) {
  if (event.type === "contextmenu" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    openMenu({ entry, event });
  }
}
function onPointerdown(event) {
  if (!menuElement.value?.contains(event.target)) closeMenu();
}
function onKeydown(event) {
  if (!menu.value) return;
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    closeMenu(true);
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const items = [...menuElement.value.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
}
// Wrap the listener so native events aren't interpreted as a request to restore focus.
const dismissMenu = () => closeMenu();
watch([subscribed, () => state.busy, () => state.searching, () => state.subscription], dismissMenu);
onMounted(() => {
  document.addEventListener("pointerdown", onPointerdown);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("scroll", dismissMenu, true);
  window.addEventListener("resize", dismissMenu);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onPointerdown);
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("scroll", dismissMenu, true);
  window.removeEventListener("resize", dismissMenu);
});
</script>

<template>
  <section class="explorer" aria-label="目录浏览与搜索">
    <fieldset id="browse-controls" :disabled="!subscribed || state.busy">
      <legend class="sr-only">文件操作</legend>
      <form class="search" @submit.prevent="w.run(w.search)">
        <label class="sr-only" for="search-query">按文件名搜索</label>
        <input id="search-query" v-model="state.query" placeholder="搜索文件名…" maxlength="256">
        <button type="submit">搜索</button>
        <button v-if="state.searching" type="button" @click="w.run(w.returnToTree)">返回目录树</button>
      </form>
      <label class="toggle"><input v-model="state.showHidden" type="checkbox"> 显示被隐藏规则标记的项目</label>
    </fieldset>
    <div class="breadcrumb">{{ state.searching ? `名称搜索：${state.query}` : `操作目录：/${state.directory}` }}</div>
    <div class="entries">
      <ul v-if="!state.searching && state.subscription" class="directory-tree" aria-label="工作区目录树">
        <DirectoryTreeNode :workspace="w" :entry="{ path: '', name: state.subscription.root, kind: 'directory' }" @entry-menu="openMenu" />
      </ul>
      <template v-if="state.searching">
      <button v-for="entry in visibleEntries" :key="entry.path" class="entry"
        :class="{ selected: state.selected?.path === entry.path, 'hidden-entry': entry.hiddenByRule }"
        :disabled="!subscribed || state.busy || !['file', 'directory'].includes(entry.kind)"
        :aria-haspopup="['file', 'directory'].includes(entry.kind) ? 'menu' : undefined"
        @click="w.run(() => w.selectEntry(entry))" @contextmenu="openSearchMenu(entry, $event)" @keydown="openSearchMenu(entry, $event)">
        <FileIcon :kind="entry.kind" />
        <span class="entry-label">{{ entry.name }}<small v-if="state.searching">{{ entry.path }}{{ entry.hiddenByRule ? ' · 隐藏项' : '' }}</small></span>
      </button>
      <p v-if="!visibleEntries.length" class="empty">没有匹配的文件名。</p>
      </template>
      <p v-if="!state.subscription" class="empty">通过系统选择器授权文件夹后，目录树会显示在这里。</p>
    </div>
    <div class="list-footer">
      <span>{{ state.searching ? `${visibleEntries.length} 个搜索结果${state.truncated ? ' · 结果不完整' : ''}` : '点击展开 / 查看 · 右键管理文件和目录' }}</span>
    </div>
  </section>
  <Teleport to="body">
    <div v-if="menu" ref="menuElement" class="entry-context-menu" role="menu" :aria-label="`${menu.entry.name} 的操作菜单`"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @contextmenu.prevent>
      <template v-if="menu.entry.kind === 'directory'">
        <button id="new-file" role="menuitem" :disabled="!subscribed || state.busy" @click="runMenuAction(entry => w.createEntry('file', entry.path))"><FileIcon kind="file" />新建文件</button>
        <button id="new-folder" role="menuitem" :disabled="!subscribed || state.busy" @click="runMenuAction(entry => w.createEntry('directory', entry.path))"><FileIcon kind="directory" />新建目录</button>
      </template>
      <template v-if="menu.entry.path">
        <button id="rename-entry" role="menuitem" :disabled="!subscribed || state.busy" @click="runMenuAction(w.renameEntry)">
          <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6ZM13 20h8" /></svg>重命名
        </button>
        <button id="delete-entry" class="danger" role="menuitem" :disabled="!subscribed || state.busy" @click="runMenuAction(w.deleteEntry)">
          <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>删除
        </button>
      </template>
    </div>
  </Teleport>
</template>
