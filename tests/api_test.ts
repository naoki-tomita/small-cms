import assert from "node:assert/strict";
import { createHandler, type Handler } from "../src/app.ts";
import { closeSql, ensureSchema, getSql } from "../src/db.ts";
import { clearResourceCache } from "../src/resources.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

if (!DATABASE_URL) {
  console.warn(
    "%cSkipping API tests: DATABASE_URL is not set. See README.md for how to start Postgres.",
    "color: yellow",
  );
}

const sql = DATABASE_URL ? getSql() : undefined;

/** Runs `body` against a freshly emptied database, then hands back the response helpers. */
function apiTest(name: string, body: (api: Api) => Promise<void>): void {
  Deno.test({
    name,
    ignore: !DATABASE_URL,
    // The pool is shared across cases and closed by the final teardown test.
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      await ensureSchema(sql!);
      // `records` goes with `resources` through ON DELETE CASCADE.
      await sql!`TRUNCATE resources CASCADE`;
      clearResourceCache();
      await body(makeApi(createHandler(sql!)));
    },
  });
}

interface Result {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
  headers: Headers;
}

interface Api {
  request(method: string, path: string, body?: unknown): Promise<Result>;
  /** Registers the `articles` resource used by most cases. */
  createArticles(): Promise<Result>;
}

function makeApi(handle: Handler): Api {
  async function request(method: string, path: string, body?: unknown): Promise<Result> {
    const response = await handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

    // Every endpoint answers with JSON except the admin UI, which is HTML.
    const text = await response.text();
    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    return {
      status: response.status,
      body: text === "" ? null : isJson ? JSON.parse(text) : text,
      headers: response.headers,
    };
  }

  return {
    request,
    createArticles: () =>
      request("POST", "/__admin/resources", {
        name: "articles",
        fields: {
          title: { type: "string", required: true },
          body: { type: "string" },
          published: { type: "boolean", default: false },
        },
      }),
  };
}

apiTest("a resource's CRUD endpoints appear as soon as it is registered", async (api) => {
  // Before registration the path is simply not there.
  assert.equal((await api.request("GET", "/articles")).status, 404);

  const created = await api.createArticles();
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "articles");
  assert.equal(created.headers.get("location"), "/__admin/resources/articles");

  const list = await api.request("GET", "/articles");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { items: [], total: 0, limit: 20, offset: 0 });
});

