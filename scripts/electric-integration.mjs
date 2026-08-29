import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Shape, ShapeStream } from "@electric-sql/client";

const exec = promisify(execFile);
const project = `buildparty-electric-${process.pid}`;
const apiPort = 43101;
const env = { ...process.env, API_PORT: String(apiPort), POSTGRES_PORT: "45432" };
const base = `http://127.0.0.1:${apiPort}`;
let composeStarted = false;
let setupFailed = false;

async function docker(args, timeout) {
  try {
    const result = await exec("docker", ["compose", "-p", project, ...args], { env, timeout, maxBuffer: 10_000_000 });
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
    return result;
  } catch (error) {
    const output = [error.message, String(error.stdout ?? ""), String(error.stderr ?? "")].filter(Boolean).join("\n");
    throw new Error(`docker compose ${args.join(" ")} failed (timeout ${timeout}ms):\n${output}`);
  }
}

async function request(path, init = {}) {
  return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
}

async function api(path, method, value, capability, participantToken) {
  const response = await request(path, {
    method,
    headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}), ...(participantToken ? { "x-participant-token": participantToken } : {}) },
    body: JSON.stringify(value),
  });
  const body = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await request("/api/health");
      if (response.ok) return;
      last = `${response.status} ${await response.text()}`;
    } catch (error) { last = String(error); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`API did not become healthy within 60000ms; last result: ${last}`);
}

function subscriber(partyId, capability, shapeName = "artifact") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("shape subscriber exceeded 30000ms")), 30_000);
  timer.unref();
  const stream = new ShapeStream({
    url: `${base}/api/parties/${partyId}/shapes/${shapeName}`,
    headers: { Authorization: `Bearer ${capability}` },
    signal: controller.signal,
  });
  return { shape: new Shape(stream), close: () => { clearTimeout(timer); controller.abort(); } };
}

