import { useEffect, useMemo, useRef } from "react";
import { validateJsonObject, type JsonObject, type JsonValue, type SandboxBlock } from "./domain.ts";
import { clampSandboxAnchorOffset, clampSandboxHeight, createSandboxDocument, SANDBOX_MIN_HEIGHT } from "./sandbox-document.ts";

const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const workspaceChromeHeight = 62;

export function SandboxFrame({ block, state, onChange }: { block: SandboxBlock; state: JsonObject; onChange: (state: JsonObject) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latestState = useRef(state);
  const channel = useMemo(() => crypto.randomUUID(), [block.id]);
  const sourceIdentity = sandboxDocumentIdentity(block);
  const document = useMemo(() => createSandboxDocument(block, channel, crypto.randomUUID()), [sourceIdentity, channel]);
  const send = (next: JsonObject) => frame.current?.contentWindow?.postMessage({ type: "bp:state", channel, state: next }, "*");

  useEffect(() => { latestState.current = state; send(state); }, [state, channel]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== channel) return;
      if (event.data.type === "bp:ready") return send(latestState.current);
      if (event.data.type === "bp:resize") {
        const height = clampSandboxHeight(event.data.height);
        if (height && frame.current && frame.current.height !== String(height)) frame.current.height = String(height);
        return;
      }
      if (event.data.type === "bp:anchor") {
        const offset = clampSandboxAnchorOffset(event.data.offset);
        if (offset !== undefined && frame.current) window.scrollTo({ top: Math.max(0, window.scrollY + frame.current.getBoundingClientRect().top + offset - workspaceChromeHeight) });
        return;
      }
      try {
        let next: JsonObject;
        if (event.data.type === "bp:patch") next = validateJsonObject({ ...latestState.current, ...validateJsonObject(event.data.patch, "state patch") }, "runtimeState");
        else if (event.data.type === "bp:set") next = setPath(latestState.current, event.data.path, event.data.value);
        else return;
        latestState.current = next;
        send(next);
        onChange(next);
      } catch { /* ignore invalid messages from the opaque sandbox */ }
    };
    addEventListener("message", receive);
    return () => removeEventListener("message", receive);
  }, [channel, onChange]);

  return <iframe ref={frame} title={block.title ?? block.id} height={SANDBOX_MIN_HEIGHT} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} />;
}

export function sandboxDocumentIdentity(block: SandboxBlock) {
  return JSON.stringify([block.id, block.source.html, block.source.css ?? null, block.source.js ?? null]);
}

function setPath(state: JsonObject, input: unknown, value: unknown): JsonObject {
  if (typeof input !== "string" || input.length > 1024) throw new Error("invalid state path");
  const path = input.split(".");
  if (path.length > 16 || path.some(key => !key || key.length > 64 || unsafe.has(key) || /^(0|[1-9]\d*)$/.test(key))) throw new Error("invalid state path");
  const next = structuredClone(state);
  let target: JsonObject = next;
  for (const key of path.slice(0, -1)) {
    const current = target[key];
    if (Array.isArray(current)) throw new Error("arrays cannot appear in state paths");
    if (current === null || typeof current !== "object") target[key] = {};
    target = target[key] as JsonObject;
  }
  target[path.at(-1)!] = value as JsonValue;
  return validateJsonObject(next, "runtimeState");
}
