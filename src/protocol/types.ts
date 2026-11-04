import type { WebSocket } from "ws";
import type { FileSystemService } from "../filesystem/service.ts";
import type { IgnoreRules } from "../storage/state-store.ts";

export type RequestMessage = { protocolVersion: "1.0"; type: "request"; requestId: string; method: string; params?: Record<string, unknown> };
export interface Connection {
  ws: WebSocket;
  clientId?: string;
  subscriptionId?: string;
  root?: string;
  rules?: IgnoreRules;
  fs?: FileSystemService;
  requestTimes: number[];
  searches: Map<string, AbortController>;
  paired?: boolean;
  pairAttempts: number;
  activeRequests: number;
  activeRequestIds: Set<string>;
  alive: boolean;
}

export const protocolVersion = "1.0" as const;