async function waitForRows(shape, predicate, label) {
  const initial = await Promise.race([
    shape.rows,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} initial snapshot timed out after 15000ms`)), 15_000)),
  ]);
  if (predicate(initial)) return initial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`${label} update timed out after 15000ms`)); }, 15_000);
    const unsubscribe = shape.subscribe(({ rows }) => {
      if (!predicate(rows)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(rows);
    });
  });
}

const actor = { name: "Electric test", kind: "agent" };
const artifact = title => ({
  format: "buildparty.artifact/v1",
  title,
  blocks: [{ id: "counter", kind: "sandbox", source: { html: "<output id=counter></output>" }, initialState: { count: 0 } }],
});

try {
  try {
    await docker(["up", "-d", "--build", "--wait"], 180_000);
    composeStarted = true;
    await waitForApi();
  } catch (error) {
    setupFailed = true;
    try { await docker(["logs", "--no-color", "api"], 15_000); } catch (logError) { console.error(logError.stack ?? logError); }
    console.error(`ELECTRIC INTEGRATION FAILED: environment setup failed exactly as follows:\n${error.stack ?? error}`);
    console.error("Running bounded static fallback checks, but this command will remain failed.");
    process.exitCode = 1;
  }

  if (composeStarted) {
    const first = await api("/api/parties", "POST", { title: "First", participant: actor });
    const second = await api("/api/parties", "POST", { title: "Second", participant: actor });
    const human = await api(`/api/parties/${first.party.id}/participants`, "POST", { participant: { name: "Electric human", kind: "human" } }, first.shareCapability);
    await api(`/api/parties/${first.party.id}/artifact`, "PUT", { artifact: artifact("First artifact") }, first.ownerCapability, first.participantToken);
    await api(`/api/parties/${second.party.id}/artifact`, "PUT", { artifact: artifact("Second artifact") }, second.ownerCapability, second.participantToken);

    const a = subscriber(first.party.id, first.shareCapability);
    const b = subscriber(first.party.id, first.shareCapability);
    const isolated = subscriber(second.party.id, second.shareCapability);
    const audit = subscriber(first.party.id, first.shareCapability, "audit");
    const revisions = subscriber(first.party.id, first.shareCapability, "revisions");
    try {
      await Promise.all([
        waitForRows(a.shape, rows => rows.some(row => row.party_id === first.party.id && row.version === 1), "subscriber A"),
        waitForRows(b.shape, rows => rows.some(row => row.party_id === first.party.id && row.version === 1), "subscriber B"),
      ]);
      const otherRows = await waitForRows(isolated.shape, rows => rows.some(row => row.party_id === second.party.id), "isolated subscriber");
      assert.ok(otherRows.every(row => row.party_id === second.party.id), "party shape leaked another party");
      const revisionRows = await waitForRows(revisions.shape, rows => rows.some(row => row.party_id === first.party.id && row.version === 1), "revision metadata");
      assert.ok(revisionRows.every(row => !("artifact_snapshot" in row) && !("runtime_state_snapshot" in row) && !("blocks" in row)), "revision shape leaked heavy snapshots");
      assert.equal(revisionRows.find(row => row.version === 1)?.snapshot_available, true);

      const comment = await api(`/api/parties/${first.party.id}/feedback`, "POST", { blockId: "counter", kind: "comment", body: "Response invalidation" }, first.shareCapability, human.participantToken);
      await api(`/api/parties/${first.party.id}/feedback/${comment.id}/respond`, "POST", { body: "Agent response only" }, first.ownerCapability, first.participantToken);
      await waitForRows(audit.shape, rows => rows.some(row => row.party_id === first.party.id && row.event_type === "feedback_responded"), "response audit invalidation");

      await api(`/api/parties/${first.party.id}/blocks`, "PATCH", { expectedVersion: 1, statePatch: { counter: { count: 1 } } }, first.ownerCapability, first.participantToken);
      await Promise.all([
        waitForRows(a.shape, rows => rows.some(row => row.party_id === first.party.id && row.version === 1 && row.runtime_state?.counter?.count === 1), "subscriber A update"),
        waitForRows(b.shape, rows => rows.some(row => row.party_id === first.party.id && row.version === 1 && row.runtime_state?.counter?.count === 1), "subscriber B update"),
      ]);

      a.close();
      await api(`/api/parties/${first.party.id}/blocks`, "PATCH", { expectedVersion: 1, statePatch: { counter: { count: 2 } } }, first.ownerCapability, first.participantToken);
      const reconnected = subscriber(first.party.id, first.shareCapability);
      try {
        await Promise.all([
          waitForRows(reconnected.shape, rows => rows.some(row => row.party_id === first.party.id && row.version === 1 && row.runtime_state?.counter?.count === 2), "reconnected catch-up"),
          waitForRows(b.shape, rows => rows.some(row => row.party_id === first.party.id && row.version === 1 && row.runtime_state?.counter?.count === 2), "subscriber B catch-up"),
        ]);
      } finally { reconnected.close(); }
    } finally { a.close(); b.close(); isolated.close(); audit.close(); revisions.close(); }
    console.log("Electric integration passed: two subscribers, response invalidation, reconnect/catch-up, and party isolation.");
  }
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  try { await docker(["down", "-v", "--remove-orphans"], 45_000); }
  catch (error) {
    console.error(`Electric cleanup failed:\n${error.stack ?? error}`);
    if (!setupFailed) process.exitCode = 1;
  }
}

if (setupFailed) {
  for (const [file, args, timeout] of [
    ["node", ["--import", "tsx", "--test", "test/domain.test.ts"], 30_000],
    ["npm", ["run", "typecheck"], 60_000],
    ["npm", ["run", "build"], 60_000],
  ]) {
    try {
      const result = await exec(file, args, { timeout, maxBuffer: 10_000_000 });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    } catch (error) {
      console.error(`Fallback verification failed: ${file} ${args.join(" ")} (timeout ${timeout}ms)\n${error.stdout ?? ""}${error.stderr ?? ""}${error.stack ?? error}`);
      process.exitCode = 1;
    }
  }
}
