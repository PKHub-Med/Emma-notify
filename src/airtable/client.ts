import type {
  AirtablePage,
  AirtableRecord,
  AirtableListOptions,
  AirtableIncrementalSource,
  AirtableRecordSource,
  AirtableRequestMetrics,
  AirtableMetricsSource,
} from "./types.js";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

type FetchFunction = typeof fetch;
export type AirtableRequestType = "LIST" | "RECORD";

export class AirtableRequestError extends Error {
  readonly code: string;

  constructor(
    message: string,
    readonly tableId: string,
    readonly requestType: AirtableRequestType,
    readonly httpStatus?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AirtableRequestError";
    this.code = httpStatus ? `AIRTABLE_HTTP_${httpStatus}` : "AIRTABLE_REQUEST_FAILED";
  }
}

export type AirtableClientOptions = {
  baseId: string;
  personalAccessToken: string;
  fetchFunction?: FetchFunction;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class AirtableClient implements AirtableRecordSource, AirtableIncrementalSource, AirtableMetricsSource {
  private readonly baseId: string;
  private readonly personalAccessToken: string;
  private readonly fetchFunction: FetchFunction;
  private readonly timeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private requestsMade = 0;
  private pagesFetched = 0;

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
    return (await this.fetchAllRecordsWithMetrics(tableId, fieldIds, options)).records;
  }

  async fetchAllRecordsWithMetrics(
    tableId: string,
    fieldIds: readonly string[],
    options: AirtableListOptions = {},
  ): Promise<{ records: AirtableRecord[]; metrics: AirtableRequestMetrics }> {
    const records: AirtableRecord[] = [];
    const metrics = { requestsMade: 0, pagesFetched: 0 };
    let offset: string | undefined;

    do {
      const page = await this.fetchPage(tableId, fieldIds, options, offset, metrics);
      records.push(...page.records);
      offset = page.offset;
    } while (offset);

    return { records, metrics };
  }

  async fetchRecord(
    tableId: string,
    recordId: string,
    fieldIds: readonly string[],
  ): Promise<AirtableRecord> {
    // Airtable's retrieve-record endpoint rejects fields[] with HTTP 422. Use
    // the list endpoint with RECORD_ID() so the response remains field-limited.
    const url = new URL(
      `https://api.airtable.com/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(tableId)}`,
    );
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("returnFieldsByFieldId", "true");
    for (const fieldId of fieldIds) url.searchParams.append("fields[]", fieldId);
    url.searchParams.set(
      "filterByFormula",
      `RECORD_ID() = '${escapeFormulaString(recordId)}'`,
    );
    const page = this.parsePage(
      await this.requestJson(url, tableId, "RECORD"),
      tableId,
    );
    this.pagesFetched += 1;
    const record = page.records[0];
    if (!record) {
      throw new AirtableRequestError(
        `Airtable record was not found in table ${tableId}`,
        tableId,
        "RECORD",
        404,
      );
    }
    return record;
  }

  getRequestMetrics(): AirtableRequestMetrics {
    return { requestsMade: this.requestsMade, pagesFetched: this.pagesFetched };
  }

  private async fetchPage(
    tableId: string,
    fieldIds: readonly string[],
    options: AirtableListOptions,
    offset?: string,
    operationMetrics?: AirtableRequestMetrics,
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

    const page = this.parsePage(
      await this.requestJson(url, tableId, "LIST", operationMetrics),
      tableId,
    );
    this.pagesFetched += 1;
    if (operationMetrics) operationMetrics.pagesFetched += 1;
    return page;
  }

  private async requestJson(
    url: URL,
    tableId: string,
    requestType: AirtableRequestType,
    operationMetrics?: AirtableRequestMetrics,
  ): Promise<unknown> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;

      try {
        this.requestsMade += 1;
        if (operationMetrics) operationMetrics.requestsMade += 1;
        response = await this.fetchFunction(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.personalAccessToken}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error: unknown) {
        if (attempt === MAX_ATTEMPTS) {
          throw new AirtableRequestError(
            `Airtable ${requestType.toLowerCase()} request failed for table ${tableId}`,
            tableId,
            requestType,
            undefined,
            { cause: error },
          );
        }
        await this.sleep(this.backoffMilliseconds(attempt));
        continue;
      }

      if (response.ok) {
        return response.json();
      }

      if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
        throw new AirtableRequestError(
          `Airtable ${requestType.toLowerCase()} request failed for table ${tableId} with status ${response.status}`,
          tableId,
          requestType,
          response.status,
        );
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : this.backoffMilliseconds(attempt);
      await this.sleep(delay);
    }

    throw new AirtableRequestError(
      `Airtable ${requestType.toLowerCase()} request failed for table ${tableId}`,
      tableId,
      requestType,
    );
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

function escapeFormulaString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
