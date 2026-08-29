import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import {
  AppError, applyRuntimeState, assertMutable, blockIds, expectedVersion, feedbackIds, initialRuntimeState,
  lifecycleAfterResolution, lifecycleAfterUpdate, object, optionalText, requiredExpectedVersion,
  validateArtifact, validateCapability, validateParticipantProfile, validateParticipantToken, validateRuntimeState, validateText,
  validateUpdates, validateUuid, PARTY_OPERATIONS, WEBMCP_OPERATIONS, type Actor, type Artifact, type JsonObject, type Lifecycle,
  type ParticipantProfile, type RuntimeState, type SandboxBlock,
} from "./domain.ts";
import { renderFinalHtml } from "./final-html.ts";

type PartyRow = {
  id: string; title: string; lifecycle: Lifecycle;
  owner_capability_hash: string; share_capability_hash: string;
  created_at: Date; finalized_at: Date | null;
};
type ArtifactRow = { format: Artifact["format"]; title: string; blocks: SandboxBlock[]; runtime_state: RuntimeState; version: number; updated_at: Date };
type Access = { party: PartyRow; role: "owner" | "share" };

export { PARTY_OPERATIONS, WEBMCP_OPERATIONS } from "./domain.ts";
export const HUMAN_OPERATIONS = ["add_feedback"] as const;
export type StorageAccounting = {
  scope: "party_row_data_only";
  accountedRowBytes: number;
  byTable: Record<string, { accountedRowBytes: number; rows: number }>;
  quotaBytes: null;
  excludes: string[];
};

export class BuildPartyService {
  constructor(private pool: Pool, private publicOrigin = "http://localhost:5173") {}

  init() {
    return {
      operations: WEBMCP_OPERATIONS,
      apiOperations: PARTY_OPERATIONS,
      humanOperations: HUMAN_OPERATIONS,
      note: "The eleven WebMCP tools mirror the authoritative party API. Party access uses a bearer capability; attribution uses a party-bound participant token.",
    };
  }

  async createParty(input: unknown) {
    const body = object(input, "input");
    rejectAssertedActor(body);
    const profile = validateParticipantProfile(body.participant);
    const title = validateText(body.title, "title", 200);
    const id = randomUUID();
    const ownerCapability = token();
    const shareCapability = token();
    const participant = await this.tx(async (client) => {
      await client.query(
        `INSERT INTO parties (id,title,owner_capability_hash,share_capability_hash) VALUES ($1,$2,$3,$4)`,
        [id, title, hash(ownerCapability), hash(shareCapability)],
      );
      const created = await this.createParticipant(client, id, profile);
      await this.audit(client, id, "party_created", created.participant, { lifecycle: "initialized" });
      return created;
    });
    const base = `${this.publicOrigin.replace(/\/$/, "")}/party/${id}`;
    return {
      party: { id, title, lifecycle: "initialized" as const },
      ...participant,
      ownerCapability,
      shareCapability,
      ownerUrl: `${base}#cap=${encodeURIComponent(ownerCapability)}`,
      shareUrl: `${base}#cap=${encodeURIComponent(shareCapability)}`,
    };
  }

  async joinParty(idInput: unknown, capabilityInput: unknown, input: unknown) {
    const id = validateUuid(idInput, "partyId");
    const body = object(input, "input");
    rejectAssertedActor(body);
    const profile = validateParticipantProfile(body.participant);
    return this.tx(async client => {
      await this.authorize(client, id, capabilityInput);
      return this.createParticipant(client, id, profile);
    });
  }

