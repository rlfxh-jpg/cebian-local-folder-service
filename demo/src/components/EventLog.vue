<script setup>
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state } = w;
</script>

<template>
  <section class="card events" aria-labelledby="events-title">
    <div class="section-heading"><h2 id="events-title">03 <span>请求与实时事件</span></h2><button @click="state.logs = []">清空记录</button></div>
    <p class="hint">显示方法、耗时和变更通知，便于调试。最多保留 80 条记录。</p>
    <ol id="event-log" aria-live="polite">
      <li v-for="entry in state.logs" :key="entry.id" :class="{ 'log-error': entry.error }"><time>{{ entry.time }}</time>{{ entry.message }}</li>
      <li v-if="!state.logs.length" class="muted">等待连接…</li>
    </ol>
  </section>
</template>
