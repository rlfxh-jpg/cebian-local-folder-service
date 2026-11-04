<script setup>
import { defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import FileIcon from "./FileIcon.vue";

const CodeEditor = defineAsyncComponent(() => import("./CodeEditor.vue"));
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const dialog = ref(null);
const preview = shallowRef(null);
const loading = ref(false);
const error = ref("");
let generation = 0;

function clear() {
  generation++;
  preview.value = null;
  loading.value = false;
  error.value = "";
}
function close() {
  dialog.value?.close();
  clear();
}
async function open(path) {
  const request = ++generation;
  preview.value = { path, content: "" };
  error.value = "";
  loading.value = true;
  dialog.value.showModal();
  try {
    const file = await w.readPreviewFile(path);
    if (request === generation) preview.value = { ...file, path };
  } catch (cause) {
    if (request === generation) error.value = `${cause.code ? `${cause.code}：` : ""}${cause.message}`;
  } finally {
    if (request === generation) loading.value = false;
  }
}

watch([w.subscribed, () => w.state.subscription], close);
onBeforeUnmount(clear);
defineExpose({ open });
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="workspace-dialog file-preview-dialog" aria-labelledby="file-preview-title"
      @click.self="close" @cancel.prevent="close" @close="!dialog.open && clear()">
      <header class="file-preview-header">
        <FileIcon kind="file" />
        <div class="file-preview-heading">
          <h2 id="file-preview-title">{{ preview?.path || '文件内容' }}</h2>
          <p>只读预览 · 打开时的本地内容</p>
        </div>
        <button type="button" class="file-preview-close" aria-label="关闭文件预览" autofocus @click="close">×</button>
      </header>
      <div class="file-preview-body" :aria-busy="loading">
        <p v-if="loading" class="file-preview-message" role="status">正在读取文件…</p>
        <p v-else-if="error" class="file-preview-message error" role="alert">{{ error }}</p>
        <CodeEditor v-else-if="preview" id="file-preview-editor" :model-value="preview.content"
          :path="preview.path" :document-key="`${generation}:${preview.path}`" :read-only="true" />
      </div>
    </dialog>
  </Teleport>
</template>
