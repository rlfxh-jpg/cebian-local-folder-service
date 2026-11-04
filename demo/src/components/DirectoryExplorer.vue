<script setup>
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, subscribed, visibleEntries } = w;
</script>

<template>
  <section class="explorer" aria-label="目录浏览与搜索">
    <fieldset id="browse-controls" :disabled="!subscribed || state.busy">
      <legend class="sr-only">文件操作</legend>
      <div class="toolbar">
        <button id="up" title="上一级目录" :disabled="!state.directory" @click="w.run(w.goUp)">↑ 上级</button>
        <button id="refresh" @click="w.run(() => w.listDirectory())">刷新</button>
        <button id="new-file" @click="w.run(() => w.createEntry('file'))">＋ 文件</button>
        <button id="new-folder" @click="w.run(() => w.createEntry('directory'))">＋ 目录</button>
      </div>
      <form class="search" @submit.prevent="w.run(w.search)">
        <label class="sr-only" for="search-query">按文件名搜索</label>
        <input id="search-query" v-model="state.query" placeholder="搜索文件名…" maxlength="256">
        <button type="submit">搜索</button>
        <button v-if="state.searching" type="button" @click="w.run(() => w.listDirectory())">返回</button>
      </form>
      <label class="toggle"><input v-model="state.showHidden" type="checkbox"> 显示被隐藏规则标记的项目</label>
    </fieldset>
    <div class="breadcrumb">{{ state.searching ? `名称搜索：${state.query}` : `/${state.directory}` }}</div>
    <div class="entries">
      <button v-for="entry in visibleEntries" :key="entry.path" class="entry"
        :class="{ selected: state.selected?.path === entry.path, 'hidden-entry': entry.hiddenByRule }"
        :disabled="!subscribed || state.busy || !['file', 'directory'].includes(entry.kind)"
        @click="w.run(() => w.selectEntry(entry))">
        <span class="entry-icon" aria-hidden="true">{{ entry.kind === 'directory' ? 'DIR' : entry.kind === 'file' ? 'TXT' : 'LNK' }}</span>
        <span class="entry-label">{{ entry.name }}<small v-if="state.searching">{{ entry.path }}{{ entry.hiddenByRule ? ' · 隐藏项' : '' }}</small></span>
      </button>
      <p v-if="!visibleEntries.length" class="empty">{{ !state.subscription ? '授权目录后，文件会显示在这里。' : state.searching ? '没有匹配的文件名。' : '此目录暂无可显示的项目。' }}</p>
    </div>
    <div class="list-footer">
      <span>{{ visibleEntries.length }} 个项目{{ state.truncated ? ' · 结果不完整' : '' }}</span>
      <button v-if="!state.searching && state.nextOffset !== undefined" :disabled="!subscribed || state.busy" @click="w.run(w.loadMore)">加载更多</button>
    </div>
  </section>
</template>
