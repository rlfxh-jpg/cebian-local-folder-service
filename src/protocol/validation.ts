import { ServiceError } from "../shared/errors.ts";
import type { Connection } from "./types.ts";

export function consumeRate(connection: Connection, limit: number): boolean {
  const now = Date.now();
  connection.requestTimes = connection.requestTimes.filter((time) => now - time < 60_000);
  if (connection.requestTimes.length >= limit) return false;
  connection.requestTimes.push(now);
  return true;
}
export function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > 16 * 1024 * 1024) throw new ServiceError("INVALID_REQUEST", `参数 ${name} 无效。`);
  return value;
}
export function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
