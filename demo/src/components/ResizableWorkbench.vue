<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const container = ref(null);
const separator = ref(null);
const preferredWidth = ref(300);
const containerWidth = ref(0);
const stacked = ref(false);
const dragging = ref(false);
const minWidth = 180;
const maxWidth = computed(() => Math.max(minWidth, (containerWidth.value || 900) - 6 - 280));
const treeWidth = computed(() => Math.min(maxWidth.value, Math.max(minWidth, preferredWidth.value)));
let pointer;
let observer;

function finishDrag(event) {
  if (!pointer || (event && event.pointerId !== pointer.id)) return;
  const id = pointer.id;
  pointer = undefined;
  dragging.value = false;
  document.documentElement.classList.remove("resizing-workspace");
  if (separator.value?.hasPointerCapture(id)) separator.value.releasePointerCapture(id);
}
function measure() {
  containerWidth.value = container.value?.getBoundingClientRect().width || 0;
  stacked.value = window.innerWidth <= 700;
  if (stacked.value) finishDrag();
}
function startDrag(event) {
  if (event.button !== 0 || pointer || stacked.value) return;
  event.preventDefault();
  measure();
  pointer = { id: event.pointerId, x: event.clientX, width: treeWidth.value };
  separator.value.setPointerCapture(event.pointerId);
  separator.value.focus({ preventScroll: true });
  dragging.value = true;
  document.documentElement.classList.add("resizing-workspace");
}
function moveDrag(event) {
  if (pointer?.id !== event.pointerId) return;
  preferredWidth.value = Math.min(maxWidth.value, Math.max(minWidth, pointer.width + event.clientX - pointer.x));
}
function resetWidth() { preferredWidth.value = window.innerWidth <= 1000 ? 260 : 300; }
function onKeydown(event) {
  if (stacked.value || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 50 : 10;
  const next = event.key === "Home" ? minWidth : event.key === "End" ? maxWidth.value
    : treeWidth.value + (event.key === "ArrowLeft" ? -step : step);
  preferredWidth.value = Math.min(maxWidth.value, Math.max(minWidth, next));
}
function onBlur() { finishDrag(); }

onMounted(() => {
  resetWidth(); measure();
  observer = new ResizeObserver(measure);
  observer.observe(container.value);
  window.addEventListener("resize", measure);
  window.addEventListener("blur", onBlur);
});
onBeforeUnmount(() => {
  finishDrag(); observer?.disconnect();
  window.removeEventListener("resize", measure);
  window.removeEventListener("blur", onBlur);
});
</script>

<template>
  <div ref="container" class="workbench" :class="{ 'is-resizing': dragging }" :style="{ '--explorer-width': `${treeWidth}px` }">
    <div id="directory-pane" class="workspace-pane"><slot name="directory" /></div>
    <div ref="separator" class="workspace-splitter" role="separator" aria-orientation="vertical"
      aria-label="调整目录树与编辑区宽度" aria-controls="directory-pane editor-pane"
      :aria-valuemin="minWidth" :aria-valuemax="Math.round(maxWidth)" :aria-valuenow="Math.round(treeWidth)"
      :tabindex="stacked ? -1 : 0" title="拖动调整宽度，双击恢复默认；方向键微调"
      @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="finishDrag"
      @pointercancel="finishDrag" @lostpointercapture="finishDrag" @dblclick="resetWidth" @keydown="onKeydown"></div>
    <div id="editor-pane" class="workspace-pane"><slot name="editor" /></div>
  </div>
</template>
