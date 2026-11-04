<script setup>
import DirectoryTreeNode from "./DirectoryTreeNode.vue";
import FileIcon from "./FileIcon.vue";
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, subscribed, visibleEntries } = w;
</script>

<template>
  <section class="explorer" aria-label="目录浏览与搜索">
    <fieldset id="browse-controls" :disabled="!subscribed || state.busy">
      <legend class="sr-only">文件操作</legend>
      <div class="toolbar">
        <button id="refresh" @click="w.run(w.refreshTree)">刷新</button>
        <button id="new-file" @click="w.run(() => w.createEntry('file'))">＋ 文件</button>
        <button id="new-folder" @click="w.run(() => w.createEntry('directory'))">＋ 目录</button>
      </div>
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
        <DirectoryTreeNode :workspace="w" :entry="{ path: '', name: state.subscription.root, kind: 'directory' }" />
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
      <span>{{ state.searching ? `${visibleEntries.length} 个搜索结果${state.truncated ? ' · 结果不完整' : ''}` : '点击目录展开或收起 · 点击文件查看' }}</span>
    </div>
  </section>
</template>
