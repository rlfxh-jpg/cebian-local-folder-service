import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { asServiceError } from "../shared/errors.ts";
import { protocolVersion, type Connection } from "./types.ts";

export function sendResponse(connection: Connection, requestId: string, result?: unknown, error?: unknown): void {
  if (connection.ws.readyState !== WebSocket.OPEN) return;
  const payload = error ? asServiceError(error) : undefined;
  let details: unknown;
  if (payload?.code === "CONFIRMATION_REQUIRED") { try { details = JSON.parse(payload.message); } catch { /* retain the safe fallback message */ } }
  connection.ws.send(JSON.stringify({ protocolVersion, type: "response", requestId, ...(payload ? { error: { code: payload.code, message: details ? "删除操作需要确认。" : payload.message, retryable: payload.retryable, ...(details ? { details } : {}) } } : { result }) }));
}
export function sendEvent(connection: Connection, event: Record<string, unknown>): void {
  if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(JSON.stringify({ protocolVersion, type: "event", eventId: randomUUID(), ...event }));
}