  async getParty(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown) {
    const id = validateUuid(idInput, "partyId");
    return this.tx(async (client) => {
      const access = await this.authorize(client, id, capabilityInput);
      await this.authenticate(client, id, participantTokenInput);
      const artifact = await client.query<ArtifactRow>(`SELECT format,title,blocks,runtime_state,version,updated_at FROM artifacts WHERE party_id=$1`, [id]);
      const participants = await client.query(`SELECT identity_id AS id,display_name AS name,kind,first_seen_at,last_seen_at FROM participants WHERE party_id=$1 ORDER BY first_seen_at`, [id]);
      const revisions = await client.query(`SELECT id,version,source,changed_block_ids,feedback_ids,summary,actor_identity_id,created_at,snapshot_available,snapshot_pruned,snapshot_bytes FROM revisions WHERE party_id=$1 ORDER BY version`, [id]);
      const feedbackCount = await client.query<{ open: number }>(
        `SELECT count(*)::int AS open FROM feedback f WHERE f.party_id=$1 AND f.status='open'
         AND EXISTS (SELECT 1 FROM artifacts a, jsonb_array_elements(a.blocks) block WHERE a.party_id=f.party_id AND block->>'id'=f.block_id)`, [id],
      );
      const value = artifact.rows[0] ?? null;
      const availableApiOperations = operationsFor(access.party.lifecycle, access.role, Boolean(value), Boolean(value?.blocks.length), revisions.rows.some(revision => revision.snapshot_available));
      return {
        party: { id: access.party.id, title: access.party.title, lifecycle: access.party.lifecycle, createdAt: access.party.created_at, finalizedAt: access.party.finalized_at },
        artifact: value ? { format: value.format, title: value.title, blocks: value.blocks } : null,
        runtimeState: value?.runtime_state ?? null,
        version: value?.version ?? null,
        updatedAt: value?.updated_at ?? null,
        participants: participants.rows,
        revisions: revisions.rows.map(revision => ({ ...revision, snapshot_bytes: revision.snapshot_bytes === null ? null : Number(revision.snapshot_bytes) })),
        openFeedback: feedbackCount.rows[0]?.open ?? 0,
        access: access.role,
        availableOperations: availableApiOperations.filter(operation => WEBMCP_OPERATIONS.includes(operation as typeof WEBMCP_OPERATIONS[number])),
        availableApiOperations,
        humanOperations: humanOperationsFor(access.party.lifecycle, Boolean(value)),
      };
    });
  }

  async setArtifact(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown, input: unknown) {
    const id = validateUuid(idInput, "partyId");
    const body = object(input, "input");
    rejectAssertedActor(body);
    const artifactInput = validateArtifact(body.artifact);
    const summary = optionalText(body.summary, "summary", 500);
    const wantedVersion = expectedVersion(body.expectedVersion);
    return this.tx(async (client) => {
      const access = await this.authorize(client, id, capabilityInput, false, true);
      assertMutable(access.party.lifecycle);
      const actor = await this.authenticate(client, id, participantTokenInput);
      const existing = (await client.query<ArtifactRow>(`SELECT format,title,blocks,runtime_state,version,updated_at FROM artifacts WHERE party_id=$1 FOR UPDATE`, [id])).rows[0];
      if (wantedVersion !== undefined && wantedVersion !== existing?.version) throw new AppError("VERSION_CONFLICT", "artifact version changed", 409);
      const defaults = initialRuntimeState(artifactInput.blocks);
      const carried = Object.fromEntries(artifactInput.blocks.map(block => [block.id, existing?.runtime_state[block.id] ?? defaults[block.id]!])) as RuntimeState;
      const runtimeState = applyRuntimeState(carried, body.statePatch, body.resetState, artifactInput.blocks);
      const version = (existing?.version ?? 0) + 1;
      await client.query(
        `INSERT INTO artifacts (party_id,format,title,blocks,runtime_state,version) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (party_id) DO UPDATE SET format=EXCLUDED.format,title=EXCLUDED.title,blocks=EXCLUDED.blocks,runtime_state=EXCLUDED.runtime_state,version=EXCLUDED.version,updated_at=now()`,
        [id, artifactInput.format, artifactInput.title, JSON.stringify(artifactInput.blocks), JSON.stringify(runtimeState), version],
      );
      await client.query(`UPDATE parties SET lifecycle='in_review' WHERE id=$1`, [id]);
      const changedIds = existing
        ? changedBlockIds({ format: existing.format, title: existing.title, blocks: existing.blocks }, artifactInput)
        : artifactInput.blocks.map(block => block.id);
      const revision = await this.revision(client, id, version, "set_artifact", artifactInput, runtimeState, changedIds, [], summary, actor);
      await this.audit(client, id, "artifact_set", actor, { revisionId: revision.id, version, lifecycle: "in_review" });
      return { artifact: artifactInput, runtimeState, version, revision, lifecycle: "in_review" as const };
    });
  }

