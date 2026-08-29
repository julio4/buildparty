import pg from "pg";
import { createApiServer } from "./http.ts";
import { BuildPartyService } from "./service.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://buildparty:buildparty@localhost:5432/buildparty" });
const service = new BuildPartyService(pool, process.env.PUBLIC_ORIGIN ?? "http://localhost:5173");
const port = Number(process.env.PORT ?? 3001);
const electricUrl = process.env.ELECTRIC_URL ?? "http://electric:3000";
const server = createApiServer(service, {
  electricUrl,
  electricSecret: process.env.ELECTRIC_SECRET,
  staticDir: process.env.STATIC_DIR,
  ready: async () => {
    await pool.query("SELECT 1");
    const response = await fetch(new URL("/v1/health", electricUrl), { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`Electric readiness failed with ${response.status}`);
  },
});

server.listen(port, () => console.log(`BuildParty API listening on http://localhost:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => pool.end().finally(() => process.exit(0))));
