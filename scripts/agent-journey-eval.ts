import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { BUILD_PARTY_AGENT_GUIDE, WEBMCP_TOOL_DEFINITIONS, recommendedNextAction, validateWebMcpInput } from "../src/webmcp.ts";
import { WEBMCP_OPERATIONS, applyRuntimeState, validateArtifact, type Artifact, type JsonObject, type RuntimeState, type WebMcpOperation } from "../src/domain.ts";

type Provider = "openai" | "gemini";
type QualitySection = { name: string; concepts: string[][] };
type ScenarioQuality = { fallbackTitle?: string; minBlocks?: number; sections?: QualitySection[]; interaction?: { persistent: boolean } };
export type Scenario = { id: string; fixture: "landing" | "feedback" | "state" | "none"; prompt: string; allowedCalls: WebMcpOperation[]; requiredCalls: WebMcpOperation[]; forbiddenCalls: WebMcpOperation[]; quality?: ScenarioQuality };
export type EvalCall = { name: string; arguments: Record<string, unknown>; result: unknown; schemaValid: boolean; error?: string };
type ModelStep = { calls: { id: string; name: string; arguments: Record<string, unknown> }[]; text: string; continuation: unknown; usage?: unknown };
export type Trial = { scenario: Scenario; calls: EvalCall[]; finalText: string; turns: number; usage: unknown[]; completed: boolean };
type Check = { id: string; passed: boolean; evidence: unknown };
export type Score = { passed: boolean; checks: Check[] };
type FetchLike = typeof fetch;

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const scenarioPath = resolve(root, "evals/buildparty/agent-journeys.json");
const feedbackId = "00000000-0000-4000-8000-000000000004";
const revisionId = "00000000-0000-4000-8000-000000000007";
const partyId = "00000000-0000-4000-8000-000000000003";
const ownerCapability = "O".repeat(43);
const reviewerCapability = "R".repeat(43);
const declaredRemoteDependency = /<(?:script|img|iframe|audio|video|source)\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\/|<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\/|<form\b[^>]*\baction\s*=\s*["']?\s*(?:https?:)?\/\/|\burl\s*\(\s*["']?\s*(?:https?:)?\/\/|@import\s+(?:url\s*\()?\s*["']?\s*(?:https?:)?\/\/|\b(?:fetch|import)\s*\(|\b(?:XMLHttpRequest|WebSocket|EventSource)\b|\bimport\s+[^;]*\bfrom\s*["'](?:https?:)?\/\//i;

export async function loadScenarios(path = scenarioPath): Promise<Scenario[]> {
  return validateScenarios(JSON.parse(await readFile(path, "utf8")));
}

export function validateScenarios(value: unknown): Scenario[] {
  if (!Array.isArray(value) || value.length !== 7) throw new Error("agent journeys must contain exactly seven scenarios");
  const expected = ["bare-start", "planning-context", "learning-context", "presentation-context", "feedback-revision", "state-only", "no-webmcp"];
  const ids = value.map(row => (row as Scenario)?.id);
  if (new Set(ids).size !== 7 || expected.some(id => !ids.includes(id))) throw new Error("agent journey IDs do not match the approved seven scenarios");
  for (const raw of value) {
    const row = raw as Scenario;
    if (!row || !["landing", "feedback", "state", "none"].includes(row.fixture) || typeof row.prompt !== "string" || !row.prompt.trim()) throw new Error(`invalid scenario ${row?.id ?? "unknown"}`);
    for (const field of ["allowedCalls", "requiredCalls", "forbiddenCalls"] as const) if (!Array.isArray(row[field]) || row[field].some(name => !WEBMCP_OPERATIONS.includes(name))) throw new Error(`invalid ${field} in ${row.id}`);
    if (row.requiredCalls.some(name => !row.allowedCalls.includes(name))) throw new Error(`required call is not allowed in ${row.id}`);
    if (row.quality !== undefined) {
      if (!row.quality || typeof row.quality !== "object") throw new Error(`invalid quality in ${row.id}`);
      if (row.quality.minBlocks !== undefined && (!Number.isSafeInteger(row.quality.minBlocks) || row.quality.minBlocks < 1 || row.quality.minBlocks > 200)) throw new Error(`invalid minBlocks in ${row.id}`);
      if (row.quality.sections !== undefined && (!Array.isArray(row.quality.sections) || row.quality.sections.some(section => !section?.name || !Array.isArray(section.concepts) || section.concepts.some(group => !Array.isArray(group) || !group.length || group.some(term => typeof term !== "string" || !term.trim()))))) throw new Error(`invalid sections in ${row.id}`);
    }
  }
  return value as Scenario[];
}

export function openAiTools() {
  return WEBMCP_TOOL_DEFINITIONS.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
}

export function geminiTools() {
  return [{ functionDeclarations: WEBMCP_TOOL_DEFINITIONS.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }];
}

export function buildOpenAiRequest(model: string, input: unknown[], withTools: boolean, maxOutputTokens = 2500) {
  return { model, instructions: systemPrompt, input, ...(withTools ? { tools: openAiTools(), tool_choice: "auto", parallel_tool_calls: false } : {}), max_output_tokens: maxOutputTokens };
}

export function parseOpenAiResponse(body: any): ModelStep {
  if (!Array.isArray(body?.output)) throw new Error("OpenAI response has no output array");
  const calls = body.output.filter((item: any) => item?.type === "function_call").map((item: any) => {
    let args: unknown;
    try { args = JSON.parse(item.arguments); } catch { throw new Error(`OpenAI returned malformed arguments for ${item.name}`); }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`OpenAI returned non-object arguments for ${item.name}`);
    return { id: String(item.call_id), name: String(item.name), arguments: args as Record<string, unknown> };
  });
  const text = typeof body.output_text === "string" ? body.output_text : body.output.flatMap((item: any) => item?.type === "message" ? item.content ?? [] : []).filter((part: any) => part?.type === "output_text").map((part: any) => part.text).join("\n");
  return { calls, text, continuation: body.output, usage: body.usage };
}

export function buildGeminiRequest(contents: unknown[], withTools: boolean, maxOutputTokens = 2500) {
  return { systemInstruction: { parts: [{ text: systemPrompt }] }, contents, ...(withTools ? { tools: geminiTools(), toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}), generationConfig: { maxOutputTokens, temperature: 0.2 } };
}

export function parseGeminiResponse(body: any): ModelStep {
  const content = body?.candidates?.[0]?.content;
  if (!content || !Array.isArray(content.parts)) throw new Error(`Gemini response has no candidate content${body?.promptFeedback?.blockReason ? `: ${body.promptFeedback.blockReason}` : ""}`);
  const calls = content.parts.filter((part: any) => part?.functionCall).map((part: any, index: number) => ({ id: String(part.functionCall.id ?? `${part.functionCall.name}-${index}`), name: String(part.functionCall.name), arguments: part.functionCall.args ?? {} }));
  const text = content.parts.filter((part: any) => typeof part.text === "string").map((part: any) => part.text).join("\n");
  return { calls, text, continuation: content, usage: body.usageMetadata };
}

export function assertCredential(provider: Provider, env: NodeJS.ProcessEnv = process.env) {
  const name = provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
  const key = env[name];
  if (!key) throw new Error(`${name} is required for the selected ${provider} evaluator`);
  return key;
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number, fetcher: FetchLike): Promise<any> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try { response = await fetcher(url, { ...init, signal }); }
  catch (error) { throw new Error(`model request failed: ${error instanceof Error ? error.message : String(error)}`); }
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { throw new Error(`model API returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`model API HTTP ${response.status}: ${String(body?.error?.message ?? "request failed").slice(0, 300)}`);
  return body;
}

async function openAiStep(model: string, key: string, input: unknown[], withTools: boolean, maxOutputTokens: number, timeoutMs: number, fetcher: FetchLike) {
  const body = await requestJson("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(buildOpenAiRequest(model, input, withTools, maxOutputTokens)) }, timeoutMs, fetcher);
  return parseOpenAiResponse(body);
}

async function geminiStep(model: string, key: string, contents: unknown[], withTools: boolean, maxOutputTokens: number, timeoutMs: number, fetcher: FetchLike) {
  const body = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(buildGeminiRequest(contents, withTools, maxOutputTokens)) }, timeoutMs, fetcher);
  return parseGeminiResponse(body);
}

const systemPrompt = "Act as the user's browser agent. Complete the request autonomously with the available BuildParty tools, following their descriptions and returned nextAction evidence. Do not invent tool results, URLs, content not supplied by the user, or network dependencies. When done, give a concise user-facing response. Label owner and reviewer links distinctly; keep the owner link private. If no tools are available, explain the exact capability needed instead of pretending to act.";

export class BuildPartyFixture {
  private initialized: boolean;
  private party: null | { id: string; title: string; lifecycle: "initialized" | "in_review" | "revising" };
  private artifact: Artifact | null;
  private runtimeState: JsonObject | null;
  private version: number | null;
  private openFeedback: number;
  private linkedRevision: string | null = null;

  constructor(readonly kind: Scenario["fixture"]) {
    this.initialized = kind === "feedback" || kind === "state";
    this.party = kind === "landing" || kind === "none" ? null : { id: partyId, title: kind === "feedback" ? "Launch review" : "Workshop timer", lifecycle: "in_review" };
    this.artifact = kind === "landing" || kind === "none" ? null : { format: "buildparty.artifact/v1", title: this.party!.title, blocks: [{ id: "hero", title: kind === "feedback" ? "Call to action" : "Facilitator timer", kind: "sandbox", source: { html: kind === "feedback" ? "<button>Review</button>" : "<output name=timer>10</output>", css: "button,output{padding:1rem}", js: "" }, initialState: kind === "state" ? { timer: 10 } : {} }] };
    this.runtimeState = kind === "landing" || kind === "none" ? null : { hero: kind === "state" ? { timer: 10 } : {} };
    this.version = kind === "landing" || kind === "none" ? null : kind === "state" ? 3 : 1;
    this.openFeedback = kind === "feedback" ? 1 : 0;
  }

  dispatch(name: string, raw: unknown): unknown {
    if (!WEBMCP_OPERATIONS.includes(name as WebMcpOperation)) throw new Error(`unknown tool ${name}`);
    const tool = name as WebMcpOperation;
    const input = validateWebMcpInput(tool, structuredClone(raw));
    if (tool === "init") {
      this.initialized = true;
      return { identity: { displayName: input.displayName, kind: "agent" }, operations: WEBMCP_OPERATIONS, guide: BUILD_PARTY_AGENT_GUIDE, nextAction: { tool: this.party ? "get_party" : "create_party", reason: this.party ? "read current party state before acting" : "create one review room" } };
    }
    if (tool === "create_party") {
      if (!this.initialized || this.party) throw new Error("create_party requires init on landing and exactly one room");
      this.party = { id: partyId, title: String(input.title), lifecycle: "initialized" };
      return { party: this.party, ownerUrl: `https://buildparty.example/party/${partyId}#cap=${ownerCapability}`, shareUrl: `https://buildparty.example/party/${partyId}#cap=${reviewerCapability}`, nextAction: { tool: "set_artifact", reason: "publish existing content or prepare it first" } };
    }
    if (!this.party || !this.initialized) throw new Error("party session is unavailable");
    if (tool === "get_party") return { party: this.party, artifact: this.artifact, runtimeState: this.runtimeState, version: this.version, openFeedback: this.openFeedback, revisions: this.linkedRevision ? [{ id: this.linkedRevision, version: this.version, feedbackIds: [feedbackId] }] : [], availableOperations: WEBMCP_OPERATIONS.filter(name => name !== "create_party"), nextAction: recommendedNextAction({ party: this.party, artifact: this.artifact, openFeedback: this.openFeedback }) };
    if (tool === "get_feedback") return { partyId, status: input.status ?? "all", feedback: this.openFeedback ? [{ id: feedbackId, blockId: "hero", anchorStatus: "active", kind: "change", body: "Change the CTA label to Start the review.", status: "open", responses: [] }] : [] };
    if (tool === "set_artifact") {
      this.artifact = input.artifact as Artifact; this.runtimeState = Object.fromEntries(this.artifact.blocks.map(block => [block.id, block.initialState ?? {}])); this.version = (this.version ?? 0) + 1; this.party.lifecycle = "in_review";
      return { ok: true, partyId, lifecycle: "in_review", version: this.version, revisionId: "00000000-0000-4000-8000-000000000006", changedBlockIds: this.artifact.blocks.map(block => block.id), nextAction: { tool: null, reason: "invite human review; do not poll" } };
    }
    if (tool === "update_blocks") {
      if (this.artifact === null || input.expectedVersion !== this.version) throw new Error("VERSION_CONFLICT");
      if (input.updates) {
        for (const update of input.updates as any[]) {
          const block = this.artifact.blocks.find(item => item.id === update.id); if (!block) throw new Error(`unknown block ${update.id}`);
          if (update.title) block.title = update.title; if (update.source) block.source = { ...block.source, ...update.source };
        }
        if (this.openFeedback && !(input.feedbackIds as string[]).includes(feedbackId)) throw new Error("targeted feedback revision must link its feedback ID");
        this.version!++; this.party.lifecycle = this.openFeedback ? "revising" : this.party.lifecycle; this.linkedRevision = revisionId;
        return { ok: true, partyId, lifecycle: this.party.lifecycle, version: this.version, revisionId, changedBlockIds: (input.updates as any[]).map(update => update.id), feedbackIds: input.feedbackIds };
      }
      this.runtimeState = applyRuntimeState((this.runtimeState ?? {}) as RuntimeState, input.statePatch, input.resetState, this.artifact.blocks);
      return { ok: true, partyId, lifecycle: this.party.lifecycle, version: this.version, revisionId: null, changedBlockIds: [], runtimeState: this.runtimeState };
    }
    if (tool === "respond_to_feedback") {
      if (input.feedbackId !== feedbackId || input.resolve !== true || input.revisionId !== this.linkedRevision) throw new Error("feedback resolution must link the returned addressing revision");
      this.openFeedback = 0; this.party.lifecycle = "in_review";
      return { ok: true, partyId, lifecycle: "in_review", feedbackId, revisionId: this.linkedRevision, resolved: true };
    }
    return { ok: false, error: { code: "TOOL_UNAVAILABLE", message: `${tool} is unavailable in this evaluation state`, retryable: false }, context: { lifecycle: this.party.lifecycle } };
  }
}

