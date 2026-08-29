import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import pg from "pg";
import WebSocket from "ws";
import { AppError } from "../src/domain.ts";
import { createApiServer, shapes } from "../src/http.ts";
import { BuildPartyService, HUMAN_OPERATIONS, WEBMCP_OPERATIONS } from "../src/service.ts";

const connectionString = process.env.DATABASE_URL ?? "postgres://buildparty:buildparty@localhost:5432/buildparty";
const pool = new pg.Pool({ connectionString });
const service = new BuildPartyService(pool, "http://example.test");
const owner = { id: "owner-1", name: "Owner", kind: "human" as const };
const reviewer = { id: "reviewer-1", name: "Review agent", kind: "agent" as const };
const humanReviewer = { id: "human-reviewer-1", name: "Human reviewer", kind: "human" as const };
const proxied: { url: URL; init?: RequestInit }[] = [];
const api = createApiServer(service, {
  electricUrl: "http://electric.invalid:3000",
  electricSecret: "server-only-electric-secret",
  fetch: async (input, init) => {
    proxied.push({ url: new URL(String(input)), init });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json", "electric-offset": "0_0" } });
  },
});
let baseUrl: string;
const artifact = {
  format: "buildparty.artifact/v1" as const,
  title: "Launch <Plan>",
  blocks: [
    { id: "scope", title: "Scope", kind: "sandbox" as const, source: { html: "<p>Small</p>", css: "p{color:navy}" }, initialState: { selected: true, zoom: 1 } },
    { id: "timing", kind: "sandbox" as const, source: { html: "<p>Friday</p>" }, initialState: { day: "Friday" } },
  ],
};

async function rejectsCode(run: () => Promise<unknown>, code: AppError["code"]) {
  await assert.rejects(run, (error) => error instanceof AppError && error.code === code);
}

