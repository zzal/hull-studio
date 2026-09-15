// Entry of the `worker` intent (see hull.yaml): a Lambda fed by the `jobs`
// queue through the generated binding, which turns each SQS batch into one
// call per message and reports the ones that threw. Each message is a todo
// title to insert into the `db` intent.
import postgres from "postgres";
import { db, jobs } from "../../.hull/bindings/index.js";
import { ensureTable } from "../todos.js";

let sql: ReturnType<typeof postgres> | undefined;
async function connect() {
  sql ??= postgres(await db.connectionString(), { max: 1 });
  return sql;
}

export const handler = jobs.consume<{ title: string }>(async ({ title }) => {
  const sql = await connect();
  await ensureTable(sql);
  await sql`insert into todos (title) values (${title})`;
});
