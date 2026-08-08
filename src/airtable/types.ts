export type AirtableRecord = {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
};

export type AirtablePage = {
  records: AirtableRecord[];
  offset?: string;
};

export type AirtableRecordSource = {
  fetchAllRecords(tableId: string, fieldIds: readonly string[]): Promise<AirtableRecord[]>;
};
