import { useCallback, useEffect, useRef } from "react";
import { WEBMCP_OPERATIONS, type WebMcpOperation } from "./domain.ts";
import { NativeWebMcpRegistration, WEBMCP_TOOL_DEFINITIONS, type WebMcpPartyView } from "./webmcp.ts";

type Execute = (name: WebMcpOperation, input?: unknown) => Promise<unknown>;

export function useNativeWebMcp(execute: Execute) {
  const currentExecute = useRef(execute);
  const registration = useRef<NativeWebMcpRegistration | null>(null);
  const cleanup = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  currentExecute.current = execute;
  const stableExecute = useCallback<Execute>((name, input) => currentExecute.current(name, input), []);

  useEffect(() => {
    clearTimeout(cleanup.current);
    const current = registration.current ??= new NativeWebMcpRegistration();
    void current.sync([...WEBMCP_OPERATIONS], stableExecute).catch(error => { if (!(error instanceof DOMException && error.name === "AbortError")) console.error("WebMCP registration failed", error); });
    return () => { cleanup.current = setTimeout(() => current.clear(), 0); };
  }, [stableExecute]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let remove: (() => void) | undefined;
    let cancelled = false;
    void import("./webmcp-dev.ts").then(module => { if (!cancelled) remove = module.installWebMcpDevHarness([...WEBMCP_OPERATIONS], stableExecute); });
    return () => { cancelled = true; remove?.(); };
  }, [stableExecute]);
}

export type { WebMcpPartyView };
export { createWebMcpExecutor, toolsForPage } from "./webmcp.ts";
export { WEBMCP_TOOL_DEFINITIONS };
