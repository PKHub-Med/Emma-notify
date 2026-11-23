/**
 * Minimal Airtable writer used only for Emma communication write-back.
 *
 * It is intentionally separate from AirtableClient: synchronization keeps its
 * read-only token and GET-only client, while this writer uses its own token
 * (AIRTABLE_WRITE_PAT) and can only PATCH explicitly passed fields.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
export const AIRTABLE_MAX_RECORDS_PER_WRITE = 10;

type FetchFunction = typeof fetch;

export type AirtableRecordUpdate = {
  id: string;
  fields: Record<string, string | null>;
};

export interface AirtableRecordWriter {
  updateRecords(tableId: string, records: readonly AirtableRecordUpdate[]): Promise<void>;
}

export class AirtableWriteError extends Error {
  readonly code: string;

  constructor(
    message: string,
    readonly tableId: string,
    readonly httpStatus?: number,
    readonly airtableErrorType?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AirtableWriteError";
    this.code = httpStatus ? `AIRTABLE_WRITE_HTTP_${httpStatus}` : "AIRTABLE_WRITE_FAILED";
  }
}

export type AirtableWriterOptions = {
  baseId: string;
  personalAccessToken: string;
  fetchFunction?: FetchFunction;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class AirtableWriter implements AirtableRecordWriter {
  private readonly fetchFunction: FetchFunction;
  private readonly timeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: AirtableWriterOptions) {
    this.fetchFunction = options.fetchFunction ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async updateRecords(tableId: string, records: readonly AirtableRecordUpdate[]): Promise<void> {
    if (records.length === 0) return;
    if (records.length > AIRTABLE_MAX_RECORDS_PER_WRITE) {
      throw new Error(`Airtable accepts at most ${AIRTABLE_MAX_RECORDS_PER_WRITE} records per write`);
    }
    const url = new URL(
      `https://api.airtable.com/v0/${encodeURIComponent(this.options.baseId)}/${encodeURIComponent(tableId)}`,
    );
    const body = JSON.stringify({
      records: records.map((record) => ({ id: record.id, fields: record.fields })),
      returnFieldsByFieldId: true,
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchFunction(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${this.options.personalAccessToken}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error: unknown) {
        if (attempt === MAX_ATTEMPTS) {
          throw new AirtableWriteError(
            `Airtable write failed for table ${tableId}`, tableId, undefined, undefined,
            { cause: error },
          );
        }
        await this.sleep(backoffMilliseconds(attempt));
        continue;
      }

      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
        throw new AirtableWriteError(
          `Airtable write failed for table ${tableId} with status ${response.status}`,
          tableId,
          response.status,
          await readErrorType(response),
        );
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : backoffMilliseconds(attempt));
    }
  }
}

function backoffMilliseconds(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

async function readErrorType(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return undefined;
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error.slice(0, 100);
    if (typeof error === "object" && error !== null) {
      const type = (error as { type?: unknown }).type;
      return typeof type === "string" ? type.slice(0, 100) : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
