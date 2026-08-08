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

  it("uses GET-only requests with filterByFormula and record IDs", async () => {
    const fetchFunction = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ records: [] }))
      .mockResolvedValueOnce(response(airtableRecord("recContact")));
    const client = new AirtableClient({
      baseId: "appBase",
      personalAccessToken: "secret-token",
      fetchFunction,
    });

    await client.fetchAllRecords("tblCases", ["fldStatus"], {
      filterByFormula: "IS_AFTER({fldModified}, '2026-08-08T10:00:00.000Z')",
    });
    await client.fetchRecord("tblContacts", "recContact", ["fldEmail"]);

    const listUrl = String(fetchFunction.mock.calls[0]?.[0]);
    const recordUrl = String(fetchFunction.mock.calls[1]?.[0]);
    expect(listUrl).toContain("filterByFormula=");
    expect(recordUrl).toContain("tblContacts/recContact");
    expect(recordUrl).toContain("returnFieldsByFieldId=true");
    expect(recordUrl).not.toContain("fields%5B%5D");
    expect(fetchFunction.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetchFunction.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
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