test.before(async () => {
  const directory = new URL("../db/", import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  }
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
test.after(async () => {
  await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  await pool.end();
});

test("migrations align the service schema and upgrade Phase-1 artifact rows", async () => {
  const current = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name,is_nullable,column_default FROM information_schema.columns
     WHERE table_schema='public' AND table_name='artifacts' AND column_name=ANY($1::text[]) ORDER BY column_name`,
    [["format", "title"]],
  );
  assert.deepEqual(current.rows.map(row => [row.column_name, row.is_nullable]), [["format", "NO"], ["title", "NO"]]);
  assert.match(current.rows[0]?.column_default ?? "", /buildparty\.artifact\/v1/);
  const sessions = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='participant_sessions' ORDER BY column_name`);
  assert.deepEqual(sessions.rows.map(row => row.column_name), ["created_at", "id", "identity_id", "last_seen_at", "party_id", "token_hash"]);
  const revisionColumns = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='revisions' ORDER BY column_name`);
  for (const name of ["artifact_snapshot", "runtime_state_snapshot", "snapshot_available", "snapshot_bytes", "snapshot_pruned"]) assert.ok(revisionColumns.rows.some(row => row.column_name === name));

  const client = await pool.connect();
  try {
    await client.query(`
      DROP SCHEMA IF EXISTS migration_smoke CASCADE;
      CREATE SCHEMA migration_smoke;
      SET search_path TO migration_smoke;
      CREATE TABLE parties (id uuid PRIMARY KEY, title text NOT NULL);
      CREATE TABLE artifacts (
        party_id uuid PRIMARY KEY REFERENCES parties(id), blocks jsonb NOT NULL,
        runtime_state jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE participants (party_id uuid REFERENCES parties(id), identity_id text, PRIMARY KEY (party_id,identity_id));
      CREATE TABLE revisions (
        id uuid PRIMARY KEY, party_id uuid REFERENCES parties(id), version integer NOT NULL,
        source text NOT NULL CHECK (source IN ('set_artifact','update_blocks')), blocks jsonb NOT NULL,
        changed_block_ids text[] NOT NULL, feedback_ids uuid[] NOT NULL DEFAULT '{}', summary text,
        actor_identity_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(party_id,version)
      );
      CREATE TABLE feedback (id uuid PRIMARY KEY, party_id uuid REFERENCES parties(id));
      CREATE TABLE feedback_responses (id uuid PRIMARY KEY, feedback_id uuid REFERENCES feedback(id), revision_id uuid REFERENCES revisions(id));
      CREATE TABLE final_versions (
        id uuid PRIMARY KEY, party_id uuid UNIQUE REFERENCES parties(id), name text NOT NULL, source_version integer NOT NULL,
        blocks jsonb NOT NULL, runtime_state jsonb NOT NULL, html text NOT NULL, actor_identity_id text NOT NULL,
        open_feedback_overridden boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO parties (id,title) VALUES ('00000000-0000-4000-8000-000000000001','Legacy title');
      INSERT INTO artifacts (party_id,blocks) VALUES ('00000000-0000-4000-8000-000000000001','[]');
      INSERT INTO participants VALUES ('00000000-0000-4000-8000-000000000001','legacy');
      INSERT INTO revisions (id,party_id,version,source,blocks,changed_block_ids,actor_identity_id)
        VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',1,'set_artifact','[]','{}','legacy');
      INSERT INTO feedback VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001');
      INSERT INTO feedback_responses VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002');
    `);
    await client.query(await readFile(new URL("../db/002_sandbox_artifacts.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../db/003_participant_sessions.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../db/004_revision_snapshots.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../db/005_final_version_delete_immutability.sql", import.meta.url), "utf8"));
    const upgraded = await client.query(`SELECT format,title FROM artifacts`);
    assert.deepEqual(upgraded.rows, [{ format: "buildparty.artifact/v1", title: "Legacy title" }]);
    const columns = await client.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name,is_nullable,column_default FROM information_schema.columns
       WHERE table_schema='migration_smoke' AND table_name='artifacts' AND column_name IN ('format','title') ORDER BY column_name`,
    );
    assert.deepEqual(columns.rows.map(row => [row.column_name, row.is_nullable]), [["format", "NO"], ["title", "NO"]]);
    assert.match(columns.rows[0]?.column_default ?? "", /buildparty\.artifact\/v1/);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM participants`)).rows[0].count, 1);
    assert.equal((await client.query(`SELECT to_regclass('migration_smoke.participant_sessions') AS name`)).rows[0].name, "participant_sessions");
    const legacyRevision = (await client.query(`SELECT blocks,artifact_snapshot,runtime_state_snapshot,snapshot_available,snapshot_pruned FROM revisions`)).rows[0];
    assert.deepEqual(legacyRevision, { blocks: [], artifact_snapshot: null, runtime_state_snapshot: null, snapshot_available: false, snapshot_pruned: false });
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM feedback_responses r JOIN revisions v ON v.id=r.revision_id`)).rows[0].count, 1);
    await client.query(`INSERT INTO revisions (id,party_id,version,source,blocks,changed_block_ids,actor_identity_id) VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001',2,'delete_blocks',NULL,'{}','legacy')`);
    await client.query(`INSERT INTO final_versions (id,party_id,name,source_version,blocks,runtime_state,html,actor_identity_id) VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','Legacy final',1,'[]','{}','<!doctype html>','legacy')`);
    await assert.rejects(() => client.query(`UPDATE final_versions SET name='changed'`), /immutable/);
    await assert.rejects(() => client.query(`DELETE FROM final_versions`), /immutable/);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM final_versions`)).rows[0].count, 1);
  } finally {
    await client.query("SET search_path TO public; DROP SCHEMA IF EXISTS migration_smoke CASCADE");
    client.release();
  }
});

test("capability party preserves exact artifacts, versions, state, feedback association, and role discovery", async () => {
  const discovery = service.init();
  assert.equal(discovery.operations.length, 11);
  assert.deepEqual(discovery.operations, WEBMCP_OPERATIONS);
  assert.deepEqual(discovery.apiOperations, WEBMCP_OPERATIONS);
  assert.deepEqual(discovery.humanOperations, HUMAN_OPERATIONS);
  assert.ok(!discovery.operations.includes("add_feedback" as never));
  assert.equal("actor" in discovery, false);

  const created = await service.createParty({ title: "Party title", participant: { name: owner.name, kind: owner.kind } });
  const id = created.party.id;
  const agentSession = await service.joinParty(id, created.shareCapability, { participant: { name: reviewer.name, kind: reviewer.kind } });
  const humanSession = await service.joinParty(id, created.shareCapability, { participant: { name: humanReviewer.name, kind: humanReviewer.kind } });
  assert.equal(created.ownerCapability.length, 43);
  assert.equal(created.shareCapability.length, 43);
  assert.equal(created.participantToken.length, 43);
  assert.equal(agentSession.participantToken.length, 43);
  assert.notEqual(created.ownerCapability, created.shareCapability);
  assert.match(created.ownerUrl, new RegExp(`#cap=${created.ownerCapability}$`));
  assert.match(created.shareUrl, new RegExp(`#cap=${created.shareCapability}$`));
  assert.doesNotMatch(created.ownerUrl, /\?cap=/);
  const stored = (await pool.query(`SELECT owner_capability_hash,share_capability_hash FROM parties WHERE id=$1`, [id])).rows[0];
  assert.notEqual(stored.owner_capability_hash, created.ownerCapability);
  assert.notEqual(stored.share_capability_hash, created.shareCapability);
  const sessionHashes = (await pool.query(`SELECT token_hash FROM participant_sessions WHERE party_id=$1`, [id])).rows.map(row => row.token_hash);
  assert.equal(sessionHashes.length, 3);
  assert.ok(!sessionHashes.includes(created.participantToken));
  assert.ok(!sessionHashes.includes(agentSession.participantToken));
  const attemptedImpersonation = await service.joinParty(id, created.shareCapability, { participant: { id: created.participant.id, name: "Impostor", kind: "agent" } });
  assert.notEqual(attemptedImpersonation.participant.id, created.participant.id);
  const other = await service.createParty({ title: "Other", participant: { name: "Other", kind: "human" } });
  await rejectsCode(() => service.getParty(id, created.ownerCapability, other.participantToken), "FORBIDDEN");
  await rejectsCode(() => service.setArtifact(id, created.ownerCapability, agentSession.participantToken, { actor: owner, artifact }), "VALIDATION_ERROR");
  await rejectsCode(() => service.getParty(id, "A".repeat(43), created.participantToken), "FORBIDDEN");
  await rejectsCode(() => service.getParty(id, created.ownerCapability, "A".repeat(43)), "FORBIDDEN");

  const emptyOwner = await service.getParty(id, created.ownerCapability, created.participantToken);
  assert.deepEqual(emptyOwner.availableOperations, ["get_party", "get_feedback", "set_artifact"]);
  assert.deepEqual(emptyOwner.humanOperations, []);

  const initial = await service.setArtifact(id, created.ownerCapability, created.participantToken, { artifact });
  assert.deepEqual(initial.artifact, artifact);
  assert.deepEqual(initial.runtimeState, { scope: { selected: true, zoom: 1 }, timing: { day: "Friday" } });
  assert.equal(initial.version, 1);
  assert.equal("runtimeState" in initial.artifact, false);

  const ownerView = await service.getParty(id, created.ownerCapability, created.participantToken);
  const shareView = await service.getParty(id, created.shareCapability, agentSession.participantToken);
  assert.deepEqual(ownerView.artifact, artifact);
  assert.deepEqual(ownerView.runtimeState, initial.runtimeState);
  assert.equal(ownerView.version, 1);
  assert.ok(ownerView.availableOperations.includes("finalize_party"));
  assert.ok(ownerView.availableOperations.includes("delete_blocks"));
  assert.ok(ownerView.availableOperations.includes("restore_revision"));
  assert.ok(shareView.availableOperations.includes("delete_blocks"));
  assert.ok(shareView.availableOperations.includes("restore_revision"));
  assert.deepEqual(ownerView.availableApiOperations, ownerView.availableOperations);
  assert.ok(!shareView.availableOperations.includes("finalize_party"));
  assert.deepEqual(ownerView.humanOperations, ["add_feedback"]);
  assert.deepEqual(shareView.humanOperations, ["add_feedback"]);

  const statePatch = await service.updateBlocks(id, created.shareCapability, agentSession.participantToken, {
    expectedVersion: 1, statePatch: { scope: { zoom: 2 } },
  });
  assert.equal(statePatch.version, 1);
  assert.deepEqual(statePatch.runtimeState.scope, { selected: true, zoom: 2 });
  assert.deepEqual(statePatch.artifact, artifact);
  assert.equal(statePatch.revision, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM revisions WHERE party_id=$1`, [id])).rows[0].count, 1);

  const fieldPatch = await service.updateBlocks(id, created.shareCapability, agentSession.participantToken, {
    expectedVersion: 1, updates: [{ id: "scope", source: { html: "<p>Measurable</p>" } }],
  });
  assert.equal(fieldPatch.version, 2);
  assert.equal(fieldPatch.artifact.blocks[0]?.source.html, "<p>Measurable</p>");
  assert.equal(fieldPatch.artifact.blocks[0]?.source.css, "p{color:navy}");
  assert.deepEqual(fieldPatch.runtimeState.scope, { selected: true, zoom: 2 });

  await service.updateBlocks(id, created.ownerCapability, created.participantToken, {
    updates: [{ id: "scope", source: { html: "<p>First writer</p>" } }],
  });
  const lww = await service.updateBlocks(id, created.shareCapability, agentSession.participantToken, {
    updates: [{ id: "scope", source: { html: "<p>Last writer</p>" } }],
  });
  assert.equal(lww.version, 4);
  assert.equal(lww.artifact.blocks[0]?.source.html, "<p>Last writer</p>");
  assert.equal(lww.artifact.blocks[0]?.source.css, "p{color:navy}");

  const reset = await service.updateBlocks(id, created.ownerCapability, created.participantToken, { expectedVersion: 4, resetState: true });
  assert.equal(reset.version, 4);
  assert.equal(reset.revision, null);
  assert.deepEqual(reset.runtimeState, { scope: { selected: true, zoom: 1 }, timing: { day: "Friday" } });

  await rejectsCode(() => service.addFeedback(id, created.shareCapability, agentSession.participantToken, {
    blockId: "scope", kind: "comment", body: "Agent feedback is not a human action",
  }), "FORBIDDEN");
  await rejectsCode(() => service.addFeedback(id, created.shareCapability, humanSession.participantToken, {
    kind: "comment", body: "Blockless human feedback is not supported",
  }), "VALIDATION_ERROR");
  const firstFeedback = await service.addFeedback(id, created.shareCapability, humanSession.participantToken, {
    blockId: "timing", kind: "change", body: "Move this to Monday",
  });
  const secondFeedback = await service.addFeedback(id, created.shareCapability, humanSession.participantToken, {
    blockId: "scope", kind: "change", body: "Explain scope",
  });
  const unrelated = await service.updateBlocks(id, created.ownerCapability, created.participantToken, {
    expectedVersion: 4, updates: [{ id: "scope", title: "Clear scope" }], feedbackIds: [secondFeedback.id],
  });
  await rejectsCode(() => service.respondToFeedback(id, created.ownerCapability, created.participantToken, firstFeedback.id, {
    revisionId: unrelated.revision.id, resolve: true,
  }), "FORBIDDEN");
  await rejectsCode(() => service.respondToFeedback(id, created.ownerCapability, agentSession.participantToken, firstFeedback.id, {
    revisionId: unrelated.revision.id, resolve: true,
  }), "VALIDATION_ERROR");

  const linked = await service.updateBlocks(id, created.ownerCapability, created.participantToken, {
    expectedVersion: 5, updates: [{ id: "timing", source: { html: "<p>Monday</p>" } }], feedbackIds: [firstFeedback.id],
  });
  assert.deepEqual(linked.revision.feedback_ids, [firstFeedback.id]);
  await service.respondToFeedback(id, created.ownerCapability, agentSession.participantToken, secondFeedback.id, {
    revisionId: unrelated.revision.id, resolve: true,
  });
  const resolved = await service.respondToFeedback(id, created.shareCapability, agentSession.participantToken, firstFeedback.id, {
    body: "Confirmed", revisionId: linked.revision.id, resolve: true,
  });
  assert.equal(resolved.lifecycle, "in_review");
  assert.equal((await service.getFeedback(id, created.shareCapability, agentSession.participantToken, "open")).length, 0);

  await rejectsCode(() => service.finalizeParty(id, created.shareCapability, agentSession.participantToken, {
    name: "Final", expectedVersion: 6,
  }), "FORBIDDEN");
  const finalized = await service.finalizeParty(id, created.ownerCapability, created.participantToken, {
    name: "Final", expectedVersion: 6,
  });
  assert.equal(finalized.lifecycle, "finalized");
  assert.match(finalized.final.html, /Last writer/);
  assert.match(finalized.final.html, /Monday/);
  assert.match(finalized.final.html, /\"zoom\":1/);
  assert.match(finalized.final.html, /bp:patch/);
  assert.match(finalized.final.html, /sandbox','allow-scripts/);
  assert.doesNotMatch(finalized.final.html, new RegExp(created.ownerCapability));
  assert.doesNotMatch(finalized.final.html, new RegExp(created.shareCapability));
  assert.doesNotMatch(finalized.final.html, new RegExp(created.participantToken));
  assert.doesNotMatch(finalized.final.html, new RegExp(agentSession.participantToken));
  await assert.rejects(() => pool.query(`UPDATE final_versions SET name='changed' WHERE party_id=$1`, [id]), /immutable/);
  await assert.rejects(() => pool.query(`DELETE FROM final_versions WHERE party_id=$1`, [id]), /immutable/);
  await assert.rejects(() => pool.query(`DELETE FROM parties WHERE id=$1`, [id]), /immutable/);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM final_versions WHERE party_id=$1`, [id])).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM parties WHERE id=$1`, [id])).rows[0].count, 1);

  const finalView = await service.getParty(id, created.shareCapability, agentSession.participantToken);
  assert.equal((await service.authorizePresence(id, created.shareCapability, agentSession.participantToken)).writable, false);
  assert.deepEqual(finalView.availableOperations, ["get_party", "get_feedback", "get_final_artifact"]);
  assert.deepEqual(finalView.humanOperations, []);
  assert.deepEqual(finalView.artifact, linked.artifact);
});

test("revision snapshots support delete, archived feedback, restore, prune, and storage accounting", async () => {
  const created = await service.createParty({ title: "Revision party", participant: { name: "Revision owner", kind: "human" } });
  const id = created.party.id;
  const agent = await service.joinParty(id, created.shareCapability, { participant: { name: "Revision agent", kind: "agent" } });
  const empty = { format: "buildparty.artifact/v1" as const, title: "Empty", blocks: [] };
  const first = await service.setArtifact(id, created.ownerCapability, created.participantToken, { artifact: empty });
  assert.deepEqual(first.artifact.blocks, []);
  assert.deepEqual(first.runtimeState, {});
  const emptyView = await service.getParty(id, created.ownerCapability, created.participantToken);
  assert.ok(!emptyView.availableOperations.includes("delete_blocks"));
  assert.ok(emptyView.availableOperations.includes("restore_revision"));

  const substantial = `${Array.from({ length: 2_000 }, (_, index) => `item-${index}`).join(" ")}`;
  const source = {
    format: "buildparty.artifact/v1" as const,
    title: "Restorable",
    blocks: [
      { id: "one", kind: "sandbox" as const, source: { html: `<p>${substantial}</p>` }, initialState: { count: 1 } },
      { id: "two", kind: "sandbox" as const, source: { html: "<p>Two</p>" }, initialState: { kept: true } },
    ],
  };
  const set = await service.setArtifact(id, created.shareCapability, created.participantToken, { artifact: source, expectedVersion: 1, summary: "Add blocks" });
  assert.equal(set.version, 2);
  const setSnapshot = (await pool.query(`SELECT artifact_snapshot,runtime_state_snapshot FROM revisions WHERE id=$1`, [set.revision.id])).rows[0];
  assert.deepEqual(setSnapshot, { artifact_snapshot: set.artifact, runtime_state_snapshot: set.runtimeState });
  const revisionCount = (await pool.query(`SELECT count(*)::int AS count FROM revisions WHERE party_id=$1`, [id])).rows[0].count;
  const interaction = await service.updateBlocks(id, created.shareCapability, created.participantToken, { expectedVersion: 2, statePatch: { one: { count: 2 } } });
  assert.equal(interaction.version, 2);
  assert.equal(interaction.revision, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM revisions WHERE party_id=$1`, [id])).rows[0].count, revisionCount);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM audit_events WHERE party_id=$1 AND event_type='runtime_state_updated'`, [id])).rows[0].count, 1);

  const updated = await service.updateBlocks(id, created.shareCapability, created.participantToken, {
    expectedVersion: 2, updates: [{ id: "one", title: "Changed" }], statePatch: { one: { count: 7 } }, summary: "Change source and state",
  });
  assert.equal(updated.version, 3);
  const updateSnapshot = (await pool.query(`SELECT blocks,artifact_snapshot,runtime_state_snapshot,snapshot_available FROM revisions WHERE id=$1`, [updated.revision.id])).rows[0];
  assert.equal(updateSnapshot.blocks, null);
  assert.deepEqual(updateSnapshot.artifact_snapshot, updated.artifact);
  assert.deepEqual(updateSnapshot.runtime_state_snapshot, updated.runtimeState);
  assert.equal(updateSnapshot.snapshot_available, true);

  const feedback = await service.addFeedback(id, created.shareCapability, created.participantToken, { blockId: "two", kind: "change", body: "Keep this visible" });
  await rejectsCode(() => service.deleteBlocks(id, created.shareCapability, created.participantToken, { blockIds: ["two"], expectedVersion: 2, summary: "Stale" }), "VERSION_CONFLICT");
  const deleted = await service.deleteBlocks(id, created.shareCapability, created.participantToken, { blockIds: ["one", "two"], expectedVersion: 3 });
  assert.equal(deleted.version, 4);
  assert.deepEqual(deleted.artifact.blocks, []);
  assert.deepEqual(deleted.runtimeState, {});
  assert.equal(deleted.revision.actor_identity_id, created.participant.id);
  const deleteSnapshot = (await pool.query(`SELECT artifact_snapshot,runtime_state_snapshot FROM revisions WHERE id=$1`, [deleted.revision.id])).rows[0];
  assert.deepEqual(deleteSnapshot, { artifact_snapshot: deleted.artifact, runtime_state_snapshot: deleted.runtimeState });
  const archived = await service.getFeedback(id, created.shareCapability, created.participantToken);
  assert.equal(archived.find(item => item.id === feedback.id).anchorStatus, "archived");
  const archivedResponse = await service.respondToFeedback(id, created.shareCapability, agent.participantToken, feedback.id, { body: "Archived feedback remains respondable" });
  assert.equal(archivedResponse.feedback.id, feedback.id);
  assert.equal((await service.getParty(id, created.ownerCapability, created.participantToken)).openFeedback, 0);

  const legacyId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO revisions (id,party_id,version,source,blocks,changed_block_ids,actor_identity_id) VALUES ($1,$2,99,'update_blocks','[]','{}',$3)`,
    [legacyId, id, created.participant.id],
  );
  await rejectsCode(() => service.restoreRevision(id, created.shareCapability, created.participantToken, legacyId, { expectedVersion: 4, summary: "Cannot invent legacy state" }), "INVALID_STATE");

  const restored = await service.restoreRevision(id, created.shareCapability, created.participantToken, updated.revision.id, { expectedVersion: 4 });
  assert.equal(restored.version, 5);
  assert.equal(restored.restoredFromVersion, 3);
  assert.deepEqual(restored.artifact, updated.artifact);
  assert.deepEqual(restored.runtimeState, updated.runtimeState);
  assert.deepEqual(restored.changedBlockIds, ["one", "two"]);
  const restoreSnapshot = (await pool.query(`SELECT artifact_snapshot,runtime_state_snapshot FROM revisions WHERE id=$1`, [restored.revision.id])).rows[0];
  assert.deepEqual(restoreSnapshot, { artifact_snapshot: restored.artifact, runtime_state_snapshot: restored.runtimeState });
  assert.equal((await service.getFeedback(id, created.shareCapability, created.participantToken))[0].anchorStatus, "active");
  assert.equal((await service.getParty(id, created.ownerCapability, created.participantToken)).openFeedback, 1);

  await service.deleteBlocks(id, created.shareCapability, created.participantToken, { blockIds: ["two"], expectedVersion: 5, summary: "Archive before final" });
  const before = await service.getStorage(id, created.ownerCapability, created.participantToken);
  const tableNames = ["parties", "artifacts", "revisions", "feedback", "feedback_responses", "final_versions", "audit_events", "participants", "participant_sessions"];
  assert.deepEqual(Object.keys(before.byTable).sort(), tableNames.sort());
  assert.equal(before.quotaBytes, null);
  assert.equal(before.scope, "party_row_data_only");
  assert.deepEqual(before.excludes, ["relation_and_page_overhead", "indexes", "toast_relation_allocation"]);
  assert.equal(before.byTable.revisions!.rows, 7);
  const final = await service.finalizeParty(id, created.ownerCapability, created.participantToken, { name: "Archived feedback final", expectedVersion: 6 });
  assert.equal(final.final.open_feedback_overridden, false);
  assert.equal(final.final.format, restored.artifact.format);
  assert.equal(final.final.title, restored.artifact.title);
  assert.deepEqual(final.final.blocks, restored.artifact.blocks.filter(block => block.id !== "two"));
  assert.deepEqual(final.final.runtime_state, { one: { count: 7 } });
  const pruned = await pool.query(`SELECT snapshot_available,snapshot_pruned,artifact_snapshot,runtime_state_snapshot,blocks FROM revisions WHERE party_id=$1`, [id]);
  assert.ok(pruned.rows.every(row => row.snapshot_available === false && row.snapshot_pruned === true && row.artifact_snapshot === null && row.runtime_state_snapshot === null && row.blocks === null));
  const after = await service.getStorage(id, created.ownerCapability, created.participantToken);
  assert.ok(after.byTable.revisions!.accountedRowBytes < before.byTable.revisions!.accountedRowBytes);
  assert.ok(after.accountedRowBytes < before.accountedRowBytes);
  assert.deepEqual((await service.getFinalArtifact(id, created.shareCapability, created.participantToken)).html, final.final.html);
  await rejectsCode(() => service.restoreRevision(id, created.ownerCapability, created.participantToken, updated.revision.id, { expectedVersion: 6, summary: "Terminal" }), "INVALID_STATE");
  const finalView = await service.getParty(id, created.ownerCapability, created.participantToken);
  assert.deepEqual(finalView.availableOperations, ["get_party", "get_feedback", "get_final_artifact"]);
  assert.deepEqual(finalView.availableApiOperations, finalView.availableOperations);
});

