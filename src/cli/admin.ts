import { readConfig } from "../config/index.ts";
import { StateStore } from "../storage/state-store.ts";

try { process.loadEnvFile(); } catch { /* .env is optional when the process manager supplies configuration. */ }
const command = process.argv[2] ?? "help";
const state = new StateStore(readConfig().dataDir);
await state.load();

if (command === "list") {
  console.table(state.clients.map(({ id, name, createdAt }) => ({ id, name, createdAt: new Date(createdAt).toISOString() })));
} else if (command === "revoke-all") {
  const removed = await state.revoke();
  console.log(`已撤销 ${removed.length} 个客户端授权。运行中的连接会在 2 秒内断开。`);
} else if (command === "revoke") {
  const id = process.argv[3];
  if (!id) throw new Error("用法：npm run admin -- revoke <clientId>");
  const removed = await state.revoke(id);
  console.log(removed.length ? `已撤销客户端 ${id}。运行中的连接会在 2 秒内断开。` : `没有找到客户端 ${id}。`);
} else {
  console.log("用法：npm run admin -- <list|revoke <clientId>|revoke-all>");
}
