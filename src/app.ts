import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Sql } from "./db.ts";
import { MethodNotAllowedError, NotFoundError } from "./errors.ts";
import { errorResponse, json, noContent, parseListQuery, readJsonBody } from "./http.ts";
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

/** Hono answers some requests without awaiting anything, hence the union rather than a Promise. */
export type Handler = (request: Request) => Response | Promise<Response>;

/**
 * Builds the request handler.
 *
 * Routes are registered most-specific first. The record endpoints live at the root (`/:resource`),
 * so every other route would be ambiguous with them if it were not matched earlier; Hono resolves
 * static segments ahead of parameters, and the registration order says the same thing out loud.
 */
export function createHandler(sql: Sql): Handler {
  const app = new Hono();

  // The API is stateless and unauthenticated, so there is nothing for a browser to leak here.
  // This is what lets a frontend be added later without touching the server.
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type"],
      maxAge: 86400,
    }),
  );

  // Anything the CMS itself owns lives under a name that a resource cannot take,
  // so registering a resource can never shadow an existing route.
  app.get("/_health", () => json({ status: "ok" }));

  /** `GET /` — lists what is registered, so the API is discoverable without a frontend. */
  app.get("/", async () => {
    const resources = await listResources(sql);
    return json({
      name: "small-cms",
      resources: resources.map((resource) => ({
        name: resource.name,
        endpoint: `/${resource.name}`,
        fields: Object.keys(resource.fields),
      })),
    });
  });

  // --- /__admin/resources — CRUD over the resource definitions themselves ---

  app.get("/__admin/resources", async () => json({ items: await listResources(sql) }));

  app.post("/__admin/resources", async (c) => {
    const definition = parseResourceDefinition(await readJsonBody(c.req.raw));
    const created = await createResource(sql, definition);
    return json(created, 201, { location: `/__admin/resources/${created.name}` });
  });

  app.get(
    "/__admin/resources/:name",
    async (c) => json(await getResource(sql, c.req.param("name"))),
  );

  app.put("/__admin/resources/:name", async (c) => {
    const name = c.req.param("name");
    // Reuse the full definition parser so a body naming a different resource is rejected,
    // then persist only the fields — a resource cannot be renamed through its own URL.
    const definition = parseResourceDefinition(await readJsonBody(c.req.raw), name);
    return json(await replaceResource(sql, name, parseFields(definition.fields)));
  });

  app.delete("/__admin/resources/:name", async (c) => {
    await deleteResource(sql, c.req.param("name"));
    return noContent();
  });

  app.all("/__admin/resources", () => {
    throw new MethodNotAllowedError(["GET", "POST"]);
  });
  app.all("/__admin/resources/:name", () => {
    throw new MethodNotAllowedError(["GET", "PUT", "DELETE"]);
  });
  app.all("/__admin/*", (c) => {
    throw new NotFoundError(`Unknown admin endpoint "${c.req.path}"`);
  });

  // --- /:resource — the CRUD endpoints that appear as soon as a resource is registered ---

  app.get("/:resource", async (c) => {
    const resource = await getResource(sql, c.req.param("resource"));
    const query = parseListQuery(new URL(c.req.url).searchParams);
    return json(await listRecords(sql, resource, query));
  });

  app.post("/:resource", async (c) => {
    const resource = await getResource(sql, c.req.param("resource"));
    const created = await createRecord(sql, resource, await readJsonBody(c.req.raw));
    return json(created, 201, { location: `/${resource.name}/${created.id}` });
  });

  app.get("/:resource/:id", async (c) => {
    const resource = await getResource(sql, c.req.param("resource"));
    return json(await getRecord(sql, resource, c.req.param("id")));
  });

  app.put("/:resource/:id", async (c) => {
    const resource = await getResource(sql, c.req.param("resource"));
    return json(
      await replaceRecord(sql, resource, c.req.param("id"), await readJsonBody(c.req.raw)),
    );
  });

  app.patch("/:resource/:id", async (c) => {
    const resource = await getResource(sql, c.req.param("resource"));
    return json(await patchRecord(sql, resource, c.req.param("id"), await readJsonBody(c.req.raw)));
  });

  app.delete("/:resource/:id", async (c) => {
    const resource = await getResource(sql, c.req.param("resource"));
    await deleteRecord(sql, resource, c.req.param("id"));
    return noContent();
  });

  // Reached only when the path matched but the method did not. Registering these after the
  // method-specific handlers is what makes "wrong method" a 405 instead of a 404 — but the
  // resource still has to exist, or the answer is 404 like any other unknown path.
  app.all("/:resource", async (c) => {
    await getResource(sql, c.req.param("resource"));
    throw new MethodNotAllowedError(["GET", "POST"]);
  });
  app.all("/:resource/:id", async (c) => {
    await getResource(sql, c.req.param("resource"));
    throw new MethodNotAllowedError(["GET", "PUT", "PATCH", "DELETE"]);
  });

  app.notFound((c) => errorResponse(new NotFoundError(`Unknown endpoint "${c.req.path}"`)));
  app.onError((error) => errorResponse(error));

  return app.fetch;
}
