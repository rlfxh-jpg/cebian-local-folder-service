<script setup>
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, authorized, subscribed } = w;
</script>

<template>
  <fieldset id="folder-controls" :disabled="!authorized || state.busy">
    <legend class="sr-only">目录授权</legend>
    <div class="folder-fields">
      <label class="sr-only" for="root-path">要授权的绝对目录路径</label>
      <input id="root-path" v-model="state.rootPath" placeholder="输入本机绝对目录路径，例如 D:\Projects\example" spellcheck="false" @keyup.enter="w.run(() => w.openRoot())">
      <button id="open-root" class="primary" @click="w.run(() => w.openRoot())">授权并打开</button>
      <button id="choose-root" @click="w.run(w.chooseRoot)">系统选择器</button>
      <button id="close-root" :disabled="!subscribed" @click="w.run(w.closeRoot)">关闭目录</button>
    </div>
    <details id="recents" @toggle="event => event.target.open && authorized && w.run(w.showRecents)">
      <summary>最近使用的目录</summary>
      <div class="recent-list">
        <div v-for="directory in state.recents" :key="directory.path" class="recent-row">
          <button @click="w.run(() => w.openRoot(directory.path))">{{ directory.path }}{{ directory.accessible ? '' : '（当前不可访问）' }}</button>
          <button @click="w.run(() => w.removeRecent(directory.path))">移除记录</button>
        </div>
        <span v-if="!state.recents.length">暂无记录</span>
      </div>
    </details>
  </fieldset>
</template>
