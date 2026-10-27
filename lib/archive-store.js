import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { searchIndexRecordSchema, trashEntrySchema } from "./archive-store-contract.js";
const searchIndexDomainSpec = defineDomain({
  name: "archive_manager_search_index",
  version: 1,
  layout: "per-record",
  invalidRecords: "backup-and-skip",
  tables: { sessions: { valueSchema: searchIndexRecordSchema } }
});
const trashDomainSpec = defineDomain({
  name: "archive_manager_trash",
  version: 1,
  layout: "per-record",
  invalidRecords: "backup-and-skip",
  tables: { entries: { valueSchema: trashEntrySchema } }
});
export * from "./archive-store-contract.js";
export {
  searchIndexDomainSpec,
  trashDomainSpec
};
