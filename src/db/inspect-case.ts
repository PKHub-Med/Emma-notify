import "dotenv/config";
import { AirtableClient } from "../airtable/client.js";
import {
  AIRTABLE_TABLE_IDS,
  CONTACT_FIELD_IDS,
  INSPECTION_FIELDS,
} from "../airtable/field-ids.js";
import { mapContact, resolveRecipient } from "../airtable/recipient.js";
import { toLinkedRecordIds } from "../airtable/values.js";
import { loadWorkerConfig } from "../config/worker.js";
import { createPrismaClient } from "./prisma.js";
import { CaseType } from "../generated/prisma/enums.js";

const businessNumber = process.argv[2]?.trim() ?? "";
if (!businessNumber) {
  console.error("Usage: npm run db:inspect-case -- <businessNumber>");
  process.exit(1);
}

const config = loadWorkerConfig(process.env);
const prisma = createPrismaClient(config.databaseUrl);
const airtable = new AirtableClient({
  baseId: config.airtableBaseId,
  personalAccessToken: config.airtablePat,
});
let diagnosticStage: "database" | "airtable" = "database";

async function main(): Promise<void> {
  const cases = await prisma.trackedCase.findMany({
    where: { caseType: CaseType.INSPECTION, businessNumber },
    orderBy: { airtableRecordId: "asc" },
    select: {
      airtableRecordId: true,
      currentStatus: true,
      recipients: {
        orderBy: { airtableContactRecordId: "asc" },
        select: {
          airtableContactRecordId: true,
          eligible: true,
          eligibilityReason: true,
          email: true,
          normalizedEmail: true,
        },
      },
      events: {
        orderBy: { detectedAt: "asc" },
        select: {
          eventType: true,
          triggersNotification: true,
          detectedAt: true,
          sourceModifiedAt: true,
        },
      },
      bufferItems: {
        orderBy: { createdAt: "asc" },
        select: {
          bufferId: true,
          firstEventAt: true,
          lastEventAt: true,
          buffer: { select: { status: true } },
        },
      },
    },
  });

  diagnosticStage = "airtable";
  const report = [];
  for (const trackedCase of cases) {
    const airtableInspection = await airtable.fetchRecord(
      AIRTABLE_TABLE_IDS.inspections,
      trackedCase.airtableRecordId,
      [INSPECTION_FIELDS.contactLinks],
    );
    const linkedContactIds = toLinkedRecordIds(
      airtableInspection.fields[INSPECTION_FIELDS.contactLinks],
    );
    const currentContacts = [];
    for (const contactRecordId of linkedContactIds) {
      const contactRecord = await airtable.fetchRecord(
        AIRTABLE_TABLE_IDS.contacts,
        contactRecordId,
        CONTACT_FIELD_IDS,
      );
      const resolved = resolveRecipient(contactRecordId, mapContact(contactRecord));
      currentContacts.push({
        airtableContactRecordId: contactRecordId,
        eligible: resolved.eligible,
        eligibilityReason: resolved.eligibilityReason,
        hasEmail: resolved.email !== null,
        hasNormalizedEmail: resolved.normalizedEmail !== null,
      });
    }

    report.push({
      airtableRecordId: trackedCase.airtableRecordId,
      currentStatus: trackedCase.currentStatus,
      recipientCount: trackedCase.recipients.length,
      eligibleRecipientCount: trackedCase.recipients.filter(
        (recipient) => recipient.eligible,
      ).length,
      databaseRecipients: trackedCase.recipients.map((recipient) => ({
        airtableContactRecordId: recipient.airtableContactRecordId,
        eligible: recipient.eligible,
        eligibilityReason: recipient.eligibilityReason,
        hasEmail: recipient.email !== null,
        hasNormalizedEmail: recipient.normalizedEmail !== null,
      })),
      airtableLinkedContacts: currentContacts,
      events: trackedCase.events,
      bufferCount: new Set(
        trackedCase.bufferItems.map((item) => item.bufferId),
      ).size,
      bufferItems: trackedCase.bufferItems.map((item) => ({
        bufferId: item.bufferId,
        status: item.buffer.status,
        firstEventAt: item.firstEventAt,
        lastEventAt: item.lastEventAt,
      })),
    });
  }

  console.info(JSON.stringify({ businessNumber, cases: report }, null, 2));
}

main()
  .catch(() => {
    console.error(`Case inspection failed stage=${diagnosticStage}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
