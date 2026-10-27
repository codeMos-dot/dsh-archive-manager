import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { searchIndexRecordSchema, trashEntrySchema } from "./archive-store-contract.js";

/** Disposable, fingerprinted full-text records. Corruption is backed up and skipped. */
export const searchIndexDomainSpec = defineDomain({
  name: "archive_manager_search_index",
  version: 1,
  layout: "per-record",
  invalidRecords: "backup-and-skip",
  tables: { sessions: { valueSchema: searchIndexRecordSchema as never } },
});

/** Authoritative soft-delete metadata. The moved artifact remains outside the domain. */
export const trashDomainSpec = defineDomain({
  name: "archive_manager_trash",
  version: 1,
  layout: "per-record",
  invalidRecords: "backup-and-skip",
  tables: { entries: { valueSchema: trashEntrySchema as never } },
});

export * from "./archive-store-contract.js";
