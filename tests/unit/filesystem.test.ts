import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSystemService } from "../../src/filesystem/service.ts";
import { ServiceError } from "../../src/shared/errors.ts";
import type { IgnoreRules } from "../../src/storage/state-store.ts";

async function withRoot(run: (root: string, fs: FileSystemService, setRules: (next: IgnoreRules) => void) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cebian-local-folder-"));
  let rules: IgnoreRules = { hidden: [], stopped: [], version: 1 };
  const fs = new FileSystemService(root, () => rules, 1024 * 1024, 5000, 20_000, 500);
  try { await run(root, fs, (next) => { rules = next; }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("读取并保存 UTF-8 BOM 和混合换行，版本冲突拒绝覆盖", async () => {
  await withRoot(async (root, fs) => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\n", "utf8")]);
    await writeFile(path.join(root, "notes.txt"), original);
    const loaded = await fs.read("notes.txt");
    assert.equal(loaded.bom, true);
    assert.equal(loaded.lineEnding, "mixed");
    assert.equal(loaded.trailingNewline, true);
    assert.equal(loaded.content, "one\r\ntwo\n");
    const saved = await fs.save("notes.txt", "one changed\r\ntwo\n", loaded.version.token, loaded.bom);
    assert.equal(saved.version.size, Buffer.byteLength("one changed\r\ntwo\n") + 3);
    assert.deepEqual((await readFile(path.join(root, "notes.txt"))).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
    await assert.rejects(fs.save("notes.txt", "stale", loaded.version.token, true), (error: unknown) => error instanceof ServiceError && error.code === "VERSION_CONFLICT");
  });
});

test("路径穿越、反斜杠和符号链接不能越过授权根目录", async () => {
  await withRoot(async (root, fs) => {
    await assert.rejects(fs.list("../"), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_PATH");
    await assert.rejects(fs.read("C:/Windows/win.ini"), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_PATH");
    await assert.rejects(fs.read("file.txt:alternate-stream"), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_PATH");
    await assert.rejects(fs.create("nested\\bad.txt", "file"), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_PATH");
    const outside = await mkdtemp(path.join(os.tmpdir(), "cebian-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      try {
        await (await import("node:fs/promises")).symlink(outside, path.join(root, "linked"), "junction");
        await assert.rejects(fs.list("linked"), (error: unknown) => error instanceof ServiceError && error.code === "SYMLINK_NOT_ALLOWED");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test("停止监听规则阻断子目录遍历，隐藏规则只标记展示状态", async () => {
  await withRoot(async (root, fs, setRules) => {
    await mkdir(path.join(root, "private"));
    await writeFile(path.join(root, "private", "target.txt"), "x");
    await writeFile(path.join(root, "hidden.txt"), "x");
    const validated = fs.validateRules(["hidden.txt"], ["private"]);
    setRules({ ...validated, version: 2 });
    const listing = await fs.list("");
    assert.equal(listing.entries.find((item) => item.name === "hidden.txt")?.hiddenByRule, true);
    assert.equal(listing.entries.some((item) => item.name === "private"), false);
    await assert.rejects(fs.list("private"), (error: unknown) => error instanceof ServiceError && error.code === "IGNORED_PATH");
    const search = await fs.search("target");
    assert.equal(search.results.length, 0);
  });
});

test("递归删除要求目录快照确认且拒绝树内符号链接", async () => {
  await withRoot(async (root, fs) => {
    await mkdir(path.join(root, "folder"));
    await writeFile(path.join(root, "folder", "a.txt"), "a");
    const inspection = await fs.inspectDelete("folder");
    assert.equal(inspection.itemCount, 2);
    await assert.rejects(fs.delete("folder"), (error: unknown) => error instanceof ServiceError && error.code === "CONFIRMATION_REQUIRED");
    await fs.delete("folder", inspection.version);
    await assert.rejects(fs.delete(""), (error: unknown) => error instanceof ServiceError && error.code === "ROOT_OPERATION_DENIED");
  });
});

test("目录按目录优先排序并支持稳定分页", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cebian-folder-page-"));
  try {
    await mkdir(path.join(root, "z-folder"));
    await writeFile(path.join(root, "a.txt"), "a");
    await writeFile(path.join(root, "b.txt"), "b");
    const fs = new FileSystemService(root, () => ({ hidden: [], stopped: [], version: 1 }), 1024, 2, 100, 10);
    const first = await fs.list("");
    assert.deepEqual(first.entries.map((item) => item.name), ["z-folder", "a.txt"]);
    assert.equal(first.nextOffset, 2);
    const second = await fs.list("", first.nextOffset);
    assert.deepEqual(second.entries.map((item) => item.name), ["b.txt"]);
    assert.equal(second.truncated, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
