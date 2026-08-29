import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = "buildparty-golden-e2e";
const artifacts = "test-results/artifacts";
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, POSTGRES_PORT: "45433", API_PORT: "43102", API_ORIGIN: "http://localhost:43102" };
const startedAt = Date.now();
const deadline = startedAt + 180_000;
const cleanupReserve = 30_000;
let vite;
let viteLog;
let composeStarted = false;

const hardDeadline = setTimeout(() => {
  console.error("Golden E2E exceeded its global 180000ms deadline.");
  try { if (vite?.pid) process.kill(-vite.pid, "SIGKILL"); } catch { /* already stopped */ }
  process.exit(1);
}, 180_000);

function budget(label, requested, reserve = cleanupReserve) {
  const remaining = deadline - Date.now() - reserve;
  if (remaining <= 0) throw new Error(`${label} could not start: global 180000ms deadline exhausted after ${Date.now() - startedAt}ms`);
  return Math.min(requested, remaining);
}

async function compose(args, timeout = 120_000, reserve = cleanupReserve) {
  const allowed = budget(`docker compose ${args.join(" ")}`, timeout, reserve);
  try {
    const result = await exec("docker", ["compose", "-p", project, ...args], { env, timeout: allowed, maxBuffer: 10_000_000 });
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
  } catch (error) {
    throw new Error(`docker compose ${args.join(" ")} failed (step budget ${allowed}ms; global elapsed ${Date.now() - startedAt}ms):\n${error.stdout ?? ""}${error.stderr ?? ""}${error.message}`);
  }
}

async function waitFor(url, label, timeout = 60_000) {
  const until = Date.now() + budget(`${label} health check`, timeout);
  let last = "not attempted";
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, until - Date.now()))) });
      if (response.ok) return;
      last = `${response.status} ${await response.text()}`;
    } catch (error) { last = String(error); }
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(300, until - Date.now()))));
  }
  throw new Error(`${label} did not become healthy before its step/global deadline; last result: ${last}`);
}

async function stopVite() {
  if (!vite || vite.exitCode !== null) return;
  try { process.kill(-vite.pid, "SIGTERM"); } catch { return; }
  const wait = Math.max(1, Math.min(5_000, deadline - Date.now()));
  await Promise.race([new Promise(resolve => vite.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, wait))]);
  if (vite.exitCode === null) try { process.kill(-vite.pid, "SIGKILL"); } catch { /* already stopped */ }
}

mkdirSync(artifacts, { recursive: true });
try {
  await compose(["down", "-v", "--remove-orphans"], 45_000);
  await compose(["up", "-d", "--build", "--wait", "--wait-timeout", "90"], 150_000);
  composeStarted = true; // The API container runs src/migrate.ts before it starts Node.
  await waitFor(`${env.API_ORIGIN}/api/health`, "API");

  viteLog = openSync(`${artifacts}/vite.log`, "w");
  vite = spawn("node_modules/.bin/vite", ["--host", "127.0.0.1", "--strictPort"], { env, detached: true, stdio: ["ignore", viteLog, viteLog] });
  await waitFor("http://localhost:5173", "Vite");

  const testStarted = Date.now();
  const allowed = budget("Playwright", 130_000);
  await exec("node_modules/.bin/playwright", ["test"], { env, timeout: allowed, maxBuffer: 20_000_000 }).then(result => {
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  }).catch(error => {
    process.stdout.write(error.stdout ?? ""); process.stderr.write(error.stderr ?? "");
    throw new Error(`Playwright failed after ${Date.now() - testStarted}ms (step budget ${allowed}ms; global elapsed ${Date.now() - startedAt}ms): ${error.message}`);
  });
  console.log(`Golden browser E2E completed in ${Date.now() - testStarted}ms (${Date.now() - startedAt}ms including startup).`);
} catch (error) {
  if (composeStarted) try { await compose(["logs", "--no-color", "api", "electric"], 15_000, 15_000); } catch (logError) { console.error(logError); }
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await stopVite();
  if (viteLog !== undefined) closeSync(viteLog);
  try { await compose(["down", "-v", "--remove-orphans", "--timeout", "10"], 45_000, 0); }
  catch (error) { console.error(`Golden E2E cleanup failed:\n${error.stack ?? error}`); process.exitCode = 1; }
  clearTimeout(hardDeadline);
}
