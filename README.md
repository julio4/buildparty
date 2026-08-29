# BuildParty

Capability-shared human/agent review of interactive sandbox artifacts.

## Demo flow

1. Open the landing page, set your display name, and create a workspace.
2. Keep the owner link and copy the separate reviewer link. Capabilities stay in `#cap=…` and are also stored as a tab fallback; the SPA converts legacy `?cap=…` links to fragments before making API calls.
3. Have an agent publish sandbox blocks through WebMCP. Reviewers interact with the seamless artifact canvas and use a block pin to open the floating review window—there is no human source editor. Anyone in the party can delete a selected block or restore an available whole-artifact revision after explicit confirmation; removed-block feedback stays archived and non-blocking.
4. Let the agent revise/respond, then use the same review window to finalize (explicitly overriding any active open feedback when intended). Finalized pages remove all review chrome and retain only the title pill and interactive HTML download.

## Local setup

Requires Node 24+ and Docker. Compose starts Postgres (with logical replication), Electric, migrates the database, and starts the API; Vite proxies `/api` to it.

```sh
npm install
docker compose up -d --build
npm run dev                 # UI on :5173; API on :3001
```

Local defaults are `DATABASE_URL=postgres://buildparty:buildparty@localhost:5432/buildparty`, `ELECTRIC_URL=http://electric:3000`, and a Compose-only development `ELECTRIC_SECRET`. Replace the local secret outside development. `PUBLIC_ORIGIN` defaults to `http://localhost:5173`.

## Native WebMCP

BuildParty registers the complete eleven-tool vocabulary once for the document lifetime with Chrome's native `document.modelContext` API on secure origins. Held tool references remain valid across same-document landing/party transitions and workspace refreshes; calls are gated against fresh server lifecycle and role evidence and return `TOOL_UNAVAILABLE` context when necessary. In Chrome, enable `chrome://flags/#enable-webmcp-testing`, relaunch, and use HTTPS (or the trusted localhost development origin). Unsupported browsers continue to provide the normal human UI without errors. In development only, the stable console fallback `window.__buildPartyWebMcp` exposes the same definitions and HTTP-backed executor with JSON inputs/results; it is removed from production builds.

The exact eleven-tool public vocabulary is `init`, `create_party`, `get_party`, `set_artifact`, `update_blocks`, `delete_blocks`, `restore_revision`, `get_feedback`, `respond_to_feedback`, `finalize_party`, and `get_final_artifact`.

URL-first agent flow:

1. Give a WebMCP-capable browser/agent the BuildParty URL and ask it to use BuildParty. Keep that page open. A URL only opens the product; it does **not** auto-install a skill. ChatGPT capability documentation and tool discovery are host-side behavior, not something the page can install or emulate.
2. On the landing page the agent calls `init` first (`Owner` is the fallback when no useful name is known). Landing init stores that reusable agent identity; party-page init creates or reuses the party participant session. The agent then creates exactly one room with `create_party`, using `BuildParty session` when no supplied content suggests a title. It keeps the owner URL private and returns both clearly labeled owner and reviewer fragment URLs.
3. If the conversation already has useful content, the agent publishes it with `set_artifact`; otherwise it creates the room and asks or works on the content. In an existing room it calls `get_party` before acting. Returned `nextAction` evidence guides this sequence without polling.
4. During review, humans interact and comment while the agent changes source. The agent reads open feedback, targets stable blocks with `update_blocks` and linked `feedbackIds`, then resolves feedback with the returned revision ID. A shared-state-only patch creates no revision. `delete_blocks` may deliberately leave a zero-block artifact; `restore_revision` restores a whole available snapshot.
5. From the owner URL, `finalize_party` locks the current version; `get_final_artifact` returns the portable final HTML.

Build one seamless artifact. Use one block for atomic work and stable blocks for independently reviewable sections. Artifact source is self-contained/no-network HTML/CSS/JS: standard named controls sync by default, `data-bp-local` stays local, and custom JavaScript uses `window.buildParty.getState`, `setState`, `patchState`, and `subscribe`. Precompile Mermaid/UML to inline SVG. For planning/RFCs, split by decision or section; for learning notebooks, use sections plus persistent exercises/progress; for presentations, use stable slide/section blocks; for prototypes and decision workshops, use shared controls for assumptions, votes, and choices.