  async updateBlocks(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown, input: unknown) {
    const id = validateUuid(idInput, "partyId");
    const body = object(input, "input");
    rejectAssertedActor(body);
    const updates = body.updates === undefined ? [] : validateUpdates(body.updates);
    if (updates.length === 0 && body.statePatch === undefined && body.resetState !== true) throw new AppError("VALIDATION_ERROR", "an update needs block changes, statePatch, or resetState", 400);
    const linkedFeedback = feedbackIds(body.feedbackIds);
    if (updates.length === 0 && linkedFeedback.length) throw new AppError("VALIDATION_ERROR", "feedback can only be linked to a source update", 400);
    const summary = optionalText(body.summary, "summary", 500);
    const wantedVersion = expectedVersion(body.expectedVersion);
    return this.tx(async (client) => {
      const access = await this.authorize(client, id, capabilityInput, false, true);
      const lifecycle = lifecycleAfterUpdate(access.party.lifecycle, linkedFeedback.length > 0);
      const actor = await this.authenticate(client, id, participantTokenInput);
      const artifact = (await client.query<ArtifactRow>(`SELECT format,title,blocks,runtime_state,version,updated_at FROM artifacts WHERE party_id=$1 FOR UPDATE`, [id])).rows[0];
      if (!artifact) throw new AppError("INVALID_STATE", "set an artifact before updating blocks", 409);
      if (wantedVersion !== undefined && wantedVersion !== artifact.version) throw new AppError("VERSION_CONFLICT", "artifact version changed", 409);
      const byId = new Map(artifact.blocks.map((block) => [block.id, block]));
      for (const update of updates) {
        const current = byId.get(update.id);
        if (!current) throw new AppError("VALIDATION_ERROR", `unknown block: ${update.id}`, 400);
        byId.set(update.id, { ...current, ...update, source: update.source ? { ...current.source, ...update.source } : current.source });
      }
      if (linkedFeedback.length) {
        const found = await client.query<{ id: string; status: string }>(`SELECT id,status FROM feedback WHERE party_id=$1 AND id=ANY($2::uuid[])`, [id, linkedFeedback]);
        if (found.rowCount !== linkedFeedback.length) throw new AppError("VALIDATION_ERROR", "feedbackIds contains feedback outside this party", 400);
        if (found.rows.some((item) => item.status !== "open")) throw new AppError("VALIDATION_ERROR", "only open feedback can be linked to an update", 400);
      }
      const blocks = artifact.blocks.map((block) => byId.get(block.id)!);
      const runtimeState = applyRuntimeState(artifact.runtime_state, body.statePatch, body.resetState, blocks);
      if (updates.length === 0) {
        await client.query(`UPDATE artifacts SET runtime_state=$2,updated_at=now() WHERE party_id=$1`, [id, JSON.stringify(runtimeState)]);
        await this.audit(client, id, "runtime_state_updated", actor, { version: artifact.version, reset: body.resetState === true, blockIds: Object.keys(body.statePatch ?? {}) });
        return { artifact: { format: artifact.format, title: artifact.title, blocks }, runtimeState, version: artifact.version, revision: null, lifecycle: access.party.lifecycle };
      }
      const version = artifact.version + 1;
      await client.query(`UPDATE artifacts SET blocks=$2,runtime_state=$3,version=$4,updated_at=now() WHERE party_id=$1`, [id, JSON.stringify(blocks), JSON.stringify(runtimeState), version]);
      if (lifecycle !== access.party.lifecycle) await client.query(`UPDATE parties SET lifecycle=$2 WHERE id=$1`, [id, lifecycle]);
      const changedIds = updates.map((update) => update.id);
      const artifactSnapshot: Artifact = { format: artifact.format, title: artifact.title, blocks };
      const revision = await this.revision(client, id, version, "update_blocks", artifactSnapshot, runtimeState, changedIds, linkedFeedback, summary, actor);
      await this.audit(client, id, "blocks_updated", actor, { revisionId: revision.id, version, changedBlockIds: changedIds, feedbackIds: linkedFeedback, lifecycle });
      return { artifact: artifactSnapshot, runtimeState, version, revision, lifecycle };
    });
  }

