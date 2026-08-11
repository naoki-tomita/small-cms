import { createHandler } from "./src/app.ts";
import { ensureSchema, getSql } from "./src/db.ts";

const sql = getSql();
await ensureSchema(sql);

console.warn(
  "small-cms: /__admin serves the admin UI and its API, both unauthenticated — anyone who can " +
    "reach this server can create, change and delete resources (and every record they hold). " +
    "Do not expose it publicly without putting authentication in front of it.",
);

Deno.serve(createHandler(sql));
