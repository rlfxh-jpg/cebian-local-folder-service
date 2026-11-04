<script setup>
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, subscribed, canSave, dirty, fileMeta } = w;
</script>

<template>
  <section class="editor-panel" aria-label="文本编辑器">
    <div class="editor-header">
      <div><strong>{{ state.loaded?.path || '选择一个文本文件' }}</strong><p>{{ fileMeta }}</p></div>
      <div class="editor-actions">
        <button :disabled="!subscribed || !state.loaded || state.busy" @click="w.run(w.reloadFile)">重新读取</button>
        <button :disabled="!subscribed || !state.selected || state.busy" @click="w.run(w.renameEntry)">重命名</button>
        <button class="danger" :disabled="!subscribed || !state.selected || state.busy" @click="w.run(w.deleteEntry)">删除</button>
        <button id="refresh" :disabled="!subscribed || state.busy" @click="w.run(w.refreshTree)">刷新</button>
        <button id="save" class="primary" :disabled="!canSave" @click="w.run(w.saveFile)">保存</button>
      </div>
    </div>
    <p v-if="state.selected" class="selection-hint">重命名 / 删除目标：{{ state.selected.path }}</p>
    <label class="sr-only" for="editor">文本文件内容</label>
    <textarea id="editor" v-model="state.draft" spellcheck="false" :readonly="!subscribed || !state.loaded?.editable || state.busy" placeholder="从左侧打开文件，开始查看或编辑。"></textarea>
    <div class="editor-footer">
      <span>{{ state.loaded ? `${dirty ? '● 有未保存修改' : '已与读取版本同步'}${state.stale ? ' · 磁盘可能已变化，请重新读取' : ''}` : '尚未打开文件' }}</span>
      <span>Ctrl / ⌘ + S 保存</span>
    </div>
  </section>
</template>
