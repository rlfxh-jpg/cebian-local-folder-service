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
  const trigger = event.currentTarget;
  const rect = trigger.getBoundingClientRect();
  const keyboard = event.type === "keydown" || (!event.clientX && !event.clientY);
  menu.value = { path: entry.path, name: entry.name, trigger,
    x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY };
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const bounds = menuElement.value.getBoundingClientRect();
  menu.value = { ...menu.value,
    x: Math.max(8, Math.min(menu.value.x, window.innerWidth - bounds.width - 8)),
    y: Math.max(8, Math.min(menu.value.y, window.innerHeight - bounds.height - 8)) };
  menuElement.value.querySelector("button")?.focus();
}
function createEntry(kind) {
  const target = menu.value;
  closeMenu(true);
  if (target && subscribed.value && !state.busy) w.run(() => w.createEntry(kind, target.path));
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
        <DirectoryTreeNode :workspace="w" :entry="{ path: '', name: state.subscription.root, kind: 'directory' }" @directory-menu="openMenu" />
      </ul>
      <template v-if="state.searching">
      <button v-for="entry in visibleEntries" :key="entry.path" class="entry"
        :class="{ selected: state.selected?.path === entry.path, 'hidden-entry': entry.hiddenByRule }"
        :disabled="!subscribed || state.busy || !['file', 'directory'].includes(entry.kind)"
        @click="w.run(() => w.selectEntry(entry))">
        <FileIcon :kind="entry.kind" />
        <span class="entry-label">{{ entry.name }}<small v-if="state.searching">{{ entry.path }}{{ entry.hiddenByRule ? ' · 隐藏项' : '' }}</small></span>
      </button>
      <p v-if="!visibleEntries.length" class="empty">没有匹配的文件名。</p>
      </template>
      <p v-if="!state.subscription" class="empty">通过系统选择器授权文件夹后，目录树会显示在这里。</p>
    </div>
    <div class="list-footer">
      <span>{{ state.searching ? `${visibleEntries.length} 个搜索结果${state.truncated ? ' · 结果不完整' : ''}` : '点击展开 / 查看 · 右键目录新建' }}</span>
    </div>
  </section>
  <Teleport to="body">
    <div v-if="menu" ref="menuElement" class="directory-context-menu" role="menu" :aria-label="`在 ${menu.name} 中新建`"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @contextmenu.prevent>
      <button id="new-file" role="menuitem" :disabled="!subscribed || state.busy" @click="createEntry('file')"><FileIcon kind="file" />新建文件</button>
      <button id="new-folder" role="menuitem" :disabled="!subscribed || state.busy" @click="createEntry('directory')"><FileIcon kind="directory" />新建目录</button>
    </div>
  </Teleport>
</template>
