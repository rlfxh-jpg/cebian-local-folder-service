<script setup>
const { workspace: w } = defineProps({ workspace: { type: Object, required: true } });
const { state, subscribed } = w;
</script>

<template>
  <details class="rules">
    <summary>隐藏与停止监听规则</summary>
    <fieldset :disabled="!subscribed || state.busy">
      <legend class="sr-only">忽略规则</legend>
      <div class="rule-grid">
        <label>隐藏规则（每行一个 glob，仅影响展示）<textarea v-model="state.hiddenRules" rows="3" spellcheck="false" placeholder="*.log"></textarea></label>
        <label>停止监听规则（不进入遍历、搜索及事件）<textarea v-model="state.stoppedRules" rows="3" spellcheck="false" placeholder="node_modules&#10;.git"></textarea></label>
      </div>
      <button @click="w.run(w.saveRules)">应用规则</button>
      <span v-if="state.ruleVersion !== null" class="hint">当前版本 v{{ state.ruleVersion }}</span>
    </fieldset>
  </details>
</template>
