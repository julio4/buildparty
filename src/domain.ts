export type Lifecycle = "initialized" | "in_review" | "revising" | "finalized";
export const WEBMCP_OPERATIONS = ["init", "create_party", "get_party", "set_artifact", "update_blocks", "delete_blocks", "restore_revision", "get_feedback", "respond_to_feedback", "finalize_party", "get_final_artifact"] as const;
export const PARTY_OPERATIONS = WEBMCP_OPERATIONS;
export type WebMcpOperation = typeof WEBMCP_OPERATIONS[number];
export type PartyOperation = typeof PARTY_OPERATIONS[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type Actor = { id: string; name: string; kind: "human" | "agent" };
export type ParticipantProfile = Pick<Actor, "name" | "kind">;
export type SandboxSource = { html: string; css?: string; js?: string };
export type SandboxBlock = { id: string; title?: string; kind: "sandbox"; source: SandboxSource; initialState?: JsonObject };
export type Artifact = { format: "buildparty.artifact/v1"; title: string; blocks: SandboxBlock[] };
export type RuntimeState = Record<string, JsonObject>;
export type BlockUpdate = { id: string; title?: string; source?: Partial<SandboxSource> };

export class AppError extends Error {
  constructor(
    public code: "VALIDATION_ERROR" | "NOT_FOUND" | "FORBIDDEN" | "INVALID_STATE" | "VERSION_CONFLICT" | "OPEN_FEEDBACK" | "NOT_FINALIZED",
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const MAX_JSON_DEPTH = 16;
const MAX_JSON_SIZE = 100_000;

export function validateUuid(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) fail(`${label} must be a UUID`);
  return value;
}

export function validateActor(value: unknown): Actor {
  const actor = object(value, "actor");
  if (typeof actor.id !== "string" || !idPattern.test(actor.id)) fail("actor.id is invalid");
  return { id: actor.id, ...validateParticipantProfile(actor) };
}

export function validateParticipantProfile(value: unknown): ParticipantProfile {
  const profile = object(value, "participant");
  if (typeof profile.name !== "string" || profile.name.trim().length < 1 || profile.name.length > 80) fail("participant.name must be 1-80 characters");
  if (profile.kind !== "human" && profile.kind !== "agent") fail("participant.kind must be human or agent");
  return { name: profile.name.trim(), kind: profile.kind };
}

export function validateCapability(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail("invalid capability");
  return value;
}

export function validateParticipantToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail("invalid participant token");
  return value;
}

export function parseBearerAuthorization(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new AppError("VALIDATION_ERROR", "authorization must use Bearer capability", 400);
  return match[1];
}

export function validateText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max) fail(`${label} must be 1-${max} characters`);
  return value.trim();
}

export function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : validateText(value, label, max);
}

function sourceText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 100_000) fail(`${label} must be a string of at most 100000 characters`);
  return value;
}

export function validateArtifact(value: unknown): Artifact {
  const artifact = object(value, "artifact");
  exactKeys(artifact, ["format", "title", "blocks"], "artifact");
  if (artifact.format !== "buildparty.artifact/v1") fail("artifact.format must be buildparty.artifact/v1");
  const title = validateText(artifact.title, "artifact.title", 200);
  if (!Array.isArray(artifact.blocks) || artifact.blocks.length > 200) fail("artifact.blocks must contain 0-200 items");
  const seen = new Set<string>();
  const blocks = artifact.blocks.map((raw, index): SandboxBlock => {
    const block = object(raw, `artifact.blocks[${index}]`);
    exactKeys(block, ["id", "title", "kind", "source", "initialState"], `artifact.blocks[${index}]`);
    if (typeof block.id !== "string" || !idPattern.test(block.id) || seen.has(block.id)) fail(`artifact.blocks[${index}].id is invalid or duplicated`);
    seen.add(block.id);
    if (block.kind !== "sandbox") fail(`artifact.blocks[${index}].kind must be sandbox`);
    const source = object(block.source, `artifact.blocks[${index}].source`);
    exactKeys(source, ["html", "css", "js"], `artifact.blocks[${index}].source`);
    const initialState = block.initialState === undefined ? undefined : validateJsonObject(block.initialState, `artifact.blocks[${index}].initialState`);
    return {
      id: block.id,
      ...(block.title === undefined ? {} : { title: validateText(block.title, `artifact.blocks[${index}].title`, 200) }),
      kind: "sandbox",
      source: {
        html: sourceText(source.html, `artifact.blocks[${index}].source.html`),
        ...(source.css === undefined ? {} : { css: sourceText(source.css, `artifact.blocks[${index}].source.css`) }),
        ...(source.js === undefined ? {} : { js: sourceText(source.js, `artifact.blocks[${index}].source.js`) }),
      },
      ...(initialState === undefined ? {} : { initialState }),
    };
  });
  return { format: "buildparty.artifact/v1", title, blocks };
}

