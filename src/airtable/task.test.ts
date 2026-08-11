import { describe, expect, it } from "vitest";
import { TASK_FIELDS } from "./field-ids.js";
import { mapTask } from "./task.js";
import type { AirtableRecord } from "./types.js";

describe("task contract mapper", () => {
  it("keeps every selected contact as a linked record ID array", () => {
    const mapped = mapTask(record({
      [TASK_FIELDS.selectedContactLinks]: [
        "recContactA",
        "recContactB",
        "recContactA",
      ],
      [TASK_FIELDS.selectedContactEmailLookup]: [
        "first@example.com",
        "second@example.com",
      ],
    }));

    expect(mapped.selectedContactRecordIds).toEqual([
      "recContactA",
      "recContactB",
    ]);
    expect(mapped.selectedContactEmailLookup).toBe(
      "first@example.com, second@example.com",
    );
  });
});

function record(fields: Record<string, unknown>): AirtableRecord {
  return {
    id: "recTask",
    createdTime: "2026-08-11T08:00:00.000Z",
    fields,
  };
}
