import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { FileSystemService } from "../filesystem/service.ts";
import type { IgnoreRules } from "../storage/state-store.ts";
import { ServiceError } from "../shared/errors.ts";

export interface FileEvent { event: string; path?: string; oldPath?: string; sequence: number; version?: string | number; reason?: string }
export interface WatchSubscription {
  id: string;
  clientId: string;
  root: string;
  fs: FileSystemService;
  rules: () => IgnoreRules;
  setRules: (rules: IgnoreRules) => void;
  send: (event: FileEvent) => void;
}

interface RootWatch {
  watcher: FSWatcher;
  subscribers: Map<string, WatchSubscription>;
  sequence: number;
  expanded: Map<string, string>;
  timer: NodeJS.Timeout;
  pending: Map<string, string>;
  flushTimer?: NodeJS.Timeout;
}

export class WatcherRegistry {
  private roots = new Map<string, RootWatch>();

  acquire(subscription: WatchSubscription): void {
    let root = this.roots.get(subscription.root);
    if (!root) {
      const state: Omit<RootWatch, "watcher"> = { subscribers: new Map<string, WatchSubscription>(), sequence: 0, expanded: new Map<string, string>(), pending: new Map<string, string>(), timer: undefined as unknown as NodeJS.Timeout };
      const watcher = watch(subscription.root, { recursive: true }, (_kind, filename) => {
        if (!filename) { this.broadcast(state, { event: "resync.required", reason: "unknown-path" }); return; }
        const relative = filename.toString().replaceAll(path.sep, "/");
        if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) { this.broadcast(state, { event: "resync.required", reason: "invalid-watch-path" }); return; }
        if (state.pending.size >= 1000) {
          state.pending.clear();
          state.pending.set("*", "*");
        }
        if (state.pending.has("*")) return;
        state.pending.set(relative, relative);
        if (!state.flushTimer) state.flushTimer = setTimeout(() => this.flush(state), 80).unref();
      });
      watcher.on("error", () => this.broadcast(state, { event: "resync.required", reason: "watcher-error" }));
      state.timer = setInterval(() => void this.reconcile(state), 30_000).unref();
      root = { ...state, watcher };
      this.roots.set(subscription.root, root);
    }
    root.subscribers.set(subscription.id, subscription);
    void this.refreshExpanded(root, subscription);
  }

  release(subscriptionId: string, rootPath?: string): void {
    const candidates = rootPath ? [this.roots.get(rootPath)].filter((item): item is RootWatch => Boolean(item)) : [...this.roots.values()];
    for (const root of candidates) {
      root.subscribers.delete(subscriptionId);
      if (root.subscribers.size) continue;
      clearInterval(root.timer);
      if (root.flushTimer) clearTimeout(root.flushTimer);
      root.watcher.close();
      this.roots.delete(rootPath ?? [...this.roots].find(([, value]) => value === root)?.[0] ?? "");
    }
  }

  noteDirectory(subscriptionId: string, rootPath: string, relativePath: string, version: string): void {
    const root = this.roots.get(rootPath);
    if (!root?.subscribers.has(subscriptionId)) return;
    root.expanded.set(`${subscriptionId}\0${relativePath}`, version);
  }

  updateRules(rootPath: string, clientId: string, rules: IgnoreRules): void {
    const root = this.roots.get(rootPath);
    if (!root) return;
    for (const subscription of root.subscribers.values()) {
      if (subscription.clientId !== clientId) continue;
      subscription.setRules(rules);
      subscription.send({ event: "ignore.changed", version: rules.version, sequence: ++root.sequence });
    }
  }

  private flush(root: Omit<RootWatch, "watcher">): void {
    root.flushTimer = undefined;
    if (root.pending.size > 100) {
      root.pending.clear();
      this.broadcast(root, { event: "resync.required", reason: "event-burst" });
      return;
    }
    if (root.pending.has("*")) {
      root.pending.clear();
      this.broadcast(root, { event: "resync.required", reason: "event-overflow" });
      return;
    }
    for (const relative of root.pending.keys()) {
      this.broadcast(root, { event: "entry.changed", path: relative });
    }
    root.pending.clear();
  }

  private broadcast(root: Omit<RootWatch, "watcher">, payload: Omit<FileEvent, "sequence">): void {
    for (const subscription of root.subscribers.values()) {
      if (payload.path && matchesAny(subscription.rules().stopped, payload.path)) continue;
      subscription.send({ ...payload, sequence: ++root.sequence });
    }
  }

  private async reconcile(root: Omit<RootWatch, "watcher">): Promise<void> {
    for (const [key, previous] of [...root.expanded]) {
      const [subscriptionId, relativePath] = key.split("\0");
      const subscription = root.subscribers.get(subscriptionId);
      if (!subscription) { root.expanded.delete(key); continue; }
      try {
        const current = await subscription.fs.list(relativePath);
        if (current.version !== previous) {
          root.expanded.set(key, current.version);
          subscription.send({ event: "directory.changed", path: relativePath, sequence: ++root.sequence });
        }
      } catch (error) {
        if (error instanceof ServiceError) subscription.send({ event: "resync.required", path: relativePath, sequence: ++root.sequence, reason: error.code });
      }
    }
  }

  private async refreshExpanded(root: RootWatch, subscription: WatchSubscription): Promise<void> {
    try {
      const listing = await subscription.fs.list("");
      root.expanded.set(`${subscription.id}\0`, listing.version);
    } catch { /* first directory request will report the concrete failure */ }
  }
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => {
    if (picomatch.isMatch(value, pattern)) return true;
    const segments = value.split("/");
    return segments.slice(1).some((_, index) => picomatch.isMatch(segments.slice(0, index + 1).join("/"), pattern));
  });
}