export function validateUpdates(value: unknown): BlockUpdate[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) fail("updates must contain 1-200 items");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const update = object(raw, `updates[${index}]`);
    if (typeof update.id !== "string" || !idPattern.test(update.id) || seen.has(update.id)) fail(`updates[${index}].id is invalid or duplicated`);
    seen.add(update.id);
    const title = optionalText(update.title, `updates[${index}].title`, 200);
    let source: Partial<SandboxSource> | undefined;
    if (update.source !== undefined) {
      const input = object(update.source, `updates[${index}].source`);
      source = {
        ...(input.html === undefined ? {} : { html: sourceText(input.html, `updates[${index}].source.html`) }),
        ...(input.css === undefined ? {} : { css: sourceText(input.css, `updates[${index}].source.css`) }),
        ...(input.js === undefined ? {} : { js: sourceText(input.js, `updates[${index}].source.js`) }),
      };
      if (Object.keys(source).length === 0) fail(`updates[${index}].source has no changes`);
    }
    if (title === undefined && source === undefined) fail(`updates[${index}] has no changes`);
    return { id: update.id, ...(title === undefined ? {} : { title }), ...(source === undefined ? {} : { source }) };
  });
}

export function validateJsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  validateJsonValue(value, label, 0);
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail(`${label} must be JSON serializable`); }
  if (encoded!.length > MAX_JSON_SIZE) fail(`${label} is too large`);
  return value as JsonObject;
}

function validateJsonValue(value: unknown, label: string, depth: number): void {
  if (depth > MAX_JSON_DEPTH) fail(`${label} is too deep`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (typeof value !== "object") fail(`${label} contains a non-JSON value`);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (unsafeKeys.has(key)) fail(`${label} contains an unsafe key`);
    validateJsonValue(child, `${label}.${key}`, depth + 1);
  }
}

export function initialRuntimeState(blocks: SandboxBlock[]): RuntimeState {
  return Object.fromEntries(blocks.map((block) => [block.id, structuredClone(block.initialState ?? {})]));
}

export function validateRuntimeState(value: unknown, blocks?: SandboxBlock[], label = "runtimeState"): RuntimeState {
  const state = validateJsonObject(value, label) as RuntimeState;
  const ids = blocks && new Set(blocks.map((block) => block.id));
  for (const [blockId, blockState] of Object.entries(state)) {
    if (!idPattern.test(blockId) || (ids && !ids.has(blockId))) fail(`${label}.${blockId} does not match an artifact block`);
    validateJsonObject(blockState, `${label}.${blockId}`);
  }
  return state;
}

export function applyRuntimeState(current: RuntimeState, patch: unknown, reset: unknown, blocks: SandboxBlock[]): RuntimeState {
  if (reset !== undefined && typeof reset !== "boolean") fail("resetState must be boolean");
  if (reset && patch !== undefined) fail("statePatch and resetState are mutually exclusive");
  if (reset) return initialRuntimeState(blocks);
  if (patch === undefined) return current;
  const validated = validateRuntimeState(patch, blocks, "statePatch");
  const next = structuredClone(current);
  for (const [blockId, blockPatch] of Object.entries(validated)) next[blockId] = mergeJsonObjects(next[blockId] ?? {}, blockPatch);
  return validateRuntimeState(next, blocks);
}

export function mergeJsonObjects(current: JsonObject, patch: JsonObject): JsonObject {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    next[key] = isJsonObject(existing) && isJsonObject(value) ? mergeJsonObjects(existing, value) : structuredClone(value);
  }
  return next;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("expectedVersion must be a positive integer");
  return value as number;
}

export function requiredExpectedVersion(value: unknown): number {
  const version = expectedVersion(value);
  if (version === undefined) fail("expectedVersion is required");
  return version;
}

export function blockIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) fail("blockIds must contain 1-200 items");
  const ids = value.map((id, index) => {
    if (typeof id !== "string" || !idPattern.test(id)) fail(`blockIds[${index}] is invalid`);
    return id;
  });
  if (new Set(ids).size !== ids.length) fail("blockIds contains duplicates");
  return ids;
}

export function feedbackIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) fail("feedbackIds must be an array of at most 200 UUIDs");
  const ids = value.map((id, index) => validateUuid(id, `feedbackIds[${index}]`));
  if (new Set(ids).size !== ids.length) fail("feedbackIds contains duplicates");
  return ids;
}

export function assertMutable(lifecycle: Lifecycle): void {
  if (lifecycle === "finalized") throw new AppError("INVALID_STATE", "finalized parties are immutable", 409);
}

export function lifecycleAfterUpdate(current: Lifecycle, linkedFeedback: boolean): Lifecycle {
  assertMutable(current);
  if (current === "initialized") throw new AppError("INVALID_STATE", "set an artifact before updating blocks", 409);
  return linkedFeedback ? "revising" : current;
}

export function lifecycleAfterResolution(current: Lifecycle, openFeedback: number): Lifecycle {
  assertMutable(current);
  return current === "revising" && openFeedback === 0 ? "in_review" : current;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) fail(`${label}.${extra} is not allowed`);
}

export function fail(message: string): never {
  throw new AppError("VALIDATION_ERROR", message, 400);
}
