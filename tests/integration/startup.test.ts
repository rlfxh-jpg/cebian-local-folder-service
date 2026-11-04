import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { readConfig } from "../../src/config/index.ts";
import { startService } from "../../src/server/service.ts";

const runNode = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

test("重复启动明确提示冲突端口，失败进程正常退出且不影响已有服务", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "cebian-startup-test-"));
  const service = await startService(readConfig({ LOCAL_FOLDER_DATA_DIR: path.join(sandbox, "running"), LOCAL_FOLDER_PORT: "0" }));
  const occupiedPort = new URL(service.url).port;
  try {
    for (const scenario of [
      { entry: "src/index.ts", backendPort: occupiedPort, demoPort: "0", variable: "LOCAL_FOLDER_PORT" },
      { entry: "demo/index.ts", backendPort: occupiedPort, demoPort: "0", variable: "LOCAL_FOLDER_PORT" },
      { entry: "demo/index.ts", backendPort: "0", demoPort: occupiedPort, variable: "DEMO_PORT" },
    ]) {
      await assert.rejects(runNode(process.execPath, ["--import", "tsx", scenario.entry], {
        cwd: projectRoot,
        timeout: 5000,
        env: {
          ...process.env,
          LOCAL_FOLDER_HOST: "127.0.0.1",
          LOCAL_FOLDER_PORT: scenario.backendPort,
          DEMO_PORT: scenario.demoPort,
          LOCAL_FOLDER_DATA_DIR: path.join(sandbox, `${scenario.variable}-${scenario.entry.split("/")[0]}`),
        },
      }), (error: Error) => {
        const failure = error as Error & { code: number; killed: boolean; stdout: string; stderr: string };
        assert.equal(failure.code, 1);
        assert.equal(failure.killed, false, "失败进程应主动退出，不应因残留监听而超时");
        assert.match(failure.stderr, new RegExp(`127\\.0\\.0\\.1:${occupiedPort} 已被占用`));
        assert.ok(failure.stderr.includes(scenario.variable));
        assert.match(failure.stderr, /Ctrl\+C/);
        if (scenario.variable === "LOCAL_FOLDER_PORT") assert.match(failure.stderr, /npm run demo 已包含后端/);
        assert.doesNotMatch(failure.stderr, /node:net:|UVExceptionWithHostPort/);
        assert.equal(failure.stdout, "", "启动失败不能输出成功提示或配对码");
        return true;
      });
      const health = await fetch(`http://127.0.0.1:${occupiedPort}/health`);
      assert.equal(health.status, 200, "已有服务应继续正常运行");
    }
  } finally {
    await service.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
