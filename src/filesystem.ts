import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { ServiceError } from "./errors.ts";
import type { IgnoreRules } from "./state.ts";

export interface FolderInfo { root: string; label: string; canonicalPath: string }
export interface FileVersion { token: string; size: number; mtimeMs: number; identity: string }
export interface EntryInfo {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: number;
  readable: boolean;
  writable: boolean;
  hiddenByRule: boolean;
}

const MAX_RULES = 100;
const MAX_RULE_LENGTH = 256;

export function canonicalRootKey(root: string): string { return process.platform === "win32" ? root.toLocaleLowerCase("en-US") : root; }

export async function selectRoot(inputPath: string): Promise<FolderInfo> {
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath) || inputPath.includes("\0")) throw new ServiceError("INVALID_PATH", "请选择一个有效的绝对目录路径。");
  const canonical = await realpath(path.resolve(inputPath));
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ServiceError("NOT_DIRECTORY", "所选路径不是可访问的真实目录。");
  await access(canonical, constants.R_OK);
  return { root: canonical, canonicalPath: canonical, label: path.basename(canonical) || canonical };
}

export class FileSystemService {
  constructor(
    private readonly root: string,
    private readonly rules: () => IgnoreRules,
    private readonly maxFileBytes: number,
    private readonly maxDirectoryEntries: number,
    private readonly maxSearchEntries: number,
    private readonly maxSearchResults: number,
  ) {}

  async list(relativePath: string, offset = 0): Promise<{ entries: EntryInfo[]; version: string; truncated: boolean; nextOffset?: number; scanLimitReached: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ServiceError("INVALID_REQUEST", "目录分页偏移量无效。");
    const target = await this.resolve(relativePath);
    const info = await lstat(target);
    if (!info.isDirectory()) throw new ServiceError("NOT_DIRECTORY", "目标不是目录。");
    if (await this.isStopped(relativePath)) throw new ServiceError("IGNORED_PATH", "此目录已按规则停止监听和搜索。");
    const names = await readdir(target);
    const scannedNames = names.slice(0, this.maxSearchEntries).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
    const records = await mapBounded(scannedNames, 32, async (name) => {
      const item = await lstat(path.join(target, name));
      const symlink = item.isSymbolicLink();
      const kind: EntryInfo["kind"] = symlink ? "symlink" : item.isDirectory() ? "directory" : item.isFile() ? "file" : "other";
      return { name, path: relativePath ? `${relativePath}/${name}` : name, kind, size: item.size, modifiedAt: item.mtimeMs, dev: item.dev, ino: item.ino };
    });
    records.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    const selected = records.slice(offset, offset + this.maxDirectoryEntries);
    const rules = this.compiledRules();
    const entries = await mapBounded(selected, 32, async (record): Promise<EntryInfo> => {
      const fullPath = path.join(target, record.name);
      const symlink = record.kind === "symlink";
      let readable = false;
      let writable = false;
      if (!symlink && (record.kind === "directory" || record.kind === "file")) {
        try { await access(fullPath, constants.R_OK); readable = true; } catch { /* permission is reported as a capability */ }
        try { await access(fullPath, constants.W_OK); writable = true; } catch { /* permission is reported as a capability */ }
      }
      return {
        name: record.name,
        path: record.path,
        kind: record.kind,
        size: record.size,
        modifiedAt: record.modifiedAt,
        readable,
        writable,
        hiddenByRule: rules.hidden.some((match) => ruleMatches(match, record.path)),
      };
    });
    const visible = entries.filter((entry) => !rules.stopped.some((match) => ruleMatches(match, entry.path)));
    const rootInfo = await stat(target, { bigint: true });
    const version = hash(JSON.stringify([rootInfo.dev.toString(), rootInfo.ino.toString(), rootInfo.mtimeNs.toString(), records.map((e) => [e.name, e.kind, e.size, e.modifiedAt, e.dev.toString(), e.ino.toString()])]));
    const nextOffset = offset + selected.length < records.length ? offset + selected.length : undefined;
    const scanLimitReached = names.length > scannedNames.length;
    return { entries: visible, version, truncated: nextOffset !== undefined || scanLimitReached, ...(nextOffset !== undefined ? { nextOffset } : {}), scanLimitReached };
  }