apiTest("records can be created, read, updated and deleted", async (api) => {
  await api.createArticles();

  const created = await api.request("POST", "/articles", { title: "はじめての記事", body: "本文" });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, "はじめての記事");
  // Defaults are filled in, and the server owns id/createdAt/updatedAt.
  assert.equal(created.body.published, false);
  assert.equal(typeof created.body.id, "string");
  assert.equal(typeof created.body.createdAt, "string");
  assert.equal(created.headers.get("location"), `/articles/${created.body.id}`);

  const id = created.body.id;

  const fetched = await api.request("GET", `/articles/${id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body, created.body);

  // PATCH merges onto what is stored.
  const patched = await api.request("PATCH", `/articles/${id}`, { published: true });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.published, true);
  assert.equal(patched.body.title, "はじめての記事");
  assert.equal(patched.body.body, "本文");

  // PUT replaces it, so the omitted optional field falls back to its default.
  const replaced = await api.request("PUT", `/articles/${id}`, { title: "書き直し" });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.title, "書き直し");
  assert.equal(replaced.body.published, false);
  assert.equal(replaced.body.body, undefined);
  assert.equal(replaced.body.createdAt, created.body.createdAt);

  const deleted = await api.request("DELETE", `/articles/${id}`);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, null);
  assert.equal((await api.request("GET", `/articles/${id}`)).status, 404);
});

apiTest("records come back with their fields in the order the schema declares", async (api) => {
  await api.createArticles();
  const created = await api.request("POST", "/articles", { body: "本文", title: "順序" });

  // Not the order they were sent in, and not the order jsonb stores them in — the schema's.
  assert.deepEqual(Object.keys(created.body), [
    "id",
    "createdAt",
    "updatedAt",
    "title",
    "body",
    "published",
  ]);

  // A field dropped from the schema is still returned, after the declared ones.
  await api.request("PUT", "/__admin/resources/articles", {
    fields: { title: { type: "string", required: true } },
  });
  const afterChange = await api.request("GET", `/articles/${created.body.id}`);
  assert.deepEqual(Object.keys(afterChange.body), [
    "id",
    "createdAt",
    "updatedAt",
    "title",
    "body",
    "published",
  ]);
});

apiTest("listing paginates and orders by creation time", async (api) => {
  await api.createArticles();
  for (const title of ["one", "two", "three"]) {
    await api.request("POST", "/articles", { title });
  }

  const newestFirst = await api.request("GET", "/articles");
  assert.equal(newestFirst.body.total, 3);
  assert.deepEqual(newestFirst.body.items.map((item: { title: string }) => item.title), [
    "three",
    "two",
    "one",
  ]);

  const oldestFirst = await api.request("GET", "/articles?order=asc");
  assert.deepEqual(oldestFirst.body.items.map((item: { title: string }) => item.title), [
    "one",
    "two",
    "three",
  ]);

  const page = await api.request("GET", "/articles?limit=1&offset=1&order=asc");
  assert.deepEqual(page.body, {
    items: [page.body.items[0]],
    total: 3,
    limit: 1,
    offset: 1,
  });
  assert.equal(page.body.items[0].title, "two");

  for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?offset=-1", "?order=sideways"]) {
    assert.equal((await api.request("GET", `/articles${query}`)).status, 400, query);
  }
});

apiTest("writes are validated against the resource's schema", async (api) => {
  await api.createArticles();

  const missing = await api.request("POST", "/articles", { body: "no title" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "validation_error");
  assert.deepEqual(missing.body.error.details, [{ field: "title", message: "is required" }]);

  const unknown = await api.request("POST", "/articles", { title: "ok", slug: "surprise" });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body.error.details, [
    { field: "slug", message: 'unknown field "slug"' },
  ]);

  const wrongType = await api.request("POST", "/articles", { title: 42 });
  assert.equal(wrongType.status, 400);

  const notJson = await api.request("POST", "/articles", "{ broken");
  assert.equal(notJson.status, 400);
});

apiTest("resources themselves are CRUD-able", async (api) => {
  await api.createArticles();

  const duplicate = await api.createArticles();
  assert.equal(duplicate.status, 409);

  const list = await api.request("GET", "/__admin/resources");
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].name, "articles");

  const one = await api.request("GET", "/__admin/resources/articles");
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.fields.title, { type: "string", required: true });

  assert.equal((await api.request("GET", "/__admin/resources/nope")).status, 404);
});

apiTest(
  "changing a schema affects later writes but leaves stored records readable",
  async (api) => {
    await api.createArticles();
    const before = await api.request("POST", "/articles", { title: "old", body: "body text" });

    const updated = await api.request("PUT", "/__admin/resources/articles", {
      fields: {
        title: { type: "string", required: true },
        slug: { type: "string", required: true },
      },
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(Object.keys(updated.body.fields), ["title", "slug"]);

    // The existing record is returned exactly as it was stored — no migration, no read-time check.
    const stillThere = await api.request("GET", `/articles/${before.body.id}`);
    assert.equal(stillThere.status, 200);
    assert.equal(stillThere.body.body, "body text");

    // New writes must satisfy the new schema.
    assert.equal((await api.request("POST", "/articles", { title: "x" })).status, 400);
    assert.equal((await api.request("POST", "/articles", { title: "x", slug: "x" })).status, 201);

    assert.equal((await api.request("PUT", "/__admin/resources/nope", { fields: {} })).status, 400);
  },
);

apiTest("deleting a resource removes its endpoint and its records", async (api) => {
  await api.createArticles();
  const record = await api.request("POST", "/articles", { title: "doomed" });
  assert.equal(record.status, 201);

  const deleted = await api.request("DELETE", "/__admin/resources/articles");
  assert.equal(deleted.status, 204);

  assert.equal((await api.request("GET", "/articles")).status, 404);
  assert.equal((await api.request("GET", `/articles/${record.body.id}`)).status, 404);
  assert.equal((await api.request("DELETE", "/__admin/resources/articles")).status, 404);

  // The cascade really removed the rows rather than orphaning them.
  const counted = await sql!<{ count: number }[]>`SELECT count(*)::int AS count FROM records`;
  assert.equal(counted[0]?.count, 0);
});

apiTest("several resources coexist without leaking records into each other", async (api) => {
  await api.createArticles();
  await api.request("POST", "/__admin/resources", {
    name: "tags",
    fields: { label: { type: "string", required: true } },
  });

  await api.request("POST", "/articles", { title: "an article" });
  await api.request("POST", "/tags", { label: "a tag" });

  const articles = await api.request("GET", "/articles");
  const tags = await api.request("GET", "/tags");
  assert.equal(articles.body.total, 1);
  assert.equal(tags.body.total, 1);
  assert.equal(articles.body.items[0].title, "an article");
  assert.equal(tags.body.items[0].label, "a tag");

  // A record id from one resource is not reachable through another.
  const strayId = articles.body.items[0].id;
  assert.equal((await api.request("GET", `/tags/${strayId}`)).status, 404);
});

apiTest("the index lists every registered resource and its endpoint", async (api) => {
  await api.createArticles();

  const index = await api.request("GET", "/");
  assert.equal(index.status, 200);
  assert.equal(index.body.name, "small-cms");
  assert.deepEqual(index.body.resources, [
    { name: "articles", endpoint: "/articles", fields: ["title", "body", "published"] },
  ]);

  assert.equal((await api.request("GET", "/_health")).status, 200);
});

apiTest("unsupported methods and unknown paths are reported distinctly", async (api) => {
  await api.createArticles();

  const badMethod = await api.request("DELETE", "/articles");
  assert.equal(badMethod.status, 405);
  assert.equal(badMethod.headers.get("allow"), "GET, POST");

  assert.equal((await api.request("POST", "/articles/some-id", { title: "x" })).status, 405);
  assert.equal((await api.request("GET", "/articles/some-id/extra")).status, 404);
  assert.equal((await api.request("GET", "/__admin/nope")).status, 404);
  assert.equal((await api.request("GET", "/nope")).status, 404);
});

apiTest("a resource cannot be named after a route the server owns", async (api) => {
  for (const name of ["__admin", "_health", "Articles"]) {
    const response = await api.request("POST", "/__admin/resources", {
      name,
      fields: { x: { type: "string" } },
    });
    assert.equal(response.status, 400, `expected "${name}" to be rejected`);
  }
});

apiTest("the admin UI is served from the same origin as the API", async (api) => {
  for (const path of ["/__admin", "/__admin/"]) {
    const response = await api.request("GET", path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/, path);
    assert.match(response.body, /<title>small-cms<\/title>/, path);
  }

  // The page must not shadow the API it drives.
  assert.equal((await api.request("GET", "/__admin/resources")).status, 200);
  assert.equal((await api.request("GET", "/__admin/nope")).status, 404);
});

apiTest("preflight requests are answered for a future frontend", async (api) => {
  const response = await api.request("OPTIONS", "/articles");
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

apiTest("CORS headers survive on error responses too", async (api) => {
  await api.createArticles();

  // A browser has to be able to read the error body, not just the happy path — which means the
  // headers have to be on responses produced by throwing, not only on the ones handlers return.
  const cases: Array<[string, Result]> = [
    ["404 from the not-found handler", await api.request("GET", "/no-such-resource")],
    ["405 from a method mismatch", await api.request("DELETE", "/articles")],
    ["400 from validation", await api.request("POST", "/articles", { body: "no title" })],
  ];

  for (const [label, response] of cases) {
    assert.equal(response.headers.get("access-control-allow-origin"), "*", label);
  }
});

Deno.test({
  name: "teardown: close the connection pool",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => closeSql(),
});
