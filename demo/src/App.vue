<script setup>
import { ref } from "vue";
import { useFolderWorkspace } from "./composables/useFolderWorkspace.js";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import FolderPanel from "./components/FolderPanel.vue";
import DirectoryExplorer from "./components/DirectoryExplorer.vue";
import TextEditor from "./components/TextEditor.vue";
import IgnoreRules from "./components/IgnoreRules.vue";
import EventLog from "./components/EventLog.vue";
import WorkspaceDialog from "./components/WorkspaceDialog.vue";

const workspace = useFolderWorkspace();
const { state, status, authorized } = workspace;
const connectionDialog = ref(null);
const eventsDialog = ref(null);
</script>

<template>
  <header class="page-header">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">C</span>
      <div><h1>本地文件工作台 <span class="tag">VUE DEMO</span></h1><p>Cebian Local Folder Service · 协议 1.0</p></div>
    </div>
    <div class="header-actions">
      <span id="connection-state" class="status" :class="{ ready: authorized }">{{ status }}</span>
      <button type="button" aria-haspopup="dialog" @click="connectionDialog.open()">连接与配对</button>
      <button type="button" aria-haspopup="dialog" @click="eventsDialog.open()">请求与实时事件</button>
    </div>
  </header>
  <main>
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
  </main>
  <WorkspaceDialog ref="connectionDialog" labelled-by="connection-title">
    <ConnectionPanel :workspace="workspace" />
    <div class="notice dialog-notice" :class="{ error: state.noticeError }" role="status" aria-live="polite">{{ state.notice }}</div>
  </WorkspaceDialog>
  <WorkspaceDialog ref="eventsDialog" labelled-by="events-title">
    <EventLog :workspace="workspace" />
  </WorkspaceDialog>
</template>
