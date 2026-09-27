import { describe, expect, it } from "vitest";
import { diagnoseRepairBatchInput } from "./inspect-service-order.js";

describe("service-order read-only diagnostic", () => {
  it("identifies an empty repair batch", () => {
    expect(diagnoseRepairBatchInput([])).toEqual({
      reason: "EMPTY_REPAIR_BATCH",
      missing: [],
    });
  });

  it.each([
    ["businessNumber", { device: { name: "Aparat" } }],
    ["device.name", { businessNumber: "24928", device: { name: "" } }],
  ] as const)("identifies missing %s", (missingField, eventSnapshot) => {
    expect(diagnoseRepairBatchInput([{
      sourceRecordId: "recService",
      eventSnapshot,
    }])).toEqual({
      reason: null,
      missing: [{ sourceRecordId: "recService", missingField }],
    });
  });
});
