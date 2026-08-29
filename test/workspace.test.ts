import test from "node:test";
import assert from "node:assert/strict";
import { mergeJsonObjects, type RuntimeState } from "../src/domain.ts";
import { approximateRowDataLabel, deleteBlockConfirmation, nextReviewState, resolvePartyCapability, restoreRevisionConfirmation, reviewFeedback, RuntimeStateWriter, stateFieldPatch } from "../src/workspace.ts";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, values };
}

test("capability fragments remain and legacy query links convert before API calls", () => {
  const fragmentCapability = "f".repeat(43);
  const queryCapability = "q".repeat(43);
  const first = storage();
  assert.deepEqual(resolvePartyCapability(`https://app.test/party/p?cap=${queryCapability}&view=1#cap=${fragmentCapability}&block=scope`, "p", first), {
    capability: fragmentCapability, cleanUrl: `/party/p?view=1#cap=${fragmentCapability}&block=scope`,
  });
  assert.equal(first.values.get("buildparty.capability.p"), fragmentCapability);

  const fallback = storage();
  assert.deepEqual(resolvePartyCapability(`https://app.test/party/p?cap=${queryCapability}&view=1#block=scope`, "p", fallback), {
    capability: queryCapability, cleanUrl: `/party/p?view=1#cap=${queryCapability}&block=scope`,
  });
  assert.deepEqual(resolvePartyCapability("https://app.test/party/p?view=1", "p", fallback), { capability: queryCapability, cleanUrl: "/party/p?view=1" });
  assert.equal(new URL(`https://app.test/party/p#cap=${fragmentCapability}`).searchParams.has("cap"), false, "fragments are not HTTP query parameters");
});

test("review window state selects valid blocks and closes without losing selection", () => {
  const opened = nextReviewState(["first", "second"], { open: false }, { type: "open", blockId: "second" });
  assert.deepEqual(opened, { open: true, blockId: "second" });
  assert.deepEqual(nextReviewState(["first", "second"], opened, { type: "close" }), { open: false, blockId: "second" });
  assert.deepEqual(nextReviewState(["first"], opened, { type: "select", blockId: "missing" }), { open: true, blockId: "first" });
});

test("delete, restore, archived feedback, and storage review helpers stay explicit", () => {
  const feedback = [{ block_id: "live", status: "open" }, { block_id: "removed", status: "open" }];
  assert.deepEqual(reviewFeedback(["live"], feedback), { active: [feedback[0]], archived: [feedback[1]], blockingOpen: 1 });
  assert.equal(reviewFeedback([], feedback).blockingOpen, 0, "open feedback on removed blocks is non-blocking");
  assert.match(deleteBlockConfirmation("Hero"), /shared state.*archived/i);
  assert.match(restoreRevisionConfirmation(3), /whole artifact and shared state.*new revision/i);
  assert.match(approximateRowDataLabel(12_800), /^Approx\. 12\.5 KB attributable row data$/);
});

test("nested state diffs and conflict replay preserve concurrent sibling fields", async () => {
  assert.deepEqual(stateFieldPatch({ form: { first: "a", second: "b" } }, { form: { first: "local", second: "b" } }), { form: { first: "local" } });
  const calls: RuntimeState[] = [];
  let conflict = true;
  const states: RuntimeState[] = [];
  const writer = new RuntimeStateWriter(
    async patch => {
      calls.push(patch);
      if (conflict) { conflict = false; throw { code: "VERSION_CONFLICT" }; }
      return { version: 3, runtimeState: { block: mergeJsonObjects({ form: { first: "a", second: "remote" } }, patch.block!) } };
    },
    async () => ({ version: 2, runtimeState: { block: { form: { first: "a", second: "remote" } } } }),
    state => states.push(state),
    error => { throw error; },
    60_000,
  );
  writer.setRemote({ block: { form: { first: "a", second: "b" } } }, 1);
  writer.update("block", { form: { first: "local", second: "b" } });
  await writer.flush();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, [{ block: { form: { first: "local" } } }, { block: { form: { first: "local" } } }]);
  assert.deepEqual(states.at(-1)?.block, { form: { first: "local", second: "remote" } });
});

test("runtime writes are field-level, serialized, and replayed after a version conflict", async () => {
  assert.deepEqual(stateFieldPatch({ text: "a", untouched: true }, { text: "ab", untouched: true }), { text: "ab" });
  let release!: (value: { version: number; runtimeState: RuntimeState }) => void;
  const calls: { patch: RuntimeState; version: number | undefined }[] = [];
  let conflict = false;
  const states: RuntimeState[] = [];
  const writer = new RuntimeStateWriter(
    (patch, version) => {
      calls.push({ patch, version });
      if (conflict) { conflict = false; return Promise.reject({ code: "VERSION_CONFLICT" }); }
      if (calls.length === 1) return new Promise(resolve => { release = resolve; });
      return Promise.resolve({ version: 4, runtimeState: { block: { remote: "kept", ...patch.block } } });
    },
    async () => ({ version: 3, runtimeState: { block: { remote: "kept" } } }),
    state => states.push(state),
    error => { throw error; },
    60_000,
  );
  writer.setRemote({ block: { text: "a", untouched: true } }, 1);
  writer.update("block", { text: "ab", untouched: true });
  const optimisticUpdates = states.length;
  writer.setRemote({ block: { text: "a", untouched: true } }, 1);
  assert.equal(states.length, optimisticUpdates + 1, "a stale Electric refresh must restore the pending optimistic state");
  assert.equal(states.at(-1)?.block?.text, "ab");
  const first = writer.flush();
  writer.update("block", { text: "abc", untouched: true });
  assert.equal(calls.length, 1, "a second write must wait for the first");
  release({ version: 2, runtimeState: { block: { text: "ab", untouched: true } } });
  await first;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { patch: { block: { text: "ab" } }, version: 1 });
  assert.deepEqual(calls[1], { patch: { block: { text: "abc" } }, version: 2 });

  conflict = true;
  writer.update("block", { text: "final", remote: "kept" });
  await writer.flush();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls.at(-1), { patch: { block: { text: "final" } }, version: 3 });
  assert.deepEqual(states.at(-1)?.block, { remote: "kept", text: "final" });
});