  async read(relativePath: string): Promise<{ path: string; content: string; bom: boolean; lineEnding: "lf" | "crlf" | "mixed" | "none"; trailingNewline: boolean; version: FileVersion; writable: boolean }> {
    await this.assertNotStopped(relativePath);
    const target = await this.resolve(relativePath);
    const before = await lstat(target, { bigint: true });
    if (!before.isFile()) throw new ServiceError("UNSUPPORTED_FILE_TYPE", "目标不是普通文本文件。");
    if (before.size > BigInt(this.maxFileBytes)) throw new ServiceError("FILE_TOO_LARGE", `文件超过 ${this.maxFileBytes} 字节的读取上限。`);
    const handle = await open(target, constants.O_RDONLY | (process.platform !== "win32" ? (constants.O_NOFOLLOW ?? 0) : 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameIdentity(before, opened)) throw new ServiceError("VERSION_CONFLICT", "读取期间文件已被替换，请重新读取。");
      const chunks: Buffer[] = [];
      let total = 0;
      const chunk = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > this.maxFileBytes) throw new ServiceError("FILE_TOO_LARGE", `文件超过 ${this.maxFileBytes} 字节的读取上限。`);
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      const bytes = Buffer.concat(chunks, total);
      const after = await handle.stat({ bigint: true });
      if (bytes.length > this.maxFileBytes || !sameIdentity(opened, after)) throw new ServiceError("VERSION_CONFLICT", "读取期间文件发生变化，请重新读取。");
      const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes); }
      catch { throw new ServiceError("UNSUPPORTED_ENCODING", "文件不是有效的 UTF-8 文本，服务不会对其进行有损解码。"); }
      if (content.includes("\0")) throw new ServiceError("UNSUPPORTED_FILE_TYPE", "文件包含 NUL 字节，按非文本文件处理。");
      const hasLf = /(?<!\r)\n/.test(content);
      const hasCrLf = /\r\n/.test(content);
      const lineEnding = hasLf && hasCrLf ? "mixed" : hasCrLf ? "crlf" : hasLf ? "lf" : "none";
      let writable = true;
      try { await access(target, constants.W_OK); } catch { writable = false; }
      return { path: relativePath, content, bom, lineEnding, trailingNewline: content.endsWith("\n"), version: makeVersion(opened, bytes), writable };
    } finally { await handle.close(); }
  }

  async save(relativePath: string, content: string, expectedVersion: string, bom: boolean): Promise<{ version: FileVersion; bytes: number }> {
    await this.assertNotStopped(relativePath);
    if (typeof content !== "string" || typeof expectedVersion !== "string") throw new ServiceError("INVALID_REQUEST", "保存内容或版本参数无效。");
    const target = await this.resolve(relativePath);
    const current = await this.read(relativePath);
    if (current.version.token !== expectedVersion) throw new ServiceError("VERSION_CONFLICT", "磁盘文件已变化，保存已拒绝。请重新加载或基于最新版本确认覆盖。");
    if (current.bom !== bom) throw new ServiceError("FORMAT_CHANGE_NOT_SUPPORTED", "首版保存必须保留原文件的 UTF-8 BOM 状态。");
    if (hasUnpairedSurrogate(content)) throw new ServiceError("INVALID_TEXT", "保存内容包含无效 Unicode 字符。");
    const body = Buffer.from(content, "utf8");
    const bytes = current.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
    if (bytes.length > this.maxFileBytes) throw new ServiceError("FILE_TOO_LARGE", `保存内容超过 ${this.maxFileBytes} 字节的上限。`);
    const currentStat = await stat(target, { bigint: true });
    const temp = path.join(path.dirname(target), `.cebian-save-${randomUUID()}.tmp`);
    const mode = Number(currentStat.mode & 0o777n);
    try {
      await writeFile(temp, bytes, { flag: "wx", mode });
      const latest = await this.read(relativePath);
      if (latest.version.token !== expectedVersion) throw new ServiceError("VERSION_CONFLICT", "保存前磁盘文件再次发生变化，保存已拒绝。");
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    const reopened = await this.read(relativePath);
    return { version: reopened.version, bytes: bytes.length };
  }

  async create(relativePath: string, kind: "file" | "directory"): Promise<{ path: string }> {
    const { target, parent } = await this.resolveParent(relativePath);
    await access(parent, constants.W_OK);
    if (kind === "directory") await mkdir(target);
    else {
      const handle = await open(target, "wx", 0o666);
      await handle.close();
    }
    return { path: relativePath };
  }

  async rename(relativePath: string, newName: string): Promise<{ oldPath: string; path: string }> {
    validateName(newName);
    const { target, parent } = await this.resolveParent(relativePath);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new ServiceError("SYMLINK_NOT_ALLOWED", "不能重命名符号链接。");
    await access(parent, constants.W_OK);
    const destination = path.join(parent, newName);
    try { await lstat(destination); throw new ServiceError("ALREADY_EXISTS", "同名目标已存在。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(target, destination);
    const parentRel = path.posix.dirname(relativePath);
    return { oldPath: relativePath, path: parentRel === "." ? newName : `${parentRel}/${newName}` };
  }

  async delete(relativePath: string, confirmationVersion?: string): Promise<{ deleted: string; itemCount: number }> {
    if (!relativePath) throw new ServiceError("ROOT_OPERATION_DENIED", "不能删除授权根目录。");
    const { target, parent } = await this.resolveParent(relativePath);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new ServiceError("SYMLINK_NOT_ALLOWED", "不能删除或跟随符号链接。");
    await access(parent, constants.W_OK);
    const snapshot = await this.subtreeSnapshot(target, relativePath);
    if (confirmationVersion !== snapshot.version) {
      throw new ServiceError("CONFIRMATION_REQUIRED", JSON.stringify({ itemCount: snapshot.count, version: snapshot.version, recursive: info.isDirectory() && snapshot.count > 1 }));
    }
    await rm(target, { recursive: info.isDirectory(), force: false, maxRetries: 2, retryDelay: 50 });
    return { deleted: relativePath, itemCount: snapshot.count };
  }

  async search(nameQuery: string, limit = this.maxSearchResults, signal?: AbortSignal): Promise<{ results: Array<{ name: string; path: string; kind: string; hiddenByRule: boolean }>; truncated: boolean; scanned: number }> {
    if (typeof nameQuery !== "string" || !nameQuery.trim()) throw new ServiceError("INVALID_REQUEST", "搜索名称不能为空。");
    const root = await this.resolve("");
    const rules = this.compiledRules();
    const results: Array<{ name: string; path: string; kind: string; hiddenByRule: boolean }> = [];
    const stack = [{ full: root, rel: "" }];
    let scanned = 0;
    let truncated = false;
    const safeLimit = Math.max(1, Math.min(limit, this.maxSearchResults));
    const start = Date.now();
    while (stack.length) {
      if (signal?.aborted) throw new ServiceError("REQUEST_CANCELLED", "搜索已取消。");
      if (Date.now() - start > 5000 || scanned >= this.maxSearchEntries || results.length >= safeLimit) { truncated = true; break; }
      const current = stack.pop()!;
      if (current.rel && rules.stopped.some((match) => ruleMatches(match, current.rel))) continue;
      let names: string[];
      try { names = await readdir(current.full); } catch { continue; }
      for (const name of names) {
        scanned++;
        if (scanned > this.maxSearchEntries) { truncated = true; break; }
        const relative = current.rel ? `${current.rel}/${name}` : name;
        if (rules.stopped.some((match) => ruleMatches(match, relative))) continue;
        let info;
        try { info = await lstat(path.join(current.full, name)); } catch { continue; }
        const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
        if (name.toLocaleLowerCase().includes(nameQuery.toLocaleLowerCase())) {
          results.push({ name, path: relative, kind, hiddenByRule: rules.hidden.some((match) => ruleMatches(match, relative)) });
          if (results.length >= safeLimit) { truncated = stack.length > 0 || names.indexOf(name) < names.length - 1; break; }
        }
        if (info.isDirectory()) stack.push({ full: path.join(current.full, name), rel: relative });
      }
    }
    return { results, truncated, scanned };
  }

  async inspectDelete(relativePath: string): Promise<{ version: string; itemCount: number; recursive: boolean }> {
    if (!relativePath) throw new ServiceError("ROOT_OPERATION_DENIED", "不能操作授权根目录。");
    const target = await this.resolve(relativePath);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new ServiceError("SYMLINK_NOT_ALLOWED", "不能跟随符号链接。");
    const snapshot = await this.subtreeSnapshot(target, relativePath);
    return { version: snapshot.version, itemCount: snapshot.count, recursive: info.isDirectory() && snapshot.count > 1 };
  }

  validateRules(hidden: unknown, stopped: unknown): { hidden: string[]; stopped: string[] } {
    return { hidden: validatePatterns(hidden), stopped: validatePatterns(stopped) };
  }

  private async resolve(relativePath: string): Promise<string> {
    const parts = parseRelativePath(relativePath);
    let current = this.root;
    for (const segment of parts) {
      current = path.join(current, segment);
      const item = await lstat(current);
      if (item.isSymbolicLink()) throw new ServiceError("SYMLINK_NOT_ALLOWED", "不允许通过符号链接访问文件。");
    }
    const actual = await realpath(current);
    if (!inside(this.root, actual)) throw new ServiceError("PATH_OUTSIDE_ROOT", "目标超出授权目录范围。");
    return actual;
  }

  private async resolveParent(relativePath: string): Promise<{ target: string; parent: string }> {
    const parts = parseRelativePath(relativePath);
    if (!parts.length) throw new ServiceError("ROOT_OPERATION_DENIED", "不能修改授权根目录本身。");
    const name = parts.pop()!;
    validateName(name);
    const parentRel = parts.join("/");
    const parent = await this.resolve(parentRel);
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory()) throw new ServiceError("NOT_DIRECTORY", "父路径不是目录。");
    const target = path.join(parent, name);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new ServiceError("SYMLINK_NOT_ALLOWED", "不允许操作符号链接。");
      if (!inside(this.root, path.resolve(target))) throw new ServiceError("PATH_OUTSIDE_ROOT", "目标超出授权目录范围。");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { target, parent };
  }

  private async assertNotStopped(relativePath: string): Promise<void> {
    if (await this.isStopped(relativePath)) throw new ServiceError("IGNORED_PATH", "此路径已按规则停止监听和搜索。");
  }
  private async isStopped(relativePath: string): Promise<boolean> {
    return this.compiledRules().stopped.some((match) => ruleMatches(match, relativePath));
  }
  private compiledRules(): { hidden: Array<(value: string) => boolean>; stopped: Array<(value: string) => boolean> } {
    const current = this.rules();
    return { hidden: current.hidden.map((pattern) => picomatch(pattern)), stopped: current.stopped.map((pattern) => picomatch(pattern)) };
  }

  private async subtreeSnapshot(target: string, relativePath: string): Promise<{ count: number; version: string }> {
    const hashState = createHash("sha256");
    let count = 1;
    let visited = 0;
    const stack = [{ target, relativePath }];
    while (stack.length) {
      if (visited++ > this.maxSearchEntries) throw new ServiceError("RESOURCE_LIMIT", "目标目录过大，无法在安全时间内统计删除范围。");
      const current = stack.pop()!;
      const info = await lstat(current.target, { bigint: true });
      hashState.update(`${current.relativePath}\0${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}\n`);
      if (!info.isDirectory()) continue;
      const names = await readdir(current.target);
      for (const name of names) {
        const child = path.join(current.target, name);
        const childInfo = await lstat(child);
        if (childInfo.isSymbolicLink()) throw new ServiceError("SYMLINK_NOT_ALLOWED", "目录包含符号链接；为避免越界，拒绝递归删除。");
        count++;
        stack.push({ target: child, relativePath: `${current.relativePath}/${name}` });
      }
    }
    return { count, version: hashState.digest("hex") };
  }
}

function parseRelativePath(value: string): string[] {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value) || value.startsWith("//")) {
    throw new ServiceError("INVALID_PATH", "路径必须是授权目录下使用正斜杠的相对路径。");
  }
  if (value === "") return [];
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw new ServiceError("INVALID_PATH", "相对路径包含非法路径段。");
  return parts;
}