export async function runTrial(provider: Provider, model: string, key: string, scenario: Scenario, options: { maxTurns: number; maxOutputTokens: number; timeoutMs: number; fetcher?: FetchLike }): Promise<Trial> {
  if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 6) throw new Error("maxTurns must be 1-6");
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 8000) throw new Error("maxOutputTokens must be 1-8000");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000) throw new Error("timeoutMs must be 1-120000");
  const fixture = new BuildPartyFixture(scenario.fixture);
  const calls: EvalCall[] = [], usage: unknown[] = [];
  const withTools = scenario.id !== "no-webmcp";
  let openAiInput: unknown[] = [{ role: "user", content: scenario.prompt }];
  let geminiContents: any[] = [{ role: "user", parts: [{ text: scenario.prompt }] }];
  let finalText = "";
  for (let turn = 1; turn <= options.maxTurns; turn++) {
    const step = provider === "openai"
      ? await openAiStep(model, key, openAiInput, withTools, options.maxOutputTokens, options.timeoutMs, options.fetcher ?? fetch)
      : await geminiStep(model, key, geminiContents, withTools, options.maxOutputTokens, options.timeoutMs, options.fetcher ?? fetch);
    if (step.usage) usage.push(step.usage);
    if (provider === "openai") openAiInput.push(...step.continuation as unknown[]);
    else geminiContents.push(step.continuation);
    if (!step.calls.length) return { scenario, calls, finalText: step.text, turns: turn, usage, completed: Boolean(step.text.trim()) };
    const outputs: { call: ModelStep["calls"][number]; result: unknown }[] = [];
    for (const call of step.calls) {
      let result: unknown; let schemaValid = true; let error: string | undefined;
      try { result = fixture.dispatch(call.name, call.arguments); }
      catch (cause) { schemaValid = false; error = cause instanceof Error ? cause.message : String(cause); result = { ok: false, error: { code: "EVAL_DISPATCH_ERROR", message: error } }; }
      calls.push({ name: call.name, arguments: call.arguments, result, schemaValid, ...(error ? { error } : {}) }); outputs.push({ call, result });
    }
    if (provider === "openai") for (const output of outputs) openAiInput.push({ type: "function_call_output", call_id: output.call.id, output: JSON.stringify(output.result) });
    else geminiContents.push({ role: "user", parts: outputs.map(output => ({ functionResponse: { name: output.call.name, id: output.call.id, response: { result: output.result } } })) });
  }
  return { scenario, calls, finalText, turns: options.maxTurns, usage, completed: false };
}

