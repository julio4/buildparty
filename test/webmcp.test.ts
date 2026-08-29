import test from "node:test";
import assert from "node:assert/strict";
import { AppError, WEBMCP_OPERATIONS, type JsonObject, type WebMcpOperation } from "../src/domain.ts";
import { BUILD_PARTY_AGENT_GUIDE, NativeWebMcpRegistration, WEBMCP_TOOL_DEFINITIONS, createWebMcpExecutor, executeWebMcpTool, recommendedNextAction, toolsForPage, type WebMcpPartyView } from "../src/webmcp.ts";

const id = "00000000-0000-4000-8000-000000000001";
const participantId = "00000000-0000-4000-8000-000000000002";
const revisionId = "00000000-0000-4000-8000-000000000003";
const token = "T".repeat(43);
const capability = "C".repeat(43);
const shareCapability = "S".repeat(43);
const artifact = { format: "buildparty.artifact/v1" as const, title: "Plan", blocks: [{ id: "scope", kind: "sandbox" as const, source: { html: "<p>Plan</p>" } }] };

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function party(lifecycle: WebMcpPartyView["party"]["lifecycle"] = "in_review", access: "owner" | "share" = "owner", availableOperations: WebMcpOperation[] = ["get_party", "get_feedback", "set_artifact", "update_blocks", "delete_blocks", "restore_revision", "respond_to_feedback", "finalize_party"]): WebMcpPartyView {
  return { party: { id, title: "Party", lifecycle, createdAt: new Date(0).toISOString(), finalizedAt: lifecycle === "finalized" ? new Date().toISOString() : null }, artifact, runtimeState: { scope: {} }, version: lifecycle === "initialized" ? null : 1, openFeedback: 0, participants: [], revisions: [], access, availableOperations };
}

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }

test("defines exactly the eleven strict WebMCP schemas", () => {
  assert.deepEqual(WEBMCP_TOOL_DEFINITIONS.map(tool => tool.name), [...WEBMCP_OPERATIONS]);
  assert.equal(new Set(WEBMCP_TOOL_DEFINITIONS.map(tool => tool.name)).size, 11);
  for (const tool of WEBMCP_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.description.length > 10, tool.name);
  }
  const setDefinition = WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "set_artifact")!;
  const set = setDefinition.inputSchema;
  const artifactSchema = (set.properties as Record<string, Record<string, unknown>>).artifact!;
  assert.equal(artifactSchema.additionalProperties, false);
  assert.deepEqual(artifactSchema.required, ["format", "title", "blocks"]);
  const artifactProperties = artifactSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(artifactProperties.format!.enum, ["buildparty.artifact/v1"]);
  const block = (artifactProperties.blocks!.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(block.kind!.enum, ["sandbox"]);
  assert.match(String(((block.source!.properties as Record<string, Record<string, unknown>>).html!.description)), /plain text/i);
  assert.match(setDefinition.description, /"format":"buildparty\.artifact\/v1"/);
  assert.match(setDefinition.description, /"kind":"sandbox"/);
  assert.match(setDefinition.description, /<p>Hello<\/p>/);
  assert.equal(artifactProperties.blocks!.minItems, 0);
  const update = WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "update_blocks")!.inputSchema;
  assert.deepEqual(update.required, ["expectedVersion"]);
  const deletion = WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "delete_blocks")!;
  assert.deepEqual(deletion.inputSchema.required, ["blockIds", "expectedVersion"]);
  assert.equal(((deletion.inputSchema.properties as Record<string, Record<string, unknown>>).blockIds!).uniqueItems, true);
  assert.match(deletion.description, /zero-block artifact/i);
  const restore = WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "restore_revision")!;
  assert.deepEqual(restore.inputSchema.required, ["revisionId", "expectedVersion"]);
  assert.match(restore.description, /whole current artifact and shared state/i);
  assert.match(restore.description, /changedBlockIds may be empty/i);
  assert.equal(WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "get_party")!.readOnly, true);
  assert.equal(WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "get_feedback")!.readOnly, true);
  assert.equal(WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "get_final_artifact")!.readOnly, true);
  const initDescription = WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "init")!.description;
  assert.match(initDescription, /first.*use or start BuildParty/i);
  assert.match(initDescription, /On landing.*reusable.*identity.*party page.*participant session/i);
  assert.doesNotMatch(initDescription, /On either page/);
  assert.match(WEBMCP_TOOL_DEFINITIONS.find(tool => tool.name === "create_party")!.description, /After init.*exactly one.*BuildParty session/i);
  for (const phrase of ["Keep this tab open", "owner URL private", "BuildParty session", "display name Owner", "one seamless", "data-bp-local", "window.buildParty.getState", "inline SVG", "learning notebook", "decision workshop"]) assert.match(BUILD_PARTY_AGENT_GUIDE, new RegExp(phrase, "i"));
});

