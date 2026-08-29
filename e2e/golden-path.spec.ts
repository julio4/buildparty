import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const artifactsDir = resolve("test-results/artifacts");
const networkProbe = "https://network.buildparty.invalid/ping";

type ToolResult = Record<string, any>;
const publicTools = ["init", "create_party", "get_party", "set_artifact", "update_blocks", "delete_blocks", "restore_revision", "get_feedback", "respond_to_feedback", "finalize_party", "get_final_artifact"].sort();
type Monitor = { errors: string[]; failedRequests: string[]; externalRequests: string[]; capabilityRequests: string[]; electricUpdates: string[]; mutableReviewRequests: string[]; blockedProbeErrors: number };
const appOrigin = "http://localhost:5173";

async function installNativeWebMcpMock(page: Page) {
  await page.addInitScript(() => {
    const tools = new Map<string, { name: string; execute(input?: unknown): Promise<unknown> }>();
    Object.defineProperty(window, "__nativeWebMcpTools", { value: tools });
    Object.defineProperty(window, "__nativeWebMcpCalls", { value: [] as string[] });
    Object.defineProperty(window, "__nativeWebMcpSignals", { value: [] as AbortSignal[] });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: { name: string; execute(input?: unknown): Promise<unknown> }, options: { signal?: AbortSignal } = {}) {
          if (options.signal?.aborted) return Promise.reject(new DOMException("Registration aborted", "AbortError"));
          tools.set(tool.name, tool);
          (window as any).__nativeWebMcpCalls.push(tool.name);
          (window as any).__nativeWebMcpSignals.push(options.signal);
          options.signal?.addEventListener("abort", () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); }, { once: true });
          return Promise.resolve();
        },
      },
    });
  });
}

async function holdNativeTools(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__nativeWebMcpTools?.size)).toBe(11);
  return page.evaluate(() => {
    const held = new Map((window as any).__nativeWebMcpTools);
    Object.defineProperty(window, "__heldNativeWebMcpTools", { value: held });
    return [...held.keys()].sort();
  });
}

async function callTool<T extends ToolResult>(page: Page, name: string, input: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ toolName, value }) => {
    const tool = (window as any).__heldNativeWebMcpTools?.get(toolName) ?? (window as any).__nativeWebMcpTools?.get(toolName);
    if (!tool) throw new Error(`registered tool ${toolName} disappeared`);
    return tool.execute(value);
  }, { toolName: name, value: input }) as Promise<T>;
}

function expectedRequest(raw: string) {
  const url = new URL(raw);
  if (["file:", "blob:", "data:", "about:"].includes(url.protocol)) return true;
  if (url.origin !== appOrigin) return false;
  return url.pathname.startsWith("/api/") || url.pathname === "/" || url.pathname === "/@react-refresh" || url.pathname.startsWith("/party/") || /^\/(?:@vite|src|node_modules)\//.test(url.pathname);
}

