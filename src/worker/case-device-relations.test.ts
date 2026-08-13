import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../generated/prisma/client.js";
import { CaseType } from "../generated/prisma/enums.js";
import { synchronizeCaseDeviceRelations } from "./baseline-store.js";

describe("TrackedCaseDevice synchronization", () => {
  it("stores a 3-device inspection idempotently and replaces stale links", async () => {
    const harness = relationHarness(new Map([
      ["recA", "hospital-A"], ["recB", "hospital-A"],
      ["recC", "hospital-A"], ["recD", "hospital-A"],
    ]));
    await sync(harness.transaction, ["recA", "recB", "recC"]);
    await sync(harness.transaction, ["recA", "recB", "recC"]);
    expect([...harness.links].sort()).toEqual(["recA", "recB", "recC"]);
    expect(harness.hospital).toBe("hospital-A");

    await sync(harness.transaction, ["recB", "recD"]);
    expect([...harness.links].sort()).toEqual(["recB", "recD"]);
    expect(harness.hospital).toBe("hospital-A");
  });

  it("fails closed and emits a structured warning for mixed hospitals", async () => {
    const log = vi.fn();
    const harness = relationHarness(new Map([
      ["recA", "hospital-A"], ["recB", "hospital-B"], ["recC", "hospital-B"],
    ]));
    await synchronizeCaseDeviceRelations(harness.transaction, {
      trackedCaseId: "case-1", caseType: CaseType.INSPECTION,
      sourceRecordId: "recInspection", directHospitalRecordId: null,
      deviceAirtableIds: ["recA", "recB", "recC"], log,
    });
    expect(harness.hospital).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "CASE_DEVICE_HOSPITAL_SCOPE_AMBIGUOUS",
    ));
    expect(log.mock.calls[0]![0]).toContain("uniqueHospitals=2");
  });
});

async function sync(transaction: Prisma.TransactionClient, ids: string[]) {
  return synchronizeCaseDeviceRelations(transaction, {
    trackedCaseId: "case-1", caseType: CaseType.INSPECTION,
    sourceRecordId: "recInspection", directHospitalRecordId: null,
    deviceAirtableIds: ids,
  });
}

function relationHarness(deviceHospitals: Map<string, string | null>) {
  const links = new Set<string>();
  const state = { hospital: null as string | null };
  const transaction = {
    trackedCaseDevice: {
      deleteMany: async ({ where }: { where: { deviceAirtableId?: { notIn: string[] } } }) => {
        const keep = where.deviceAirtableId?.notIn ?? [];
        for (const id of [...links]) if (!keep.includes(id)) links.delete(id);
        return { count: 0 };
      },
      createMany: async ({ data }: { data: Array<{ deviceAirtableId: string }> }) => {
        for (const item of data) links.add(item.deviceAirtableId);
        return { count: data.length };
      },
    },
    trackedDevice: {
      findMany: async ({ where }: { where: { airtableRecordId: { in: string[] } } }) =>
        where.airtableRecordId.in.flatMap((id) => deviceHospitals.has(id)
          ? [{ airtableRecordId: id, sourceHospitalRecordId: deviceHospitals.get(id) ?? null }]
          : []),
    },
    trackedCase: {
      update: async ({ data }: { data: { sourceHospitalRecordId: string | null } }) => {
        state.hospital = data.sourceHospitalRecordId;
        return { id: "case-1" };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return {
    transaction, links,
    get hospital() { return state.hospital; },
  };
}
