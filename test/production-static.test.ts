import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createApiServer } from "../src/http.ts";
import { BuildPartyService } from "../src/service.ts";

const directory = await mkdtemp(join(tmpdir(), "buildparty-static-"));
const secret = "must-not-leak-capability";
await mkdir(join(directory, "assets"));
await writeFile(join(directory, "index.html"), "<!doctype html><main>production app</main>");
await writeFile(join(directory, "assets", "app.js"), "console.log('built asset')");
const server = createApiServer(new BuildPartyService({} as pg.Pool), { electricUrl: "http://electric.invalid", staticDir: directory });
let origin = "";

before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

test("app declares a self-contained favicon", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.doesNotMatch(html, /href="\/favicon\.ico"/);
});

test("production server serves assets and SPA routes without reflecting capabilities", async () => {
  const root = await fetch(`${origin}/party/example?cap=${secret}`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(root.headers.get("referrer-policy"), "no-referrer");
  assert.doesNotMatch(await root.text(), new RegExp(secret));

  const asset = await fetch(`${origin}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(await asset.text(), "console.log('built asset')");
});

test("API-looking and encoded traversal paths never receive the SPA", async () => {
  for (const path of ["/api/not-real", "//api/not-real", "/api%2fnot-real", "/api%252fnot-real", "/api/%2e%2e%2findex.html", "/api/%2E%2E%2Fassets/app.js"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /production app|built asset/);
  }
});
