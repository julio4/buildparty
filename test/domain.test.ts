import test from "node:test";
import assert from "node:assert/strict";
import {
  AppError, applyRuntimeState, lifecycleAfterResolution, lifecycleAfterUpdate,
  parseBearerAuthorization, validateArtifact,
} from "../src/domain.ts";
import { renderFinalHtml } from "../src/final-html.ts";
import { clampSandboxHeight, createSandboxDocument, SANDBOX_DEFAULT_CSS, SANDBOX_MAX_HEIGHT, SANDBOX_MIN_HEIGHT } from "../src/sandbox-document.ts";
import { sandboxDocumentIdentity } from "../src/SandboxFrame.tsx";

const artifact = {
  format: "buildparty.artifact/v1" as const,
  title: "Interactive plan <safe>",
  blocks: [{
    id: "scope", title: "Scope", kind: "sandbox" as const,
    source: {
      html: '<label>Count <input name="count"></label><p id="source-marker" style="padding:7px">embedded source</p>',
      css: "#source-marker{color:rebeccapurple}",
      js: "window.buildParty.subscribe(state=>document.body.dataset.count=String(state.count))",
    },
    initialState: { count: 1, untouched: "yes" },
  }],
};

test("v1 artifact contract is exact and runtime state is separate", () => {
  assert.deepEqual(validateArtifact(artifact), artifact);
  assert.deepEqual(validateArtifact({ ...artifact, blocks: [] }).blocks, []);
  assert.throws(() => validateArtifact({ ...artifact, format: "other" }), /artifact\.format/);
  assert.throws(() => validateArtifact({ ...artifact, extra: true }), /artifact\.extra is not allowed/);
  assert.throws(() => validateArtifact({ ...artifact, blocks: [{ ...artifact.blocks[0], kind: "text" }] }), /kind must be sandbox/);
  assert.throws(() => validateArtifact({ ...artifact, blocks: [{ ...artifact.blocks[0], extra: true }] }), /\.extra is not allowed/);
  assert.throws(() => validateArtifact({ ...artifact, blocks: [{ ...artifact.blocks[0], source: { ...artifact.blocks[0]!.source, url: "https://example.test" } }] }), /\.source\.url is not allowed/);

  const blocks = artifact.blocks;
  const current = { scope: { count: 1, untouched: "yes" } };
  assert.equal(applyRuntimeState(current, undefined, undefined, blocks), current);
  assert.deepEqual(applyRuntimeState(current, { scope: { count: 2 } }, false, blocks), { scope: { count: 2, untouched: "yes" } });
  assert.deepEqual(applyRuntimeState({ scope: { form: { left: "a", right: "b" }, choices: [1, 2] } }, { scope: { form: { left: "changed" }, choices: [3] } }, false, blocks), { scope: { form: { left: "changed", right: "b" }, choices: [3] } });
  assert.throws(() => applyRuntimeState(current, JSON.parse('{"scope":{"__proto__":{"polluted":true}}}'), false, blocks), /unsafe key/);
  assert.deepEqual(applyRuntimeState(current, undefined, true, blocks), { scope: { count: 1, untouched: "yes" } });
  assert.throws(() => applyRuntimeState(current, { other: {} }, false, blocks), /does not match an artifact block/);
});

test("lifecycle and bearer parsing rules are explicit", () => {
  assert.equal(lifecycleAfterUpdate("in_review", false), "in_review");
  assert.equal(lifecycleAfterUpdate("in_review", true), "revising");
  assert.equal(lifecycleAfterResolution("revising", 1), "revising");
  assert.equal(lifecycleAfterResolution("revising", 0), "in_review");
  assert.throws(() => lifecycleAfterUpdate("initialized", false), AppError);
  assert.throws(() => lifecycleAfterUpdate("finalized", false), AppError);
  assert.equal(parseBearerAuthorization("Bearer abc_DEF-123"), "abc_DEF-123");
  assert.equal(parseBearerAuthorization(undefined), undefined);
  assert.throws(() => parseBearerAuthorization("bearer token"), /must use Bearer/);
  assert.throws(() => parseBearerAuthorization("Bearer token extra"), /must use Bearer/);
});

test("unchanged refreshed blocks keep iframe documents memoized and source changes invalidate them", () => {
  const block = artifact.blocks[0]!;
  const identity = sandboxDocumentIdentity(block);
  assert.equal(sandboxDocumentIdentity({ ...block, title: "Refreshed title", source: { ...block.source }, initialState: { count: 99 } }), identity);
  for (const changed of [
    { ...block, id: "other" },
    { ...block, source: { ...block.source, html: `${block.source.html}<p>changed</p>` } },
    { ...block, source: { ...block.source, css: `${block.source.css} body{margin:0}` } },
    { ...block, source: { ...block.source, js: `${block.source.js};document.body.hidden=true` } },
  ]) assert.notEqual(sandboxDocumentIdentity(changed), identity);
});

test("sandbox document keeps scripts nonce-only while allowing inline style attributes", () => {
  const html = createSandboxDocument(artifact.blocks[0]!, "channel-marker", "nonce-marker");
  assert.match(html, /sandbox|buildParty/);
  assert.match(html, /bp:ready|bp:set|bp:patch|bp:state/);
  assert.match(html, /bp:resize/);
  assert.match(html, /ResizeObserver/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-nonce-marker'/);
  assert.match(html, /style-src-elem 'nonce-nonce-marker'/);
  assert.match(html, /style-src-attr 'unsafe-inline'/);
  assert.ok(html.indexOf(SANDBOX_DEFAULT_CSS) < html.indexOf("#source-marker{color:rebeccapurple}"), "neutral defaults must precede agent CSS");
  assert.ok(html.includes('style=\\"padding:7px\\"'));
  assert.doesNotMatch(html, /navigate-to|allow-same-origin|allow-forms|allow-popups/);
});

test("final HTML embeds source and finalized state in interactive opaque frames", () => {
  const html = renderFinalHtml(artifact, { scope: { count: 7, untouched: "final" } });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Interactive plan &lt;safe&gt;/);
  assert.match(html, /embedded source/);
  assert.match(html, /rebeccapurple/);
  assert.match(html, /window\.buildParty\.subscribe/);
  assert.match(html, /\"count\":7/);
  assert.match(html, /\"untouched\":\"final\"/);
  assert.match(html, /sandbox','allow-scripts/);
  assert.match(html, /bp:ready/);
  assert.match(html, /bp:set/);
  assert.match(html, /bp:patch/);
  assert.match(html, /bp:state/);
  assert.match(html, /bp:resize/);
  assert.match(html, /style-src-elem 'nonce-/);
  assert.match(html, /style-src-attr 'unsafe-inline'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /navigate-to|allow-same-origin|allow-forms|allow-popups/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<main><h1>|border-radius:8px|min-height:320px/);
});

test("sandbox resize heights are finite and clamped", () => {
  assert.equal(clampSandboxHeight(1), SANDBOX_MIN_HEIGHT);
  assert.equal(clampSandboxHeight(321.2), 322);
  assert.equal(clampSandboxHeight(SANDBOX_MAX_HEIGHT + 1), SANDBOX_MAX_HEIGHT);
  for (const value of [undefined, null, "300", 0, -1, NaN, Infinity]) assert.equal(clampSandboxHeight(value), undefined);
});
