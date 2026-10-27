import { record } from "./contracts.js";
const MAX_ID = 1024;
const MAX_MESSAGES = 2e4;
const MAX_MESSAGE_TEXT = 2e6;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_TRASH_ENTRIES = 100;
function checkedId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID) throw new TypeError("\u4F1A\u8BDD ID \u957F\u5EA6\u987B\u4E3A 1\uFF5E1024 \u4E2A\u5B57\u7B26");
  return value;
}
function boundedText(value, max, label) {
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${label} \u65E0\u6548`);
  return value;
}
function safeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} \u65E0\u6548`);
  return value;
}
function isAbsoluteFilePath(value) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}
function utf8Bytes(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 128) bytes += 1;
    else if (code < 2048) bytes += 2;
    else if (code >= 55296 && code <= 56319 && index + 1 < value.length && value.charCodeAt(index + 1) >= 56320 && value.charCodeAt(index + 1) <= 57343) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
const searchIndexRecordSchema = {
  parse(input) {
    const value = record(input);
    const sessionId = checkedId(value.sessionId);
    const fingerprint = boundedText(value.fingerprint, 4096, "\u7D22\u5F15\u6307\u7EB9");
    if (!fingerprint.length || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) throw new TypeError("\u68C0\u7D22\u7D22\u5F15\u6D88\u606F\u65E0\u6548");
    let bytes = 0;
    const messages = value.messages.map((item) => {
      const message = record(item);
      const seq = safeInteger(message.seq, "\u6D88\u606F\u5E8F\u53F7");
      const role = boundedText(message.role, 32, "\u6D88\u606F\u89D2\u8272");
      if (role !== "user" && role !== "assistant") throw new TypeError("\u68C0\u7D22\u7D22\u5F15\u4EC5\u5141\u8BB8\u7528\u6237\u548C\u52A9\u624B\u6D88\u606F");
      const text = boundedText(message.text, MAX_MESSAGE_TEXT, "\u6D88\u606F\u6B63\u6587");
      bytes += utf8Bytes(text);
      if (bytes > MAX_INDEX_BYTES) throw new TypeError("\u4F1A\u8BDD\u68C0\u7D22\u7D22\u5F15\u8D85\u8FC7 64 MiB\uFF0C\u8DF3\u8FC7\u6301\u4E45\u7F13\u5B58");
      return { seq, role, text };
    });
    if (safeInteger(value.bytes, "\u7D22\u5F15\u5927\u5C0F") !== bytes) throw new TypeError("\u7D22\u5F15\u5927\u5C0F\u4E0E\u6D88\u606F\u6B63\u6587\u4E0D\u4E00\u81F4");
    return {
      sessionId,
      fingerprint,
      messages,
      indexedAt: safeInteger(value.indexedAt, "\u7D22\u5F15\u65F6\u95F4"),
      bytes
    };
  },
  safeParse(value) {
    try {
      return { success: true, data: this.parse(value) };
    } catch (error) {
      return { success: false, error };
    }
  }
};
const trashEntrySchema = {
  parse(input) {
    const value = record(input);
    const sessionId = checkedId(value.sessionId);
    const header = record(value.header);
    if (header.id !== sessionId) throw new TypeError("\u56DE\u6536\u7AD9\u5934\u90E8\u4E0E\u4F1A\u8BDD ID \u4E0D\u4E00\u81F4");
    const artifactKind = boundedText(value.artifactKind, 64, "\u5DE5\u4EF6\u7C7B\u578B");
    if (artifactKind !== "session directory" && artifactKind !== "transcript artifact") throw new TypeError("\u56DE\u6536\u7AD9\u5DE5\u4EF6\u7C7B\u578B\u65E0\u6548");
    if (typeof value.wasArchived !== "boolean" || typeof value.wasFavorite !== "boolean") throw new TypeError("\u56DE\u6536\u7AD9\u72B6\u6001\u6807\u8BB0\u65E0\u6548");
    if (value.expired !== void 0 && typeof value.expired !== "boolean") throw new TypeError("\u56DE\u6536\u7AD9\u8FC7\u671F\u6807\u8BB0\u65E0\u6548");
    const originalPath = boundedText(value.originalPath, 4096, "\u539F\u59CB\u4F1A\u8BDD\u8DEF\u5F84");
    const trashPath = boundedText(value.trashPath, 4096, "\u56DE\u6536\u7AD9\u8DEF\u5F84");
    if (!isAbsoluteFilePath(originalPath) || !isAbsoluteFilePath(trashPath)) throw new TypeError("\u56DE\u6536\u7AD9\u8DEF\u5F84\u5FC5\u987B\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
    const workspaceId = value.workspaceId === void 0 ? void 0 : checkedId(value.workspaceId);
    const workspaceIndex = value.workspaceIndex === void 0 ? void 0 : safeInteger(value.workspaceIndex, "\u5DE5\u4F5C\u533A\u4F4D\u7F6E");
    return {
      sessionId,
      header,
      ...value.title === void 0 ? {} : { title: boundedText(value.title, 500, "\u4F1A\u8BDD\u6807\u9898") },
      deletedAt: safeInteger(value.deletedAt, "\u5220\u9664\u65F6\u95F4"),
      expiresAt: safeInteger(value.expiresAt, "\u4FDD\u7559\u622A\u6B62\u65F6\u95F4"),
      sizeBytes: safeInteger(value.sizeBytes, "\u4F1A\u8BDD\u5927\u5C0F"),
      originalPath,
      trashPath,
      artifactKind,
      ...workspaceId === void 0 ? {} : { workspaceId },
      ...workspaceIndex === void 0 ? {} : { workspaceIndex },
      wasArchived: value.wasArchived,
      wasFavorite: value.wasFavorite,
      ...value.expired === void 0 ? {} : { expired: value.expired }
    };
  },
  safeParse(value) {
    try {
      return { success: true, data: this.parse(value) };
    } catch (error) {
      return { success: false, error };
    }
  }
};
const trashIdsSchema = {
  parse(input) {
    const value = record(input);
    if (!Array.isArray(value.sessionIds) || value.sessionIds.length === 0 || value.sessionIds.length > MAX_TRASH_ENTRIES) throw new TypeError("\u6BCF\u6B21\u987B\u9009\u62E9 1\uFF5E100 \u4E2A\u56DE\u6536\u7AD9\u4F1A\u8BDD");
    return { sessionIds: [...new Set(value.sessionIds.map(checkedId))] };
  }
};
const purgeTrashSchema = {
  parse(input) {
    const value = record(input);
    if (value.all === true && value.sessionIds === void 0) return { all: true, sessionIds: [] };
    if (Array.isArray(value.sessionIds) && value.sessionIds.length > 0 && value.sessionIds.length <= MAX_TRASH_ENTRIES && value.all === void 0) {
      return { all: false, sessionIds: [...new Set(value.sessionIds.map(checkedId))] };
    }
    throw new TypeError("\u6C38\u4E45\u6E05\u7406\u987B\u9009\u62E9\u4F1A\u8BDD\u6216\u663E\u5F0F\u6E05\u7A7A\u56DE\u6536\u7AD9");
  }
};
const failureList = (value) => {
  if (!Array.isArray(value) || value.some((item) => {
    const failure = record(item);
    return typeof failure.sessionId !== "string" || typeof failure.message !== "string";
  })) throw new TypeError("\u56DE\u6536\u7AD9\u5931\u8D25\u5217\u8868\u65E0\u6548");
  return value;
};
const idList = (value) => {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new TypeError("\u56DE\u6536\u7AD9\u4F1A\u8BDD\u5217\u8868\u65E0\u6548");
  return value;
};
const trashBatchSchema = { parse(input) {
  const value = record(input);
  return {
    requestedSessionIds: idList(value.requestedSessionIds),
    trashedSessionIds: idList(value.trashedSessionIds),
    skippedSessionIds: idList(value.skippedSessionIds),
    failures: failureList(value.failures)
  };
} };
const trashSingleSchema = { parse(input) {
  const value = record(input);
  if (value.trashed !== true) throw new TypeError("\u56DE\u6536\u7AD9\u64CD\u4F5C\u672A\u5B8C\u6210");
  return { trashed: true };
} };
const trashListSchema = { parse(input) {
  const value = record(input);
  if (!Array.isArray(value.items) || value.items.length > MAX_TRASH_ENTRIES) throw new TypeError("\u56DE\u6536\u7AD9\u5217\u8868\u65E0\u6548");
  return { retentionDays: safeInteger(value.retentionDays, "\u56DE\u6536\u7AD9\u4FDD\u7559\u671F"), items: value.items.map((item) => trashEntrySchema.parse(item)) };
} };
const trashRestoreSchema = { parse(input) {
  const value = record(input);
  return { restoredSessionIds: idList(value.restoredSessionIds), skippedSessionIds: idList(value.skippedSessionIds), failures: failureList(value.failures) };
} };
const trashPurgeSchema = { parse(input) {
  const value = record(input);
  return { purgedSessionIds: idList(value.purgedSessionIds), failures: failureList(value.failures) };
} };
function trashInvocations(inputs) {
  const codec = (name, schema) => ({ mode: "strict", typeSymbol: `@michengai/dsh-archive-manager/types#${name}`, create: () => schema, schema });
  const descriptor = (method, parameters, result) => ({
    id: `@michengai/dsh-archive-manager#workspaceRegistry/${method}`,
    service: "workspaceRegistry",
    namespace: "workspaceRegistry",
    method,
    invocation: { kind: "direct" },
    parameters: parameters.map(({ name, schema, type }) => ({ name, wire: name, source: "json", codec: codec(type, schema) })),
    result: codec(result.name, result.schema),
    sourceLocation: { file: "@michengai/dsh-archive-manager/lib/workspace.js", line: 1, column: 1 }
  });
  return [
    descriptor("trashSession", [{ name: "sessionId", schema: inputs.sessionId, type: "SessionId" }], { name: "TrashSingleResult", schema: trashSingleSchema }),
    descriptor("trashArchivedSessions", [{ name: "target", schema: inputs.batchTarget, type: "ArchivedBatchTarget" }], { name: "TrashBatch", schema: trashBatchSchema }),
    descriptor("trashedSessions", [], { name: "TrashList", schema: trashListSchema }),
    descriptor("restoreTrashedSessions", [{ name: "input", schema: trashIdsSchema, type: "TrashSelection" }], { name: "TrashRestoreResult", schema: trashRestoreSchema }),
    descriptor("purgeTrashedSessions", [{ name: "input", schema: purgeTrashSchema, type: "TrashPurgeInput" }], { name: "TrashPurgeResult", schema: trashPurgeSchema })
  ];
}
export {
  MAX_TRASH_ENTRIES,
  checkedId,
  isAbsoluteFilePath,
  purgeTrashSchema,
  searchIndexRecordSchema,
  trashEntrySchema,
  trashIdsSchema,
  trashInvocations
};
