// Entry of the `api` intent (see hull.yaml): a Hono app served by a Lambda
// handler. It reaches the `db` intent through the generated binding, never
// through a connection string of its own.
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import postgres from "postgres";
import { db } from "../../.hull/bindings/index.js";

type Todo = { id: number; title: string; done: boolean };

// One connection per Lambda instance, opened on the first request and kept
// across invocations; the binding caches the secret the same way.
let sql: ReturnType<typeof postgres> | undefined;
async function connect() {
  sql ??= postgres(await db.connectionString(), { max: 1 });
  return sql;
}

const app = new Hono();

// GET /todos: creates the table if missing, seeds one row if the table is
// empty, and returns every row. The demo proves the link works end to end
// when this returns rows from Postgres.
app.get("/todos", async (c) => {
  const sql = await connect();
  await sql`create table if not exists todos (id serial primary key, title text not null, done boolean not null default false)`;
  const [count] = await sql<{ count: number }[]>`select count(*)::int as count from todos`;
  if (count?.count === 0) await sql`insert into todos (title) values ('Deploy the todos app with Hull')`;
  const todos = await sql<Todo[]>`select id, title, done from todos order by id`;
  return c.json(todos);
});

export const handler = handle(app);
