import test from "node:test";
import assert from "node:assert/strict";
import { BUILD_PARTY_AGENT_GUIDE, WEBMCP_TOOL_DEFINITIONS } from "../src/webmcp.ts";
import { WEBMCP_OPERATIONS, type Artifact } from "../src/domain.ts";
import {
  assertCredential, BuildPartyFixture, buildGeminiRequest, buildOpenAiRequest, geminiTools, loadScenarios, openAiTools, parseGeminiResponse, parseOpenAiResponse,
  redact, runTrial, scoreTrial, validateScenarios, type EvalCall, type Scenario, type Trial,
} from "../scripts/agent-journey-eval.ts";

const call = (name: string, args: Record<string, unknown> = {}, result: unknown = { ok: true }, schemaValid = true): EvalCall => ({ name, arguments: args, result, schemaValid });
const trial = (scenario: Scenario, calls: EvalCall[], finalText = "Done"): Trial => ({ scenario, calls, finalText, turns: 1, usage: [], completed: true });
const published = (artifact: Artifact) => [call("init", { displayName: "Owner" }), call("create_party", { title: "Review" }), call("set_artifact", { artifact })];
const block = (id: string, html: string, extra: Partial<Artifact["blocks"][number]> = {}) => ({ id, title: id, kind: "sandbox" as const, source: { html }, ...extra });
const learningArtifact = (interactive: boolean): Artifact => ({ format: "buildparty.artifact/v1", title: "Event loop", blocks: [
  block("stack", "<h2>Call stack</h2><p>Current synchronous frames run first.</p>"),
  block("queues", "<h2>Queue ordering</h2><p>A timer callback enters the task queue. A microtask runs before the next task.</p>"),
  block("exercise", "<h2>Prediction exercise</h2><p>Predict the order: A, D, C, B.</p>"),
  block("progress", interactive ? "<h2>Progress</h2><label>Prediction answer <input name=answer></label>" : "<h2>Progress</h2><p>Record the prediction answer when complete.</p>", interactive ? { initialState: { answer: "", complete: false } } : {}),
] });

async function scenario(id: string) { return (await loadScenarios()).find(row => row.id === id)!; }

test("probabilistic eval imports the exact production eleven definitions", () => {
  assert.deepEqual(WEBMCP_TOOL_DEFINITIONS.map(tool => tool.name), [...WEBMCP_OPERATIONS]);
  assert.deepEqual(openAiTools().map((tool: any) => tool.parameters), WEBMCP_TOOL_DEFINITIONS.map(tool => tool.inputSchema));
  assert.deepEqual((geminiTools()[0] as any).functionDeclarations.map((tool: any) => tool.parametersJsonSchema), WEBMCP_TOOL_DEFINITIONS.map(tool => tool.inputSchema));
  assert.equal(openAiTools().length, 11);
});

test("scenario file contains seven validated, secret-free, explicit quality contracts", async () => {
  const rows = await loadScenarios();
  assert.equal(rows.length, 7);
  assert.ok(rows.every(row => !/#cap=|api[_-]?key|Bearer /i.test(row.prompt)));
  for (const id of ["planning-context", "learning-context", "presentation-context"]) {
    const quality = rows.find(row => row.id === id)!.quality!;
    assert.ok(quality.minBlocks! >= 4 && quality.sections!.length >= 4, id);
  }
  assert.equal(rows[0]!.quality!.fallbackTitle, "BuildParty session");
  assert.match(BUILD_PARTY_AGENT_GUIDE, /BuildParty session/);
  assert.throws(() => validateScenarios(rows.slice(0, 6)), /exactly seven/);
  assert.throws(() => validateScenarios(rows.map((row, index) => index ? row : { ...row, requiredCalls: ["set_artifact"] })), /not allowed/);
  assert.throws(() => validateScenarios(rows.map((row, index) => index === 1 ? { ...row, quality: { sections: [{ name: "bad", concepts: [[]] }] } } : row)), /invalid sections/);
});

test("provider payloads and response fixtures follow Responses and generateContent function calling", () => {
  const openRequest: any = buildOpenAiRequest("gpt-test", [{ role: "user", content: "hi" }], true, 100);
  assert.equal(openRequest.tools.length, 11); assert.equal(openRequest.parallel_tool_calls, false); assert.equal(openRequest.max_output_tokens, 100);
  const open = parseOpenAiResponse({ output: [{ type: "function_call", call_id: "call_1", name: "init", arguments: "{\"displayName\":\"Owner\"}" }], usage: { input_tokens: 2 } });
  assert.deepEqual(open.calls[0], { id: "call_1", name: "init", arguments: { displayName: "Owner" } });
  assert.throws(() => parseOpenAiResponse({ output: [{ type: "function_call", call_id: "x", name: "init", arguments: "{" }] }), /malformed/);

  const geminiRequest: any = buildGeminiRequest([{ role: "user", parts: [{ text: "hi" }] }], true, 120);
  assert.equal(geminiRequest.tools[0].functionDeclarations.length, 11); assert.equal(geminiRequest.generationConfig.maxOutputTokens, 120);
  const gemini = parseGeminiResponse({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "fc1", name: "get_party", args: {} } }, { text: "reading" }] } }], usageMetadata: { totalTokenCount: 3 } });
  assert.deepEqual(gemini.calls[0], { id: "fc1", name: "get_party", arguments: {} }); assert.equal(gemini.text, "reading");
  assert.throws(() => parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }), /SAFETY/);
});

