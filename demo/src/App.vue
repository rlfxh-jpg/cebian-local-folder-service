<script setup>
import { useFolderWorkspace } from "./composables/useFolderWorkspace.js";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import FolderPanel from "./components/FolderPanel.vue";
import DirectoryExplorer from "./components/DirectoryExplorer.vue";
import TextEditor from "./components/TextEditor.vue";
import IgnoreRules from "./components/IgnoreRules.vue";
import EventLog from "./components/EventLog.vue";

const workspace = useFolderWorkspace();
const { state, status, authorized } = workspace;
</script>

<template>
  <header class="page-header">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">C</span>
      <div><h1>本地文件工作台 <span class="tag">VUE DEMO</span></h1><p>Cebian Local Folder Service · 协议 1.0</p></div>
    </div>
    <span id="connection-state" class="status" :class="{ ready: authorized }">{{ status }}</span>
  </header>
  <main>
    <ConnectionPanel :workspace="workspace" />
    <div id="notice" class="notice" :class="{ error: state.noticeError }" role="status" aria-live="polite">{{ state.notice }}</div>
    <section class="card workspace" aria-labelledby="workspace-title">
      <div class="section-heading">
        <h2 id="workspace-title">02 <span>文件工作区</span></h2>
        <span id="root-label" class="muted">{{ state.subscription?.rootPath || '尚未授权目录' }}</span>
      </div>
      <FolderPanel :workspace="workspace" />
      <div class="workbench">
        <DirectoryExplorer :workspace="workspace" />
        <TextEditor :workspace="workspace" />
      </div>
      <IgnoreRules :workspace="workspace" />
    </section>
    <EventLog :workspace="workspace" />
  </main>
  <footer class="page-footer">本机文件系统是事实来源 · 所有操作均受目录授权约束</footer>
</template>
