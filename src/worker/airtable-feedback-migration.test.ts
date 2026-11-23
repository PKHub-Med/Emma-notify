import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "prisma/migrations/20261123230000_add_airtable_feedback/migration.sql";

describe("Airtable feedback migration safety", () => {
  it("is additive and does not touch communication tables", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain('CREATE TABLE "AirtableFeedbackRecord"');
    expect(sql).toContain('CREATE TABLE "AirtableFeedbackState"');
    expect(sql).toContain('"AirtableFeedbackRecord_tableId_recordId_key"');
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/INSERT\s+INTO|UPDATE\s+"/i);
  });
});
