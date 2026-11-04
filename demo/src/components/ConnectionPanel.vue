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
    <p class="hint">凭据仅保存在当前页面内存；断线后可重新认证。刷新页面后需重启服务获取新配对码。</p>
  </section>
</template>
