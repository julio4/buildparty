import {
  AppError, WEBMCP_OPERATIONS, blockIds, expectedVersion, feedbackIds, object, optionalText, requiredExpectedVersion, validateArtifact,
  validateCapability, validateJsonObject, validateParticipantProfile, validateText, validateUpdates, validateUuid,
  type JsonObject, type Lifecycle, type WebMcpOperation,
} from "./domain.ts";
import { api, ApiError } from "./browser-api.ts";

export type JsonSchema = Record<string, unknown>;
export type WebMcpToolDefinition = {
  name: WebMcpOperation;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
};

const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const uuid = { type: "string", format: "uuid" };
const jsonObject = { type: "object", additionalProperties: true };
const sourceSchema = {
  type: "object", description: "Inline sandbox content. html is required; css and js are optional.", additionalProperties: false, required: ["html"],
  properties: {
    html: { type: "string", description: "HTML markup. Plain text is accepted when wrapped in an HTML element, for example <p>Hello</p>.", maxLength: 100_000 },
    css: { type: "string", description: "Optional CSS for this sandbox block.", maxLength: 100_000 },
    js: { type: "string", description: "Optional JavaScript for this sandbox block.", maxLength: 100_000 },
  },
};
const partialSourceSchema = { type: "object", additionalProperties: false, minProperties: 1, properties: sourceSchema.properties };
const blockSchema = {
  type: "object", additionalProperties: false, required: ["id", "kind", "source"],
  properties: {
    id: { type: "string", description: "Stable block identifier used by feedback and updates.", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
    title: { ...text(200), description: "Optional human-readable block title." },
    kind: { type: "string", enum: ["sandbox"], description: "Required literal: sandbox." },
    source: sourceSchema,
    initialState: { ...jsonObject, description: "Optional initial shared state for this block." },
  },
};
const artifactSchema = {
  type: "object", description: "A complete BuildParty artifact document.", additionalProperties: false, required: ["format", "title", "blocks"],
  properties: {
    format: { type: "string", enum: ["buildparty.artifact/v1"], description: "Required literal: buildparty.artifact/v1." },
    title: { ...text(200), description: "Human-readable artifact title." },
    blocks: { type: "array", description: "Zero to 200 sandbox blocks. An empty array is a valid deliberate canvas.", minItems: 0, maxItems: 200, items: blockSchema },
  },
};
const version = { type: "integer", minimum: 1 };
const commonMutationProperties = { expectedVersion: version, summary: text(500), statePatch: jsonObject, resetState: { type: "boolean" } };
const emptySchema = { type: "object", additionalProperties: false, properties: {} };

export const BUILD_PARTY_AGENT_GUIDE = "BuildParty creates one seamless interactive artifact for human review. Keep this tab open. Initialize, then create exactly one room; keep the owner URL private and return labeled owner and reviewer URLs. If no supplied content suggests a room title, use BuildParty session. If this conversation already contains content, publish it; otherwise create the room and ask or work on the content. Use display name Owner when no useful name is known. Use one block for atomic work and stable blocks for independently reviewable sections. Source must be self-contained, no-network HTML/CSS/JS; standard named controls sync by default, data-bp-local stays local, and custom JS uses window.buildParty.getState/setState/patchState/subscribe. Precompile Mermaid/UML to inline SVG. Humans interact and comment while agents change source. Patterns: planning/RFC—blocks by decision or section; learning notebook—sections plus persistent exercises/progress; presentation—stable slide/section blocks; prototype or decision workshop—shared controls for assumptions, votes, and choices.";

export const WEBMCP_TOOL_DEFINITIONS: readonly WebMcpToolDefinition[] = [
  { name: "init", title: "Initialize agent", description: "Call this first when the user asks to use or start BuildParty. On landing, store a reusable agent display identity (use Owner if none is useful); on a party page, create or reuse that party's participant session. Then follow nextAction.", inputSchema: { type: "object", additionalProperties: false, required: ["displayName"], properties: { displayName: text(80) } }, readOnly: false },
  { name: "create_party", title: "Create party", description: "After init on the landing page, create exactly one review room (use title BuildParty session when no supplied content suggests one). Returns the only portable capability results: private owner URL and reviewer URL; continue in the opened party instead of creating another room.", inputSchema: { type: "object", additionalProperties: false, required: ["title"], properties: { title: text(200) } }, readOnly: false },
  { name: "get_party", title: "Get party", description: "Read first after init in an existing party, and before any versioned change. Returns current artifact, shared state, lifecycle, revisions, open-feedback count, available operations, and a deterministic next action.", inputSchema: emptySchema, readOnly: true },
  { name: "set_artifact", title: "Set artifact", description: "Publish prepared conversation content as the first artifact, or replace the whole artifact when get_party advertises this operation. Use stable blocks for independently reviewable sections. Required literals: artifact.format must be \"buildparty.artifact/v1\" and every block.kind must be \"sandbox\". source.html is required; CSS/JS are optional and must be self-contained/no-network. Simple text example: {\"artifact\":{\"format\":\"buildparty.artifact/v1\",\"title\":\"Note\",\"blocks\":[{\"id\":\"note\",\"kind\":\"sandbox\",\"source\":{\"html\":\"<p>Hello</p>\"}}]}}", inputSchema: { type: "object", additionalProperties: false, required: ["artifact"], properties: { artifact: artifactSchema, ...commonMutationProperties } }, readOnly: false },
  { name: "update_blocks", title: "Update blocks", description: "After get_party, make targeted source edits to existing stable blocks or patch shared state at the exact current version. Link relevant feedbackIds to source edits; a statePatch-only update does not create a revision.", inputSchema: { type: "object", additionalProperties: false, required: ["expectedVersion"], anyOf: [{ required: ["updates"] }, { required: ["statePatch"] }, { properties: { resetState: { const: true } }, required: ["resetState"] }], properties: { ...commonMutationProperties, feedbackIds: { type: "array", maxItems: 200, uniqueItems: true, items: uuid }, updates: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", additionalProperties: false, required: ["id"], anyOf: [{ required: ["title"] }, { required: ["source"] }], properties: { id: blockSchema.properties.id, title: text(200), source: partialSourceSchema } } } } }, readOnly: false },
  { name: "delete_blocks", title: "Delete blocks", description: "Remove obsolete review sections and their shared state at the exact current version when advertised. Deleting every block deliberately leaves a valid zero-block artifact; it does not delete the artifact, room, or revision history.", inputSchema: { type: "object", additionalProperties: false, required: ["blockIds", "expectedVersion"], properties: { blockIds: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: blockSchema.properties.id }, expectedVersion: version, summary: text(500) } }, readOnly: false },
  { name: "restore_revision", title: "Restore revision", description: "Undo unwanted changes by restoring an available pre-final revision as the whole current artifact and shared state, creating a new revision. changedBlockIds may be empty when only title, format, or shared state changed.", inputSchema: { type: "object", additionalProperties: false, required: ["revisionId", "expectedVersion"], properties: { revisionId: uuid, expectedVersion: version, summary: text(500) } }, readOnly: false },
  { name: "get_feedback", title: "Get feedback", description: "Read human review comments and prior agent responses before revising. Use open status to find actionable active or archived feedback, then target source changes and link feedback IDs.", inputSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: ["open", "resolved", "all"] } } }, readOnly: true },
  { name: "respond_to_feedback", title: "Respond to feedback", description: "Acknowledge a comment or, after a targeted update_blocks call, link its returned revision and resolve the addressed feedback. Never claim resolution without that revision link.", inputSchema: { type: "object", additionalProperties: false, required: ["feedbackId"], anyOf: [{ required: ["body"] }, { required: ["revisionId"] }, { properties: { resolve: { const: true } }, required: ["resolve"] }], properties: { feedbackId: uuid, body: text(10_000), revisionId: uuid, resolve: { type: "boolean" } } }, readOnly: false },
  { name: "finalize_party", title: "Finalize party", description: "Owner-only: when review is complete, lock the exact current version as immutable final output. Open active feedback requires an explicit allowOpenFeedback override; do not use it casually.", inputSchema: { type: "object", additionalProperties: false, required: ["name", "expectedVersion"], properties: { name: text(200), expectedVersion: version, allowOpenFeedback: { type: "boolean" } } }, readOnly: false },
  { name: "get_final_artifact", title: "Get final artifact", description: "After finalization, retrieve immutable final metadata and portable interactive HTML for delivery or download; this is read-only and cannot reopen editing.", inputSchema: emptySchema, readOnly: true },
] as const;