test("next actions are compact and deterministic across party state", () => {
  assert.deepEqual(recommendedNextAction({ ...party("initialized"), artifact: null }), { tool: "set_artifact", reason: "publish prepared content for review" });
  assert.deepEqual(recommendedNextAction({ ...party("in_review"), openFeedback: 2 }), { tool: "get_feedback", reason: "read and address open human feedback" });
  assert.deepEqual(recommendedNextAction(party("finalized")), { tool: "get_final_artifact", reason: "retrieve the immutable final output" });
  assert.deepEqual(recommendedNextAction(party()), { tool: null, reason: "wait for or continue human review; do not poll" });
});

test("tool availability follows service state and role evidence", () => {
  assert.deepEqual(toolsForPage("landing"), ["init", "create_party"]);
  const empty = party("initialized", "owner", ["get_party", "get_feedback", "set_artifact"]);
  assert.deepEqual(toolsForPage("party", empty), ["init", "get_party", "set_artifact", "get_feedback"]);
  const owner = toolsForPage("party", party());
  assert.ok(owner.includes("finalize_party"));
  assert.ok(owner.includes("delete_blocks"));
  assert.ok(owner.includes("restore_revision"));
  const reviewerTools = toolsForPage("party", party("in_review", "share", ["get_party", "get_feedback", "set_artifact", "update_blocks", "delete_blocks", "restore_revision", "respond_to_feedback", "finalize_party"]));
  assert.ok(reviewerTools.includes("delete_blocks") && reviewerTools.includes("restore_revision"));
  assert.ok(!reviewerTools.includes("finalize_party"));
  const finalized = toolsForPage("party", party("finalized", "owner", ["get_party", "get_feedback", "get_final_artifact", "set_artifact"]));
  assert.deepEqual(finalized, ["init", "get_party", "get_feedback", "get_final_artifact"]);
  assert.ok(!toolsForPage("party", party("in_review", "owner", ["get_party", "get_feedback", "get_final_artifact"])).includes("get_final_artifact"));
});

