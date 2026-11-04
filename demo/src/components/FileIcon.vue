<script setup>
defineProps({ kind: { type: String, required: true }, expanded: Boolean });
</script>

<template>
  <svg class="file-icon" :class="`icon-${kind}`" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="kind === 'directory'">
      <path v-if="expanded" d="M3 9V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1M3 10h18l-3 10H5L3 10Z" />
      <path v-else d="M3 8V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" />
    </template>
    <template v-else-if="kind === 'file'">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6M8 13h8M8 17h6" />
    </template>
    <template v-else><path d="m10 13 4-4m-6 7-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m2 0 1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0" /></template>
  </svg>
</template>
