<script setup>
import { computed } from "vue";
import FileIcon from "./FileIcon.vue";

const { workspace: w, entry } = defineProps({ workspace: { type: Object, required: true }, entry: { type: Object, required: true } });
const { state, subscribed } = w;
const emit = defineEmits(["entry-menu"]);
const isDirectory = computed(() => entry.kind === "directory");
const expanded = computed(() => isDirectory.value && Boolean(state.expanded[entry.path]));
const listing = computed(() => state.directories[entry.path]);
const children = computed(() => w.entriesFor(entry.path));
function openMenu(event) {
  if (!["file", "directory"].includes(entry.kind) || !subscribed.value || state.busy) return;
  event.preventDefault();
  emit("entry-menu", { entry, event });
}
function onKeydown(event) {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openMenu(event);
}
</script>

<template>
  <li class="tree-node">
    <button class="entry" :class="{ selected: state.selected?.path === entry.path, 'hidden-entry': entry.hiddenByRule }"
      :disabled="!subscribed || state.busy || !['file', 'directory'].includes(entry.kind)"
      :aria-expanded="isDirectory ? expanded : undefined" :aria-current="state.selected?.path === entry.path ? 'true' : undefined"
      :aria-haspopup="['file', 'directory'].includes(entry.kind) ? 'menu' : undefined"
      :title="`${entry.path || state.subscription?.rootPath || '/'}${entry.hiddenByRule ? '（隐藏项）' : ''}`"
      @click="w.run(() => w.selectEntry(entry))" @contextmenu="openMenu" @keydown="onKeydown">
      <svg class="tree-chevron" :class="{ expanded, leaf: !isDirectory }" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
      <FileIcon :kind="entry.kind" :expanded="expanded" />
      <span class="entry-label">{{ entry.name }}<span class="sr-only">（{{ isDirectory ? '目录' : entry.kind === 'file' ? '文件' : '链接，不可打开' }}）</span></span>
    </button>
    <ul v-if="expanded" class="tree-children" :aria-label="`${entry.name} 的内容`">
      <DirectoryTreeNode v-for="child in children" :key="child.path" :workspace="w" :entry="child" @entry-menu="emit('entry-menu', $event)" />
      <li v-if="listing?.error" class="tree-message error">{{ listing.error }}</li>
      <li v-else-if="listing && !children.length" class="tree-message">暂无可显示的项目</li>
      <li v-if="listing?.nextOffset !== undefined" class="tree-message"><button :disabled="!subscribed || state.busy" @click="w.run(() => w.loadMore(entry.path))">加载更多</button></li>
      <li v-else-if="listing?.truncated" class="tree-message">扫描已达上限，结果不完整</li>
    </ul>
  </li>
</template>