test("registered tools return fresh context-aware unavailability without secrets", async t => {
  const local = new MemoryStorage(); const session = new MemoryStorage();
  const landing = createWebMcpExecutor({ localStorage: local, sessionStorage: session });
  const onLanding = await landing("get_party", {}) as any;
  assert.equal(onLanding.error.code, "TOOL_UNAVAILABLE");
  assert.deepEqual(onLanding.context, { page: "landing", lifecycle: null, access: null, availableOperations: ["init", "create_party"] });

  const partyExecutor = createWebMcpExecutor({ partyId: id, capability, localStorage: local, sessionStorage: session });
  const createOnParty = await partyExecutor("create_party", { title: "Wrong context" }) as any;
  assert.equal(createOnParty.error.code, "TOOL_UNAVAILABLE");
  const beforeInit = await executeWebMcpTool(partyExecutor, "get_party", {}) as any;
  assert.equal(beforeInit.error.code, "AGENT_SESSION_REQUIRED");

  session.setItem(`buildparty.webmcp.participant.${id}`, JSON.stringify({ participant: { id: participantId, name: "Agent", kind: "agent" }, participantToken: token }));
  let current = party("finalized", "owner", ["get_party", "get_feedback", "get_final_artifact"]); let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; return json(current); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const finalizedMutation = await partyExecutor("update_blocks", { expectedVersion: 1, resetState: true }) as any;
  assert.equal(finalizedMutation.error.code, "TOOL_UNAVAILABLE");
  assert.equal(finalizedMutation.context.lifecycle, "finalized");
  assert.equal(finalizedMutation.context.access, "owner");
  assert.deepEqual(finalizedMutation.context.availableOperations, ["init", "get_party", "get_feedback", "get_final_artifact"]);
  assert.match(finalizedMutation.error.hint, /remains registered.*no tool refetch/i);

  current = party("in_review", "share", ["get_party", "get_feedback", "set_artifact", "update_blocks", "delete_blocks", "restore_revision", "respond_to_feedback"]);
  const reviewerFinalize = await partyExecutor("finalize_party", { name: "No", expectedVersion: 1 }) as any;
  assert.equal(reviewerFinalize.error.code, "TOOL_UNAVAILABLE");
  assert.equal(reviewerFinalize.context.access, "share");
  assert.ok(!reviewerFinalize.context.availableOperations.includes("finalize_party"));
  assert.equal(requests, 2, "unavailable party tools only preflight fresh server evidence");
  assert.doesNotMatch(JSON.stringify({ onLanding, createOnParty, finalizedMutation, reviewerFinalize }), new RegExp(`${token}|${capability}`));
});

test("native registration updates same-name delegates without aborting and cleans changed sets", async () => {
  const calls: { name: string; signal?: AbortSignal; readOnly?: boolean; tool: ModelContextTool }[] = [];
  const context: ModelContext = { registerTool(tool, options) { calls.push({ name: tool.name, signal: options?.signal, readOnly: tool.annotations?.readOnlyHint, tool }); } };
  const registration = new NativeWebMcpRegistration(context, true);
  assert.equal(await registration.sync(["get_party", "set_artifact"], async () => ({ delegate: 1 })), true);
  const firstSignal = calls[0]!.signal!;
  const held = calls[0]!.tool;
  assert.equal(calls[0]!.readOnly, true);
  assert.equal(calls[1]!.readOnly, false);
  await registration.sync(["get_party", "set_artifact"], async () => ({ delegate: 2 }));
  assert.equal(calls.length, 2);
  assert.equal(firstSignal.aborted, false);
  assert.deepEqual(await held.execute({}), { delegate: 2 });
  await registration.sync(["get_feedback"], async () => ({}));
  assert.equal(firstSignal.aborted, true);
  assert.equal(calls.at(-1)!.name, "get_feedback");
  const secondSignal = calls.at(-1)!.signal!;
  registration.clear();
  assert.equal(secondSignal.aborted, true);

  const execute = async () => ({});
  let unsupportedCalls = 0;
  const unsupported = new NativeWebMcpRegistration({ registerTool() { unsupportedCalls++; } }, false);
  assert.equal(await unsupported.sync(["init"], execute), false);
  assert.equal(unsupportedCalls, 0);

  const failure = new Error("registration rejected");
  const active = new Map<string, ModelContextTool>();
  const failedSignals: AbortSignal[] = [];
  let rejectRegistration = true; let releaseLate!: () => void; let lateSawAbort = false;
  const rejecting = new NativeWebMcpRegistration({ registerTool(tool, options) {
    const signal = options!.signal!; failedSignals.push(signal); active.set(tool.name, tool);
    signal.addEventListener("abort", () => active.delete(tool.name), { once: true });
    if (tool.name === "set_artifact" && rejectRegistration) return Promise.reject(failure);
    if (tool.name === "get_party" && rejectRegistration) return new Promise<void>(resolve => { releaseLate = () => { lateSawAbort = signal.aborted; resolve(); }; });
  } }, true);
  const failedSync = rejecting.sync(["get_party", "set_artifact"], execute);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(failedSignals.every(signal => signal.aborted), "one rejection must immediately abort every started registration");
  releaseLate();
  await assert.rejects(failedSync, failure);
  assert.equal(lateSawAbort, true);
  assert.equal(active.size, 0, "late completion must not leave a partial tool active");

  rejectRegistration = false;
  await rejecting.sync(["get_party", "set_artifact"], execute);
  assert.deepEqual([...active.keys()], ["get_party", "set_artifact"]);
  assert.ok(failedSignals.slice(-2).every(signal => !signal.aborted), "a retry must use a clean signal");
  rejecting.clear();
  assert.equal(active.size, 0);
});

