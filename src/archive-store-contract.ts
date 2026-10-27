import { record } from "./contracts.js";
import type { Schema } from "./contracts.js";

const MAX_ID = 1024;
const MAX_MESSAGES = 20_000;
const MAX_MESSAGE_TEXT = 2_000_000;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_TRASH_ENTRIES = 100;

function checkedId(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID) throw new TypeError("会话 ID 长度须为 1～1024 个字符");
  return value;
}

function boundedText(value: unknown, max: number, label: string) {
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${label} 无效`);
  return value;
}

function safeInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} 无效`);
  return value;
}

/** Browser and Host share this check without importing node:path into the client bundle. */
export function isAbsoluteFilePath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function utf8Bytes(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export interface SearchIndexMessage { seq: number; role: string; text: string }
export interface SearchIndexRecord {
  sessionId: string;
  fingerprint: string;
  messages: SearchIndexMessage[];
  indexedAt: number;
  bytes: number;
}

export const searchIndexRecordSchema = {
  parse(input: unknown): SearchIndexRecord {
    const value = record(input);
    const sessionId = checkedId(value.sessionId);
    const fingerprint = boundedText(value.fingerprint, 4096, "索引指纹");
    if (!fingerprint.length || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) throw new TypeError("检索索引消息无效");
    let bytes = 0;
    const messages = value.messages.map((item) => {
      const message = record(item);
      const seq = safeInteger(message.seq, "消息序号");
      const role = boundedText(message.role, 32, "消息角色");
      if (role !== "user" && role !== "assistant") throw new TypeError("检索索引仅允许用户和助手消息");
      const text = boundedText(message.text, MAX_MESSAGE_TEXT, "消息正文");
      bytes += utf8Bytes(text);
      if (bytes > MAX_INDEX_BYTES) throw new TypeError("会话检索索引超过 64 MiB，跳过持久缓存");
      return { seq, role, text };
    });
    if (safeInteger(value.bytes, "索引大小") !== bytes) throw new TypeError("索引大小与消息正文不一致");
    return {
      sessionId,
      fingerprint,
      messages,
      indexedAt: safeInteger(value.indexedAt, "索引时间"),
      bytes,
    };
  },
  safeParse(value: unknown) {
    try { return { success: true as const, data: this.parse(value) }; }
    catch (error) { return { success: false as const, error }; }
  },
};

export interface TrashEntry {
  sessionId: string;
  header: Record<string, unknown>;
  title?: string;
  deletedAt: number;
  expiresAt: number;
  sizeBytes: number;
  originalPath: string;
  trashPath: string;
  artifactKind: string;
  workspaceId?: string;
  workspaceIndex?: number;
  wasArchived: boolean;
  wasFavorite: boolean;
  expired?: boolean;
}

export const trashEntrySchema = {
  parse(input: unknown): TrashEntry {
    const value = record(input);
    const sessionId = checkedId(value.sessionId);
    const header = record(value.header);
    if (header.id !== sessionId) throw new TypeError("回收站头部与会话 ID 不一致");
    const artifactKind = boundedText(value.artifactKind, 64, "工件类型");
    if (artifactKind !== "session directory" && artifactKind !== "transcript artifact") throw new TypeError("回收站工件类型无效");
    if (typeof value.wasArchived !== "boolean" || typeof value.wasFavorite !== "boolean") throw new TypeError("回收站状态标记无效");
    if (value.expired !== undefined && typeof value.expired !== "boolean") throw new TypeError("回收站过期标记无效");
    const originalPath = boundedText(value.originalPath, 4096, "原始会话路径");
    const trashPath = boundedText(value.trashPath, 4096, "回收站路径");
    if (!isAbsoluteFilePath(originalPath) || !isAbsoluteFilePath(trashPath)) throw new TypeError("回收站路径必须为绝对路径");
    const workspaceId = value.workspaceId === undefined ? undefined : checkedId(value.workspaceId);
    const workspaceIndex = value.workspaceIndex === undefined ? undefined : safeInteger(value.workspaceIndex, "工作区位置");
    return {
      sessionId,
      header,
      ...(value.title === undefined ? {} : { title: boundedText(value.title, 500, "会话标题") }),
      deletedAt: safeInteger(value.deletedAt, "删除时间"),
      expiresAt: safeInteger(value.expiresAt, "保留截止时间"),
      sizeBytes: safeInteger(value.sizeBytes, "会话大小"),
      originalPath,
      trashPath,
      artifactKind,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(workspaceIndex === undefined ? {} : { workspaceIndex }),
      wasArchived: value.wasArchived,
      wasFavorite: value.wasFavorite,
      ...(value.expired === undefined ? {} : { expired: value.expired }),
    };
  },
  safeParse(value: unknown) {
    try { return { success: true as const, data: this.parse(value) }; }
    catch (error) { return { success: false as const, error }; }
  },
};

export interface TrashBatch {
  requestedSessionIds: string[];
  trashedSessionIds: string[];
  skippedSessionIds: string[];
  failures: { sessionId: string; message: string }[];
}

export interface TrashList {
  retentionDays: number;
  items: TrashEntry[];
}

export interface TrashRestoreResult {
  restoredSessionIds: string[];
  skippedSessionIds: string[];
  failures: { sessionId: string; message: string }[];
}

export interface TrashPurgeResult {
  purgedSessionIds: string[];
  failures: { sessionId: string; message: string }[];
}

export const trashIdsSchema = {
  parse(input: unknown) {
    const value = record(input);
    if (!Array.isArray(value.sessionIds) || value.sessionIds.length === 0 || value.sessionIds.length > MAX_TRASH_ENTRIES) throw new TypeError("每次须选择 1～100 个回收站会话");
    return { sessionIds: [...new Set(value.sessionIds.map(checkedId))] };
  },
};

export const purgeTrashSchema = {
  parse(input: unknown) {
    const value = record(input);
    if (value.all === true && value.sessionIds === undefined) return { all: true as const, sessionIds: [] as string[] };
    if (Array.isArray(value.sessionIds) && value.sessionIds.length > 0 && value.sessionIds.length <= MAX_TRASH_ENTRIES && value.all === undefined) {
      return { all: false as const, sessionIds: [...new Set(value.sessionIds.map(checkedId))] };
    }
    throw new TypeError("永久清理须选择会话或显式清空回收站");
  },
};

const failureList = (value: unknown) => {
  if (!Array.isArray(value) || value.some((item) => {
    const failure = record(item);
    return typeof failure.sessionId !== "string" || typeof failure.message !== "string";
  })) throw new TypeError("回收站失败列表无效");
  return value as { sessionId: string; message: string }[];
};

const idList = (value: unknown) => {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new TypeError("回收站会话列表无效");
  return value as string[];
};

const trashBatchSchema = { parse(input: unknown): TrashBatch {
  const value = record(input);
  return {
    requestedSessionIds: idList(value.requestedSessionIds),
    trashedSessionIds: idList(value.trashedSessionIds),
    skippedSessionIds: idList(value.skippedSessionIds),
    failures: failureList(value.failures),
  };
} };

const trashSingleSchema = { parse(input: unknown) {
  const value = record(input);
  if (value.trashed !== true) throw new TypeError("回收站操作未完成");
  return { trashed: true as const };
} };

const trashListSchema = { parse(input: unknown): TrashList {
  const value = record(input);
  if (!Array.isArray(value.items) || value.items.length > MAX_TRASH_ENTRIES) throw new TypeError("回收站列表无效");
  return { retentionDays: safeInteger(value.retentionDays, "回收站保留期"), items: value.items.map((item) => trashEntrySchema.parse(item)) };
} };

const trashRestoreSchema = { parse(input: unknown): TrashRestoreResult {
  const value = record(input);
  return { restoredSessionIds: idList(value.restoredSessionIds), skippedSessionIds: idList(value.skippedSessionIds), failures: failureList(value.failures) };
} };

const trashPurgeSchema = { parse(input: unknown): TrashPurgeResult {
  const value = record(input);
  return { purgedSessionIds: idList(value.purgedSessionIds), failures: failureList(value.failures) };
} };

export function trashInvocations(inputs: { sessionId: Schema<unknown>; batchTarget: Schema<unknown> }) {
  const codec = (name: string, schema: Schema<unknown>) => ({ mode: "strict", typeSymbol: `@michengai/dsh-archive-manager/types#${name}`, create: () => schema, schema });
  const descriptor = (method: string, parameters: { name: string; schema: Schema<unknown>; type: string }[], result: { name: string; schema: Schema<unknown> }) => ({
    id: `@michengai/dsh-archive-manager#workspaceRegistry/${method}`,
    service: "workspaceRegistry", namespace: "workspaceRegistry", method,
    invocation: { kind: "direct" },
    parameters: parameters.map(({ name, schema, type }) => ({ name, wire: name, source: "json", codec: codec(type, schema) })),
    result: codec(result.name, result.schema),
    sourceLocation: { file: "@michengai/dsh-archive-manager/lib/workspace.js", line: 1, column: 1 },
  });
  return [
    descriptor("trashSession", [{ name: "sessionId", schema: inputs.sessionId, type: "SessionId" }], { name: "TrashSingleResult", schema: trashSingleSchema }),
    descriptor("trashArchivedSessions", [{ name: "target", schema: inputs.batchTarget, type: "ArchivedBatchTarget" }], { name: "TrashBatch", schema: trashBatchSchema }),
    descriptor("trashedSessions", [], { name: "TrashList", schema: trashListSchema }),
    descriptor("restoreTrashedSessions", [{ name: "input", schema: trashIdsSchema, type: "TrashSelection" }], { name: "TrashRestoreResult", schema: trashRestoreSchema }),
    descriptor("purgeTrashedSessions", [{ name: "input", schema: purgeTrashSchema, type: "TrashPurgeInput" }], { name: "TrashPurgeResult", schema: trashPurgeSchema }),
  ];
}

export { checkedId, MAX_TRASH_ENTRIES };
