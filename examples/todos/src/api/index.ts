// Entry of the `api` intent (see hull.yaml): a Hono app served by a Lambda
// handler. It reaches the `db` intent and the `jobs` queue through the
// generated bindings, never through a connection string or a queue URL of
// its own.
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import postgres from "postgres";
import { db, jobs } from "../../.hull/bindings/index.js";
import { ensureTable, type Todo } from "../todos.js";

// One connection per Lambda instance, opened on the first request and kept
// across invocations; the binding caches the secret the same way.
let sql: ReturnType<typeof postgres> | undefined;
async function connect() {
  sql ??= postgres(await db.connectionString(), { max: 1 });
  return sql;
}

const app = new Hono();

// GET /todos: creates the table if missing, seeds one row if the table is
// empty, and returns every row, including what the worker wrote.
app.get("/todos", async (c) => {
  const sql = await connect();
  await ensureTable(sql);
  const [count] = await sql<{ count: number }[]>`select count(*)::int as count from todos`;
  if (count?.count === 0) await sql`insert into todos (title) values ('Deploy the todos app with Hull')`;
  const todos = await sql<Todo[]>`select id, title, done from todos order by id`;
  return c.json(todos);
});

// POST /todos: enqueues the title for the worker and answers 202. The demo
// proves produce and consume end to end when the next GET shows the row.
app.post("/todos", async (c) => {
  const { title } = (await c.req.json().catch(() => ({}))) as { title?: unknown };
  if (typeof title !== "string" || title.trim() === "") return c.json({ error: "title is required" }, 400);
  await jobs.send({ title });
  return c.json({ queued: title }, 202);
});

export const handler = handle(app);