test("bare-start scoring requires the declared fallback title and exact returned labeled URLs", async () => {
  const bare = await scenario("bare-start"), ownerUrl = "https://example.test/owner#cap=owner-placeholder", shareUrl = "https://example.test/review#cap=review-placeholder";
  const calls = [call("init", { displayName: "Owner" }), call("create_party", { title: "BuildParty session" }, { ownerUrl, shareUrl })];
  const valid = scoreTrial(trial(bare, calls, `Owner URL: ${ownerUrl}\nReviewer URL: ${shareUrl}\nWhat content should we work on?`));
  assert.equal(valid.checks.find(row => row.id === "fallback-and-title")!.passed, true);
  assert.equal(valid.checks.find(row => row.id === "exact-labeled-links")!.passed, true);
  const arbitrary = scoreTrial(trial(bare, [calls[0]!, call("create_party", { title: "x" }, { ownerUrl, shareUrl })], `Owner URL: ${ownerUrl}\nReviewer URL: ${shareUrl}\nWhat content should we work on?`));
  assert.equal(arbitrary.checks.find(row => row.id === "fallback-and-title")!.passed, false);
  const wrong = scoreTrial(trial(bare, calls, "Owner URL: https://wrong/#cap=x\nReviewer URL: https://wrong/#cap=y\nWhat content should we work on?"));
  assert.equal(wrong.checks.find(row => row.id === "exact-labeled-links")!.passed, false);
  const wrongFirst = scoreTrial(trial(bare, [calls[1]!, calls[0]!], `Owner: ${ownerUrl}\nReviewer: ${shareUrl}\nLet's work on content.`));
  assert.equal(wrongFirst.checks.find(row => row.id === "init-first-once")!.passed, false);
});

test("artifact quality rejects keyword stuffing, missing supplied presentation content, and missing learning state", async () => {
  const planning = await scenario("planning-context");
  const stuffed: Artifact = { format: "buildparty.artifact/v1", title: "Plan", blocks: [
    block("one", "milestone risk decision success onboarding reliability feedback operations 20 50"), block("two", "milestone"), block("three", "risk"), block("four", "success")
  ] };
  const planScore = scoreTrial(trial(planning, published(stuffed)));
  assert.equal(planScore.checks.find(row => row.id === "distinct-review-sections")!.passed, false);
  const malformed = scoreTrial(trial(planning, [call("init"), call("create_party"), call("set_artifact", { artifact: { format: "wrong", blocks: [] } }, {}, false)]));
  assert.equal(malformed.checks.find(row => row.id === "artifact-schema")!.passed, false);
  assert.equal(malformed.checks.find(row => row.id === "successful-completion")!.passed, false);

  const presentation = await scenario("presentation-context");
  const incomplete: Artifact = { format: "buildparty.artifact/v1", title: "Kickoff", blocks: [block("problem", "email spreadsheet feedback"), block("workflow", "invite dashboard in-product survey"), block("evidence", "evidence"), block("risks", "survey response permission"), block("next", "20 weekly")] };
  assert.equal(scoreTrial(trial(presentation, published(incomplete))).checks.find(row => row.id === "distinct-review-sections")!.passed, false);

  const learning = await scenario("learning-context");
  const noInteraction = scoreTrial(trial(learning, published(learningArtifact(false))));
  assert.equal(noInteraction.checks.find(row => row.id === "distinct-review-sections")!.passed, true);
  assert.equal(noInteraction.checks.find(row => row.id === "persistent-learning-interaction")!.passed, false);
});

test("source check catches declared external dependencies but permits benign textual URLs", async () => {
  const planning = await scenario("planning-context");
  const remote = learningArtifact(true); remote.blocks[0]!.source.html += '<img src="https://example.test/remote.png">';
  const bad = scoreTrial(trial(planning, published(remote)));
  assert.equal(bad.checks.find(row => row.id === "no-declared-remote-dependency")!.passed, false);
  const textual = learningArtifact(true); textual.blocks[0]!.source.html += "<p>Reference text: https://example.test/docs</p>";
  const allowed = scoreTrial(trial(planning, published(textual)));
  assert.equal(allowed.checks.find(row => row.id === "no-declared-remote-dependency")!.passed, true);
});

