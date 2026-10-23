import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath =
  "prisma/migrations/20261022090000_add_case_assets/migration.sql";

function migrationSql(): string {
  return readFileSync(migrationPath, "utf8");
}

describe("case assets migration safety", () => {
  it("is atomic, bounded by a lock timeout, and remains additive", () => {
    const sql = migrationSql();

    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|INDEX|COLUMN|TYPE)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+"(?!CaseAsset")/i);
    expect(sql).not.toMatch(/UPDATE\s+"(?:StoredFile|CommunicationAsset)"/i);
  });

  it("validates the complete existing StoredFile index before schema changes", () => {
    const sql = migrationSql();
    const validationAt = sql.indexOf("pg_get_indexdef(index_relation.indexrelid)");
    const tableAt = sql.indexOf('CREATE TABLE "CaseAsset"');

    expect(validationAt).toBeGreaterThan(0);
    expect(validationAt).toBeLessThan(tableAt);
    expect(sql).toContain("index_relation.indisunique");
    expect(sql).toContain("index_relation.indisvalid");
    expect(sql).toContain("index_relation.indisready");
    expect(sql).toContain("has an unexpected definition");
    expect(sql).toContain("do not mark the migration as applied");
    expect(sql).not.toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "StoredFile_sourceProvider_sourceAttachmentId_key"',
    );
  });

  it("uses Prisma-compatible PostgreSQL index names", () => {
    const sql = migrationSql();
    const expectedNames = [
      "CaseAsset_sourceEntityType_sourceRecordId_sourceFieldId_sto_key",
      "CaseAsset_sourceHospitalRecordId_sourceEntityType_sourceRec_idx",
      "CaseAsset_storedFileId_active_idx",
    ];

    for (const name of expectedNames) {
      expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(63);
      expect(sql).toContain(`INDEX "${name}"`);
    }
    expect(sql).not.toContain(
      "CaseAsset_sourceEntityType_sourceRecordId_sourceFieldId_storedFileId_key",
    );
    expect(sql).not.toContain(
      "CaseAsset_sourceHospitalRecordId_sourceEntityType_sourceRecordId_active_idx",
    );
  });

  it("preserves the complete deterministic CommunicationAsset backfill", () => {
    const sql = migrationSql();

    expect(sql.match(/FROM "CommunicationAsset" communication_asset/g)).toHaveLength(2);
    expect(sql.match(/JOIN "StoredFile" stored_file/g)).toHaveLength(3);
    expect(sql).toContain("SELECT DISTINCT ON");
    expect(sql).toContain("communication_asset.\"createdAt\" ASC, communication_asset.id ASC");
    expect(sql).toContain("CommunicationAsset to CaseAsset backfill failed its postcondition");
    expect(sql).toContain("actual_count <> expected_count OR mismatch_count <> 0");
  });

  it("tests indexes, the restrictive foreign key, and hospital scope in SQL", () => {
    const sql = migrationSql();

    expect(sql.match(/failed its postcondition/g)?.length).toBeGreaterThanOrEqual(5);
    expect(sql).toContain("constraint_definition.confdeltype = 'r'");
    expect(sql).toContain("constraint_definition.confupdtype = 'c'");
    expect(sql).toContain(
      'case_asset."sourceHospitalRecordId" IS DISTINCT FROM stored_file."sourceHospitalRecordId"',
    );
  });

  it("does not mask conflicting partial CaseAsset schema", () => {
    const sql = migrationSql();

    expect(sql).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"CaseAsset"/i);
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"CaseAsset_/i);
  });
});
