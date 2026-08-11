import { jsonTextParam, type Sql } from "./db.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type { Fields, ResourceDefinition } from "./schema.ts";

export interface Resource {
  name: string;
  fields: Fields;
  createdAt: string;
  updatedAt: string;
}

interface ResourceRow {
  name: string;
  /** Raw text: the driver only auto-parses `jsonb`, and `fields` is `json` to keep its key order. */
  fields: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Every data request has to know the resource's schema first. Reading it from Postgres on each
 * request would double the round trips, so definitions are cached in the isolate.
 *
 * The TTL matters because Deno Deploy runs several isolates: a resource created or changed on one
 * of them is invalidated locally, but the others keep serving their copy until it expires.
 */
const CACHE_TTL_MS = Number(Deno.env.get("RESOURCE_CACHE_TTL_MS") ?? 30_000);

interface CacheEntry {
  resource: Resource | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function toResource(row: ResourceRow): Resource {
  return {
    name: row.name,
    fields: JSON.parse(row.fields) as Fields,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function remember(name: string, resource: Resource | null): void {
  cache.set(name, { resource, expiresAt: Date.now() + CACHE_TTL_MS });
}

function forget(name: string): void {
  cache.delete(name);
}

/** Drops the whole cache. Used by tests that reset the database between cases. */
export function clearResourceCache(): void {
  cache.clear();
}

export async function listResources(sql: Sql): Promise<Resource[]> {
  const rows = await sql<ResourceRow[]>`
    SELECT name, fields, created_at, updated_at FROM resources ORDER BY name ASC
  `;
  return rows.map(toResource);
}

/** Returns the resource, or `null` when no such resource is registered. */
export async function findResource(sql: Sql, name: string): Promise<Resource | null> {
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.resource;
  }

  const rows = await sql<ResourceRow[]>`
    SELECT name, fields, created_at, updated_at FROM resources WHERE name = ${name}
  `;
  const resource = rows[0] ? toResource(rows[0]) : null;
  // Misses are cached too, so requests to paths that do not exist stay off the database.
  remember(name, resource);
  return resource;
}

export async function getResource(sql: Sql, name: string): Promise<Resource> {
  const resource = await findResource(sql, name);
  if (!resource) {
    throw new NotFoundError(`Resource "${name}" does not exist`);
  }
  return resource;
}

export async function createResource(
  sql: Sql,
  definition: ResourceDefinition,
): Promise<Resource> {
  const rows = await sql<ResourceRow[]>`
    INSERT INTO resources (name, fields)
    VALUES (${definition.name}, ${jsonTextParam(definition.fields)}::json)
    ON CONFLICT (name) DO NOTHING
    RETURNING name, fields, created_at, updated_at
  `;

  const row = rows[0];
  if (!row) {
    throw new ConflictError(`Resource "${definition.name}" already exists`);
  }

  const resource = toResource(row);
  remember(resource.name, resource);
  return resource;
}

/**
 * Replaces a resource's field definitions.
 *
 * Existing records are left untouched: validation runs on write, never on read, so a schema change
 * never has to rewrite stored data and never makes old records unreadable.
 */
export async function replaceResource(sql: Sql, name: string, fields: Fields): Promise<Resource> {
  const rows = await sql<ResourceRow[]>`
    UPDATE resources
       SET fields = ${jsonTextParam(fields)}::json, updated_at = now()
     WHERE name = ${name}
    RETURNING name, fields, created_at, updated_at
  `;

  const row = rows[0];
  if (!row) {
    forget(name);
    throw new NotFoundError(`Resource "${name}" does not exist`);
  }

  const resource = toResource(row);
  remember(resource.name, resource);
  return resource;
}

/** Deletes the resource; its records go with it through the foreign key's ON DELETE CASCADE. */
export async function deleteResource(sql: Sql, name: string): Promise<void> {
  const rows = await sql`DELETE FROM resources WHERE name = ${name} RETURNING name`;
  forget(name);
  if (rows.length === 0) {
    throw new NotFoundError(`Resource "${name}" does not exist`);
  }
}