const definitions = new Map(WEBMCP_TOOL_DEFINITIONS.map(definition => [definition.name, definition]));
if (WEBMCP_OPERATIONS.some(name => !definitions.has(name)) || definitions.size !== WEBMCP_OPERATIONS.length) throw new Error("WebMCP definitions do not match service operations");

export async function executeWebMcpTool(execute: (name: WebMcpOperation, input?: unknown) => Promise<unknown>, name: WebMcpOperation, input: unknown = {}) {
  try { return await execute(name, input); }
  catch (error) {
    const known = error instanceof ApiError || error instanceof AppError;
    if (!known) console.error(`WebMCP ${name} failed unexpectedly`, error);
    const code = known ? error.code : "INTERNAL_ERROR";
    const message = known ? sanitizeError(error.message) : "Unexpected tool execution failure.";
    const path = /^(?:input|artifact|updates|blockIds|revisionId|feedbackIds|expectedVersion|summary)(?:\.[A-Za-z0-9_-]+|\[\d+\])*/.exec(message)?.[0];
    const hint = name === "set_artifact" && code === "VALIDATION_ERROR"
      ? "Use artifact.format \"buildparty.artifact/v1\" and every block.kind \"sandbox\"; source.html may be simple text wrapped in HTML. Correct the indicated path and retry."
      : code === "AGENT_SESSION_REQUIRED" ? "Call init, then retry this tool."
      : code === "VERSION_CONFLICT" ? "Call get_party for the current version, then retry with that expectedVersion."
      : code === "FORBIDDEN" ? "Use a capability with permission for this operation."
      : known ? "Correct the indicated input or state and retry."
      : "Retry once; if this persists, report the internal failure.";
    return { ok: false, error: { code, message, ...(path ? { path } : {}), hint, retryable: code === "VERSION_CONFLICT" || (!known || error.status === 429 || error.status >= 500) } };
  }
}

