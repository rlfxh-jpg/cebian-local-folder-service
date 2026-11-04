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
import ResizableWorkbench from "./components/ResizableWorkbench.vue";

const workspace = useFolderWorkspace();
const { state, status, authorized } = workspace;
const connectionDialog = ref(null);
const eventsDialog = ref(null);
const rulesDialog = ref(null);
</script>

<template>
  <header class="page-header">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">C</span>
      <div>
        <div class="brand-title">
          <h1>本地文件工作台</h1>
          <span id="connection-state" class="status" :class="{ ready: authorized }" role="status">{{ status }}</span>
        </div>
        <p>Cebian Local Folder Service · 协议 1.0</p>
      </div>
    </div>
    <FolderPanel :workspace="workspace" />
    <div class="header-actions">
      <button type="button" aria-haspopup="dialog" @click="connectionDialog.open()">连接与配对</button>
      <button type="button" aria-haspopup="dialog" @click="eventsDialog.open()">请求与实时事件</button>
      <button type="button" aria-haspopup="dialog" @click="rulesDialog.open()">隐藏与停止监听规则</button>
    </div>
  </header>
  <main>
    <div id="notice" class="notice" :class="{ error: state.noticeError }" role="status" aria-live="polite">{{ state.notice }}</div>
    <section class="card workspace" aria-labelledby="workspace-title">
      <h2 id="workspace-title" class="sr-only">文件工作区</h2>
      <ResizableWorkbench>
        <template #directory><DirectoryExplorer :workspace="workspace" /></template>
        <template #editor><TextEditor :workspace="workspace" /></template>
      </ResizableWorkbench>
    </section>
  </main>
  <WorkspaceDialog ref="connectionDialog" labelled-by="connection-title">
    <ConnectionPanel :workspace="workspace" />
    <div class="notice dialog-notice" :class="{ error: state.noticeError }" role="status" aria-live="polite">{{ state.notice }}</div>
  </WorkspaceDialog>
  <WorkspaceDialog ref="eventsDialog" labelled-by="events-title">
    <EventLog :workspace="workspace" />
  </WorkspaceDialog>
  <WorkspaceDialog ref="rulesDialog" labelled-by="rules-title">
    <IgnoreRules :workspace="workspace" />
    <div class="notice dialog-notice" :class="{ error: state.noticeError }" role="status" aria-live="polite">{{ state.notice }}</div>
  </WorkspaceDialog>
</template>
