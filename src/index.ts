import { readConfig } from "./config.ts";
import { startService } from "./server.ts";

try { process.loadEnvFile(); } catch { /* .env is optional when the process manager supplies configuration. */ }
const config = readConfig();
const service = await startService(config);
console.log("[Cebian Local Folder] 本机文件服务已启动");
console.log(`[Cebian Local Folder] WebSocket: ${service.url}`);
console.log(`[Cebian Local Folder] 配对码（5 分钟内有效、仅可使用一次）: ${service.pairingCode}`);
console.log(`[Cebian Local Folder] HTTP 健康检查: http://${config.host}:${service.url.match(/:(\d+)\/ws$/)?.[1] ?? config.port}/health`);
if (!config.allowedOrigins.size) console.warn("[Cebian Local Folder] 尚未配置 CEBIAN_EXTENSION_ORIGINS；浏览器扩展连接会被拒绝。请先设置扩展的 chrome-extension:// 或 moz-extension:// 来源。");

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[Cebian Local Folder] 收到 ${signal}，正在关闭服务…`);
  await service.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