function sanitizeError(message: string) {
  return message.replace(/((?:#cap=|Bearer ))[A-Za-z0-9_-]+/g, "$1[redacted]").replace(/\b[A-Za-z0-9_-]{43}\b/g, "[redacted]").slice(0, 500);
}

function toolUnavailable(name: WebMcpOperation, page: "landing" | "party", view?: Pick<WebMcpPartyView, "party" | "access" | "availableOperations">) {
  return {
    ok: false,
    error: { code: "TOOL_UNAVAILABLE", message: `${name} is unavailable in the current ${page} context.`, hint: "This tool remains registered but is unavailable in the current state. Use context.availableOperations; no tool refetch is needed for same-document transitions.", retryable: false },
    context: { page, lifecycle: view?.party.lifecycle ?? null, access: view?.access ?? null, availableOperations: page === "landing" ? toolsForPage("landing") : view ? toolsForPage("party", view) : ["init"] },
  };
}

export type WebMcpPartyView = {
  party: { id: string; title: string; lifecycle: Lifecycle; createdAt: string; finalizedAt: string | null };
  artifact: ReturnType<typeof validateArtifact> | null;
  runtimeState: JsonObject | null;
  version: number | null;
  openFeedback: number;
  participants: unknown[];
  revisions: unknown[];
  access: "owner" | "share";
  availableOperations: WebMcpOperation[];
};

type StorageSet = Pick<Storage, "getItem" | "setItem">;
type AdapterOptions = {
  partyId?: string;
  capability?: string;
  localStorage: StorageSet;
  sessionStorage: StorageSet;
  navigate?: (url: string) => void;
  onPartyCreated?: (context: { partyId: string; capability: string }) => void;
  onPartyView?: (view: WebMcpPartyView) => void;
  onMutation?: () => void | Promise<void>;
};
type AgentSession = { participant: { id: string; name: string; kind: "agent" }; participantToken: string };
const identityKey = "buildparty.webmcp.identity";
const agentKey = (partyId: string) => `buildparty.webmcp.participant.${partyId}`;

export function toolsForPage(page: "landing" | "party", view?: Pick<WebMcpPartyView, "party" | "access" | "availableOperations">): WebMcpOperation[] {
  if (page === "landing") return ["init", "create_party"];
  const names = new Set<WebMcpOperation>(["init", "get_party", "get_feedback"]);
  for (const operation of view?.availableOperations ?? []) {
    if (view?.party.lifecycle === "finalized" && !["get_party", "get_feedback", "get_final_artifact"].includes(operation)) continue;
    if (operation === "get_final_artifact" && view?.party.lifecycle !== "finalized") continue;
    if (operation === "finalize_party" && view?.access !== "owner") continue;
    if (operation !== "create_party") names.add(operation);
  }
  return WEBMCP_OPERATIONS.filter(name => names.has(name));
}

export function createWebMcpExecutor(options: AdapterOptions) {
  const execute = async (name: WebMcpOperation, raw: unknown = {}) => {
    if (!definitions.has(name)) throw new ApiError("unknown WebMCP operation", "VALIDATION_ERROR", 400);
    const input = validateWebMcpInput(name, raw);
    const page = options.partyId ? "party" : "landing";
    try {
      if (page === "landing") {
        if (name === "init") return init(input, options);
        if (name === "create_party") return createParty(input, options);
        return toolUnavailable(name, "landing");
      }
      if (name === "init") return init(input, options);
      const partyId = validateUuid(options.partyId, "partyId");
      const capability = options.capability ?? options.sessionStorage.getItem(`buildparty.capability.${partyId}`);
      if (!capability) throw new ApiError("party capability is unavailable", "FORBIDDEN", 403);
      const session = loadAgentSession(options.sessionStorage, partyId);
      if (name === "create_party" && !session) return toolUnavailable(name, "party");
      if (!session) throw new ApiError("call init before using party tools", "AGENT_SESSION_REQUIRED", 409);
      const headers = { Authorization: `Bearer ${capability}`, "X-Participant-Token": session.participantToken };
      const current = await fetchParty(partyId, headers, options);
      const available = toolsForPage("party", current);
      if (!available.includes(name)) return toolUnavailable(name, "party", current);
      if (name === "get_party") return partyEvidence(current);
      if (name === "get_feedback") {
        const status = input.status as string | undefined;
        const rows = await api<unknown[]>(`/api/parties/${partyId}/feedback${status ? `?status=${encodeURIComponent(status)}` : ""}`, { headers });
        return { partyId, status: status ?? "all", feedback: validateFeedback(rows) };
      }
      let result: unknown;
      if (name === "set_artifact") {
        if (current.version !== null && input.expectedVersion === undefined) throw new ApiError("expectedVersion is required when replacing an artifact", "VALIDATION_ERROR", 400);
        result = await api(`/api/parties/${partyId}/artifact`, { method: "PUT", headers, body: JSON.stringify(input) });
      } else if (name === "update_blocks") {
        result = await api(`/api/parties/${partyId}/blocks`, { method: "PATCH", headers, body: JSON.stringify(input) });
      } else if (name === "delete_blocks") {
        result = await api(`/api/parties/${partyId}/blocks`, { method: "DELETE", headers, body: JSON.stringify(input) });
      } else if (name === "restore_revision") {
        const { revisionId, ...body } = input;
        result = await api(`/api/parties/${partyId}/revisions/${revisionId}/restore`, { method: "POST", headers, body: JSON.stringify(body) });
      } else if (name === "respond_to_feedback") {
        const { feedbackId, ...body } = input;
        result = await api(`/api/parties/${partyId}/feedback/${feedbackId}/respond`, { method: "POST", headers, body: JSON.stringify(body) });
      } else if (name === "finalize_party") {
        result = await api(`/api/parties/${partyId}/finalize`, { method: "POST", headers, body: JSON.stringify(input) });
      } else {
        const final = validateFinal(await api(`/api/parties/${partyId}/final`, { headers }));
        return { partyId, lifecycle: "finalized", final };
      }
      const evidence = mutationEvidence(name, partyId, result, name === "update_blocks" && input.updates === undefined);
      const view = await fetchParty(partyId, headers, options);
      const storage = name === "delete_blocks" || name === "restore_revision" ? storageEvidence(await api(`/api/parties/${partyId}/storage`, { headers })) : undefined;
      await options.onMutation?.();
      return { ...evidence, ...(storage ? { storage } : {}), availableOperations: view.availableOperations };
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT" && options.partyId) {
        const session = loadAgentSession(options.sessionStorage, options.partyId);
        const capability = options.capability ?? options.sessionStorage.getItem(`buildparty.capability.${options.partyId}`);
        if (session && capability) {
          const view = await fetchParty(options.partyId, { Authorization: `Bearer ${capability}`, "X-Participant-Token": session.participantToken }, options);
          const latest = view.revisions.at(-1) as { id?: unknown; version?: unknown; changed_block_ids?: unknown } | undefined;
          return { ok: false, error: { code: error.code, message: error.message, status: error.status }, retry: { partyId: options.partyId, currentVersion: view.version, lifecycle: view.party.lifecycle, latestRevisionId: typeof latest?.id === "string" ? latest.id : null, changedBlockIds: Array.isArray(latest?.changed_block_ids) ? latest.changed_block_ids : [] } };
        }
      }
      throw error;
    }
  };
  return execute;
}

async function init(input: Record<string, unknown>, options: AdapterOptions) {
  const displayName = input.displayName as string;
  const discovery = await api<{ operations?: unknown }>("/api/init", { method: "POST", body: "{}" });
  const operations = operationList(discovery.operations);
  options.localStorage.setItem(identityKey, JSON.stringify({ name: displayName, kind: "agent" }));
  if (!options.partyId) return { identity: { displayName, kind: "agent" }, operations, guide: BUILD_PARTY_AGENT_GUIDE, nextAction: { tool: "create_party", reason: "create one review room" } };
  const partyId = validateUuid(options.partyId, "partyId");
  const capability = options.capability ?? options.sessionStorage.getItem(`buildparty.capability.${partyId}`);
  if (!capability) throw new ApiError("party capability is unavailable", "FORBIDDEN", 403);
  let session = loadAgentSession(options.sessionStorage, partyId);
  const reused = Boolean(session && session.participant.name === displayName);
  if (!reused) {
    session = validateAgentSession(await api(`/api/parties/${partyId}/participants`, { method: "POST", headers: { Authorization: `Bearer ${capability}` }, body: JSON.stringify({ participant: { name: displayName, kind: "agent" } }) }));
    options.sessionStorage.setItem(agentKey(partyId), JSON.stringify(session));
  }
  const view = await fetchParty(partyId, { Authorization: `Bearer ${capability}`, "X-Participant-Token": session!.participantToken }, options);
  return { partyId, participant: session!.participant, reused, lifecycle: view.party.lifecycle, availableOperations: view.availableOperations, operations, guide: BUILD_PARTY_AGENT_GUIDE, nextAction: { tool: "get_party", reason: "read current party state before acting" } };
}

async function createParty(input: Record<string, unknown>, options: AdapterOptions) {
  const identity = loadJson(options.localStorage.getItem(identityKey));
  const participant = validateParticipantProfile(identity);
  if (participant.kind !== "agent") throw new ApiError("call init before create_party", "AGENT_SESSION_REQUIRED", 409);
  const created = validateCreated(await api("/api/parties", { method: "POST", body: JSON.stringify({ title: input.title, participant }) }));
  const partyId = created.party.id;
  options.sessionStorage.setItem(`buildparty.capability.${partyId}`, created.ownerCapability);
  options.sessionStorage.setItem(`buildparty.share.${partyId}`, created.shareCapability);
  options.sessionStorage.setItem(agentKey(partyId), JSON.stringify({ participant: created.participant, participantToken: created.participantToken }));
  options.onPartyCreated?.({ partyId, capability: created.ownerCapability });
  const result = { party: created.party, participant: created.participant, ownerUrl: created.ownerUrl, shareUrl: created.shareUrl, nextAction: { tool: "set_artifact", reason: "publish existing content or prepare it first" } };
  if (options.navigate) setTimeout(options.navigate, 0, created.ownerUrl);
  return result;
}

async function fetchParty(partyId: string, headers: Record<string, string>, options: AdapterOptions) {
  const view = validateParty(await api(`/api/parties/${partyId}`, { headers }));
  options.onPartyView?.(view);
  return view;
}

export function validateWebMcpInput(name: WebMcpOperation, raw: unknown): Record<string, unknown> {
  const input = object(raw, "input");
  const allowed: Record<WebMcpOperation, string[]> = {
    init: ["displayName"], create_party: ["title"], get_party: [], set_artifact: ["artifact", "summary", "expectedVersion", "statePatch", "resetState"],
    update_blocks: ["updates", "statePatch", "resetState", "feedbackIds", "summary", "expectedVersion"],
    delete_blocks: ["blockIds", "expectedVersion", "summary"], restore_revision: ["revisionId", "expectedVersion", "summary"], get_feedback: ["status"],
    respond_to_feedback: ["feedbackId", "body", "revisionId", "resolve"], finalize_party: ["name", "expectedVersion", "allowOpenFeedback"], get_final_artifact: [],
  };
  exact(input, allowed[name], "input");
  if (name === "init") validateText(input.displayName, "displayName", 80);
  else if (name === "create_party") validateText(input.title, "title", 200);
  else if (name === "set_artifact") {
    input.artifact = validateArtifact(input.artifact); mutationFields(input);
  } else if (name === "update_blocks") {
    if (input.expectedVersion === undefined) throw new ApiError("expectedVersion is required", "VALIDATION_ERROR", 400);
    if (input.updates !== undefined) { exactUpdates(input.updates); input.updates = validateUpdates(input.updates); }
    mutationFields(input); input.feedbackIds = feedbackIds(input.feedbackIds);
    if (input.updates === undefined && input.statePatch === undefined && input.resetState !== true) throw new ApiError("an update needs block changes, statePatch, or resetState", "VALIDATION_ERROR", 400);
  } else if (name === "delete_blocks") {
    input.blockIds = blockIds(input.blockIds); input.expectedVersion = requiredExpectedVersion(input.expectedVersion); input.summary = optionalText(input.summary, "summary", 500);
    if (input.summary === undefined) delete input.summary;
  } else if (name === "restore_revision") {
    input.revisionId = validateUuid(input.revisionId, "revisionId"); input.expectedVersion = requiredExpectedVersion(input.expectedVersion); input.summary = optionalText(input.summary, "summary", 500);
    if (input.summary === undefined) delete input.summary;
  } else if (name === "get_feedback") {
    if (input.status !== undefined && !["open", "resolved", "all"].includes(String(input.status))) throw new ApiError("status must be open, resolved, or all", "VALIDATION_ERROR", 400);
  } else if (name === "respond_to_feedback") {
    input.feedbackId = validateUuid(input.feedbackId, "feedbackId");
    input.body = optionalText(input.body, "body", 10_000);
    if (input.revisionId !== undefined) input.revisionId = validateUuid(input.revisionId, "revisionId");
    if (input.resolve !== undefined && typeof input.resolve !== "boolean") throw new ApiError("resolve must be boolean", "VALIDATION_ERROR", 400);
    if (input.resolve === true && !input.revisionId) throw new ApiError("resolving feedback requires a linked revision", "VALIDATION_ERROR", 400);
    if (!input.body && !input.revisionId && input.resolve !== true) throw new ApiError("a response needs body, revisionId, or resolve", "VALIDATION_ERROR", 400);
    if (input.body === undefined) delete input.body;
  } else if (name === "finalize_party") {
    input.name = validateText(input.name, "name", 200); input.expectedVersion = expectedVersion(input.expectedVersion);
    if (input.expectedVersion === undefined) throw new ApiError("expectedVersion is required", "VALIDATION_ERROR", 400);
    if (input.allowOpenFeedback !== undefined && typeof input.allowOpenFeedback !== "boolean") throw new ApiError("allowOpenFeedback must be boolean", "VALIDATION_ERROR", 400);
  }
  return input;
}

function mutationFields(input: Record<string, unknown>) {
  input.expectedVersion = expectedVersion(input.expectedVersion);
  input.summary = optionalText(input.summary, "summary", 500);
  if (input.statePatch !== undefined) input.statePatch = validateJsonObject(input.statePatch, "statePatch");
  if (input.resetState !== undefined && typeof input.resetState !== "boolean") throw new ApiError("resetState must be boolean", "VALIDATION_ERROR", 400);
  if (input.resetState === true && input.statePatch !== undefined) throw new ApiError("statePatch and resetState are mutually exclusive", "VALIDATION_ERROR", 400);
  for (const key of ["expectedVersion", "summary"] as const) if (input[key] === undefined) delete input[key];
}

function exactUpdates(value: unknown) {
  if (!Array.isArray(value)) return;
  value.forEach((raw, index) => {
    const update = object(raw, `updates[${index}]`); exact(update, ["id", "title", "source"], `updates[${index}]`);
    if (update.source !== undefined) exact(object(update.source, `updates[${index}].source`), ["html", "css", "js"], `updates[${index}].source`);
  });
}

function exact(value: Record<string, unknown>, allowed: string[], label: string) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new ApiError(`${label}.${extra} is not allowed`, "VALIDATION_ERROR", 400);
}
function operationList(value: unknown): WebMcpOperation[] {
  if (!Array.isArray(value) || value.some(name => !WEBMCP_OPERATIONS.includes(name as WebMcpOperation)) || new Set(value).size !== value.length) throw new ApiError("invalid operation discovery response", "INVALID_RESPONSE", 502);
  return value as WebMcpOperation[];
}
function loadJson(value: string | null): unknown { try { return JSON.parse(value ?? "null"); } catch { return null; } }
function loadAgentSession(storage: StorageSet, partyId: string) { try { return validateAgentSession(loadJson(storage.getItem(agentKey(partyId)))); } catch { return undefined; } }
function validateAgentSession(value: unknown): AgentSession {
  const session = object(value, "agent session"); const participant = object(session.participant, "agent participant");
  const id = validateUuid(participant.id, "participant.id");
  const profile = validateParticipantProfile(participant);
  if (profile.kind !== "agent" || typeof session.participantToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(session.participantToken)) throw new ApiError("invalid agent session", "INVALID_RESPONSE", 502);
  return { participant: { id, name: profile.name, kind: "agent" }, participantToken: session.participantToken };
}
function validateCreated(value: unknown) {
  const created = object(value, "create_party result"); const party = object(created.party, "party");
  const session = validateAgentSession(created);
  const result = { party: { id: validateUuid(party.id, "party.id"), title: validateText(party.title, "party.title", 200), lifecycle: party.lifecycle }, ...session,
    ownerCapability: created.ownerCapability, shareCapability: created.shareCapability, ownerUrl: created.ownerUrl, shareUrl: created.shareUrl };
  if (result.party.lifecycle !== "initialized" || typeof result.ownerUrl !== "string" || typeof result.shareUrl !== "string") throw new ApiError("invalid create_party response", "INVALID_RESPONSE", 502);
  validateCapability(result.ownerCapability); validateCapability(result.shareCapability);
  if (!result.ownerUrl.includes(`#cap=${result.ownerCapability}`) || !result.shareUrl.includes(`#cap=${result.shareCapability}`)) throw new ApiError("create_party URLs do not contain their capabilities", "INVALID_RESPONSE", 502);
  return result as typeof result & { party: { id: string; title: string; lifecycle: "initialized" }; ownerCapability: string; shareCapability: string; ownerUrl: string; shareUrl: string };
}
function validateParty(value: unknown): WebMcpPartyView {
  const view = object(value, "get_party result"); const party = object(view.party, "party");
  const lifecycle = party.lifecycle;
  if (!["initialized", "in_review", "revising", "finalized"].includes(String(lifecycle))) throw new ApiError("invalid party lifecycle", "INVALID_RESPONSE", 502);
  const artifact = view.artifact === null ? null : validateArtifact(view.artifact);
  const versionValue = view.version;
  if (versionValue !== null && (!Number.isSafeInteger(versionValue) || Number(versionValue) < 1)) throw new ApiError("invalid artifact version", "INVALID_RESPONSE", 502);
  const availableOperations = operationList(view.availableOperations);
  if (view.access !== "owner" && view.access !== "share") throw new ApiError("invalid party access", "INVALID_RESPONSE", 502);
  if (!Array.isArray(view.participants) || !Array.isArray(view.revisions) || !Number.isSafeInteger(view.openFeedback)) throw new ApiError("invalid party response", "INVALID_RESPONSE", 502);
  const participants = view.participants.map((raw, index) => { const participant = object(raw, `participants[${index}]`); const profile = validateParticipantProfile(participant); return { id: validateUuid(participant.id, `participants[${index}].id`), ...profile }; });
  const revisions = view.revisions.map((raw, index) => { const revision = object(raw, `revisions[${index}]`); if (!Number.isSafeInteger(revision.version) || !Array.isArray(revision.changed_block_ids) || !Array.isArray(revision.feedback_ids) || typeof revision.snapshot_available !== "boolean" || typeof revision.snapshot_pruned !== "boolean" || (revision.snapshot_bytes !== null && !Number.isSafeInteger(revision.snapshot_bytes))) throw new ApiError("invalid revision response", "INVALID_RESPONSE", 502); return { id: validateUuid(revision.id, `revisions[${index}].id`), version: revision.version, source: String(revision.source), changed_block_ids: revision.changed_block_ids.map((blockId, child) => validateText(blockId, `revisions[${index}].changed_block_ids[${child}]`, 64)), feedback_ids: revision.feedback_ids.map((feedbackId, child) => validateUuid(feedbackId, `revisions[${index}].feedback_ids[${child}]`)), summary: revision.summary === null ? null : String(revision.summary), actor_identity_id: String(revision.actor_identity_id), created_at: String(revision.created_at), snapshot_available: revision.snapshot_available, snapshot_pruned: revision.snapshot_pruned, snapshot_bytes: revision.snapshot_bytes }; });
  return { party: { id: validateUuid(party.id, "party.id"), title: validateText(party.title, "party.title", 200), lifecycle: lifecycle as Lifecycle, createdAt: String(party.createdAt), finalizedAt: party.finalizedAt === null ? null : String(party.finalizedAt) }, artifact, runtimeState: view.runtimeState === null ? null : validateJsonObject(view.runtimeState, "runtimeState"), version: versionValue as number | null, openFeedback: view.openFeedback as number, participants, revisions, access: view.access, availableOperations };
}
export function recommendedNextAction(view: { party: { lifecycle: Lifecycle }; artifact: WebMcpPartyView["artifact"]; openFeedback: number }) {
  if (view.party.lifecycle === "finalized") return { tool: "get_final_artifact", reason: "retrieve the immutable final output" } as const;
  if (view.artifact === null || view.party.lifecycle === "initialized") return { tool: "set_artifact", reason: "publish prepared content for review" } as const;
  if (view.openFeedback > 0) return { tool: "get_feedback", reason: "read and address open human feedback" } as const;
  return { tool: null, reason: "wait for or continue human review; do not poll" } as const;
}
function partyEvidence(view: WebMcpPartyView) { return { ...view, nextAction: recommendedNextAction(view) }; }
function validateFeedback(value: unknown[]) {
  if (!Array.isArray(value)) throw new ApiError("invalid feedback response", "INVALID_RESPONSE", 502);
  return value.map((raw, index) => {
    const item = object(raw, `feedback[${index}]`);
    if (!Array.isArray(item.responses) || !["open", "resolved"].includes(String(item.status)) || !["active", "archived"].includes(String(item.anchorStatus))) throw new ApiError("invalid feedback response", "INVALID_RESPONSE", 502);
    const responses = item.responses.map((rawResponse, child) => { const response = object(rawResponse, `feedback[${index}].responses[${child}]`); return { id: validateUuid(response.id, `feedback[${index}].responses[${child}].id`), body: response.body === null ? null : String(response.body), revisionId: response.revision_id === null ? null : validateUuid(response.revision_id, "response.revisionId"), resolved: response.resolved === true, actorId: String(response.actor_identity_id), createdAt: String(response.created_at) }; });
    return { id: validateUuid(item.id, `feedback[${index}].id`), blockId: String(item.block_id), anchorStatus: item.anchorStatus, kind: String(item.kind), body: String(item.body), status: item.status, actorId: String(item.actor_identity_id), createdAt: String(item.created_at), resolvedAt: item.resolved_at === null ? null : String(item.resolved_at), responses };
  });
}
function storageEvidence(value: unknown) {
  const storage = object(value, "storage result");
  if (storage.scope !== "party_row_data_only" || !Number.isSafeInteger(storage.accountedRowBytes) || storage.quotaBytes !== null) throw new ApiError("invalid storage response", "INVALID_RESPONSE", 502);
  return { scope: storage.scope, accountedRowBytes: storage.accountedRowBytes, quotaBytes: null };
}
function validateFinal(value: unknown) {
  const final = object(value, "final result");
  const result = { id: validateUuid(final.id, "final.id"), name: validateText(final.name, "final.name", 200), sourceVersion: final.source_version, openFeedbackOverridden: final.open_feedback_overridden, createdAt: String(final.created_at), html: final.html };
  if (!Number.isSafeInteger(result.sourceVersion) || typeof result.openFeedbackOverridden !== "boolean" || typeof result.html !== "string") throw new ApiError("invalid final artifact response", "INVALID_RESPONSE", 502);
  return result;
}
function mutationEvidence(name: WebMcpOperation, partyId: string, value: unknown, stateOnlyUpdate = false) {
  const result = object(value, `${name} result`);
  const lifecycle = result.lifecycle;
  if (!["in_review", "revising", "finalized"].includes(String(lifecycle))) throw new ApiError(`invalid ${name} lifecycle`, "INVALID_RESPONSE", 502);
  if (name === "respond_to_feedback") {
    const response = object(result.response, "response"); const feedback = object(result.feedback, "feedback");
    return { partyId, lifecycle, feedbackId: validateUuid(feedback.id, "feedback.id"), responseId: validateUuid(response.id, "response.id"), revisionId: response.revision_id ?? null, status: feedback.status, resolved: response.resolved === true };
  }
  if (name === "finalize_party") return { partyId, lifecycle, final: validateFinal(result.final) };
  if (!Number.isSafeInteger(result.version)) throw new ApiError(`invalid ${name} version`, "INVALID_RESPONSE", 502);
  if (name === "update_blocks" && stateOnlyUpdate) {
    if (result.revision !== null) throw new ApiError("invalid state-only update_blocks revision", "INVALID_RESPONSE", 502);
    let runtimeState: JsonObject;
    try { runtimeState = validateJsonObject(result.runtimeState, "runtimeState"); }
    catch { throw new ApiError("invalid state-only update_blocks runtimeState", "INVALID_RESPONSE", 502); }
    return { ok: true, partyId, lifecycle, version: result.version, revisionId: null, changedBlockIds: [], runtimeState };
  }
  let revision: Record<string, unknown>;
  try { revision = object(result.revision, "revision"); }
  catch { throw new ApiError(`invalid ${name} revision`, "INVALID_RESPONSE", 502); }
  const base = { partyId, lifecycle, version: result.version, revisionId: validateUuid(revision.id, "revision.id"), changedBlockIds: Array.isArray(result.changedBlockIds) ? result.changedBlockIds : Array.isArray(revision.changed_block_ids) ? revision.changed_block_ids : [], feedbackIds: Array.isArray(revision.feedback_ids) ? revision.feedback_ids : [] };
  if (name === "delete_blocks") return { ...base, deletedBlockIds: Array.isArray(result.deletedBlockIds) ? result.deletedBlockIds : [] };
  if (name === "restore_revision") {
    if (!Number.isSafeInteger(result.restoredFromVersion)) throw new ApiError("invalid restored revision version", "INVALID_RESPONSE", 502);
    return { ...base, restoredFromRevisionId: validateUuid(result.restoredFromRevisionId, "restoredFromRevisionId"), restoredFromVersion: result.restoredFromVersion };
  }
  return base;
}

export class NativeWebMcpRegistration {
  private controller?: AbortController;
  private key = "";
  private execute?: (name: WebMcpOperation, input?: unknown) => Promise<unknown>;
  constructor(private modelContext: Document["modelContext"] | undefined = typeof document === "undefined" ? undefined : document.modelContext, private secure = typeof window !== "undefined" && window.isSecureContext) {}
  async sync(names: WebMcpOperation[], execute: (name: WebMcpOperation, input?: unknown) => Promise<unknown>) {
    const key = names.join(",");
    this.execute = execute;
    if (this.controller && this.key === key && !this.controller.signal.aborted) return true;
    this.clear(); this.execute = execute;
    if (!this.secure || typeof this.modelContext?.registerTool !== "function") return false;
    const controller = new AbortController(); this.controller = controller; this.key = key;
    try {
      let failure: unknown; let failed = false;
      await Promise.allSettled(names.map(name => Promise.resolve().then(() => {
        const definition = definitions.get(name)!;
        return this.modelContext!.registerTool({ name, title: definition.title, description: definition.description, inputSchema: definition.inputSchema, annotations: { readOnlyHint: definition.readOnly }, execute: (input = {}) => executeWebMcpTool((toolName, toolInput) => this.execute!(toolName, toolInput), name, input) }, { signal: controller.signal });
      }).catch(error => { if (!failed) { failure = error; failed = true; } controller.abort(); throw error; })));
      if (failed) throw failure;
      return !controller.signal.aborted;
    } catch (error) {
      if (this.controller === controller) this.clear();
      else controller.abort();
      throw error;
    }
  }
  clear() { this.controller?.abort(); this.controller = undefined; this.key = ""; }
}