test("HTTP boundary parses bearer capabilities, enforces roles, and pins Electric shape scope", async () => {
  const request = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  const jsonRequest = (path: string, value: unknown, capability?: string, method = "POST", participantToken?: string) => request(path, {
    method,
    headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}), ...(participantToken ? { "x-participant-token": participantToken } : {}) },
    body: JSON.stringify(value),
  });

  const malformed = await request(`/api/parties/00000000-0000-4000-8000-000000000000`, { headers: { authorization: "Basic nope" } });
  assert.equal(malformed.status, 400);
  const createdResponse = await jsonRequest("/api/parties", { title: "HTTP party", participant: { name: owner.name, kind: owner.kind } });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as Awaited<ReturnType<BuildPartyService["createParty"]>>;
  const agentJoin = await jsonRequest(`/api/parties/${created.party.id}/participants`, { participant: { name: reviewer.name, kind: reviewer.kind } }, created.shareCapability);
  const agentSession = await agentJoin.json() as Awaited<ReturnType<BuildPartyService["joinParty"]>>;
  const humanJoin = await jsonRequest(`/api/parties/${created.party.id}/participants`, { participant: { name: humanReviewer.name, kind: humanReviewer.kind } }, created.shareCapability);
  const humanSession = await humanJoin.json() as Awaited<ReturnType<BuildPartyService["joinParty"]>>;

  const unauthorizedTicket = await request(`/api/parties/${created.party.id}/presence-ticket`, { method: "POST", headers: { "x-participant-token": agentSession.participantToken } });
  assert.equal(unauthorizedTicket.status, 403);
  const otherResponse = await jsonRequest("/api/parties", { title: "Other HTTP party", participant: { name: "Other", kind: "human" } });
  const other = await otherResponse.json() as Awaited<ReturnType<BuildPartyService["createParty"]>>;
  const crossPartyTicket = await request(`/api/parties/${created.party.id}/presence-ticket`, { method: "POST", headers: { authorization: `Bearer ${created.shareCapability}`, "x-participant-token": other.participantToken } });
  assert.equal(crossPartyTicket.status, 403);
  const ticketResponse = await request(`/api/parties/${created.party.id}/presence-ticket`, { method: "POST", headers: { authorization: `Bearer ${created.shareCapability}`, "x-participant-token": agentSession.participantToken } });
  assert.equal(ticketResponse.status, 201);
  const ticketText = await ticketResponse.text();
  assert.doesNotMatch(ticketText, new RegExp(`${created.shareCapability}|${agentSession.participantToken}`));
  const ticket = (JSON.parse(ticketText) as { ticket: string }).ticket;
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  const presenceSocket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/api/presence?ticket=${encodeURIComponent(ticket)}`);
  const presencePayload = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("presence socket timed out")), 2_000); timer.unref();
    presenceSocket.once("message", data => { clearTimeout(timer); resolve(data.toString()); });
    presenceSocket.once("error", reject);
  });
  assert.doesNotMatch(`${presenceSocket.url}${presencePayload}`, new RegExp(`${created.shareCapability}|${agentSession.participantToken}`));
  assert.deepEqual([...new URL(presenceSocket.url).searchParams.keys()], ["ticket"]);
  await new Promise<void>(resolve => { presenceSocket.once("close", () => resolve()); presenceSocket.close(); });

  const setResponse = await jsonRequest(`/api/parties/${created.party.id}/artifact`, { artifact }, created.shareCapability, "PUT", agentSession.participantToken);
  assert.equal(setResponse.status, 200);
  const setValue = await setResponse.json() as { revision: { id: string } };
  const deleteResponse = await jsonRequest(`/api/parties/${created.party.id}/blocks`, { blockIds: ["scope"], expectedVersion: 1, summary: "HTTP delete" }, created.shareCapability, "DELETE", agentSession.participantToken);
  assert.equal(deleteResponse.status, 200);
  const restoreResponse = await jsonRequest(`/api/parties/${created.party.id}/revisions/${setValue.revision.id}/restore`, { expectedVersion: 2, summary: "HTTP restore" }, created.shareCapability, "POST", agentSession.participantToken);
  assert.equal(restoreResponse.status, 200);
  const storageResponse = await request(`/api/parties/${created.party.id}/storage`, { headers: { authorization: `Bearer ${created.shareCapability}`, "x-participant-token": agentSession.participantToken } });
  assert.equal(storageResponse.status, 200);
  const storage = await storageResponse.json();
  assert.equal(storage.scope, "party_row_data_only");
  assert.equal(storage.quotaBytes, null);
  assert.equal(typeof storage.accountedRowBytes, "number");
  assert.equal("totalBytes" in storage, false);
  assert.equal("bytes" in storage.byTable.revisions, false);
  const readResponse = await request(`/api/parties/${created.party.id}`, {
    headers: { authorization: `Bearer ${created.shareCapability}`, "x-participant-token": agentSession.participantToken },
  });
  const readText = await readResponse.text();
  assert.equal(readResponse.status, 200);
  assert.doesNotMatch(readText, new RegExp(created.ownerCapability));
  assert.doesNotMatch(readText, new RegExp(created.shareCapability));
  assert.doesNotMatch(readText, new RegExp(agentSession.participantToken));
  assert.doesNotMatch(readText, /capability_hash|participant_token|token_hash|server-only-electric-secret/);

  const queryOnly = await request(`/api/parties/${created.party.id}?cap=${created.shareCapability}`, { headers: { "x-participant-token": agentSession.participantToken } });
  assert.equal(queryOnly.status, 403);
  const fragmentOnly = await request(`/api/parties/${created.party.id}#cap=${created.shareCapability}`, { headers: { "x-participant-token": agentSession.participantToken } });
  assert.equal(fragmentOnly.status, 403, "URL fragments never reach the HTTP server");
  const assertedActor = await jsonRequest(`/api/parties/${created.party.id}/blocks`, { actor: owner, statePatch: { scope: { forged: true } } }, created.shareCapability, "PATCH", agentSession.participantToken);
  assert.equal(assertedActor.status, 400);

  const feedback = await jsonRequest(`/api/parties/${created.party.id}/feedback`, { blockId: "scope", kind: "comment", body: "Open concern" }, created.shareCapability, "POST", humanSession.participantToken);
  assert.equal(feedback.status, 201);
  const deniedFinalize = await jsonRequest(`/api/parties/${created.party.id}/finalize`, { name: "No" }, created.shareCapability, "POST", agentSession.participantToken);
  assert.equal(deniedFinalize.status, 403);
  const blockedFinalize = await jsonRequest(`/api/parties/${created.party.id}/finalize`, { name: "Yes", expectedVersion: 3 }, created.ownerCapability, "POST", created.participantToken);
  assert.equal(blockedFinalize.status, 409);
  assert.equal((await blockedFinalize.json()).error, "OPEN_FEEDBACK");
  const finalized = await jsonRequest(`/api/parties/${created.party.id}/finalize`, { name: "Yes", expectedVersion: 3, allowOpenFeedback: true }, created.ownerCapability, "POST", created.participantToken);
  assert.equal(finalized.status, 201);
  const finalJson = await request(`/api/parties/${created.party.id}/final`, { headers: { authorization: `Bearer ${created.shareCapability}`, "x-participant-token": humanSession.participantToken } });
  const finalValue = await finalJson.json();
  const exported = await request(`/api/parties/${created.party.id}/final/export`, { headers: { authorization: `Bearer ${created.shareCapability}`, "x-participant-token": humanSession.participantToken } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(exported.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(exported.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), Buffer.from(finalValue.html, "utf8"));
  const queryExport = await request(`/api/parties/${created.party.id}/final/export?cap=${created.shareCapability}`, { headers: { "x-participant-token": humanSession.participantToken } });
  assert.equal(queryExport.status, 403);

  const queryCapability = await request(`/api/parties/${created.party.id}/shapes/artifact?cap=${created.shareCapability}&offset=-1`);
  assert.equal(queryCapability.status, 403);
  proxied.length = 0;
  const hostile = await request(`/api/parties/${created.party.id}/shapes/artifact?table=audit_events&columns=owner_capability_hash&where=true&params%5B1%5D=00000000-0000-4000-8000-000000000000&secret=evil&cap=${created.shareCapability}&offset=-1&live=true`, {
    headers: { authorization: `Bearer ${created.shareCapability}` },
  });
  assert.equal(hostile.status, 200);
  assert.equal(proxied.length, 1);
  const upstream = proxied[0]!.url;
  assert.equal(upstream.searchParams.get("table"), shapes.artifact.table);
  assert.equal(upstream.searchParams.get("columns"), shapes.artifact.columns);
  assert.equal(upstream.searchParams.get("where"), shapes.artifact.where);
  assert.equal(upstream.searchParams.get("params[1]"), created.party.id);
  assert.equal(upstream.searchParams.get("secret"), "server-only-electric-secret");
  assert.equal(upstream.searchParams.get("offset"), "-1");
  assert.equal(upstream.searchParams.get("live"), "true");
  assert.ok(!upstream.toString().includes(created.ownerCapability));
  assert.ok(!upstream.toString().includes(created.shareCapability));
  assert.equal(new Headers(proxied[0]!.init?.headers).has("authorization"), false);

  assert.equal(shapes.audit.table, "audit_events");
  assert.match(shapes.revisions.columns, /snapshot_available/);
  assert.doesNotMatch(shapes.revisions.columns, /artifact_snapshot|runtime_state_snapshot|\bblocks\b/);
  assert.equal(shapes.audit.where, "party_id = $1");
  assert.ok(!Object.values(shapes).some(shape => String(shape.table) === "feedback_responses"), "responses invalidate through the party-scoped audit shape");
  assert.equal(shapes.participants.where, "party_id = $1");
  assert.equal(shapes.final.where, "party_id = $1");
});