test("feedback scoring links IDs from actual dispatcher results, not fixture constants", async () => {
  const feedback = await scenario("feedback-revision"), returnedFeedbackId = "00000000-0000-4000-8000-000000000090", returnedRevisionId = "00000000-0000-4000-8000-000000000091";
  const reads = [call("get_party"), call("get_feedback", {}, { feedback: [{ id: returnedFeedbackId, blockId: "hero", status: "open", anchorStatus: "active" }] })];
  const wrong = scoreTrial(trial(feedback, [...reads,
    call("update_blocks", { expectedVersion: 1, updates: [{ id: "hero", source: { html: "<button>Start</button>" } }], feedbackIds: ["00000000-0000-4000-8000-000000000004"] }, { revisionId: returnedRevisionId }),
    call("respond_to_feedback", { feedbackId: returnedFeedbackId, revisionId: "00000000-0000-4000-8000-000000000007", resolve: true }),
  ]));
  assert.equal(wrong.checks.find(row => row.id === "targeted-linked-update")!.passed, false);
  assert.equal(wrong.checks.find(row => row.id === "linked-resolution")!.passed, false);
});

test("state fixture and scorer reject contradictory, unknown-block, source, and revision claims", async () => {
  const fixture = new BuildPartyFixture("state");
  assert.throws(() => fixture.dispatch("update_blocks", { expectedVersion: 3, resetState: true, statePatch: { hero: { timer: 15 } } }), /mutually exclusive/);
  assert.throws(() => fixture.dispatch("update_blocks", { expectedVersion: 3, statePatch: { unknown: { timer: 15 } } }), /does not match an artifact block/);
  const state = await scenario("state-only");
  const wrong = scoreTrial(trial(state, [call("get_party"), call("update_blocks", { expectedVersion: 3, updates: [{ id: "hero", title: "Changed" }] }, { revisionId: "invented", version: 4 })]));
  assert.equal(wrong.checks.find(row => row.id === "state-only-update")!.passed, false);
  assert.equal(wrong.checks.find(row => row.id === "no-invented-revision")!.passed, false);
});

test("no-tool warning accepts equivalent capability language", async () => {
  const noTools = await scenario("no-webmcp");
  const score = scoreTrial(trial(noTools, [], "Website tools are required but unavailable in this browser."));
  assert.equal(score.checks.find(row => row.id === "capability-warning")!.passed, true);
});

test("redaction removes adversarial secrets recursively from every trace-shaped field", () => {
  const session = `${"S".repeat(42)}-`, openAi = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-"), gemini = ["AIza", "SyABCDEFGHIJKLMNOPQRSTUVWXYZ123456789"].join("");
  const value = redact({
    prompt: `OPENAI_API_KEY=${openAi} and ${gemini}`,
    finalText: `Bearer ${session} https://x/#cap=${session}`,
    trace: [{ arguments: { nested: [`GEMINI_API_KEY=${gemini}`] }, result: { participantToken: session }, error: `api_key=${openAi}` }],
    authorization: `Bearer ${session}`,
    note: `session ${session}.`,
    usage: { input_tokens: 12, totalTokenCount: 20 },
  });
  const encoded = JSON.stringify(value);
  for (const secret of [session, openAi, gemini]) assert.doesNotMatch(encoded, new RegExp(secret));
  assert.doesNotMatch(encoded, /#cap=S/); assert.match(encoded, /REDACTED/);
  assert.deepEqual((value as any).usage, { input_tokens: 12, totalTokenCount: 20 });
});

test("credential failures are clear and model journeys obey turn and timeout bounds", async () => {
  assert.throws(() => assertCredential("openai", {}), /OPENAI_API_KEY is required/);
  assert.throws(() => assertCredential("gemini", {}), /GEMINI_API_KEY is required/);
  const bare = await scenario("bare-start"); let requests = 0;
  await assert.rejects(() => runTrial("openai", "test", "not-a-real-key", bare, { maxTurns: 7, maxOutputTokens: 50, timeoutMs: 100, fetcher: fetch }), /maxTurns must be 1-6/);
  const loopingFetch = async () => { requests++; return new Response(JSON.stringify({ output: [{ type: "function_call", call_id: `c${requests}`, name: "init", arguments: "{\"displayName\":\"Owner\"}" }] }), { status: 200 }); };
  const bounded = await runTrial("openai", "test", "not-a-real-key", bare, { maxTurns: 2, maxOutputTokens: 50, timeoutMs: 100, fetcher: loopingFetch as typeof fetch });
  assert.equal(requests, 2); assert.equal(bounded.completed, false); assert.equal(bounded.turns, 2);

  const hangingFetch = ((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))) as typeof fetch;
  const noTools = await scenario("no-webmcp");
  await assert.rejects(() => runTrial("openai", "test", "not-a-real-key", noTools, { maxTurns: 1, maxOutputTokens: 50, timeoutMs: 5, fetcher: hangingFetch }), /model request failed/i);
});
