import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ServiceError } from "../shared/errors.ts";
import type { FolderInfo } from "./types.ts";

export function canonicalRootKey(root: string): string { return process.platform === "win32" ? root.toLocaleLowerCase("en-US") : root; }

export async function selectRoot(inputPath: string): Promise<FolderInfo> {
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath) || inputPath.includes("\0")) throw new ServiceError("INVALID_PATH", "请选择一个有效的绝对目录路径。");
  const canonical = await realpath(path.resolve(inputPath));
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ServiceError("NOT_DIRECTORY", "所选路径不是可访问的真实目录。");
  await access(canonical, constants.R_OK);
  return { root: canonical, canonicalPath: canonical, label: path.basename(canonical) || canonical };
}

export function parseRelativePath(value: string): string[] {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value) || value.startsWith("//")) {
    throw new ServiceError("INVALID_PATH", "路径必须是授权目录下使用正斜杠的相对路径。");
  }
  if (value === "") return [];
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw new ServiceError("INVALID_PATH", "相对路径包含非法路径段。");
  return parts;
}

export function validateName(name: string): void {
  if (typeof name !== "string" || !name || name === "." || name === ".." || name.length > 255 || /[\\/:*?"<>|\0-\x1f]/.test(name) || /[. ]$/.test(name)) {
    throw new ServiceError("INVALID_NAME", "名称为空、过长或包含当前平台不允许的字符。");
  }
  if (process.platform === "win32" && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) throw new ServiceError("INVALID_NAME", "该名称是 Windows 保留名称。");
}

export function inside(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
