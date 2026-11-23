import { describe, expect, it, vi } from "vitest";
import { AirtableWriteError, AirtableWriter } from "./writer.js";

describe("AirtableWriter", () => {
  it("PATCHes only the passed fields with field IDs and its own token", async () => {
    const fetchFunction = vi.fn<typeof fetch>().mockResolvedValueOnce(ok());
    const writer = new AirtableWriter({
      baseId: "appBase",
      personalAccessToken: "write-token",
      fetchFunction,
    });

    await writer.updateRecords("tblOrders", [
      { id: "recOne", fields: { fldStatus: "Wysłany", fldReason: null } },
    ]);

    expect(fetchFunction).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFunction.mock.calls[0]!;
    expect(String(url)).toBe("https://api.airtable.com/v0/appBase/tblOrders");
    expect(init).toMatchObject({ method: "PATCH" });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer write-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      records: [{ id: "recOne", fields: { fldStatus: "Wysłany", fldReason: null } }],
      returnFieldsByFieldId: true,
    });
  });

  it("retries rate limits and rejects batches larger than Airtable allows", async () => {
    const fetchFunction = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => undefined);
    const writer = new AirtableWriter({
      baseId: "appBase", personalAccessToken: "token", fetchFunction, sleep,
    });

    await writer.updateRecords("tbl", [{ id: "rec1", fields: { fld: "x" } }]);
    expect(fetchFunction).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);

    await expect(writer.updateRecords("tbl", Array.from({ length: 11 }, (_, index) => ({
      id: `rec${index}`, fields: { fld: "x" },
    })))).rejects.toThrow(/at most 10/);
  });

  it("does not retry permanent errors and reports a safe error type", async () => {
    const fetchFunction = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { type: "ROW_DOES_NOT_EXIST", message: "Record rec1 not found" } }),
      { status: 422, headers: { "content-type": "application/json" } },
    ));
    const writer = new AirtableWriter({
      baseId: "appBase", personalAccessToken: "token", fetchFunction,
    });

    const error = await writer.updateRecords("tbl", [{ id: "rec1", fields: { fld: "x" } }])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AirtableWriteError);
    expect(error).toMatchObject({
      code: "AIRTABLE_WRITE_HTTP_422",
      airtableErrorType: "ROW_DOES_NOT_EXIST",
    });
    expect(fetchFunction).toHaveBeenCalledTimes(1);
  });
});

function ok(): Response {
  return new Response(JSON.stringify({ records: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
