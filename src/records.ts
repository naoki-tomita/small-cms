import { jsonParam, type Sql } from "./db.ts";
import { NotFoundError } from "./errors.ts";
import type { Resource } from "./resources.ts";
import { validateRecord } from "./schema.ts";

/** A record as returned by the API: server-managed keys first, then the resource's own fields. */
export type RecordItem = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

interface RecordRow {
  id: string;
  data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ListOptions {
  limit: number;
  offset: number;
  order: "asc" | "desc";
}

export interface ListResult {
  items: RecordItem[];
  total: number;
  limit: number;
  offset: number;
}

function toRecord(row: RecordRow, resource: Resource): RecordItem {
  // jsonb does not keep the key order a record was written with, so it is restored from the
  // schema. Keys left over from an older schema are kept, after the declared ones: a record is
  // always returned exactly as it was stored, never trimmed to the current schema.
  const data: Record<string, unknown> = {};
  for (const fieldName of Object.keys(resource.fields)) {
    if (fieldName in row.data) data[fieldName] = row.data[fieldName];
  }
  for (const [key, value] of Object.entries(row.data)) {
    if (!(key in data)) data[key] = value;
  }

  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...data,
  };
}

export async function listRecords(
  sql: Sql,
  resource: Resource,
  options: ListOptions,
): Promise<ListResult> {
  const { limit, offset, order } = options;

  // The sort direction cannot be a bind parameter, so each direction is its own literal query
  // rather than a string built at runtime.
  const rows = order === "asc"
    ? await sql<RecordRow[]>`
      SELECT id, data, created_at, updated_at FROM records
       WHERE resource = ${resource.name}
       ORDER BY created_at ASC, id ASC
       LIMIT ${limit} OFFSET ${offset}
    `
    : await sql<RecordRow[]>`
      SELECT id, data, created_at, updated_at FROM records
       WHERE resource = ${resource.name}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}
    `;

  const counted = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total FROM records WHERE resource = ${resource.name}
  `;

  return {
    items: rows.map((row) => toRecord(row, resource)),
    total: counted[0]?.total ?? 0,
    limit,
    offset,
  };
}

export async function getRecord(sql: Sql, resource: Resource, id: string): Promise<RecordItem> {
  const rows = await sql<RecordRow[]>`
    SELECT id, data, created_at, updated_at FROM records
     WHERE resource = ${resource.name} AND id = ${id}
  `;

  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`No ${resource.name} with id "${id}"`);
  }
  return toRecord(row, resource);
}

export async function createRecord(
  sql: Sql,
  resource: Resource,
  body: unknown,
): Promise<RecordItem> {
  const data = validateRecord(resource.fields, body);
  const id = crypto.randomUUID();

  const rows = await sql<RecordRow[]>`
    INSERT INTO records (resource, id, data)
    VALUES (${resource.name}, ${id}, ${jsonParam(sql, data)})
    RETURNING id, data, created_at, updated_at
  `;

  return toRecord(rows[0]!, resource);
}

/** `PUT`: the body replaces the record's data outright, defaults and all. */
export async function replaceRecord(
  sql: Sql,
  resource: Resource,
  id: string,
  body: unknown,
): Promise<RecordItem> {
  const data = validateRecord(resource.fields, body);
  return await writeRecord(sql, resource, id, data);
}

/** `PATCH`: the body is merged onto the stored data, and the merged result is validated. */
export async function patchRecord(
  sql: Sql,
  resource: Resource,
  id: string,
  body: unknown,
): Promise<RecordItem> {
  const patch = validateRecord(resource.fields, body, { partial: true });
  const current = await getRecord(sql, resource, id);
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...currentData } = current;

  return await writeRecord(sql, resource, id, { ...currentData, ...patch });
}

async function writeRecord(
  sql: Sql,
  resource: Resource,
  id: string,
  data: Record<string, unknown>,
): Promise<RecordItem> {
  const rows = await sql<RecordRow[]>`
    UPDATE records
       SET data = ${jsonParam(sql, data)}, updated_at = now()
     WHERE resource = ${resource.name} AND id = ${id}
    RETURNING id, data, created_at, updated_at
  `;

  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`No ${resource.name} with id "${id}"`);
  }
  return toRecord(row, resource);
}

export async function deleteRecord(sql: Sql, resource: Resource, id: string): Promise<void> {
  const rows = await sql`
    DELETE FROM records WHERE resource = ${resource.name} AND id = ${id} RETURNING id
  `;
  if (rows.length === 0) {
    throw new NotFoundError(`No ${resource.name} with id "${id}"`);
  }
}