function monitor(page: Page, label: string): Monitor {
  const result: Monitor = { errors: [], failedRequests: [], externalRequests: [], capabilityRequests: [], electricUpdates: [], mutableReviewRequests: [], blockedProbeErrors: 0 };
  page.on("pageerror", error => result.errors.push(`${label} pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.includes(networkProbe) && /Content Security Policy|Refused to connect/.test(text)) result.blockedProbeErrors++;
    else result.errors.push(`${label} console: ${text}`);
  });
  page.on("response", response => {
    if (response.url().includes("/api/parties/") && response.url().includes("/shapes/audit") && response.ok()) result.electricUpdates.push(response.url());
    if (response.status() >= 400) result.failedRequests.push(`${response.status()} ${response.url()}`);
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (!expectedRequest(request.url())) result.externalRequests.push(request.url());
    if ((request.resourceType() === "document" || url.pathname.startsWith("/api/")) && url.searchParams.has("cap")) result.capabilityRequests.push(request.url());
    if (/\/api\/parties\/[^/]+\/(?:feedback|events|storage|presence-ticket|shapes\/)/.test(url.pathname)) result.mutableReviewRequests.push(request.url());
  });
  page.on("requestfailed", request => {
    const url = new URL(request.url());
    const allowedAbort = request.failure()?.errorText === "net::ERR_ABORTED" && url.origin === appOrigin && /\/api\/parties\/[^/]+\/shapes\/audit$/.test(url.pathname);
    if (!allowedAbort) result.failedRequests.push(`${request.failure()?.errorText ?? "request failed"} ${request.url()}`);
  });
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    const expected = url.origin === "ws://localhost:5173" && (url.pathname === "/" || url.pathname === "/api/presence");
    if (!expected) result.externalRequests.push(`websocket ${socket.url()}`);
    socket.on("socketerror", error => { if (!(expected && /closed before the connection is established/i.test(String(error)))) result.failedRequests.push(`websocket ${String(error)} ${socket.url()}`); });
  });
  return result;
}

const initialLaunchHtml = `
<section class="launch-card">
  <p class="kicker">Orbit · Product launch command center</p>
  <h1>Turn launch day into lift-off.</h1>
  <label>Launch headline<textarea id="headline" rows="3"></textarea></label>
  <label>Voice<select id="tone"><option value="confident">Confident</option><option value="bold">Bold</option><option value="warm">Warm</option></select></label>
  <form id="signup"><label>Waitlist email<input id="email" type="email" placeholder="pilot@example.com"></label><button type="submit">Save test signup</button></form>
  <button id="approve" type="button">Approve launch</button>
  <p id="inlineMarker" style="background:rgb(255, 238, 153);padding:9px">Inline style marker</p>
  <p id="approvalStatus" role="status"></p><p id="networkStatus" role="status"></p>
</section>`;
const revisedLaunchHtml = initialLaunchHtml.replace("Turn launch day into lift-off.", "Meet Orbit: your calmest, clearest launch day.") + "<p class=review-note>Reviewer-approved launch promise.</p>";
const launchCss = `body{margin:0;font:16px/1.45 system-ui;background:#f5f1ff;color:#251b3f}.launch-card{padding:28px;border:2px solid #6d4aff;border-radius:18px;background:white}label{display:block;margin:14px 0;font-weight:700}textarea,input,select,button{display:block;width:100%;margin-top:6px;padding:10px;font:inherit}button{background:#6d4aff;color:white;border:0;border-radius:9px;font-weight:800}.kicker,.review-note{color:#5b3bd6}`;
const launchJs = `
const render = state => {
  document.querySelector('#approvalStatus').textContent = 'Approvals: ' + (state.approvals || 0) + (state.submitted ? ' · signup saved' : '');
  document.querySelector('#networkStatus').textContent = 'Network: ' + (state.network || 'not attempted');
};
window.buildParty.subscribe(render);
document.querySelector('#signup').addEventListener('submit', event => { event.preventDefault(); window.buildParty.setState('submitted', true); });
document.querySelector('#approve').addEventListener('click', () => {
  window.buildParty.setState('approvals', Number(window.buildParty.getState().approvals || 0) + 1);
  fetch('${networkProbe}').then(() => window.buildParty.setState('network', 'unexpected')).catch(error => window.buildParty.setState('network', 'caught CSP block: ' + error.name));
});`;

const artifact = {
  format: "buildparty.artifact/v1",
  title: "Orbit launch command center",
  blocks: [
    {
      id: "launch-brief", title: "Launch brief", kind: "sandbox",
      source: { html: initialLaunchHtml, css: launchCss, js: launchJs },
      initialState: { headline: "Orbit makes launch operations feel effortless.", tone: "confident", email: "", submitted: false, approvals: 0, network: "not attempted" },
    },
    {
      id: "success-metrics", title: "Success metrics", kind: "sandbox",
      source: {
        html: "<section><h1>First 30 days</h1><label>Activation target<input id=activation type=range min=40 max=90></label><output id=result></output><table id=defaultTable><tbody><tr><th>Goal</th><td>1,000 teams</td></tr></tbody></table></section>",
        css: "body{font:16px system-ui;background:#ecfff8;color:#123b30;padding:24px}section{border-left:8px solid #18a875;padding:16px}input{width:100%}",
        js: "window.buildParty.subscribe(state => document.querySelector('#result').textContent = state.activation + '% activated · ' + state.goal);",
      },
      initialState: { activation: "68", goal: "1,000 teams" },
    },
  ],
};

test("real golden path: agent build, human review, durable sync, and portable final", async ({ browser }) => {
  await mkdir(artifactsDir, { recursive: true });
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] }); contexts.push(hostContext);
  const collaboratorContext = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] }); contexts.push(collaboratorContext);
  const host = await hostContext.newPage(); pages.push(host);
  const collaborator = await collaboratorContext.newPage(); pages.push(collaborator);
  await Promise.all([installNativeWebMcpMock(host), installNativeWebMcpMock(collaborator)]);
  const hostMonitor = monitor(host, "host");
  const collaboratorMonitor = monitor(collaborator, "collaborator");

  await host.goto("/");
  await expect(host.getByRole("heading", { name: "Build together." })).toBeVisible();
  await expect(host.locator('link[rel="icon"]')).toHaveAttribute("href", /^data:image\/svg\+xml,/);
  expect(await holdNativeTools(host)).toEqual(publicTools);
  const init = await callTool<ToolResult>(host, "init", { displayName: "Orbit launch agent" });
  expect(init.identity).toEqual({ displayName: "Orbit launch agent", kind: "agent" });

  const creation = await host.evaluate(async immediateArtifact => {
    const tools = (window as any).__heldNativeWebMcpTools;
    const result = await tools.get("create_party").execute({ title: "Orbit product launch review" });
    const hrefAtResolution = location.href;
    const setResult = await tools.get("set_artifact").execute({ artifact: immediateArtifact, summary: "Polished Orbit launch brief and measurable success plan" });
    return { result, hrefAtResolution, setResult };
  }, artifact) as { result: ToolResult; hrefAtResolution: string; setResult: ToolResult };
  const created = creation.result;
  expect(new URL(creation.hrefAtResolution).pathname).toBe("/");
  for (const value of [created.ownerUrl, created.shareUrl]) {
    const url = new URL(value);
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#cap=[A-Za-z0-9_-]+$/);
  }
  expect(created.ownerUrl).not.toBe(created.shareUrl);
  expect(creation.setResult.version).toBe(1);
  expect(creation.setResult.changedBlockIds).toEqual(["launch-brief", "success-metrics"]);
  const partyId = created.party.id as string;
  await expect.poll(() => new URL(host.url()).pathname).toBe(`/party/${partyId}`);
  expect(new URL(host.url()).hash).toMatch(/^#cap=[A-Za-z0-9_-]{43}$/);
  expect(new URL(host.url()).search).toBe("");
  expect(hostMonitor.capabilityRequests).toEqual([]);

  await expect(host.getByRole("heading", { name: "Join the party" })).toBeVisible();
  await host.getByLabel("Display name").fill("Host owner");
  await host.getByRole("button", { name: "Join workspace" }).click();
  await expect(host.getByText("Host owner", { exact: true })).toBeVisible();

  await expect.poll(() => host.evaluate(() => [...(window as any).__nativeWebMcpTools.keys()].sort())).toEqual(publicTools);
  await expect(host.locator(".artifact-region")).toHaveCount(2);
  await expect(host.locator(".block-card, .sidebar, .workspace-head")).toHaveCount(0);
  await expect(host.locator(".artifact-canvas")).toBeVisible();

  await host.getByRole("button", { name: /Copy reviewer link/ }).click();
  const copiedReviewerUrl = await host.evaluate(() => navigator.clipboard.readText());
  expect(copiedReviewerUrl).toBe(created.shareUrl);
  expect(new URL(copiedReviewerUrl).hash).toMatch(/^#cap=[A-Za-z0-9_-]{43}$/);
  const freshContext = await browser.newContext({ viewport: { width: 900, height: 700 } }); contexts.push(freshContext);
  const fresh = await freshContext.newPage(); pages.push(fresh);
  await fresh.goto(copiedReviewerUrl);
  await expect(fresh.getByRole("heading", { name: "Join the party" })).toBeVisible();
  expect(new URL(fresh.url()).hash).toBe(new URL(copiedReviewerUrl).hash);
  expect(new URL(fresh.url()).search).toBe("");
  await fresh.close();

  await collaborator.goto(created.shareUrl);
  await expect.poll(() => new URL(collaborator.url()).pathname).toBe(`/party/${partyId}`);
  expect(new URL(collaborator.url()).hash).toBe(new URL(created.shareUrl).hash);
  expect(collaboratorMonitor.capabilityRequests).toEqual([]);
  await expect(collaborator.getByRole("heading", { name: "Join the party" })).toBeVisible();
  await collaborator.getByLabel("Display name").fill("Maya reviewer");
  await collaborator.getByRole("button", { name: "Join workspace" }).click();
  await expect(collaborator.locator(".artifact-canvas")).toBeVisible();
  await expect(collaborator.locator(".presence-badges")).toHaveAttribute("title", /Host owner/);
  await expect.poll(() => [hostMonitor.electricUpdates.length > 0, collaboratorMonitor.electricUpdates.length > 0]).toEqual([true, true]);
  const hostElectricBaseline = hostMonitor.electricUpdates.length;

  const collaboratorLaunchFrame = collaborator.locator('iframe[title="Launch brief"]');
  const collaboratorLaunch = collaborator.frameLocator('iframe[title="Launch brief"]');
  const collaboratorMetrics = collaborator.frameLocator('iframe[title="Success metrics"]');
  await expect.poll(async () => {
    const frameHeight = await collaboratorLaunchFrame.evaluate(element => element.getBoundingClientRect().height);
    const contentHeight = await collaboratorLaunch.locator("html").evaluate(element => element.scrollHeight);
    return Math.abs(frameHeight - contentHeight);
  }).toBeLessThanOrEqual(2);
  await expect(collaboratorLaunch.locator("#inlineMarker")).toHaveCSS("background-color", "rgb(255, 238, 153)");
  await expect(collaboratorLaunch.locator("body")).toHaveCSS("background-color", "rgb(245, 241, 255)");
  await expect(collaboratorMetrics.locator("#defaultTable")).toHaveCSS("border-collapse", "collapse");
  await collaborator.locator("#launch-brief").hover();
  await collaboratorLaunch.getByLabel("Launch headline").fill("Meet Orbit: launch with confidence, not chaos.");
  await collaboratorLaunch.getByLabel("Voice").selectOption("bold");
  await collaboratorLaunch.getByLabel("Waitlist email").fill("maya@example.com");
  await collaboratorLaunch.getByRole("button", { name: "Approve launch" }).click();
  await expect(collaboratorLaunch.getByText("Network: caught CSP block: TypeError")).toBeVisible();
  await expect.poll(() => new URL(collaborator.url()).pathname).toBe(`/party/${partyId}`);
  expect(new URL(collaborator.url()).hash).toBe(new URL(created.shareUrl).hash);
  expect(collaboratorMonitor.blockedProbeErrors).toBeGreaterThan(0);
  expect(collaboratorMonitor.externalRequests).toEqual([]);

  let beforeRevision!: ToolResult;
  await expect.poll(async () => {
    beforeRevision = await callTool<ToolResult>(host, "get_party");
    return beforeRevision.runtimeState?.["launch-brief"];
  }).toEqual({ headline: "Meet Orbit: launch with confidence, not chaos.", tone: "bold", email: "maya@example.com", submitted: false, approvals: 1, network: "caught CSP block: TypeError" });
  await expect.poll(() => hostMonitor.electricUpdates.length).toBeGreaterThan(hostElectricBaseline);

  const hostLaunch = host.frameLocator('iframe[title="Launch brief"]');
  const canvasWidth = (await collaborator.locator(".artifact-canvas").boundingBox())!.width;
  await collaborator.getByRole("button", { name: /Review Launch brief/ }).click();
  await expect(collaborator.locator(".review-panel")).toBeVisible();
  await expect(collaborator.getByRole("button", { name: "Close review" })).toBeFocused();
  await collaborator.keyboard.press("Escape");
  await expect(collaborator.locator(".review-panel")).toBeHidden();
  await expect(collaborator.getByRole("button", { name: /Review Launch brief/ })).toBeFocused();
  await collaborator.getByRole("button", { name: /Review Launch brief/ }).click();
  const sheet = (await collaborator.locator(".review-panel").boundingBox())!;
  expect(Math.abs(sheet.width - 374)).toBeLessThanOrEqual(2);
  expect(await collaborator.locator(".review-panel").evaluate(element => getComputedStyle(element).bottom)).toBe("8px");
  expect(sheet.y).toBeGreaterThan(100);
  expect((await collaborator.locator(".artifact-canvas").boundingBox())!.width).toBe(canvasWidth);
  expect(await collaborator.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(host.locator("#launch-brief")).toHaveClass(/active/);
  await expect(hostLaunch.getByLabel("Launch headline")).toHaveValue("Meet Orbit: launch with confidence, not chaos.");
  await expect(hostLaunch.getByLabel("Voice")).toHaveValue("bold");
  await expect(hostLaunch.getByLabel("Waitlist email")).toHaveValue("maya@example.com");
  await expect(hostLaunch.getByText("Approvals: 1")).toBeVisible();

  await collaborator.getByLabel("Comment on Launch brief").fill("Lead with calm confidence and make the launch-day promise explicit.");
  await collaborator.getByRole("button", { name: "Post comment" }).click();
  let feedback!: ToolResult;
  await expect.poll(async () => {
    feedback = await callTool<ToolResult>(host, "get_feedback", { status: "open" });
    return feedback.feedback?.length;
  }).toBe(1);
  const feedbackId = feedback.feedback[0].id as string;

  const update = await callTool<ToolResult>(host, "update_blocks", {
    expectedVersion: beforeRevision.version,
    feedbackIds: [feedbackId],
    summary: "Sharpened the launch-day promise from reviewer feedback",
    updates: [{ id: "launch-brief", source: { html: revisedLaunchHtml } }],
  });
  expect(update.changedBlockIds).toEqual(["launch-brief"]);
  expect(update.feedbackIds).toEqual([feedbackId]);
  const afterRevision = await callTool<ToolResult>(host, "get_party");
  expect(afterRevision.artifact.blocks[1]).toEqual(beforeRevision.artifact.blocks[1]);
  expect(afterRevision.artifact.blocks[0].source.css).toBe(beforeRevision.artifact.blocks[0].source.css);
  expect(afterRevision.artifact.blocks[0].source.js).toBe(beforeRevision.artifact.blocks[0].source.js);
  expect(afterRevision.runtimeState).toEqual(beforeRevision.runtimeState);

  await expect(collaboratorLaunch.getByText("Reviewer-approved launch promise.")).toBeVisible();
  expect(await collaborator.locator(".storage-usage").textContent()).toMatch(/^Approx\. .* attributable row data$/);
  collaborator.once("dialog", async dialog => { expect(dialog.message()).toMatch(/Delete “Launch brief”.*shared state.*archived/i); await dialog.accept(); });
  await collaborator.getByRole("button", { name: "Delete Launch brief" }).click();
  await expect(collaborator.locator('iframe[title="Launch brief"]')).toHaveCount(0);
  await expect(collaborator.getByRole("heading", { name: "Removed blocks" })).toBeVisible();
  await expect(collaborator.locator(".archived-feedback .thread.open")).toContainText("Lead with calm confidence");
  await expect(collaborator.locator(".archived-feedback")).toContainText("non-blocking");
  await expect(collaborator.locator(".review-button span")).toHaveText("0");

  const deletedParty = await callTool<ToolResult>(host, "get_party");
  expect(deletedParty.version).toBe(3);
  expect(deletedParty.artifact.blocks.map((block: ToolResult) => block.id)).toEqual(["success-metrics"]);
  expect(deletedParty.openFeedback).toBe(0);
  const archivedFeedback = await callTool<ToolResult>(host, "get_feedback", { status: "open" });
  expect(archivedFeedback.feedback[0]).toMatchObject({ id: feedbackId, blockId: "launch-brief", anchorStatus: "archived", status: "open" });
  const zeroed = await callTool<ToolResult>(host, "delete_blocks", { blockIds: ["success-metrics"], expectedVersion: deletedParty.version });
  expect(zeroed).toMatchObject({ version: 4, deletedBlockIds: ["success-metrics"], storage: { accountedRowBytes: expect.any(Number) } });
  await expect(collaborator.getByRole("heading", { name: "This revision has zero blocks" })).toBeVisible();
  await expect(collaborator.locator(".artifact-canvas iframe")).toHaveCount(0);
  await expect(collaborator.locator(".zero-block-note")).toContainText("Revision restore remains available");

  const history = collaborator.locator(".review-panel summary", { hasText: /revision/ });
  await history.click();
  await expect(collaborator.getByRole("button", { name: "Restore revision v2" })).toBeEnabled();
  collaborator.once("dialog", async dialog => { expect(dialog.message()).toMatch(/whole artifact and shared state.*new revision/i); await dialog.dismiss(); });
  await collaborator.getByRole("button", { name: "Restore revision v2" }).click();
  await expect(collaborator.locator('iframe[title="Launch brief"]')).toHaveCount(0);
  await collaborator.locator(".review-panel").evaluate(element => { element.scrollTop = 0; });
  await collaborator.screenshot({ path: `${artifactsDir}/workspace-narrow.png` });

  if (!await host.locator(".review-panel").count()) await host.getByRole("button", { name: /Review$/ }).click();
  await host.locator(".review-panel summary", { hasText: /revision/ }).click();
  await expect(host.getByRole("button", { name: "Restore revision v2" })).toBeVisible();
  await host.screenshot({ path: `${artifactsDir}/workspace-desktop.png` });
  const desktopPanel = (await host.locator(".review-panel").boundingBox())!;
  expect(desktopPanel.x + desktopPanel.width).toBeGreaterThan(1420);

  const restored = await callTool<ToolResult>(host, "restore_revision", { revisionId: update.revisionId, expectedVersion: zeroed.version, summary: "Restore reviewed full snapshot" });
  expect(restored).toMatchObject({ version: 5, revisionId: expect.any(String), restoredFromRevisionId: update.revisionId, restoredFromVersion: 2, storage: { scope: "party_row_data_only", accountedRowBytes: expect.any(Number), quotaBytes: null } });
  expect(restored.changedBlockIds.sort()).toEqual(["launch-brief", "success-metrics"]);
  const restoredParty = await callTool<ToolResult>(host, "get_party");
  expect(restoredParty.artifact).toEqual(afterRevision.artifact);
  expect(restoredParty.runtimeState).toEqual(afterRevision.runtimeState);
  await expect(host.locator('iframe[title="Launch brief"]')).toBeVisible();
  const reanchored = await callTool<ToolResult>(host, "get_feedback", { status: "open" });
  expect(reanchored.feedback[0].anchorStatus).toBe("active");
  await expect(collaborator.locator(".archived-feedback")).toHaveCount(0);
  await collaborator.getByLabel("Block").selectOption("launch-brief");
  await expect(collaborator.locator(".review-panel .thread.open")).toContainText("Lead with calm confidence");

  const response = await callTool<ToolResult>(host, "respond_to_feedback", {
    feedbackId,
    body: "Restored the complete reviewed source and shared state.",
    revisionId: update.revisionId,
    resolve: true,
  });
  expect(response).toMatchObject({ feedbackId, revisionId: update.revisionId, status: "resolved", resolved: true });
  await expect(collaborator.locator(".review-panel .thread.resolved")).toContainText("Restored the complete reviewed source and shared state.");

  const deletedByTool = await callTool<ToolResult>(host, "delete_blocks", { blockIds: ["success-metrics"], expectedVersion: restoredParty.version });
  expect(deletedByTool).toMatchObject({ version: 6, deletedBlockIds: ["success-metrics"], changedBlockIds: ["success-metrics"], storage: { accountedRowBytes: expect.any(Number) } });
  await expect(collaborator.locator('iframe[title="Success metrics"]')).toHaveCount(0);
  await expect(collaboratorLaunch.getByLabel("Launch headline")).toHaveValue("Meet Orbit: launch with confidence, not chaos.");

  const finalized = await callTool<ToolResult>(host, "finalize_party", { name: "Orbit Launch — Approved", expectedVersion: 6 });
  expect(finalized.lifecycle).toBe("finalized");
  for (const page of [host, collaborator]) {
    await expect(page.locator(".final-title-pill")).toContainText("Orbit launch command center");
    await expect(page.locator(".final-download").getByRole("button", { name: "Download interactive HTML" })).toBeVisible();
    await expect(page.locator(".floating-topbar, .review-panel, .feedback-pin, .presence-badges, .share-button, .review-button, .lifecycle-chip, .revision")).toHaveCount(0);
    await expect(page.locator("body button")).toHaveCount(1);
  }
  const finalReviewBaselines = [hostMonitor.mutableReviewRequests.length, collaboratorMonitor.mutableReviewRequests.length];
  await host.waitForTimeout(400);
  expect([hostMonitor.mutableReviewRequests.length, collaboratorMonitor.mutableReviewRequests.length]).toEqual(finalReviewBaselines);
  for (const page of [host, collaborator]) await expect.poll(() => page.evaluate(() => [...(window as any).__nativeWebMcpTools.keys()].sort())).toEqual(publicTools);
  const unavailableAfterFinal = await callTool<ToolResult>(host, "update_blocks", { expectedVersion: 6, resetState: true });
  expect(unavailableAfterFinal).toMatchObject({ ok: false, error: { code: "TOOL_UNAVAILABLE", retryable: false }, context: { page: "party", lifecycle: "finalized", access: "owner", availableOperations: ["init", "get_party", "get_feedback", "get_final_artifact"] } });
  expect(JSON.stringify(unavailableAfterFinal)).not.toMatch(/[A-Za-z0-9_-]{43}/);
  const registrationEvidence = await host.evaluate(() => ({ calls: (window as any).__nativeWebMcpCalls as string[], aborted: ((window as any).__nativeWebMcpSignals as AbortSignal[]).map(signal => signal.aborted) }));
  expect(registrationEvidence.calls.sort()).toEqual(publicTools);
  expect(registrationEvidence.calls).toHaveLength(11);
  expect(registrationEvidence.aborted).toEqual(Array(11).fill(false));

  await host.screenshot({ path: `${artifactsDir}/final-desktop.png` });
  await collaborator.screenshot({ path: `${artifactsDir}/final-mobile.png` });
  const finalArtifact = await callTool<ToolResult>(host, "get_final_artifact");
  expect(finalArtifact.final.sourceVersion).toBe(6);
  expect(finalArtifact.final.html).toBe(finalized.final.html);
  const downloadPromise = host.waitForEvent("download");
  await host.getByRole("button", { name: "Download interactive HTML" }).click();
  const download = await downloadPromise;
  const finalPath = `${artifactsDir}/orbit-launch-final.html`;
  await download.saveAs(finalPath);
  expect(await readFile(finalPath, "utf8")).toBe(finalArtifact.final.html);

  const secrets = await host.evaluate(() => Object.entries(sessionStorage).flatMap(([key, value]) => {
    if (key.includes("capability") || key.includes(".share.")) return [value];
    if (!key.includes("participant")) return [];
    try { return [JSON.parse(value).participantToken].filter(Boolean); } catch { return []; }
  })) as string[];
  for (const secret of secrets) expect(finalArtifact.final.html).not.toContain(secret);
  expect(finalArtifact.final.html).not.toContain("http://localhost:5173");

  const standalone = await hostContext.newPage(); pages.push(standalone);
  const standaloneMonitor = monitor(standalone, "standalone");
  const standaloneUrl = pathToFileURL(finalPath).href;
  await standalone.goto(standaloneUrl);
  await expect(standalone.locator("iframe")).toHaveCount(1);
  await expect(standalone.locator("body > main > section")).toHaveCount(1);
  await expect(standalone.locator("body > main > h1, body > main > h2")).toHaveCount(0);
  const standaloneLaunchFrame = standalone.locator('iframe[title="Launch brief"]');
  const standaloneLaunch = standalone.frameLocator('iframe[title="Launch brief"]');
  await expect(standaloneLaunch.getByLabel("Launch headline")).toHaveValue("Meet Orbit: launch with confidence, not chaos.");
  await expect(standaloneLaunch.getByLabel("Voice")).toHaveValue("bold");
  await expect(standaloneLaunch.getByText("Approvals: 1")).toBeVisible();
  await expect(standaloneLaunch.locator("#inlineMarker")).toHaveCSS("background-color", "rgb(255, 238, 153)");
  await expect.poll(async () => Math.abs(
    await standaloneLaunchFrame.evaluate(element => element.getBoundingClientRect().height) -
    await standaloneLaunch.locator("html").evaluate(element => element.scrollHeight),
  )).toBeLessThanOrEqual(2);
  await expect(standaloneLaunchFrame).toHaveCSS("border-top-style", "none");
  await standaloneLaunch.getByRole("button", { name: "Approve launch" }).click();
  await expect(standaloneLaunch.getByText("Approvals: 2")).toBeVisible();
  await expect(standaloneLaunch.getByText("Network: caught CSP block: TypeError")).toBeVisible();
  await expect(standalone).toHaveURL(standaloneUrl);
  expect(standaloneMonitor.blockedProbeErrors).toBeGreaterThan(0);
  expect(standaloneMonitor.externalRequests).toEqual([]);
  expect(standaloneMonitor.failedRequests).toEqual([]);
  expect(standaloneMonitor.errors).toEqual([]);
  await standalone.screenshot({ path: `${artifactsDir}/final-standalone.png` });
  await standalone.close();

  await expect(hostLaunch.getByText("Reviewer-approved launch promise.")).toBeVisible();
  expect(hostMonitor.errors).toEqual([]);
  expect(collaboratorMonitor.errors).toEqual([]);
  expect(hostMonitor.failedRequests).toEqual([]);
  expect(collaboratorMonitor.failedRequests).toEqual([]);
  expect(hostMonitor.externalRequests).toEqual([]);
  expect(hostMonitor.capabilityRequests).toEqual([]);
  expect(collaboratorMonitor.capabilityRequests).toEqual([]);

  } finally {
    await Promise.allSettled(pages.map(page => page.close()));
    await Promise.allSettled(contexts.map(context => context.close()));
  }
});
