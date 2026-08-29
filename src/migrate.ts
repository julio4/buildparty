import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://buildparty:buildparty@localhost:5432/buildparty" });
try {
  const directory = new URL("../db/", import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  }
  console.log("database migrated");
} finally {
  await pool.end();
}
