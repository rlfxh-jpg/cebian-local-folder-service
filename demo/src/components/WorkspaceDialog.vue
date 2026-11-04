<script setup>
import { ref } from "vue";

defineProps({ labelledBy: { type: String, required: true } });
const dialog = ref(null);
const open = () => dialog.value?.showModal();
const close = () => dialog.value?.close();
defineExpose({ open, close });
</script>

<template>
  <dialog ref="dialog" class="workspace-dialog" :aria-labelledby="labelledBy" @click.self="close">
    <div class="dialog-surface">
      <button class="dialog-close" type="button" aria-label="关闭弹窗" @click="close">×</button>
      <slot />
    </div>
  </dialog>
</template>
