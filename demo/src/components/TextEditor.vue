<script setup>
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, subscribed, syncStatus, fileMeta } = w;
</script>

<template>
  <section class="editor-panel" aria-label="文本编辑器">
    <div class="editor-header">
      <div><strong>{{ state.loaded?.path || '选择一个文本文件' }}</strong><p>{{ fileMeta }}</p></div>
      <div class="editor-actions">
        <button id="refresh" :disabled="!subscribed || state.busy" @click="w.run(w.refreshTree)">刷新</button>
      </div>
    </div>
    <label class="sr-only" for="editor">文本文件内容</label>
    <textarea id="editor" :value="state.draft" @input="w.updateDraft($event.target.value)"
      @compositionstart="w.setComposing(true)" @compositionend="w.updateDraft($event.target.value); w.setComposing(false)"
      spellcheck="false" :readonly="!subscribed || !state.loaded?.editable || state.busy" placeholder="从左侧打开文件，修改后自动同步到本地。"></textarea>
    <div class="editor-footer" :class="{ 'sync-error': state.syncError }">
      <span role="status" aria-live="polite">{{ syncStatus }}</span>
      <div v-if="subscribed && state.conflict" class="editor-actions">
        <button :disabled="state.busy || state.saving" @click="w.run(() => w.resolveConflict(false))">使用本地内容</button>
        <button :disabled="state.busy || state.saving" @click="w.run(() => w.resolveConflict(true))">使用网页内容</button>
      </div>
      <button v-else-if="subscribed && state.syncError" :disabled="state.busy || state.saving" @click="w.run(w.retrySync)">重试同步</button>
    </div>
  </section>
</template>
