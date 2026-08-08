import type {
  AirtablePage,
  AirtableRecord,
  AirtableListOptions,
  AirtableIncrementalSource,
  AirtableRecordSource,
} from "./types.js";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

type FetchFunction = typeof fetch;

export type AirtableClientOptions = {
  baseId: string;
  personalAccessToken: string;
  fetchFunction?: FetchFunction;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class AirtableClient implements AirtableRecordSource, AirtableIncrementalSource {
  private readonly baseId: string;
  private readonly personalAccessToken: string;
  private readonly fetchFunction: FetchFunction;
  private readonly timeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: AirtableClientOptions) {
    this.baseId = options.baseId;
    this.personalAccessToken = options.personalAccessToken;
    this.fetchFunction = options.fetchFunction ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async fetchAllRecords(
    tableId: string,
    fieldIds: readonly string[],
    options: AirtableListOptions = {},
  ): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = [];
    let offset: string | undefined;

    do {
      const page = await this.fetchPage(tableId, fieldIds, options, offset);
      records.push(...page.records);
      offset = page.offset;
    } while (offset);

    return records;
  }

  async fetchRecord(
    tableId: string,
    recordId: string,
    fieldIds: readonly string[],
  ): Promise<AirtableRecord> {
    const url = new URL(
      `https://api.airtable.com/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`,
    );
    url.searchParams.set("returnFieldsByFieldId", "true");
    for (const fieldId of fieldIds) url.searchParams.append("fields[]", fieldId);
    return this.parseRecord(await this.requestJson(url, tableId), tableId);
  }

  private async fetchPage(
    tableId: string,
    fieldIds: readonly string[],
    options: AirtableListOptions,
    offset?: string,
  ): Promise<AirtablePage> {
    const url = new URL(
      `https://api.airtable.com/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(tableId)}`,
    );
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    for (const fieldId of fieldIds) url.searchParams.append("fields[]", fieldId);
    if (options.filterByFormula) {
      url.searchParams.set("filterByFormula", options.filterByFormula);
    }
    if (offset) url.searchParams.set("offset", offset);

    return this.parsePage(await this.requestJson(url, tableId), tableId);
  }

  private async requestJson(url: URL, tableId: string): Promise<unknown> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        response = await this.fetchFunction(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.personalAccessToken}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error: unknown) {
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`Airtable request failed for table ${tableId}`, {
            cause: error,
          });
        }
        await this.sleep(this.backoffMilliseconds(attempt));
        continue;
      }

      if (response.ok) {
        return response.json();
      }

      if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(
          `Airtable request failed for table ${tableId} with status ${response.status}`,
        );
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : this.backoffMilliseconds(attempt);
      await this.sleep(delay);
    }

    throw new Error(`Airtable request failed for table ${tableId}`);
  }

  private parsePage(value: unknown, tableId: string): AirtablePage {
    if (!isObject(value) || !Array.isArray(value.records)) {
      throw new Error(`Airtable returned an invalid response for table ${tableId}`);
    }

    const records = value.records.map((record) => this.parseRecord(record, tableId));
    const offset = typeof value.offset === "string" ? value.offset : undefined;
    return offset ? { records, offset } : { records };
  }

  private parseRecord(value: unknown, tableId: string): AirtableRecord {
    if (
      !isObject(value) ||
      typeof value.id !== "string" ||
      typeof value.createdTime !== "string" ||
      !isObject(value.fields)
    ) {
      throw new Error(`Airtable returned an invalid record for table ${tableId}`);
    }

    return {
      id: value.id,
      createdTime: value.createdTime,
      fields: value.fields,
    };
  }

  private backoffMilliseconds(attempt: number): number {
    return 500 * 2 ** (attempt - 1);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
