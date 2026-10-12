import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath =
  "prisma/migrations/20261012130000_add_communication_diagnostics/migration.sql";

describe("communication diagnostics migration safety", () => {
  it("is additive for the previous application version", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain(
      'ALTER TABLE "CommunicationCursor" ADD COLUMN "lastEventRevision" INTEGER;',
    );
    expect(sql).toContain(
      'ALTER TABLE "CommunicationCursor" ADD COLUMN "pendingEventRevision" INTEGER;',
    );
    expect(sql).not.toMatch(/ADD COLUMN "(?:lastEventRevision|pendingEventRevision)" INTEGER NOT NULL/);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN/i);
  });

  it("initializes only emitted revisions and never creates historical events", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain('SET "lastEventRevision" = emitted.revision');
    expect(sql).toContain("communicationRevision");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"CommunicationEvent"/i);
    expect(sql).not.toMatch(/UPDATE\s+"CommunicationEvent"/i);
    expect(sql).not.toMatch(/SET\s+"pendingEventRevision"/i);
  });

  it("keeps database uniqueness barriers for parallel workers", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const eventSource = readFileSync("src/worker/communication-event.ts", "utf8");
    const deliverySource = readFileSync("src/worker/communication-delivery.ts", "utf8");

    expect(schema).toContain("@@unique([sourceEntityType, sourceRecordId])");
    expect(schema).toContain("fingerprint      String                        @unique");
    expect(schema).toContain("logicalDigestKey              String?                             @unique");
    expect(schema).toContain("communicationEventRecipientId String                              @unique");
    expect(eventSource).toContain("Prisma.TransactionIsolationLevel.Serializable");
    expect(deliverySource).toContain("Prisma.TransactionIsolationLevel.Serializable");
  });
});