function ordered(names: string[], required: string[]) { let index = -1; return required.every(name => (index = names.indexOf(name, index + 1)) >= 0); }
function artifactFrom(trial: Trial) { return trial.calls.find(call => call.name === "set_artifact")?.arguments.artifact; }
function sourceOf(artifact: Artifact | undefined) { return artifact?.blocks.map(block => `${block.title ?? ""}\n${block.source.html}\n${block.source.css ?? ""}\n${block.source.js ?? ""}`).join("\n") ?? ""; }
function check(id: string, passed: unknown, evidence: unknown): Check { return { id, passed: Boolean(passed), evidence }; }
function validArtifact(value: unknown): value is Artifact { try { validateArtifact(structuredClone(value)); return true; } catch { return false; } }
function normalized(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function containsConcept(text: string, term: string) { return ` ${text} `.includes(` ${normalized(term)} `); }
function sectionCoverage(artifact: Artifact | undefined, sections: QualitySection[] = []) {
  if (!artifact) return { passed: false, matches: {} };
  const blockText = artifact.blocks.map(block => normalized(`${block.title ?? ""} ${block.source.html} ${block.source.css ?? ""} ${block.source.js ?? ""}`));
  const candidates = sections.map(section => blockText.map((text, index) => section.concepts.every(group => group.some(term => containsConcept(text, term))) ? index : -1).filter(index => index >= 0));
  const assign = (section: number, used: Set<number>, matches: number[]): number[] | undefined => {
    if (section === sections.length) return matches;
    for (const index of candidates[section] ?? []) if (!used.has(index)) { const found = assign(section + 1, new Set([...used, index]), [...matches, index]); if (found) return found; }
  };
  const matches = assign(0, new Set(), []);
  return { passed: Boolean(matches), matches: Object.fromEntries(sections.map((section, index) => [section.name, matches ? artifact.blocks[matches[index]!]!.id : candidates[index]?.map(block => artifact.blocks[block]!.id) ?? []])) };
}
function exactLabeledUrl(text: string, label: "owner" | "reviewer", url: unknown) {
  if (typeof url !== "string" || !text.includes(url)) return false;
  const index = text.indexOf(url), prefix = text.slice(Math.max(0, index - 120), index);
  return new RegExp(`${label}\\s*(?:url|link)?\\s*:?[^\\n]{0,80}$`, "i").test(prefix);
}

export function scoreTrial(trial: Trial): Score {
  const { scenario, calls, finalText } = trial; const names = calls.map(call => call.name); const checks: Check[] = [];
  checks.push(check("successful-completion", trial.completed && calls.every(call => call.schemaValid), { completed: trial.completed, errors: calls.filter(call => call.error).map(call => call.error) }));
  checks.push(check("allowed-calls", names.every(name => scenario.allowedCalls.includes(name as WebMcpOperation)), names));
  checks.push(check("required-order", ordered(names, scenario.requiredCalls) && scenario.requiredCalls.every(name => names.includes(name)), names));
  checks.push(check("forbidden-calls", scenario.forbiddenCalls.every(name => !names.includes(name)), names));
  const artifactInput = artifactFrom(trial), artifact = validArtifact(artifactInput) ? artifactInput : undefined, source = sourceOf(artifact);
  if (artifact) checks.push(check("no-declared-remote-dependency", !declaredRemoteDependency.test(source), source.match(declaredRemoteDependency)?.[0] ?? "none declared"));

  if (scenario.id === "bare-start") {
    const create = calls.find(call => call.name === "create_party"), created = create?.result as any;
    checks.push(check("init-first-once", names[0] === "init" && names.filter(name => name === "init").length === 1 && names.filter(name => name === "create_party").length === 1, names));
    const fallbackTitle = scenario.quality?.fallbackTitle;
    checks.push(check("fallback-and-title", calls[0]?.arguments.displayName === "Owner" && typeof fallbackTitle === "string" && typeof create?.arguments.title === "string" && create.arguments.title.trim().toLowerCase() === fallbackTitle.trim().toLowerCase(), { displayName: calls[0]?.arguments.displayName, expectedTitle: fallbackTitle, title: create?.arguments.title }));
    checks.push(check("no-invented-artifact", !names.includes("set_artifact"), names));
    checks.push(check("exact-labeled-links", exactLabeledUrl(finalText, "owner", created?.ownerUrl) && exactLabeledUrl(finalText, "reviewer", created?.shareUrl), { returned: { ownerUrl: created?.ownerUrl, reviewerUrl: created?.shareUrl }, finalText }));
    checks.push(check("content-handoff", /(?:work on|add|create|prepare|what.*content|content.*next|share.*content)/i.test(finalText), finalText));
  }
  if (["planning-context", "learning-context", "presentation-context"].includes(scenario.id)) {
    const coverage = sectionCoverage(artifact, scenario.quality?.sections);
    checks.push(check("artifact-schema", validArtifact(artifactInput), artifact?.format));
    checks.push(check("distinct-review-sections", (artifact?.blocks.length ?? 0) >= (scenario.quality?.minBlocks ?? 1) && coverage.passed, { blocks: artifact?.blocks.map(block => block.id), sectionMatches: coverage.matches }));
  }
  if (scenario.quality?.interaction?.persistent) {
    const persistent = artifact?.blocks.some(block => Object.keys(block.initialState ?? {}).length > 0 && (/(?:window\.buildParty\.(?:setState|patchState)|<(?:input|select|textarea)[^>]+name\s*=)/i.test(`${block.source.html}\n${block.source.js ?? ""}`)));
    checks.push(check("persistent-learning-interaction", persistent, artifact?.blocks.map(block => ({ id: block.id, initialState: block.initialState }))));
  }
  if (scenario.id === "feedback-revision") {
    const feedbackCall = calls.find(call => call.name === "get_feedback"), update = calls.find(call => call.name === "update_blocks"), response = calls.find(call => call.name === "respond_to_feedback");
    const returnedFeedback = (feedbackCall?.result as any)?.feedback?.find((item: any) => item?.status === "open" && item?.anchorStatus === "active"), returnedRevisionId = (update?.result as any)?.revisionId;
    const updates = update?.arguments.updates as any[] | undefined;
    checks.push(check("read-before-write", names.indexOf("get_party") >= 0 && names.indexOf("get_feedback") > names.indexOf("get_party") && names.indexOf("update_blocks") > names.indexOf("get_feedback"), names));
    checks.push(check("targeted-linked-update", typeof returnedFeedback?.id === "string" && Array.isArray(updates) && updates.length === 1 && updates[0]?.id === returnedFeedback.blockId && (update?.arguments.feedbackIds as unknown[])?.includes(returnedFeedback.id), { returnedFeedback, update: update?.arguments }));
    checks.push(check("linked-resolution", typeof returnedRevisionId === "string" && response?.arguments.feedbackId === returnedFeedback?.id && response?.arguments.revisionId === returnedRevisionId && response?.arguments.resolve === true, { returnedFeedbackId: returnedFeedback?.id, returnedRevisionId, response: response?.arguments }));
  }
  if (scenario.id === "state-only") {
    const update = calls.find(call => call.name === "update_blocks"), result = update?.result as any;
    checks.push(check("read-first", names[0] === "get_party", names));
    checks.push(check("state-only-update", update?.arguments.expectedVersion === 3 && (update.arguments.statePatch as any)?.hero?.timer === 15 && update.arguments.updates === undefined && !names.includes("set_artifact"), update?.arguments));
    checks.push(check("no-invented-revision", result?.revisionId === null && result?.version === 3, result));
  }
  if (scenario.id === "no-webmcp") checks.push(check("capability-warning", names.length === 0 && /(?:\bWebMCP\b|(?:website|browser)\s+(?:tools?|capabilit\w*)|tool-capable\s+browser)/i.test(finalText) && /(?:unavailable|not available|required|requires?|need(?:ed|s)?|without)/i.test(finalText), finalText));
  return { passed: checks.every(item => item.passed), checks };
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, /^(?:.*(?:api.?key|private.?key|capability)|authorization|token|secret|password|client.?secret|(?:participant|access|refresh|session|auth).?token)$/i.test(key) ? "[REDACTED]" : redact(child)]));
  if (typeof value === "string") return value
    .replace(/(#cap=)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g, "[REDACTED]")
    .replace(/(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, "[REDACTED]")
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "[REDACTED]")
    .replace(/\b((?:OPENAI_API_KEY|GEMINI_API_KEY|API[_-]?KEY)\s*[:=]\s*["']?)[^\s,"';}]+/gi, "$1[REDACTED]");
  return value;
}

function parseArgs(argv: string[]) {
  const provider = argv.find(value => value === "openai" || value === "gemini") as Provider | undefined;
  if (!provider) throw new Error("select provider: openai or gemini");
  const flag = (name: string) => argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const integer = (name: string, fallback: number, max: number) => { const value = Number(flag(name) ?? fallback); if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be 1-${max}`); return value; };
  const trials = integer("trials", Number(process.env.AGENT_EVAL_TRIALS ?? 1), 3);
  const maxTurns = integer("max-turns", Number(process.env.AGENT_EVAL_MAX_TURNS ?? 6), 6);
  const maxOutputTokens = integer("max-output-tokens", Number(process.env.AGENT_EVAL_MAX_OUTPUT_TOKENS ?? 2500), 8000);
  const timeoutMs = integer("timeout-ms", Number(process.env.AGENT_EVAL_TIMEOUT_MS ?? 45_000), 120_000);
  const requiredPasses = integer("required-passes", Number(process.env.AGENT_EVAL_REQUIRED_PASSES ?? Math.floor(trials / 2) + 1), trials);
  const model = flag("model") ?? (provider === "openai" ? process.env.OPENAI_MODEL ?? "gpt-5-mini" : process.env.GEMINI_MODEL ?? "gemini-2.5-flash");
  return { provider, model, trials, maxTurns, maxOutputTokens, timeoutMs, requiredPasses };
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv), key = assertCredential(config.provider), scenarios = await loadScenarios();
  const rows: any[] = [];
  for (const scenario of scenarios) for (let trialNumber = 1; trialNumber <= config.trials; trialNumber++) {
    const trial = await runTrial(config.provider, config.model, key, scenario, config);
    const score = scoreTrial(trial);
    rows.push({ provider: config.provider, model: config.model, scenario: scenario.id, trial: trialNumber, prompt: scenario.prompt, trace: trial.calls, finalText: trial.finalText, turns: trial.turns, usage: trial.usage, score });
    console.log(`${score.passed ? "PASS" : "FAIL"} ${scenario.id} trial ${trialNumber}/${config.trials}`);
  }
  const scenarioSummary = scenarios.map(scenario => { const matching = rows.filter(row => row.scenario === scenario.id); const passed = matching.filter(row => row.score.passed).length; const required = scenario.id === "no-webmcp" ? config.trials : config.requiredPasses; return { scenario: scenario.id, passed, required, total: config.trials, ok: passed >= required }; });
  const report = redact({ generatedAt: new Date().toISOString(), config: { ...config, provider: config.provider }, definitions: WEBMCP_TOOL_DEFINITIONS.map(tool => tool.name), scenarios: rows, summary: scenarioSummary });
  const directory = resolve(root, "test-results/agent-evals"); await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${config.provider}-${basename(config.model)}.json`); await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${file}`); console.log(`Passed ${scenarioSummary.filter(row => row.ok).length}/${scenarioSummary.length} scenarios`);
  if (scenarioSummary.some(row => !row.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