  async deleteBlocks(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown, input: unknown) {
    const id = validateUuid(idInput, "partyId");
    const body = object(input, "input");
    rejectAssertedActor(body);
    const deletedIds = blockIds(body.blockIds);
    const wantedVersion = requiredExpectedVersion(body.expectedVersion);
    const summary = optionalText(body.summary, "summary", 500);
    return this.tx(async client => {
      const access = await this.authorize(client, id, capabilityInput, false, true);
      lifecycleAfterUpdate(access.party.lifecycle, false);
      const actor = await this.authenticate(client, id, participantTokenInput);
      const current = (await client.query<ArtifactRow>(`SELECT format,title,blocks,runtime_state,version,updated_at FROM artifacts WHERE party_id=$1 FOR UPDATE`, [id])).rows[0];
      if (!current) throw new AppError("INVALID_STATE", "set an artifact before deleting blocks", 409);
      if (wantedVersion !== current.version) throw new AppError("VERSION_CONFLICT", "artifact version changed", 409);
      const existing = new Set(current.blocks.map(block => block.id));
      const missing = deletedIds.find(blockId => !existing.has(blockId));
      if (missing) throw new AppError("VALIDATION_ERROR", `unknown block: ${missing}`, 400);
      const blocks = current.blocks.filter(block => !deletedIds.includes(block.id));
      const runtimeState = Object.fromEntries(Object.entries(current.runtime_state).filter(([blockId]) => !deletedIds.includes(blockId))) as RuntimeState;
      const artifact: Artifact = { format: current.format, title: current.title, blocks };
      const version = current.version + 1;
      await client.query(`UPDATE artifacts SET blocks=$2,runtime_state=$3,version=$4,updated_at=now() WHERE party_id=$1`, [id, JSON.stringify(blocks), JSON.stringify(runtimeState), version]);
      const revision = await this.revision(client, id, version, "delete_blocks", artifact, runtimeState, deletedIds, [], summary, actor);
      await this.audit(client, id, "blocks_deleted", actor, { revisionId: revision.id, version, changedBlockIds: deletedIds, lifecycle: access.party.lifecycle });
      return { artifact, runtimeState, version, revision, lifecycle: access.party.lifecycle, deletedBlockIds: deletedIds };
    });
  }

  async restoreRevision(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown, revisionIdInput: unknown, input: unknown) {
    const id = validateUuid(idInput, "partyId");
    const revisionId = validateUuid(revisionIdInput, "revisionId");
    const body = object(input, "input");
    rejectAssertedActor(body);
    const wantedVersion = requiredExpectedVersion(body.expectedVersion);
    const summary = optionalText(body.summary, "summary", 500);
    return this.tx(async client => {
      const access = await this.authorize(client, id, capabilityInput, false, true);
      lifecycleAfterUpdate(access.party.lifecycle, false);
      const actor = await this.authenticate(client, id, participantTokenInput);
      const current = (await client.query<ArtifactRow>(`SELECT format,title,blocks,runtime_state,version,updated_at FROM artifacts WHERE party_id=$1 FOR UPDATE`, [id])).rows[0];
      if (!current) throw new AppError("INVALID_STATE", "set an artifact before restoring a revision", 409);
      if (wantedVersion !== current.version) throw new AppError("VERSION_CONFLICT", "artifact version changed", 409);
      const source = (await client.query<{ version: number; artifact_snapshot: unknown; runtime_state_snapshot: unknown; snapshot_pruned: boolean }>(
        `SELECT version,artifact_snapshot,runtime_state_snapshot,snapshot_pruned FROM revisions WHERE id=$1 AND party_id=$2`, [revisionId, id],
      )).rows[0];
      if (!source) throw new AppError("NOT_FOUND", "revision not found", 404);
      if (source.snapshot_pruned) throw new AppError("INVALID_STATE", "revision snapshot was pruned after finalization", 409);
      if (source.artifact_snapshot === null || source.runtime_state_snapshot === null) throw new AppError("INVALID_STATE", "revision snapshot is unavailable for this legacy revision", 409);
      const artifact = validateArtifact(source.artifact_snapshot);
      const runtimeState = validateRuntimeState(source.runtime_state_snapshot, artifact.blocks, "revision.runtimeState");
      const changedIds = changedBlockIds({ format: current.format, title: current.title, blocks: current.blocks }, artifact);
      const version = current.version + 1;
      await client.query(`UPDATE artifacts SET format=$2,title=$3,blocks=$4,runtime_state=$5,version=$6,updated_at=now() WHERE party_id=$1`, [id, artifact.format, artifact.title, JSON.stringify(artifact.blocks), JSON.stringify(runtimeState), version]);
      const revision = await this.revision(client, id, version, "restore_revision", artifact, runtimeState, changedIds, [], summary, actor);
      await this.audit(client, id, "revision_restored", actor, { revisionId: revision.id, restoredFromRevisionId: revisionId, restoredFromVersion: source.version, version, changedBlockIds: changedIds, lifecycle: access.party.lifecycle });
      return { artifact, runtimeState, version, revision, lifecycle: access.party.lifecycle, restoredFromRevisionId: revisionId, restoredFromVersion: source.version, changedBlockIds: changedIds };
    });
  }

