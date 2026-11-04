<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { createCodeEditor } from "../editor/code-editor.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  path: { type: String, default: "" },
  documentKey: { type: String, default: "" },
  readOnly: { type: Boolean, default: true },
});
const emit = defineEmits(["update:modelValue", "composition"]);
const host = ref(null);
let editor;
const options = () => ({ value: props.modelValue, path: props.path, documentKey: props.documentKey, readOnly: props.readOnly });

onMounted(() => {
  editor = createCodeEditor({ parent: host.value, ...options(),
    onChange: (value) => emit("update:modelValue", value),
    onCompositionChange: (value) => emit("composition", value),
  });
});
watch(options, (next) => editor?.update(next), { flush: "post" });
onBeforeUnmount(() => { editor?.destroy(); });
</script>

<template>
  <div ref="host" class="code-editor"></div>
</template>
