import { describe, expect, it, vi } from "vitest";
import { AirtableClient } from "./client.js";

describe("AirtableClient", () => {
  it("retries 429 and follows pagination using field IDs", async () => {
    const fetchFunction = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(response({
        records: [airtableRecord("recOne")],
        offset: "next-page",
      }))
      .mockResolvedValueOnce(response({ records: [airtableRecord("recTwo")] }));
    const sleep = vi.fn(async () => undefined);
    const client = new AirtableClient({
      baseId: "appBase",
      personalAccessToken: "secret-token",
      fetchFunction,
      sleep,
    });

    const records = await client.fetchAllRecords("tblTable", ["fldOne"]);

    expect(records.map((record) => record.id)).toEqual(["recOne", "recTwo"]);
    expect(fetchFunction).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    const finalUrl = String(fetchFunction.mock.calls[2]?.[0]);
    expect(finalUrl).toContain("pageSize=100");
    expect(finalUrl).toContain("returnFieldsByFieldId=true");
    expect(finalUrl).toContain("fields%5B%5D=fldOne");
    expect(finalUrl).toContain("offset=next-page");
  });
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function airtableRecord(id: string): object {
  return { id, createdTime: "2026-08-01T08:00:00.000Z", fields: {} };
}