WebMCP uses a distinct agent participant session from the human UI. Its participant token remains tab-scoped and internal; native results never expose participant tokens or raw capabilities (the create result's explicitly requested fragment URLs are the only portable capability-bearing values). `get_party.availableOperations` and `TOOL_UNAVAILABLE.context` remain state-aware guidance even though all tools stay registered. ChatGPT's capability-level `webmcp.documentation()` availability is host behavior outside page control; BuildParty does not add a fake documentation tool or refetch protocol.

## Artifact and shared state

`PUT /api/parties/:id/artifact` accepts the exact v1 artifact under `artifact`:

```json
{
  "format": "buildparty.artifact/v1",
  "title": "Launch plan",
  "blocks": [{
    "id": "counter",
    "title": "Counter",
    "kind": "sandbox",
    "source": { "html": "<button id=add>Add</button>", "css": "button{padding:1rem}", "js": "window.buildParty.setState('count', 1)" },
    "initialState": { "count": 0 }
  }]
}
```

Runtime state is stored separately by block id. `PATCH /blocks` accepts partial `updates`, `statePatch`, or `resetState`; object patches merge recursively while arrays and scalars replace. `DELETE /blocks` and revision restore require an exact `expectedVersion` and accept an optional summary. `expectedVersion` returns a simple `VERSION_CONFLICT` on stale writes, while omitted versions on the older mutation routes use last-write-wins. Sandbox and finalized HTML frames use `sandbox="allow-scripts"`, restrictive no-network CSP, nonce-only scripts and stylesheet elements, inline style attributes, neutral classless defaults before agent CSS, and a clamped resize bridge alongside the validated `window.buildParty` state bridge.

## API and Electric shapes

Party routes require `Authorization: Bearer <capability>`; the server never accepts `?cap=`. Portable links use fragments so capabilities never reach the initial request or referrer. The SPA alone accepts legacy query links as a bootstrap fallback, converts them to `#cap=…`, and keeps a session-storage fallback. Owner capabilities alone may finalize; share capabilities retain non-final writes.

Creating a party or `POST /api/parties/:id/participants` chooses a display name and `human`/`agent` kind and returns a participant token once. Attributed routes also require that token in `X-Participant-Token`; only its hash is stored, and the server resolves its fixed party, generated participant ID, name, and kind instead of trusting mutation bodies. This is lightweight attribution, not identity proof or extra authorization: anyone holding a party capability may create either kind, but cannot claim an existing participant ID. Capabilities still decide permissions.

Live presence is ephemeral and process-local. The browser exchanges its bearer capability and participant token over authenticated HTTP for a short-lived, one-time ticket; only that disposable ticket is used in the WebSocket URL. Rooms broadcast connected display identities and active block only, heartbeat stale sockets, and never persist presence. Finalized rooms remain viewable but presence updates and durable state writes stay disabled.

`add_feedback` is a human-only block-comment action and is not one of the eleven WebMCP operations returned by `/api/init`. `GET /api/parties/:id/final/export` returns the stored finalized HTML as a safe attachment. Final-version rows reject both direct updates and deletes; this intentionally also prevents a party deletion from cascading through an immutable final, and there is no delete-party feature.

`GET /api/parties/:id/storage` returns authenticated per-party row-data accounting from `pg_column_size`: total `accountedRowBytes`, per-table `rows` and `accountedRowBytes`, `scope: "party_row_data_only"`, and explicit exclusions for relation/page overhead, indexes, and TOAST relation allocation. The review panel labels this compactly as approximate attributable row data. It is not total PostgreSQL storage, and `quotaBytes: null` means no default quota or enforcement exists.

Read-only Electric projections are available at:

- `/api/parties/:id/shapes/party`
- `/api/parties/:id/shapes/artifact`
- `/api/parties/:id/shapes/feedback`
- `/api/parties/:id/shapes/revisions`
- `/api/parties/:id/shapes/participants`
- `/api/parties/:id/shapes/audit`
- `/api/parties/:id/shapes/final`

The party-scoped audit shape also invalidates response-only feedback changes without exposing unscoped `feedback_responses`. Shape routes require bearer auth. The Node proxy fixes each table, column allowlist, and `party_id`/`id` filter, forwards only Electric protocol cursor parameters, and adds the server-side Electric secret. All writes continue through Node API routes.

## Release artifacts

Production operations live in a separate private repository. This source repository only creates versioned, immutable release archives; it does not contain domains, infrastructure, credentials, or deployment state. Docker with Buildx is required.

```sh
./scripts/build-release.sh 2026-09-02.1
```

This builds `linux/amd64` and writes the image archive and SHA-256 checksum under `~/.local/share/buildparty/releases/`. Release names are explicit timestamps rather than Git commit IDs, and existing release archives are never overwritten.

## Verification

The normal checks are Docker-free:

```sh
npm test
npm run eval:agent:check # secret-free probabilistic-harness contract checks; no provider call
npm run typecheck
npm run build
npm run test:production-harness # checks the completed dist bundle
```

The service integration suite is available separately when local Postgres is running (`docker compose up -d postgres`): `npm run test:service`.

The bounded Electric check uses an isolated Compose project and ports, verifies two subscribers, reconnect/catch-up, and party isolation, then always tears it down:

```sh
npm run test:electric
```

The real-browser golden demo starts a clean isolated Postgres/Electric/API Compose stack, runs its migrations, starts Vite, drives the registered WebMCP tools and two browser contexts, and always tears everything down. Install Chromium once, then run the single orchestration command (screenshots and the exact final HTML land in `test-results/artifacts/`):

```sh
npx playwright install chromium
npm run test:e2e
```

## Evaluation layers

These layers answer different questions:

- **Deterministic contract eval:** the WebMCP-Bench bundle below verifies declared state transitions and service semantics without a model.
- **Production E2E:** `npm run test:e2e` drives BuildParty's real registered tools, service, Electric sync, and browser UI.
- **Probabilistic API model eval:** the credentialed harness sends the current imported eleven production definitions to a real OpenAI Responses or Gemini `generateContent` model and scores seven bounded agent journeys. This is API-model tool-selection, argument, and planning evidence—not native browser discovery proof. It uses a deterministic in-memory dispatcher as tool evidence, not as a fake browser or model.
- **Manual ChatGPT browser smoke:** open the deployed URL in a WebMCP-enabled in-app browser and try the URL-first flow. This is intentionally manual; this repository does not claim ChatGPT in-app automation.

The probabilistic scenarios are secret-free JSON in `evals/buildparty/agent-journeys.json`. Reports contain a recursively redacted tool trace and are written under ignored `test-results/agent-evals/`. Artifact scoring rejects declared remote dependencies such as remote resource attributes and network APIs while avoiding benign textual-URL false positives; the production CSP and browser E2E remain the security proof. Runs default to one trial and at most six turns; `--trials=3`, `--model=…`, `--required-passes=…`, output-token, and timeout flags are supported. No provider prices are hardcoded; inspect returned usage and provider billing for cost.

```sh
npm run eval:agent:check
OPENAI_API_KEY=… npm run eval:agent:openai -- --model=gpt-5-mini
GEMINI_API_KEY=… npm run eval:agent:gemini -- --model=gemini-2.5-flash
```

### Deterministic WebMCP evaluation

The three-file bundle is in `evals/buildparty/`. It targets WebMCP-Bench `main` at commit `179b7470caf8ed7993791fac75b1a21677904a78` from `https://github.com/julio4/webmcp-bench.git` (no release tag existed when pinned). CI checks that exact source with Python 3.11 and its pinned requirements using `--self-test` only. The full Daytona run stays explicit below and is intentionally not in CI because it requires credentials.

```sh
# From this repository, with a sibling checkout at ../webmcp-bench:
python3 ../webmcp-bench/app.py evals/buildparty --self-test
python3 ../webmcp-bench/app.py evals/buildparty --run # requires preconfigured Daytona credentials
```

For a reproducible fresh sibling checkout:

```sh
git clone https://github.com/julio4/webmcp-bench.git ../webmcp-bench
git -C ../webmcp-bench checkout 179b7470caf8ed7993791fac75b1a21677904a78
```

WebMCP-Bench v1 invokes one adapter action per task rather than driving the browser. The deterministic bundle declares 8 states, 17 transitions, and 17 active tasks with 100% transition coverage. Its native site registers exactly the same eleven public tools documented above; the deterministic human-feedback fixture and composite full-journey action remain clearly private adapter infrastructure and are never registered with native WebMCP. Evaluation parity intentionally stops at deterministic state semantics: the real service remains authoritative for PostgreSQL transactions, generated IDs/timestamps, authenticated capabilities/participant tokens, and final HTML rendering.
