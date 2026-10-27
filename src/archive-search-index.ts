import { createHash } from "node:crypto";
import type { Header } from "./host-compat.js";
import type { TextMessage } from "./contracts.js";
import { searchIndexRecordSchema } from "./archive-store-contract.js";
import type { SearchIndexRecord } from "./archive-store-contract.js";

export interface SearchIndexStat {
  header?: Header;
  revision?: unknown;
  eventCount?: number;
  sizeBytes?: number;
  size?: number;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  const row = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, stableValue(row[key], seen)]));
}

function stableString(value: unknown) {
  try { return JSON.stringify(stableValue(value)); }
  catch { return String(value); }
}

/**
 * The persistence revision is the authoritative change token. Event count and
 * artifact size are deliberately added so a backend that omits revisions still
 * gets conservative invalidation rather than a permanently stale index.
 */
export function searchIndexFingerprint(header: Header, snapshot: SearchIndexStat | undefined) {
  if (snapshot === undefined) return undefined;
  const revision = snapshot.revision === undefined ? undefined : stableString(snapshot.revision);
  const eventCount = Number.isSafeInteger(snapshot.eventCount) ? snapshot.eventCount : undefined;
  const sizeBytes = Number.isSafeInteger(snapshot.sizeBytes) ? snapshot.sizeBytes : Number.isSafeInteger(snapshot.size) ? snapshot.size : undefined;
  if (revision === undefined && eventCount === undefined && sizeBytes === undefined) return undefined;
  return createHash("sha256").update(stableString({
    format: 1,
    header: snapshot.header ?? header,
    revision: revision ?? null,
    eventCount: eventCount ?? null,
    sizeBytes: sizeBytes ?? null,
  })).digest("hex");
}

export function createSearchIndexRecord(sessionId: string, fingerprint: string, messages: readonly TextMessage[]): SearchIndexRecord | undefined {
  const indexed = searchIndexRecordSchema.safeParse({
    sessionId,
    fingerprint,
    messages: messages.map(({ seq, role, text }) => ({ seq, role, text })),
    indexedAt: Date.now(),
    bytes: Buffer.byteLength(messages.map((message) => message.text).join(""), "utf8"),
  });
  return indexed.success ? indexed.data : undefined;
}

export function usableSearchIndexRecord(value: unknown, sessionId: string, fingerprint: string) {
  const parsed = searchIndexRecordSchema.safeParse(value);
  return parsed.success && parsed.data.sessionId === sessionId && parsed.data.fingerprint === fingerprint ? parsed.data : undefined;
}
