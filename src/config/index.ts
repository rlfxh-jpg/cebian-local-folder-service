import os from "node:os";
import path from "node:path";

export interface ServiceConfig {
  host: string;
  port: number;
  dataDir: string;
  allowedOrigins: Set<string>;
  maxConnections: number;
  maxMessageBytes: number;
  maxFileBytes: number;
  maxDirectoryEntries: number;
  maxSearchEntries: number;
  maxSearchResults: number;
  maxRequestsPerMinute: number;
}

export function readConfig(env = process.env): ServiceConfig {
  const host = env.LOCAL_FOLDER_HOST ?? "127.0.0.1";
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error("LOCAL_FOLDER_HOST 只能绑定本机回环地址。");
  }
  const port = Number(env.LOCAL_FOLDER_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("LOCAL_FOLDER_PORT 必须是 0 到 65535 之间的整数。");
  const dataDir = path.resolve(env.LOCAL_FOLDER_DATA_DIR ?? path.join(env.LOCALAPPDATA ?? os.homedir(), "Cebian", "LocalFolderService"));
  const allowedOrigins = new Set((env.CEBIAN_EXTENSION_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error(`CEBIAN_EXTENSION_ORIGINS 中的来源无效：${origin}`); }
    if (!["chrome-extension:", "moz-extension:"].includes(parsed.protocol) || !parsed.host || parsed.pathname || parsed.search || parsed.hash || parsed.href !== origin) {
      throw new Error(`CEBIAN_EXTENSION_ORIGINS 只接受精确的 chrome-extension:// 或 moz-extension:// 来源：${origin}`);
    }
  }
  return {
    host,
    port,
    dataDir,
    allowedOrigins,
    maxConnections: integer(env.LOCAL_FOLDER_MAX_CONNECTIONS, 32),
    maxMessageBytes: integer(env.LOCAL_FOLDER_MAX_MESSAGE_BYTES, 16 * 1024 * 1024),
    maxFileBytes: integer(env.LOCAL_FOLDER_MAX_FILE_BYTES, 5 * 1024 * 1024),
    maxDirectoryEntries: integer(env.LOCAL_FOLDER_MAX_DIRECTORY_ENTRIES, 5000),
    maxSearchEntries: integer(env.LOCAL_FOLDER_MAX_SEARCH_ENTRIES, 20000),
    maxSearchResults: integer(env.LOCAL_FOLDER_MAX_SEARCH_RESULTS, 500),
    maxRequestsPerMinute: integer(env.LOCAL_FOLDER_MAX_REQUESTS_PER_MINUTE, 600),
  };
}

function integer(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`无效的正整数配置：${raw}`);
  return value;
}
