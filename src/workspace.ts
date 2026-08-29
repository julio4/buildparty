import { mergeJsonObjects, type JsonObject, type JsonValue, type RuntimeState } from "./domain.ts";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

const capabilityPattern = /^[A-Za-z0-9_-]{43}$/;

export function resolvePartyCapability(href: string, partyId: string, storage: StorageLike) {
  const url = new URL(href);
  let fragment = new URLSearchParams(url.hash.slice(1));
  const fragmentCapability = fragment.get("cap");
  const queryCapability = url.searchParams.get("cap");
  const supplied = capabilityPattern.test(fragmentCapability ?? "") ? fragmentCapability! : capabilityPattern.test(queryCapability ?? "") ? queryCapability! : undefined;
  const key = `buildparty.capability.${partyId}`;
  if (supplied) {
    storage.setItem(key, supplied);
    if (supplied !== fragmentCapability) {
      fragment.delete("cap");
      const converted = new URLSearchParams({ cap: supplied });
      for (const [name, value] of fragment) converted.append(name, value);
      fragment = converted;
    } else fragment.set("cap", supplied);
  }
  url.searchParams.delete("cap");
  url.hash = fragment.toString() ? `#${fragment}` : "";
  const stored = storage.getItem(key) ?? undefined;
  return { capability: supplied ?? (capabilityPattern.test(stored ?? "") ? stored : undefined), cleanUrl: `${url.pathname}${url.search}${url.hash}` };
}

export type ReviewState = { open: boolean; blockId?: string };
export function nextReviewState(blockIds: string[], current: ReviewState, action: { type: "open" | "select"; blockId?: string } | { type: "close" }): ReviewState {
  if (action.type === "close") return { ...current, open: false };
  const requested = action.blockId && blockIds.includes(action.blockId) ? action.blockId : undefined;
  const blockId = requested ?? (current.blockId && blockIds.includes(current.blockId) ? current.blockId : blockIds[0]);
  return { open: true, ...(blockId ? { blockId } : {}) };
}

export function reviewFeedback<T extends { block_id: string; status?: string }>(blockIds: string[], feedback: T[]) {
  const ids = new Set(blockIds);
  const active = feedback.filter(item => ids.has(item.block_id));
  return { active, archived: feedback.filter(item => !ids.has(item.block_id)), blockingOpen: active.filter(item => item.status === "open").length };
}

export const deleteBlockConfirmation = (title: string) => `Delete “${title}”? The block and its shared state will be removed in a new revision. Feedback stays archived and can return if you restore the block.`;
export const restoreRevisionConfirmation = (version: number) => `Restore revision v${version}? This replaces the whole artifact and shared state, then creates a new revision.`;
export function approximateRowDataLabel(bytes: number) {
  const value = bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `Approx. ${value} attributable row data`;
}

export function stateFieldPatch(previous: JsonObject, next: JsonObject): JsonObject {
  const patch: JsonObject = {};
  for (const [key, value] of Object.entries(next)) {
    const existing = previous[key];
    if (isJsonObject(existing) && isJsonObject(value)) {
      const nested = stateFieldPatch(existing, value);
      if (Object.keys(nested).length) patch[key] = nested;
    } else if (JSON.stringify(existing) !== JSON.stringify(value)) patch[key] = structuredClone(value);
  }
  return patch;
}

type SaveResult = { version: number; runtimeState: RuntimeState };
type Remote = { version: number; runtimeState: RuntimeState };
type Save = (patch: RuntimeState, expectedVersion: number | undefined) => Promise<SaveResult>;
type Reload = () => Promise<Remote>;

/** Debounces and serializes the one global artifact version while sending only changed block fields. */
export class RuntimeStateWriter {
  private version: number | undefined;
  private visible: RuntimeState = {};
  private pending: RuntimeState = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private paused = false;

  constructor(
    private save: Save,
    private reload: Reload,
    private onState: (state: RuntimeState, version?: number) => void,
    private onError: (error: unknown) => void,
    private delay = 300,
  ) {}

  setRemote(runtimeState: RuntimeState, version: number | null) {
    if (this.running || Object.keys(this.pending).length) {
      if (JSON.stringify(runtimeState) !== JSON.stringify(this.visible)) this.onState(structuredClone(this.visible), this.version);
      return;
    }
    this.visible = structuredClone(runtimeState);
    this.version = version ?? undefined;
  }

  update(blockId: string, next: JsonObject) {
    const patch = stateFieldPatch(this.visible[blockId] ?? {}, next);
    if (!Object.keys(patch).length) return;
    this.visible = { ...this.visible, [blockId]: mergeJsonObjects(this.visible[blockId] ?? {}, patch) };
    this.pending[blockId] = mergeJsonObjects(this.pending[blockId] ?? {}, patch);
    this.paused = false;
    this.onState(structuredClone(this.visible));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  currentVersion() { return this.version; }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running;
    if (!Object.keys(this.pending).length) return Promise.resolve();
    const patch = this.pending;
    this.pending = {};
    this.running = this.commit(patch).finally(() => {
      this.running = undefined;
      if (!this.paused && Object.keys(this.pending).length) void this.flush();
    });
    return this.running;
  }

  private async commit(patch: RuntimeState): Promise<void> {
    try {
      const saved = await this.save(patch, this.version);
      this.version = saved.version;
      this.visible = overlay(saved.runtimeState, this.pending);
      this.onState(structuredClone(this.visible), this.version);
    } catch (error) {
      if (isVersionConflict(error)) {
        try {
          const remote = await this.reload();
          this.version = remote.version;
          this.pending = overlay(patch, this.pending);
          this.visible = overlay(remote.runtimeState, this.pending);
          this.onState(structuredClone(this.visible), this.version);
          return;
        } catch (reloadError) { error = reloadError; }
      }
      this.pending = overlay(patch, this.pending);
      this.paused = true;
      this.onError(error);
    }
  }
}

function overlay(base: RuntimeState, patch: RuntimeState): RuntimeState {
  const next = structuredClone(base);
  for (const [blockId, fields] of Object.entries(patch)) next[blockId] = mergeJsonObjects(next[blockId] ?? {}, fields);
  return next;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVersionConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "VERSION_CONFLICT");
}