test("native tools return actionable structured validation failures without mutating", async t => {
  const local = new MemoryStorage(); const session = new MemoryStorage();
  let requests = 0; let nativeTool: ModelContextTool | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; return json({}); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const registration = new NativeWebMcpRegistration({ registerTool(tool) { nativeTool = tool; } }, true);
  const executor = createWebMcpExecutor({ partyId: id, capability, localStorage: local, sessionStorage: session });
  await registration.sync(["set_artifact"], executor);
  const result = await nativeTool!.execute({ artifact: { format: "v1", title: "Plan", blocks: [{ id: "scope", kind: "html", source: { html: "<p>Plan</p>" } }] } }) as { ok: boolean; error: { code: string; message: string; path: string; hint: string; retryable: boolean } };
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "VALIDATION_ERROR");
  assert.equal(result.error.path, "artifact.format");
  assert.match(result.error.message, /artifact\.format/);
  assert.match(result.error.hint, /artifact\.format "buildparty\.artifact\/v1"/);
  assert.match(result.error.hint, /block\.kind "sandbox"/);
  assert.equal(result.error.retryable, false);
  assert.equal(requests, 0, "invalid literals must not reach the API");

  await registration.sync(["delete_blocks"], executor);
  const invalidDelete = await nativeTool!.execute({ blockIds: ["scope", "scope"], expectedVersion: 1 }) as { ok: boolean; error: { code: string; path?: string } };
  assert.equal(invalidDelete.ok, false);
  assert.equal(invalidDelete.error.code, "VALIDATION_ERROR");
  assert.equal(invalidDelete.error.path, "blockIds");
  assert.equal(requests, 0);

  await registration.sync(["set_artifact"], async () => { throw new AppError("FORBIDDEN", `Bearer ${capability} rejected`, 403); });
  const safe = await nativeTool!.execute({}) as { ok: boolean; error: { code: string } };
  assert.equal(safe.ok, false);
  assert.equal(safe.error.code, "FORBIDDEN");
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(capability));
  registration.clear();
});

test("document-lifetime registration installs exactly eleven tools once", async () => {
  const calls: { tool: ModelContextTool; signal: AbortSignal }[] = [];
  const registration = new NativeWebMcpRegistration({ registerTool(tool, options) { calls.push({ tool, signal: options!.signal! }); } }, true);
  await registration.sync([...WEBMCP_OPERATIONS], async () => ({ delegate: "first" }));
  const held = new Map(calls.map(call => [call.tool.name, call.tool]));
  await registration.sync([...WEBMCP_OPERATIONS], async () => ({ delegate: "current" }));
  assert.equal(calls.length, 11);
  assert.deepEqual([...held.keys()], [...WEBMCP_OPERATIONS]);
  assert.ok(calls.every(call => !call.signal.aborted));
  assert.deepEqual(await held.get("get_party")!.execute({}), { delegate: "current" });
  registration.clear();
  assert.ok(calls.every(call => call.signal.aborted));
});