  async addFeedback(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown, input: unknown) {
    const id = validateUuid(idInput, "partyId");
    const body = object(input, "input");
    rejectAssertedActor(body);
    const blockId = validateText(body.blockId, "blockId", 64);
    const kind = String(body.kind);
    if (!["comment", "question", "change", "approval", "disagreement"].includes(kind)) throw new AppError("VALIDATION_ERROR", "invalid feedback kind", 400);
    const text = validateText(body.body, "body", 10_000);
    return this.tx(async (client) => {
      const access = await this.authorize(client, id, capabilityInput, false, true);
      assertMutable(access.party.lifecycle);
      const actor = await this.authenticate(client, id, participantTokenInput);
      if (actor.kind !== "human") throw new AppError("FORBIDDEN", "only humans can add feedback", 403);
      const artifact = (await client.query<ArtifactRow>(`SELECT blocks,runtime_state,version,updated_at FROM artifacts WHERE party_id=$1`, [id])).rows[0];
      if (!artifact) throw new AppError("INVALID_STATE", "set an artifact before adding feedback", 409);
      if (blockId && !artifact.blocks.some((block) => block.id === blockId)) throw new AppError("VALIDATION_ERROR", "feedback block does not exist", 400);
      const feedbackId = randomUUID();
      const feedback = (await client.query(
        `INSERT INTO feedback (id,party_id,block_id,kind,body,actor_identity_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [feedbackId, id, blockId, kind, text, actor.id],
      )).rows[0];
      await this.audit(client, id, "feedback_created", actor, { feedbackId, blockId, kind });
      return feedback;
    });
  }

  async getFeedback(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown, statusInput: unknown = "all") {
    const id = validateUuid(idInput, "partyId");
    if (!["open", "resolved", "all"].includes(statusInput as string)) throw new AppError("VALIDATION_ERROR", "status must be open, resolved, or all", 400);
    return this.tx(async (client) => {
      await this.authorize(client, id, capabilityInput);
      await this.authenticate(client, id, participantTokenInput);
      const rows = await client.query(
        `SELECT f.*,
         CASE WHEN EXISTS (SELECT 1 FROM artifacts a, jsonb_array_elements(a.blocks) block WHERE a.party_id=f.party_id AND block->>'id'=f.block_id) THEN 'active' ELSE 'archived' END AS "anchorStatus",
         COALESCE(json_agg(r ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL),'[]') AS responses
         FROM feedback f LEFT JOIN feedback_responses r ON r.feedback_id=f.id
         WHERE f.party_id=$1 AND ($2='all' OR f.status=$2) GROUP BY f.id ORDER BY f.created_at`,
        [id, statusInput],
      );
      return rows.rows;
    });
  }

  async respondToFeedback(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown, feedbackIdInput: unknown, input: unknown) {
    const id = validateUuid(idInput, "partyId");
    const feedbackId = validateUuid(feedbackIdInput, "feedbackId");
    const body = object(input, "input");
    rejectAssertedActor(body);
    const text = optionalText(body.body, "body", 10_000);
    const revisionId = body.revisionId === undefined ? undefined : validateUuid(body.revisionId, "revisionId");
    if (body.resolve !== undefined && typeof body.resolve !== "boolean") throw new AppError("VALIDATION_ERROR", "resolve must be boolean", 400);
    const resolve = body.resolve === true;
    if (resolve && !revisionId) throw new AppError("VALIDATION_ERROR", "resolving feedback requires a linked revision", 400);
    if (!text && !revisionId && !resolve) throw new AppError("VALIDATION_ERROR", "a response needs body, revisionId, or resolve", 400);
    return this.tx(async (client) => {
      const access = await this.authorize(client, id, capabilityInput, false, true);
      assertMutable(access.party.lifecycle);
      const actor = await this.authenticate(client, id, participantTokenInput);
      if (actor.kind !== "agent") throw new AppError("FORBIDDEN", "only agents can respond to or resolve feedback", 403);
      const feedback = (await client.query(`SELECT * FROM feedback WHERE id=$1 AND party_id=$2 FOR UPDATE`, [feedbackId, id])).rows[0];
      if (!feedback) throw new AppError("NOT_FOUND", "feedback not found", 404);
      if (revisionId) {
        const revision = await client.query(`SELECT 1 FROM revisions WHERE id=$1 AND party_id=$2 AND $3::uuid=ANY(feedback_ids)`, [revisionId, id, feedbackId]);
        if (!revision.rowCount) throw new AppError("VALIDATION_ERROR", "revision must explicitly address this feedback", 400);
      }
      const responseId = randomUUID();
      const response = (await client.query(
        `INSERT INTO feedback_responses (id,feedback_id,body,revision_id,resolved,actor_identity_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [responseId, feedbackId, text ?? null, revisionId ?? null, resolve, actor.id],
      )).rows[0];
      if (resolve && feedback.status === "open") await client.query(`UPDATE feedback SET status='resolved',resolved_at=now(),resolved_by_identity_id=$2 WHERE id=$1`, [feedbackId, actor.id]);
      const open = (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM feedback f WHERE f.party_id=$1 AND f.status='open'
         AND EXISTS (SELECT 1 FROM artifacts a, jsonb_array_elements(a.blocks) block WHERE a.party_id=f.party_id AND block->>'id'=f.block_id)`, [id],
      )).rows[0]?.count ?? 0;
      const lifecycle = lifecycleAfterResolution(access.party.lifecycle, open);
      if (lifecycle !== access.party.lifecycle) await client.query(`UPDATE parties SET lifecycle=$2 WHERE id=$1`, [id, lifecycle]);
      await this.audit(client, id, "feedback_responded", actor, { feedbackId, responseId, ...(revisionId ? { revisionId } : {}), resolved: resolve, lifecycle });
      return { response, feedback: { ...feedback, status: resolve ? "resolved" : feedback.status }, lifecycle };
    });
  }

  async finalizeParty(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown, input: unknown) {
    const id = validateUuid(idInput, "partyId");
    const body = object(input, "input");
    rejectAssertedActor(body);
    const name = validateText(body.name, "name", 200);
    const wantedVersion = expectedVersion(body.expectedVersion);
    if (body.allowOpenFeedback !== undefined && typeof body.allowOpenFeedback !== "boolean") throw new AppError("VALIDATION_ERROR", "allowOpenFeedback must be boolean", 400);
    const allowOpen = body.allowOpenFeedback === true;
    return this.tx(async (client) => {
      const access = await this.authorize(client, id, capabilityInput, true, true);
      assertMutable(access.party.lifecycle);
      const actor = await this.authenticate(client, id, participantTokenInput);
      const artifact = (await client.query<ArtifactRow>(`SELECT format,title,blocks,runtime_state,version,updated_at FROM artifacts WHERE party_id=$1 FOR UPDATE`, [id])).rows[0];
      if (!artifact) throw new AppError("INVALID_STATE", "cannot finalize without an artifact", 409);
      if (wantedVersion !== undefined && wantedVersion !== artifact.version) throw new AppError("VERSION_CONFLICT", "artifact version changed", 409);
      const open = (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM feedback f WHERE f.party_id=$1 AND f.status='open'
         AND EXISTS (SELECT 1 FROM artifacts a, jsonb_array_elements(a.blocks) block WHERE a.party_id=f.party_id AND block->>'id'=f.block_id)`, [id],
      )).rows[0]?.count ?? 0;
      if (open > 0 && !allowOpen) throw new AppError("OPEN_FEEDBACK", "open active feedback requires explicit override", 409);
      const finalId = randomUUID();
      const html = renderFinalHtml({ format: artifact.format, title: artifact.title, blocks: artifact.blocks }, artifact.runtime_state);
      const final = (await client.query(
        `INSERT INTO final_versions (id,party_id,name,source_version,format,title,blocks,runtime_state,html,actor_identity_id,open_feedback_overridden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [finalId, id, name, artifact.version, artifact.format, artifact.title, JSON.stringify(artifact.blocks), JSON.stringify(artifact.runtime_state), html, actor.id, open > 0],
      )).rows[0];
      await client.query(`UPDATE parties SET lifecycle='finalized',finalized_at=now() WHERE id=$1`, [id]);
      await client.query(`UPDATE revisions SET blocks=NULL,artifact_snapshot=NULL,runtime_state_snapshot=NULL,snapshot_available=false,snapshot_pruned=true WHERE party_id=$1`, [id]);
      await this.audit(client, id, "party_finalized", actor, { finalId, sourceVersion: artifact.version, openFeedback: open, overridden: open > 0, revisionSnapshotsPruned: true });
      return { final, lifecycle: "finalized" as const };
    });
  }

  async getFinalArtifact(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown) {
    const id = validateUuid(idInput, "partyId");
    return this.tx(async (client) => {
      await this.authorize(client, id, capabilityInput);
      await this.authenticate(client, id, participantTokenInput);
      const final = (await client.query(`SELECT * FROM final_versions WHERE party_id=$1`, [id])).rows[0];
      if (!final) throw new AppError("NOT_FINALIZED", "party has not been finalized", 409);
      return final;
    });
  }

  async getAuditEvents(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown) {
    const id = validateUuid(idInput, "partyId");
    return this.tx(async (client) => {
      await this.authorize(client, id, capabilityInput);
      await this.authenticate(client, id, participantTokenInput);
      return (await client.query(`SELECT id,event_type,actor_identity_id,details,created_at FROM audit_events WHERE party_id=$1 ORDER BY id`, [id])).rows;
    });
  }

  async getStorage(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown) {
    const id = validateUuid(idInput, "partyId");
    return this.tx(async client => {
      await this.authorize(client, id, capabilityInput);
      await this.authenticate(client, id, participantTokenInput);
      return this.storage(client, id);
    });
  }

  async authorizeShape(idInput: unknown, capabilityInput: unknown): Promise<void> {
    const id = validateUuid(idInput, "partyId");
    await this.tx(async client => { await this.authorize(client, id, capabilityInput); });
  }

  async authorizePresence(idInput: unknown, capabilityInput: unknown, participantTokenInput: unknown) {
    const id = validateUuid(idInput, "partyId");
    return this.tx(async client => {
      const access = await this.authorize(client, id, capabilityInput);
      const participant = await this.authenticate(client, id, participantTokenInput);
      const artifact = (await client.query<Pick<ArtifactRow, "blocks">>(`SELECT blocks FROM artifacts WHERE party_id=$1`, [id])).rows[0];
      return { participant, writable: access.party.lifecycle !== "finalized", blockIds: artifact?.blocks.map(block => block.id) ?? [] };
    });
  }

  private async tx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  private async authorize(client: PoolClient, id: string, capabilityInput: unknown, ownerOnly = false, lock = false): Promise<Access> {
    const capability = validateCapability(capabilityInput);
    const party = (await client.query<PartyRow>(`SELECT * FROM parties WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
    if (!party) throw new AppError("NOT_FOUND", "party not found", 404);
    const supplied = Buffer.from(hash(capability), "hex");
    const owner = timingSafeEqual(supplied, Buffer.from(party.owner_capability_hash, "hex"));
    const share = timingSafeEqual(supplied, Buffer.from(party.share_capability_hash, "hex"));
    if (!owner && (!share || ownerOnly)) throw new AppError("FORBIDDEN", "capability does not permit this operation", 403);
    return { party, role: owner ? "owner" : "share" };
  }

  private async createParticipant(client: PoolClient, partyId: string, profile: ParticipantProfile) {
    const participant = { id: randomUUID(), ...profile };
    const participantToken = token();
    await client.query(`INSERT INTO participants (party_id,identity_id,display_name,kind) VALUES ($1,$2,$3,$4)`, [partyId, participant.id, participant.name, participant.kind]);
    await client.query(
      `INSERT INTO participant_sessions (id,party_id,identity_id,token_hash) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), partyId, participant.id, hash(participantToken)],
    );
    return { participant, participantToken };
  }

  private async authenticate(client: PoolClient, partyId: string, tokenInput: unknown): Promise<Actor> {
    const participantToken = validateParticipantToken(tokenInput);
    const row = (await client.query<Actor & { session_id: string }>(
      `SELECT p.identity_id AS id,p.display_name AS name,p.kind,s.id AS session_id
       FROM participant_sessions s JOIN participants p ON p.party_id=s.party_id AND p.identity_id=s.identity_id
       WHERE s.party_id=$1 AND s.token_hash=$2`,
      [partyId, hash(participantToken)],
    )).rows[0];
    if (!row) throw new AppError("FORBIDDEN", "participant token does not belong to this party", 403);
    await client.query(`UPDATE participant_sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval '1 minute'`, [row.session_id]);
    return { id: row.id, name: row.name, kind: row.kind };
  }

  private async revision(client: PoolClient, partyId: string, version: number, source: string, artifact: Artifact, runtimeState: RuntimeState, changedIds: string[], linkedFeedback: string[], summary: string | undefined, actor: Actor) {
    const id = randomUUID();
    const artifactJson = JSON.stringify(artifact);
    const runtimeJson = JSON.stringify(runtimeState);
    return (await client.query(
      `INSERT INTO revisions (id,party_id,version,source,artifact_snapshot,runtime_state_snapshot,snapshot_bytes,snapshot_available,changed_block_ids,feedback_ids,summary,actor_identity_id)
       VALUES ($1,$2,$3,$4,$5,$6,pg_column_size($5::jsonb)+pg_column_size($6::jsonb),true,$7,$8,$9,$10)
       RETURNING id,version,source,changed_block_ids,feedback_ids,summary,actor_identity_id,created_at,snapshot_available,snapshot_pruned,snapshot_bytes`,
      [id, partyId, version, source, artifactJson, runtimeJson, changedIds, linkedFeedback, summary ?? null, actor.id],
    )).rows[0];
  }

  private async storage(client: PoolClient, partyId: string): Promise<StorageAccounting> {
    const rows = (await client.query<{ table_name: string; rows: number; bytes: string }>(
      `SELECT 'parties' table_name,count(*)::int rows,COALESCE(sum(pg_column_size(p)),0)::bigint bytes FROM parties p WHERE id=$1
       UNION ALL SELECT 'artifacts',count(*)::int,COALESCE(sum(pg_column_size(a)),0)::bigint FROM artifacts a WHERE party_id=$1
       UNION ALL SELECT 'revisions',count(*)::int,COALESCE(sum(pg_column_size(r)),0)::bigint FROM revisions r WHERE party_id=$1
       UNION ALL SELECT 'feedback',count(*)::int,COALESCE(sum(pg_column_size(f)),0)::bigint FROM feedback f WHERE party_id=$1
       UNION ALL SELECT 'feedback_responses',count(*)::int,COALESCE(sum(pg_column_size(fr)),0)::bigint FROM feedback_responses fr JOIN feedback f ON f.id=fr.feedback_id WHERE f.party_id=$1
       UNION ALL SELECT 'final_versions',count(*)::int,COALESCE(sum(pg_column_size(v)),0)::bigint FROM final_versions v WHERE party_id=$1
       UNION ALL SELECT 'audit_events',count(*)::int,COALESCE(sum(pg_column_size(e)),0)::bigint FROM audit_events e WHERE party_id=$1
       UNION ALL SELECT 'participants',count(*)::int,COALESCE(sum(pg_column_size(p)),0)::bigint FROM participants p WHERE party_id=$1
       UNION ALL SELECT 'participant_sessions',count(*)::int,COALESCE(sum(pg_column_size(s)),0)::bigint FROM participant_sessions s WHERE party_id=$1`,
      [partyId],
    )).rows;
    const byTable = Object.fromEntries(rows.map(row => [row.table_name, { accountedRowBytes: Number(row.bytes), rows: row.rows }]));
    return {
      scope: "party_row_data_only",
      accountedRowBytes: rows.reduce((total, row) => total + Number(row.bytes), 0),
      byTable,
      quotaBytes: null,
      excludes: ["relation_and_page_overhead", "indexes", "toast_relation_allocation"],
    };
  }

  private async audit(client: PoolClient, partyId: string, eventType: string, actor: Actor, details: JsonObject) {
    await client.query(`INSERT INTO audit_events (party_id,event_type,actor_identity_id,details) VALUES ($1,$2,$3,$4)`, [partyId, eventType, actor.id, JSON.stringify(details)]);
  }
}

function changedBlockIds(current: Artifact, restored: Artifact) {
  const before = new Map(current.blocks.map(block => [block.id, block]));
  const after = new Map(restored.blocks.map(block => [block.id, block]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(id => !isDeepStrictEqual(before.get(id), after.get(id)));
}

function rejectAssertedActor(body: Record<string, unknown>) {
  if (body.actor !== undefined) throw new AppError("VALIDATION_ERROR", "actor is resolved from the participant token", 400);
}
function token() { return randomBytes(32).toString("base64url"); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function operationsFor(lifecycle: Lifecycle, role: "owner" | "share", hasArtifact: boolean, hasBlocks = hasArtifact, hasRestorableRevision = hasArtifact) {
  const reads = ["get_party", "get_feedback"];
  if (lifecycle === "finalized") return [...reads, "get_final_artifact"];
  const active = hasArtifact && (lifecycle === "in_review" || lifecycle === "revising");
  const writes = active
    ? ["set_artifact", "update_blocks", ...(hasBlocks ? ["delete_blocks"] : []), ...(hasRestorableRevision ? ["restore_revision"] : []), "respond_to_feedback"]
    : ["set_artifact"];
  return [...reads, ...writes, ...(role === "owner" && active ? ["finalize_party"] : [])];
}

export function humanOperationsFor(lifecycle: Lifecycle, hasArtifact: boolean) {
  return lifecycle !== "finalized" && hasArtifact ? [...HUMAN_OPERATIONS] : [];
}
