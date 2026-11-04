<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import FileIcon from "./FileIcon.vue";
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, authorized, subscribed } = w;
const recents = ref(null);
function dismissRecents(event) {
  if (event.type === "keydown" ? event.key === "Escape" : !recents.value?.contains(event.target)) {
    if (recents.value) recents.value.open = false;
  }
}
onMounted(() => {
  document.addEventListener("pointerdown", dismissRecents);
  document.addEventListener("keydown", dismissRecents);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", dismissRecents);
  document.removeEventListener("keydown", dismissRecents);
});
</script>

<template>
  <fieldset id="folder-controls" :disabled="!authorized || state.busy">
    <legend class="sr-only">目录授权</legend>
    <div class="folder-fields">
      <button id="choose-root" class="primary choose-folder" title="通过系统文件夹选择器授权工作区，取消选择会保留当前目录" @click="w.run(w.chooseRoot)"><FileIcon kind="directory" />选择文件夹</button>
      <button id="close-root" :disabled="!subscribed" @click="w.run(w.closeRoot)">关闭目录</button>
    </div>
    <span id="root-label" class="muted" :title="state.subscription?.rootPath || '尚未授权目录'">{{ state.subscription?.rootPath || '尚未授权目录' }}</span>
    <details id="recents" ref="recents" @toggle="event => event.target.open && authorized && w.run(w.showRecents)">
      <summary>最近目录</summary>
      <div class="recent-list">
        <p class="hint">最近目录仅用于查看记录，重新打开请使用系统选择器。</p>
        <div v-for="directory in state.recents" :key="directory.path" class="recent-row">
          <span class="recent-path">{{ directory.path }}{{ directory.accessible ? '' : '（当前不可访问）' }}</span>
          <button @click="w.run(() => w.removeRecent(directory.path))">移除记录</button>
        </div>
        <span v-if="!state.recents.length">暂无记录</span>
      </div>
    </details>
  </fieldset>
</template>
