import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { readConfig, type ServiceConfig } from "../src/config/index.ts";
import { startService } from "../src/server/service.ts";
import { listen } from "../src/server/listen.ts";

const dist = new URL("./dist/", import.meta.url);

async function builtAssets() {
  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ]);
  try {
    await readFile(new URL("index.html", dist));
    for (const entry of await readdir(new URL("assets/", dist), { withFileTypes: true })) {
      if (!entry.isFile() || !/^[\w.-]+\.(js|css)$/.test(entry.name)) continue;
      const type = entry.name.endsWith(".css") ? "text/css" : "text/javascript";
      assets.set(`/assets/${entry.name}`, [`assets/${entry.name}`, `${type}; charset=utf-8`]);
    }
  } catch {
    throw new Error("Vue demo 尚未构建，请先执行 npm run demo:build，或运行 npm run demo 使用开发模式。");
  }
  return assets;
}

/** The demo grants only its actual loopback origin, for this process. */
export async function startDemo(config: ServiceConfig = readConfig(), port = 4173, { development = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("DEMO_PORT 必须是 0 到 65535 之间的整数。");
  const assets = development ? undefined : await builtAssets();
  let vite: ViteDevServer | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'${development ? " 'unsafe-inline'" : ""}; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
      }
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/config.json") {
        response.writeHead(service ? 200 : 503, { "Content-Type": "application/json" });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({ websocketUrl: service?.url })); return;
      }
      if (vite) { vite.middlewares(request, response); return; }
      const asset = assets?.get(pathname);
      if (!asset) { response.writeHead(404); response.end("Not found"); return; }
      const bytes = await readFile(new URL(asset[0], dist));
      response.writeHead(200, { "Content-Type": asset[1], "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  const closePage = async () => {
    await vite?.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  try {
    if (development) {
      const { createServer: createViteServer } = await import("vite");
      vite = await createViteServer({
        configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
        server: { middlewareMode: true, hmr: { server } },
      });
    }
    await listen(server, "127.0.0.1", port, "Demo 页面", "DEMO_PORT");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法获取 demo 监听地址。");
    const url = `http://127.0.0.1:${address.port}`;
    service = await startService({ ...config, allowedOrigins: new Set([...config.allowedOrigins, url]) });
    const runningService = service;
    return {
      url, service: runningService,
      close: async () => {
        try { await runningService.close(); }
        finally { await closePage(); }
      },
    };
  } catch (error) {
    await closePage();
    throw error;
  }
}
