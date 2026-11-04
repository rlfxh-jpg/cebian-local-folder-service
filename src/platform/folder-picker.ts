import { spawn } from "node:child_process";
import { ServiceError } from "../shared/errors.ts";

export async function chooseFolder(): Promise<string | null> {
  if (process.platform !== "win32") throw new ServiceError("PICKER_UNAVAILABLE", "此版本的系统文件夹选择器仅支持 Windows；请在页面输入绝对路径。");
  const script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择 Cebian 本地文件夹工作台的根目录'; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($d.SelectedPath) }";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new ServiceError("PICKER_TIMEOUT", "系统文件夹选择器超时。", true)); }, 5 * 60_000).unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.once("error", () => { clearTimeout(timeout); reject(new ServiceError("PICKER_UNAVAILABLE", "无法启动系统文件夹选择器。")); });
    child.once("close", (code) => { clearTimeout(timeout); if (code !== 0) reject(new ServiceError("PICKER_FAILED", "系统文件夹选择器未能完成。")); else resolve(output.trim() || null); });
  });
}