function validateName(name: string): void {
  if (typeof name !== "string" || !name || name === "." || name === ".." || name.length > 255 || /[\\/:*?"<>|\0-\x1f]/.test(name) || /[. ]$/.test(name)) {
    throw new ServiceError("INVALID_NAME", "名称为空、过长或包含当前平台不允许的字符。");
  }
  if (process.platform === "win32" && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) throw new ServiceError("INVALID_NAME", "该名称是 Windows 保留名称。");
}

function validatePatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RULES || value.some((item) => typeof item !== "string" || !item || item.length > MAX_RULE_LENGTH || item.startsWith("/") || item.includes("\\") || item.split("/").includes(".."))) {
    throw new ServiceError("INVALID_IGNORE_RULE", "忽略规则格式无效或超过数量限制。");
  }
  for (const item of value) {
    try { picomatch.makeRe(item as string); } catch { throw new ServiceError("INVALID_IGNORE_RULE", `无效的忽略规则：${String(item).slice(0, 80)}`); }
  }
  return [...new Set(value as string[])];
}

function makeVersion(info: { dev: bigint; ino: bigint; size: bigint; mtimeNs?: bigint; mtimeMs: bigint | number }, bytes: Buffer): FileVersion {
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs?.toString() ?? info.mtimeMs}`;
  const token = hash(`${identity}:${createHash("sha256").update(bytes).digest("hex")}`);
  return { token, identity, size: bytes.length, mtimeMs: Number(info.mtimeNs !== undefined ? info.mtimeNs / 1_000_000n : info.mtimeMs) };
}
function sameIdentity(a: { dev: bigint; ino: bigint; size: bigint; mtimeNs?: bigint }, b: { dev: bigint; ino: bigint; size: bigint; mtimeNs?: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}
function inside(root: string, target: string): boolean { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function kindOrder(kind: EntryInfo["kind"]): number { return kind === "directory" ? 0 : kind === "file" ? 1 : kind === "symlink" ? 2 : 3; }
function ruleMatches(match: (value: string) => boolean, value: string): boolean {
  if (match(value)) return true;
  const segments = value.split("/");
  for (let index = 1; index < segments.length; index++) if (match(segments.slice(0, index).join("/"))) return true;
  return false;
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
async function mapBounded<T, R>(items: T[], concurrency: number, callback: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      result[index] = await callback(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return result;
}
