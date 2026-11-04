import picomatch from "picomatch";
import { ServiceError } from "../shared/errors.ts";

const MAX_RULES = 100;
const MAX_RULE_LENGTH = 256;

export function validatePatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RULES || value.some((item) => typeof item !== "string" || !item || item.length > MAX_RULE_LENGTH || item.startsWith("/") || item.includes("\\") || item.split("/").includes(".."))) {
    throw new ServiceError("INVALID_IGNORE_RULE", "忽略规则格式无效或超过数量限制。");
  }
  for (const item of value) {
    try { picomatch.makeRe(item as string); } catch { throw new ServiceError("INVALID_IGNORE_RULE", `无效的忽略规则：${String(item).slice(0, 80)}`); }
  }
  return [...new Set(value as string[])];
}

export function ruleMatches(match: (value: string) => boolean, value: string): boolean {
  if (match(value)) return true;
  const segments = value.split("/");
  for (let index = 1; index < segments.length; index++) if (match(segments.slice(0, index).join("/"))) return true;
  return false;
}
