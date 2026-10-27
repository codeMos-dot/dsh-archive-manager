import { createHash } from "node:crypto";
import { searchIndexRecordSchema } from "./archive-store-contract.js";
function stableValue(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  const row = value;
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, stableValue(row[key], seen)]));
}
function stableString(value) {
  try {
    return JSON.stringify(stableValue(value));
  } catch {
    return String(value);
  }
}
function searchIndexFingerprint(header, snapshot) {
  if (snapshot === void 0) return void 0;
  const revision = snapshot.revision === void 0 ? void 0 : stableString(snapshot.revision);
  const eventCount = Number.isSafeInteger(snapshot.eventCount) ? snapshot.eventCount : void 0;
  const sizeBytes = Number.isSafeInteger(snapshot.sizeBytes) ? snapshot.sizeBytes : Number.isSafeInteger(snapshot.size) ? snapshot.size : void 0;
  if (revision === void 0 && eventCount === void 0 && sizeBytes === void 0) return void 0;
  return createHash("sha256").update(stableString({
    format: 1,
    header: snapshot.header ?? header,
    revision: revision ?? null,
    eventCount: eventCount ?? null,
    sizeBytes: sizeBytes ?? null
  })).digest("hex");
}
function createSearchIndexRecord(sessionId, fingerprint, messages) {
  const indexed = searchIndexRecordSchema.safeParse({
    sessionId,
    fingerprint,
    messages: messages.map(({ seq, role, text }) => ({ seq, role, text })),
    indexedAt: Date.now(),
    bytes: Buffer.byteLength(messages.map((message) => message.text).join(""), "utf8")
  });
  return indexed.success ? indexed.data : void 0;
}
function usableSearchIndexRecord(value, sessionId, fingerprint) {
  const parsed = searchIndexRecordSchema.safeParse(value);
  return parsed.success && parsed.data.sessionId === sessionId && parsed.data.fingerprint === fingerprint ? parsed.data : void 0;
}
export {
  createSearchIndexRecord,
  searchIndexFingerprint,
  usableSearchIndexRecord
};
