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

