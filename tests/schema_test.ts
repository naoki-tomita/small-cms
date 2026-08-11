import assert from "node:assert/strict";
import { parseResourceDefinition, validateRecord } from "../src/schema.ts";
import { catchHttpError, issueFields } from "./support.ts";

const articleFields = {
  title: { type: "string", required: true } as const,
  body: { type: "string", required: false } as const,
  views: { type: "number", required: false, default: 0 } as const,
  published: { type: "boolean", required: false, default: false } as const,
  publishedAt: { type: "datetime", required: false } as const,
  meta: { type: "json", required: false } as const,
};

Deno.test("parseResourceDefinition normalizes a valid definition", () => {
  const definition = parseResourceDefinition({
    name: "articles",
    fields: { title: { type: "string", required: true }, body: { type: "string" } },
  });

  assert.equal(definition.name, "articles");
  assert.deepEqual(definition.fields.title, { type: "string", required: true });
  // `required` defaults to false rather than staying undefined.
  assert.deepEqual(definition.fields.body, { type: "string", required: false });
});

Deno.test("parseResourceDefinition rejects names that are not URL path segments", () => {
  for (const name of ["Articles", "1articles", "my articles", "articles/x", "", "__admin"]) {
    assert.deepEqual(
      issueFields(() => parseResourceDefinition({ name, fields: articleFields })),
      ["name"],
      `expected "${name}" to be rejected`,
    );
  }
});

Deno.test("parseResourceDefinition rejects unknown field types and empty schemas", () => {
  assert.deepEqual(
    issueFields(() => parseResourceDefinition({ name: "a", fields: { x: { type: "date" } } })),
    ["fields.x.type"],
  );
  assert.deepEqual(
    issueFields(() => parseResourceDefinition({ name: "a", fields: {} })),
    ["fields"],
  );
  assert.deepEqual(
    issueFields(() => parseResourceDefinition({ name: "a" })),
    ["fields"],
  );
});

Deno.test("parseResourceDefinition rejects server-managed field names", () => {
  assert.deepEqual(
    issueFields(() => parseResourceDefinition({ name: "a", fields: { id: { type: "string" } } })),
    ["fields.id"],
  );
});

Deno.test("parseResourceDefinition rejects a default whose type does not match the field", () => {
  assert.deepEqual(
    issueFields(() =>
      parseResourceDefinition({
        name: "a",
        fields: { views: { type: "number", default: "many" } },
      })
    ),
    ["fields.views.default"],
  );
});

Deno.test("parseResourceDefinition rejects a default on a required field", () => {
  assert.deepEqual(
    issueFields(() =>
      parseResourceDefinition({
        name: "a",
        fields: { title: { type: "string", required: true, default: "x" } },
      })
    ),
    ["fields.title.default"],
  );
});

Deno.test("parseResourceDefinition rejects unknown keys in a field definition", () => {
  assert.deepEqual(
    issueFields(() =>
      parseResourceDefinition({
        name: "a",
        fields: { title: { type: "string", uniqe: true } },
      })
    ),
    ["fields.title.uniqe"],
  );
});

Deno.test("parseResourceDefinition collects every problem in one response", () => {
  assert.deepEqual(
    issueFields(() =>
      parseResourceDefinition({
        name: "Bad Name",
        fields: { a: { type: "nope" }, b: { type: "string", required: "yes" } },
      })
    ),
    ["name", "fields.a.type", "fields.b.required"],
  );
});

Deno.test("parseResourceDefinition rejects a PUT body naming a different resource", () => {
  assert.deepEqual(
    issueFields(() =>
      parseResourceDefinition({ name: "posts", fields: articleFields }, "articles")
    ),
    ["name"],
  );
});

Deno.test("parseResourceDefinition accepts a PUT body with no name at all", () => {
  const definition = parseResourceDefinition({ fields: articleFields }, "articles");
  assert.equal(definition.name, "articles");
});

Deno.test("validateRecord applies defaults and normalizes datetimes", () => {
  const data = validateRecord(articleFields, {
    title: "Hello",
    publishedAt: "2026-08-11T00:00:00+09:00",
  });

  assert.deepEqual(data, {
    title: "Hello",
    views: 0,
    published: false,
    publishedAt: "2026-08-10T15:00:00.000Z",
  });
});

Deno.test("validateRecord rejects missing required fields and unknown fields", () => {
  assert.deepEqual(issueFields(() => validateRecord(articleFields, { body: "no title" })), [
    "title",
  ]);
  assert.deepEqual(
    issueFields(() => validateRecord(articleFields, { title: "ok", slug: "surprise" })),
    ["slug"],
  );
  assert.deepEqual(
    issueFields(() => validateRecord(articleFields, { title: "ok", id: "mine" })),
    ["id"],
  );
});

Deno.test("validateRecord enforces field types", () => {
  assert.deepEqual(issueFields(() => validateRecord(articleFields, { title: 42 })), ["title"]);
  assert.deepEqual(
    issueFields(() => validateRecord(articleFields, { title: "ok", views: Number.NaN })),
    ["views"],
  );
  assert.deepEqual(
    issueFields(() => validateRecord(articleFields, { title: "ok", published: "yes" })),
    ["published"],
  );
  assert.deepEqual(
    issueFields(() => validateRecord(articleFields, { title: "ok", publishedAt: "not a date" })),
    ["publishedAt"],
  );
});

Deno.test("validateRecord accepts any JSON shape for a json field", () => {
  const data = validateRecord(articleFields, {
    title: "ok",
    meta: { tags: ["a", "b"], nested: { n: 1 } },
  });
  assert.deepEqual(data.meta, { tags: ["a", "b"], nested: { n: 1 } });
});

Deno.test("validateRecord treats null as clearing an optional field", () => {
  const data = validateRecord(articleFields, { title: "ok", body: null });
  assert.equal(data.body, null);
  assert.deepEqual(issueFields(() => validateRecord(articleFields, { title: null })), ["title"]);
});

Deno.test("validateRecord in partial mode skips required checks and defaults", () => {
  const data = validateRecord(articleFields, { body: "just the body" }, { partial: true });
  assert.deepEqual(data, { body: "just the body" });
});

Deno.test("validateRecord rejects bodies that are not objects", () => {
  for (const body of [["nope"], "nope", null, 42]) {
    assert.equal(catchHttpError(() => validateRecord(articleFields, body)).status, 400);
  }
});
