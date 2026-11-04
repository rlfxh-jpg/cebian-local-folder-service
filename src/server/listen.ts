import type { Server } from "node:http";

/** Bind a listener and describe address conflicts in terms of the startup command. */
export async function listen(server: Server, host: string, port: number, name: string, portVariable: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      const guidance = portVariable === "LOCAL_FOLDER_PORT" ? " npm run demo 已包含后端，无需同时运行 npm run dev。" : "";
      throw new Error(`${name}启动失败：${host}:${port} 已被占用（EADDRINUSE）。请在已有服务的终端按 Ctrl+C 关闭后重试，或修改 .env 中的 ${portVariable}。${guidance}`, { cause: error });
    }
    if (code === "EACCES") {
      throw new Error(`${name}启动失败：无法监听 ${host}:${port}（EACCES）。请修改 .env 中的 ${portVariable}，使用可用端口。`, { cause: error });
    }
    throw error;
  }
}
