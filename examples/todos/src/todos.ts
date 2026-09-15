// What the API and the worker share: the table and its row shape.
import type postgres from "postgres";

export type Todo = { id: number; title: string; done: boolean };

export async function ensureTable(sql: ReturnType<typeof postgres>) {
  await sql`create table if not exists todos (id serial primary key, title text not null, done boolean not null default false)`;
}