test("executor uses a separate internal agent session, authenticated headers, and refreshes mutations", async t => {
  const local = new MemoryStorage(); const session = new MemoryStorage();
  const requests: { url: string; init: RequestInit }[] = [];
  let current = party(); let mutationRefreshes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (url === "/api/init") return json({ operations: WEBMCP_OPERATIONS });
    if (url.endsWith("/participants")) return json({ participant: { id: participantId, name: "Agent One", kind: "agent" }, participantToken: token }, 201);
    if (url.endsWith("/blocks")) {
      current = { ...current, version: 2, revisions: [{ id: revisionId, version: 2, source: "update_blocks", changed_block_ids: ["scope"], feedback_ids: [], summary: null, actor_identity_id: participantId, created_at: new Date().toISOString(), snapshot_available: true, snapshot_pruned: false, snapshot_bytes: 123 }] };
      return json({ artifact, runtimeState: { scope: {} }, version: 2, lifecycle: "in_review", revision: { id: revisionId, changed_block_ids: ["scope"], feedback_ids: [] } });
    }
    if (url === `/api/parties/${id}`) return json(current);
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const executor = createWebMcpExecutor({ partyId: id, capability, localStorage: local, sessionStorage: session, onMutation: () => { mutationRefreshes++; } });
  const initialized = await executor("init", { displayName: "Agent One" }) as any;
  assert.equal(initialized.guide, BUILD_PARTY_AGENT_GUIDE);
  assert.deepEqual(initialized.nextAction, { tool: "get_party", reason: "read current party state before acting" });
  assert.doesNotMatch(JSON.stringify(initialized), new RegExp(token));
  assert.ok(!session.getItem(`buildparty.participant.${id}`), "human participant storage remains untouched");
  assert.match(session.getItem(`buildparty.webmcp.participant.${id}`) ?? "", new RegExp(token));

  const result = await executor("update_blocks", { expectedVersion: 1, updates: [{ id: "scope", source: { html: "<p>Revised</p>" } }] });
  assert.deepEqual((result as { changedBlockIds: string[] }).changedBlockIds, ["scope"]);
  assert.equal(mutationRefreshes, 1);
  const patch = requests.find(request => request.url.endsWith("/blocks"))!;
  const headers = new Headers(patch.init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${capability}`);
  assert.equal(headers.get("x-participant-token"), token);
  assert.doesNotMatch(String(patch.init.body), new RegExp(`${token}|${capability}`));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${token}|${capability}`));
});

test("state-only updates return success without inventing revisions and still refresh", async t => {
  const local = new MemoryStorage(); const session = new MemoryStorage();
  session.setItem(`buildparty.webmcp.participant.${id}`, JSON.stringify({ participant: { id: participantId, name: "Agent", kind: "agent" }, participantToken: token }));
  const patchBodies: Record<string, unknown>[] = [];
  let current = party(); let refreshes = 0; let partyViews = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === `/api/parties/${id}/blocks`) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; patchBodies.push(body);
      const runtimeState: JsonObject = body.resetState === true ? { scope: {} } : { scope: { count: 2 } };
      current = { ...current, runtimeState };
      return json({ artifact, runtimeState, version: 1, lifecycle: "in_review", revision: null });
    }
    if (url === `/api/parties/${id}`) return json(current);
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const executor = createWebMcpExecutor({ partyId: id, capability, localStorage: local, sessionStorage: session, onPartyView: () => { partyViews++; }, onMutation: () => { refreshes++; } });

  const patched = await executor("update_blocks", { expectedVersion: 1, statePatch: { scope: { count: 2 } } });
  const reset = await executor("update_blocks", { expectedVersion: 1, resetState: true });
  assert.deepEqual(patched, { ok: true, partyId: id, lifecycle: "in_review", version: 1, revisionId: null, changedBlockIds: [], runtimeState: { scope: { count: 2 } }, availableOperations: party().availableOperations });
  assert.deepEqual(reset, { ok: true, partyId: id, lifecycle: "in_review", version: 1, revisionId: null, changedBlockIds: [], runtimeState: { scope: {} }, availableOperations: party().availableOperations });
  assert.deepEqual(patchBodies.slice(0, 2).map(body => ({ statePatch: body.statePatch, resetState: body.resetState })), [{ statePatch: { scope: { count: 2 } }, resetState: undefined }, { statePatch: undefined, resetState: true }]);
  assert.equal(patchBodies.length, 2, "each successful call makes one PATCH request");
  assert.equal(refreshes, 2);
  assert.equal(partyViews, 4, "each success preflights and refreshes server evidence");
  assert.doesNotMatch(JSON.stringify({ patched, reset }), new RegExp(`${token}|${capability}`));

  await assert.rejects(() => executor("update_blocks", { expectedVersion: 1, updates: [{ id: "scope", title: "Source change" }] }), (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_RESPONSE");
  assert.equal(patchBodies.length, 3, "malformed source response is rejected after its single PATCH");
  assert.equal(refreshes, 2, "a malformed response must not report or refresh a successful mutation");
  assert.equal(partyViews, 5);
});

