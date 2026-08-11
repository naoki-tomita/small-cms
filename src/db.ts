import postgres from "postgres";

export type Sql = postgres.Sql<Record<string, never>>;

let instance: Sql | undefined;

/**
 * Lazily opens the connection pool from `DATABASE_URL`.
 *
 * On Deno Deploy a provisioned Postgres injects `DATABASE_URL` (alongside `PGHOST`, `PGUSER`,
 * ...) for every environment, so production, previews and branch deployments each get their own
 * isolated database without any code change.
 */
export function getSql(): Sql {
  if (instance) return instance;

  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at a Postgres instance, e.g. " +
        "postgres://postgres:postgres@localhost:5432/smallcms",
    );
  }

  instance = postgres(url, {
    // Deno Deploy runs many short-lived isolates, and managed Postgres offerings cap connections.
    max: Number(Deno.env.get("DATABASE_POOL_MAX") ?? 5),
    // Managed Postgres is usually fronted by a transaction-mode pooler, which cannot carry
    // server-side prepared statements across checkouts.
    prepare: false,
    onnotice: (notice) => {
      // `CREATE ... IF NOT EXISTS` announces every object that is already there, on every boot.
      if (notice.code === "42P07") return;
      console.warn("postgres notice:", notice.message);
    },
  });

  return instance;
}

/**
 * Binds a value for a `json` or `jsonb` column.
 *
 * Everything stored as JSON here came out of `JSON.parse`, so it is JSON by construction, but that
 * is not something the driver's `JSONValue` type can be told — hence the cast in one place instead
 * of at every call site.
 */
export function jsonParam(sql: Sql, value: unknown): postgres.Parameter {
  return sql.json(value as postgres.JSONValue);
}

/**
 * Binds a value as JSON *text*, for a `json` column that must keep its key order.
 *
 * `jsonParam` cannot do this: the driver hands the value to Postgres typed as jsonb, which sorts
 * object keys on the way in, so the order is already gone by the time it is cast to json. Sending
 * text and casting in SQL stores the document verbatim. Call sites must add the `::json` cast.
 */
export function jsonTextParam(value: unknown): string {
  return JSON.stringify(value);
}

/** Closes the pool. Used by tests; the server keeps the pool open for its lifetime. */
export async function closeSql(): Promise<void> {
  if (!instance) return;
  const sql = instance;
  instance = undefined;
  await sql.end();
}

/**
 * Creates the two tables the CMS runs on, if they are not there yet.
 *
 * Resource schemas are data, not DDL: every record of every resource lives in `records.data` as
 * jsonb. That keeps `POST /__admin/resources` from having to run `CREATE TABLE` at request time,
 * and makes changing a schema a single-row update with no migration.
 */
export async function ensureSchema(sql: Sql): Promise<void> {
  // `fields` is json, not jsonb: jsonb reorders object keys, and the order fields are declared in
  // is meaningful for a schema (it is the order an editing UI would lay them out in). This column
  // is only ever read whole, so the indexing jsonb would buy is of no use here.
  await sql`
    CREATE TABLE IF NOT EXISTS resources (
      name       TEXT PRIMARY KEY,
      fields     JSON NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS records (
      resource   TEXT NOT NULL REFERENCES resources(name) ON DELETE CASCADE,
      id         TEXT NOT NULL,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (resource, id)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS records_resource_created_at_idx
      ON records (resource, created_at DESC, id DESC)
  `;
}
