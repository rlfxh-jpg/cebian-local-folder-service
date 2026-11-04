<script setup>
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, authorized } = w;
</script>

<template>
  <section class="card connection" aria-labelledby="connection-title">
    <div class="section-heading"><h2 id="connection-title">01 <span>连接与配对</span></h2><p>启动服务 → 输入终端配对码 → 授权一个目录</p></div>
    <div class="connection-fields">
      <label class="endpoint">WebSocket 地址<input id="endpoint" v-model="state.endpoint" type="url" spellcheck="false" :disabled="state.connected || state.busy"></label>
      <button id="connect" class="primary" :disabled="state.connected || state.busy" @click="w.run(w.connect)">连接服务</button>
      <button id="disconnect" :disabled="!state.connected || state.busy" @click="w.disconnect">断开</button>
      <label>一次性配对码<input id="pair-code" v-model="state.pairCode" placeholder="从启动终端复制" autocomplete="off" spellcheck="false" maxlength="10" :disabled="!state.connected || state.authenticated || state.busy" @keyup.enter="w.run(w.pair)"></label>
      <button id="pair" :disabled="!state.connected || state.authenticated || state.busy" @click="w.run(w.pair)">配对</button>
      <button id="service-status" :disabled="!authorized || state.busy" @click="w.run(w.serviceStatus)">服务状态</button>
    </div>
    <p v-if="state.connectionMode === 'shared-worker'" class="hint">刷新时尝试接回原连接和目录订阅，离开页面后连接最多保留 30 秒。多个标签页的连接与目录授权独立；配对凭据仅保存在同源 SharedWorker 内存中。最后一个标签页刷新时，浏览器可能回收 Worker，此时需重新配对。</p>
    <p v-else class="hint">当前浏览器不支持 SharedWorker，使用页面连接；刷新会断开连接并清除内存中的配对凭据。</p>
  </section>
</template>
