import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readConfig, type ServiceConfig } from "../src/config/index.ts";
import { startService } from "../src/server/service.ts";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/client.js", ["client.js", "text/javascript; charset=utf-8"]],
]);

/** The demo grants only its actual loopback origin, for this process. */
export async function startDemo(config: ServiceConfig = readConfig(), port = 4173) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("DEMO_PORT 必须是 0 到 65535 之间的整数。");
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
      }
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/config.json") {
        response.writeHead(service ? 200 : 503, { "Content-Type": "application/json" });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({ websocketUrl: service?.url })); return;
      }
      const asset = assets.get(pathname);
      if (!asset) { response.writeHead(404); response.end("Not found"); return; }
      const bytes = await readFile(new URL(`./${asset[0]}`, import.meta.url));
      response.writeHead(200, { "Content-Type": asset[1], "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法获取 demo 监听地址。");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    service = await startService({ ...config, allowedOrigins: new Set([...config.allowedOrigins, url]) });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  const runningService = service;
  return {
    url, service: runningService,
    close: async () => {
      await runningService.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
