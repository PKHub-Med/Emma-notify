export type AirtableRecord = {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
};

export type AirtablePage = {
  records: AirtableRecord[];
  offset?: string;
};

export type AirtableListOptions = {
  filterByFormula?: string;
};

export type AirtableRecordSource = {
  fetchAllRecords(
    tableId: string,
    fieldIds: readonly string[],
    options?: AirtableListOptions,
  ): Promise<AirtableRecord[]>;
};

export type AirtableIncrementalSource = AirtableRecordSource & {
  fetchRecord(
    tableId: string,
    recordId: string,
    fieldIds: readonly string[],
  ): Promise<AirtableRecord>;
};

export type AirtableRequestMetrics = {
  requestsMade: number;
  pagesFetched: number;
};

export type AirtableMetricsSource = {
  getRequestMetrics(): AirtableRequestMetrics;
};
