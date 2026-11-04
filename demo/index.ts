import { startDemo } from "./server.ts";

try { process.loadEnvFile(); } catch { /* Environment files are optional. */ }
try {
  const demo = await startDemo(undefined, Number(process.env.DEMO_PORT ?? 4173));
  console.log(`[Cebian Demo] 页面：${demo.url}`);
  console.log(`[Cebian Demo] WebSocket：${demo.service.url}`);
  console.log(`[Cebian Demo] 配对码（5 分钟内有效、仅可使用一次）：${demo.service.pairingCode}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await demo.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  console.error(`[Cebian Demo] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
