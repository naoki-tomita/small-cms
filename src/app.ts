import type { Sql } from "./db.ts";
import { NotFoundError } from "./errors.ts";
import {
  errorResponse,
  json,
  noContent,
  parseListQuery,
  preflight,
  readJsonBody,
  requireMethod,
} from "./http.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  patchRecord,
  replaceRecord,
} from "./records.ts";
import {
  createResource,
  deleteResource,
  getResource,
  listResources,
  replaceResource,
} from "./resources.ts";
import { parseFields, parseResourceDefinition } from "./schema.ts";

export type Handler = (request: Request) => Promise<Response>;

/**
 * Builds the request handler.
 *
 * Routing is deliberately hand-rolled: the route table is tiny and its first segment is dynamic
 * (it is whatever resource happens to be registered), which a static route table would not express
 * any more clearly than a switch on the path segments.
 */
export function createHandler(sql: Sql): Handler {
  return async function handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return preflight();
    }

    try {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter((segment) => segment !== "");

      // Anything the CMS itself owns lives under a prefix that resource names cannot take,
      // so registering a resource can never shadow an existing route.
      if (segments[0] === "__admin") {
        return await handleAdmin(sql, request, segments.slice(1));
      }
      if (segments.length === 0) {
        return await handleIndex(sql, request, url);
      }
      if (segments.length === 1 && segments[0] === "_health") {
        requireMethod(request, ["GET"]);
        return json({ status: "ok" });
      }

      return await handleRecords(sql, request, url, segments);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** `GET /` — lists what is registered, so the API is discoverable without a frontend. */
async function handleIndex(sql: Sql, request: Request, url: URL): Promise<Response> {
  requireMethod(request, ["GET"]);
  const resources = await listResources(sql);

  return json({
    name: "small-cms",
    resources: resources.map((resource) => ({
      name: resource.name,
      endpoint: new URL(`/${resource.name}`, url.origin).pathname,
      fields: Object.keys(resource.fields),
    })),
  });
}

/** `/__admin/resources[/{name}]` — CRUD over the resource definitions themselves. */
async function handleAdmin(sql: Sql, request: Request, segments: string[]): Promise<Response> {
  if (segments[0] !== "resources") {
    throw new NotFoundError(`Unknown admin endpoint "/${["__admin", ...segments].join("/")}"`);
  }

  if (segments.length === 1) {
    switch (requireMethod(request, ["GET", "POST"])) {
      case "GET":
        return json({ items: await listResources(sql) });
      case "POST": {
        const definition = parseResourceDefinition(await readJsonBody(request));
        const created = await createResource(sql, definition);
        return json(created, 201, { location: `/__admin/resources/${created.name}` });
      }
    }
  }

  if (segments.length === 2) {
    const name = segments[1]!;
    switch (requireMethod(request, ["GET", "PUT", "DELETE"])) {
      case "GET":
        return json(await getResource(sql, name));
      case "PUT": {
        const body = await readJsonBody(request);
        // Reuse the full definition parser so a body naming a different resource is rejected,
        // then persist only the fields — a resource cannot be renamed through its own URL.
        const definition = parseResourceDefinition(body, name);
        return json(await replaceResource(sql, name, parseFields(definition.fields)));
      }
      case "DELETE":
        await deleteResource(sql, name);
        return noContent();
    }
  }

  throw new NotFoundError(`Unknown admin endpoint "/${["__admin", ...segments].join("/")}"`);
}

/** `/{resource}[/{id}]` — the CRUD endpoints that appear as soon as a resource is registered. */
async function handleRecords(
  sql: Sql,
  request: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  if (segments.length > 2) {
    throw new NotFoundError(`Unknown endpoint "${url.pathname}"`);
  }

  const resourceName = segments[0]!;
  const resource = await getResource(sql, resourceName);

  if (segments.length === 1) {
    switch (requireMethod(request, ["GET", "POST"])) {
      case "GET":
        return json(await listRecords(sql, resource, parseListQuery(url.searchParams)));
      case "POST": {
        const created = await createRecord(sql, resource, await readJsonBody(request));
        return json(created, 201, { location: `/${resource.name}/${created.id}` });
      }
    }
  }

  const id = segments[1]!;
  switch (requireMethod(request, ["GET", "PUT", "PATCH", "DELETE"])) {
    case "GET":
      return json(await getRecord(sql, resource, id));
    case "PUT":
      return json(await replaceRecord(sql, resource, id, await readJsonBody(request)));
    case "PATCH":
      return json(await patchRecord(sql, resource, id, await readJsonBody(request)));
    case "DELETE":
      await deleteRecord(sql, resource, id);
      return noContent();
  }

  throw new NotFoundError(`Unknown endpoint "${url.pathname}"`);
}