test("create_party activates held party tools before deferred SPA navigation", async t => {
  const local = new MemoryStorage(); const session = new MemoryStorage(); let navigated = ""; let resultObserved = false; let navigationSawResult = false;
  const ownerUrl = `http://example.test/party/${id}#cap=${capability}`;
  const shareUrl = `http://example.test/party/${id}#cap=${shareCapability}`;
  let current: WebMcpPartyView = { ...party("initialized", "owner", ["get_party", "get_feedback", "set_artifact"]), artifact: null, runtimeState: null };
  let artifactAuthorization = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "/api/init") return json({ operations: WEBMCP_OPERATIONS });
    if (url === "/api/parties") return json({ party: { id, title: "Party", lifecycle: "initialized" }, participant: { id: participantId, name: "Agent", kind: "agent" }, participantToken: token, ownerCapability: capability, shareCapability, ownerUrl, shareUrl }, 201);
    if (url === `/api/parties/${id}/artifact`) {
      artifactAuthorization = new Headers(init.headers).get("authorization") ?? "";
      current = { ...party("in_review", "owner"), artifact, version: 1 };
      return json({ version: 1, lifecycle: "in_review", revision: { id: revisionId, changed_block_ids: ["scope"], feedback_ids: [] } });
    }
    if (url === `/api/parties/${id}`) return json(current);
    throw new Error(`unexpected request ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const calls: { tool: ModelContextTool; signal: AbortSignal }[] = [];
  const registration = new NativeWebMcpRegistration({ registerTool(tool, options) { calls.push({ tool, signal: options!.signal! }); } }, true);
  let resolveNavigation!: () => void;
  const navigationComplete = new Promise<void>(resolve => { resolveNavigation = resolve; });
  let delegate!: ReturnType<typeof createWebMcpExecutor>;
  const landing = createWebMcpExecutor({
    localStorage: local,
    sessionStorage: session,
    onPartyCreated: context => { delegate = createWebMcpExecutor({ ...context, localStorage: local, sessionStorage: session }); },
    navigate: url => { navigated = url; navigationSawResult = resultObserved; resolveNavigation(); },
  });
  delegate = landing;
  await registration.sync([...WEBMCP_OPERATIONS], (name, input) => delegate(name, input));
  const held = new Map(calls.map(call => [call.tool.name, call.tool]));
  await held.get("init")!.execute({ displayName: "Agent" });
  const result = await held.get("create_party")!.execute({ title: "Party" });
  resultObserved = true;
  assert.equal(navigated, "", "navigation must wait until the tool result is observable");
  const setResult = await held.get("set_artifact")!.execute({ artifact, summary: "Immediate handoff" }) as any;
  assert.equal(navigated, "", "the held party tool must finish before the deferred navigation callback runs");
  assert.equal(setResult.version, 1);
  assert.equal(artifactAuthorization, `Bearer ${capability}`);
  assert.deepEqual(result, { party: { id, title: "Party", lifecycle: "initialized" }, participant: { id: participantId, name: "Agent", kind: "agent" }, ownerUrl, shareUrl, nextAction: { tool: "set_artifact", reason: "publish existing content or prepare it first" } });
  await navigationComplete;
  assert.equal(navigationSawResult, true);
  assert.equal(navigated, ownerUrl);
  assert.equal(calls.length, 11);
  assert.ok(calls.every(call => !call.signal.aborted));
  registration.clear();

  assert.doesNotMatch(JSON.stringify(result).replace(ownerUrl, "").replace(shareUrl, ""), new RegExp(`${token}|${capability}|${shareCapability}`));
  assert.equal(session.getItem(`buildparty.capability.${id}`), capability);
  assert.match(session.getItem(`buildparty.webmcp.participant.${id}`) ?? "", new RegExp(token));
});

test("tool inputs map to the party HTTP API contract", async t => {
  const local = new MemoryStorage(); const session = new MemoryStorage();
  const feedbackId = "00000000-0000-4000-8000-000000000004";
  const responseId = "00000000-0000-4000-8000-000000000005";
  const finalId = "00000000-0000-4000-8000-000000000006";
  session.setItem(`buildparty.webmcp.participant.${id}`, JSON.stringify({ participant: { id: participantId, name: "Agent", kind: "agent" }, participantToken: token }));
  const requests: { url: string; method: string; body?: unknown }[] = [];
  let current = party("in_review", "owner");
  const final = { id: finalId, name: "Approved", source_version: 2, open_feedback_overridden: false, created_at: new Date(0).toISOString(), html: "<!doctype html>" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    requests.push({ url, method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url === `/api/parties/${id}`) return json(current);
    if (url === `/api/parties/${id}/artifact`) return json({ version: 2, lifecycle: "in_review", revision: { id: revisionId, changed_block_ids: ["scope"], feedback_ids: [] } });
    if (url === `/api/parties/${id}/blocks` && method === "DELETE") return json({ version: 3, lifecycle: "in_review", revision: { id: revisionId, changed_block_ids: ["scope"], feedback_ids: [] }, deletedBlockIds: ["scope"] });
    if (url === `/api/parties/${id}/revisions/${revisionId}/restore`) return json({ version: 4, lifecycle: "in_review", revision: { id: revisionId, changed_block_ids: [], feedback_ids: [] }, changedBlockIds: [], restoredFromRevisionId: revisionId, restoredFromVersion: 1 });
    if (url === `/api/parties/${id}/storage`) return json({ scope: "party_row_data_only", accountedRowBytes: 4096, quotaBytes: null });
    if (url === `/api/parties/${id}/feedback?status=open`) return json([{ id: feedbackId, block_id: "scope", anchorStatus: "archived", kind: "comment", body: "Still auditable", status: "open", actor_identity_id: participantId, created_at: new Date(0).toISOString(), resolved_at: null, responses: [] }]);
    if (url === `/api/parties/${id}/feedback/${feedbackId}/respond`) return json({ lifecycle: "in_review", response: { id: responseId, revision_id: revisionId, resolved: true }, feedback: { id: feedbackId, status: "resolved" } });
    if (url === `/api/parties/${id}/finalize`) { current = party("finalized", "owner", ["get_party", "get_feedback", "get_final_artifact"]); return json({ lifecycle: "finalized", final }); }
    if (url === `/api/parties/${id}/final`) return json(final);
    throw new Error(`unexpected request ${method} ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const executor = createWebMcpExecutor({ partyId: id, capability, localStorage: local, sessionStorage: session });

  await executor("set_artifact", { artifact, expectedVersion: 1, summary: "Publish" });
  const deleted = await executor("delete_blocks", { blockIds: ["scope"], expectedVersion: 2 });
  const restored = await executor("restore_revision", { revisionId, expectedVersion: 3 });
  const feedbackResult = await executor("get_feedback", { status: "open" });
  await executor("respond_to_feedback", { feedbackId, revisionId, resolve: true });
  await executor("finalize_party", { name: "Approved", expectedVersion: 2 });
  const finalResult = await executor("get_final_artifact", {});

  assert.deepEqual((feedbackResult as { feedback: unknown[] }).feedback[0], { id: feedbackId, blockId: "scope", anchorStatus: "archived", kind: "comment", body: "Still auditable", status: "open", actorId: participantId, createdAt: new Date(0).toISOString(), resolvedAt: null, responses: [] });
  assert.deepEqual(requests.find(request => request.url.endsWith("/artifact")), { url: `/api/parties/${id}/artifact`, method: "PUT", body: { artifact, expectedVersion: 1, summary: "Publish" } });
  assert.deepEqual(requests.find(request => request.url.endsWith("/blocks")), { url: `/api/parties/${id}/blocks`, method: "DELETE", body: { blockIds: ["scope"], expectedVersion: 2 } });
  assert.deepEqual(requests.find(request => request.url.includes("/restore")), { url: `/api/parties/${id}/revisions/${revisionId}/restore`, method: "POST", body: { expectedVersion: 3 } });
  assert.deepEqual(deleted, { partyId: id, lifecycle: "in_review", version: 3, revisionId, changedBlockIds: ["scope"], feedbackIds: [], deletedBlockIds: ["scope"], storage: { scope: "party_row_data_only", accountedRowBytes: 4096, quotaBytes: null }, availableOperations: party().availableOperations });
  assert.deepEqual(restored, { partyId: id, lifecycle: "in_review", version: 4, revisionId, changedBlockIds: [], feedbackIds: [], restoredFromRevisionId: revisionId, restoredFromVersion: 1, storage: { scope: "party_row_data_only", accountedRowBytes: 4096, quotaBytes: null }, availableOperations: party().availableOperations });
  assert.doesNotMatch(JSON.stringify({ deleted, restored }), new RegExp(`${token}|${capability}|artifact_snapshot|runtime_state_snapshot`));
  assert.deepEqual(requests.find(request => request.url.includes("/respond")), { url: `/api/parties/${id}/feedback/${feedbackId}/respond`, method: "POST", body: { revisionId, resolve: true } });
  assert.deepEqual(requests.find(request => request.url.endsWith("/finalize")), { url: `/api/parties/${id}/finalize`, method: "POST", body: { name: "Approved", expectedVersion: 2 } });
  assert.deepEqual(finalResult, { partyId: id, lifecycle: "finalized", final: { id: finalId, name: "Approved", sourceVersion: 2, openFeedbackOverridden: false, createdAt: new Date(0).toISOString(), html: "<!doctype html>" } });
  assert.doesNotMatch(JSON.stringify(finalResult), new RegExp(`${token}|${capability}`));
});

