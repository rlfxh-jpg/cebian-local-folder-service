import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

export interface ClientRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
}

export interface RecentDirectory {
  path: string;
  label: string;
  lastOpenedAt: number;
}

export interface IgnoreRules {
  hidden: string[];
  stopped: string[];
  version: number;
}

interface PersistedState {
  schemaVersion: 1;
  clients: ClientRecord[];
  recents: Record<string, RecentDirectory[]>;
  ignores: Record<string, IgnoreRules>;
}

const emptyState = (): PersistedState => ({ schemaVersion: 1, clients: [], recents: {}, ignores: {} });

export class StateStore {
  private state = emptyState();
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) { this.filePath = path.join(dataDir, "state.json"); }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as PersistedState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.clients) || !parsed.recents || !parsed.ignores) throw new Error("invalid state schema");
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try { await writeFile(backup, await readFile(this.filePath)); } catch { /* damaged state may not be readable */ }
        this.state = emptyState();
        console.error(`[LocalFolder] 状态文件无法读取，已使用安全空状态：${backup}`);
      }
    }
    try { await chmod(path.dirname(this.filePath), 0o700); await chmod(this.filePath, 0o600); } catch { /* Windows ACL inherits from the user's profile directory. */ }
  }

  async refresh(): Promise<void> {
    await this.writeQueue;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as PersistedState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.clients) || !parsed.recents || !parsed.ignores) throw new Error("invalid state schema");
      this.state = parsed;
    } catch (error) {
      this.state = emptyState();
    }
  }

  get clients(): ClientRecord[] { return this.state.clients; }

  async addClient(name: string): Promise<{ client: ClientRecord; token: string }> {
    const token = randomBytes(32).toString("base64url");
    const client: ClientRecord = { id: randomBytes(16).toString("hex"), name: cleanName(name), tokenHash: hashToken(token), createdAt: Date.now() };
    this.state.clients.push(client);
    await this.persist();
    return { client, token };
  }

  findClient(token: string): ClientRecord | undefined {
    const hash = hashToken(token);
    return this.state.clients.find((client) => client.tokenHash === hash);
  }

  async revoke(clientId?: string): Promise<ClientRecord[]> {
    const removed = clientId ? this.state.clients.filter((item) => item.id === clientId) : [...this.state.clients];
    this.state.clients = clientId ? this.state.clients.filter((item) => item.id !== clientId) : [];
    if (removed.length) await this.persist();
    return removed;
  }

  async addRecent(clientId: string, directory: RecentDirectory): Promise<void> {
    const list = this.state.recents[clientId] ?? [];
    this.state.recents[clientId] = [directory, ...list.filter((item) => item.path !== directory.path)].slice(0, 20);
    await this.persist();
  }

  getRecents(clientId: string): RecentDirectory[] { return this.state.recents[clientId] ?? []; }

  async removeRecent(clientId: string, directoryPath: string): Promise<void> {
    this.state.recents[clientId] = this.getRecents(clientId).filter((item) => item.path !== directoryPath);
    await this.persist();
  }

  getIgnores(key: string): IgnoreRules { return this.state.ignores[key] ?? { hidden: [], stopped: [], version: 1 }; }

  async setIgnores(key: string, hidden: string[], stopped: string[]): Promise<IgnoreRules> {
    const current = this.getIgnores(key);
    const next = { hidden, stopped, version: current.version + 1 };
    this.state.ignores[key] = next;
    await this.persist();
    return next;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      const { rename } = await import("node:fs/promises");
      await rename(temp, this.filePath);
      try { await chmod(this.filePath, 0o600); } catch { /* Windows ACL inherits from the user's profile directory. */ }
    });
    await this.writeQueue;
  }
}

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function cleanName(name: string): string { return name.replace(/[\r\n\0]/g, " ").trim().slice(0, 80) || "Cebian page"; }