test("version conflicts return current retry evidence without overwriting", async t => {
  const local = new MemoryStorage(); const session = new MemoryStorage();
  session.setItem(`buildparty.webmcp.participant.${id}`, JSON.stringify({ participant: { id: participantId, name: "Agent", kind: "agent" }, participantToken: token }));
  const latest = { ...party(), version: 3, revisions: [{ id: revisionId, version: 3, source: "update_blocks", changed_block_ids: ["scope"], feedback_ids: [], summary: null, actor_identity_id: participantId, created_at: new Date().toISOString(), snapshot_available: true, snapshot_pruned: false, snapshot_bytes: 123 }] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).endsWith("/blocks")
    ? json({ error: "VERSION_CONFLICT", message: "artifact version changed" }, 409)
    : json(latest);
  t.after(() => { globalThis.fetch = originalFetch; });
  const executor = createWebMcpExecutor({ partyId: id, capability, localStorage: local, sessionStorage: session });
  const result = await executor("update_blocks", { expectedVersion: 1, updates: [{ id: "scope", title: "Changed" }] }) as { ok: boolean; retry: { currentVersion: number; latestRevisionId: string; changedBlockIds: string[] } };
  assert.equal(result.ok, false);
  assert.equal(result.retry.currentVersion, 3);
  assert.equal(result.retry.latestRevisionId, revisionId);
  assert.deepEqual(result.retry.changedBlockIds, ["scope"]);
});
