import { WEBMCP_TOOL_DEFINITIONS, executeWebMcpTool } from "./webmcp.ts";
import type { WebMcpOperation } from "./domain.ts";

declare global {
  interface Window {
    __buildPartyWebMcp?: {
      tools: ReadonlyArray<(typeof WEBMCP_TOOL_DEFINITIONS)[number]>;
      execute(name: WebMcpOperation, input?: unknown): Promise<unknown>;
    };
  }
}

/** Development-only console harness: JSON in, the real HTTP-backed executor result out. */
export function installWebMcpDevHarness(names: WebMcpOperation[], execute: (name: WebMcpOperation, input?: unknown) => Promise<unknown>) {
  const active = new Set(names);
  const harness = {
    tools: WEBMCP_TOOL_DEFINITIONS.filter(definition => active.has(definition.name)),
    execute(name: WebMcpOperation, input: unknown = {}) {
      if (!active.has(name)) return Promise.resolve({ ok: false, error: { code: "INVALID_STATE", message: `${name} is not available in the current state`, hint: "Use one of the currently advertised tools.", retryable: false } });
      return executeWebMcpTool(execute, name, input);
    },
  };
  window.__buildPartyWebMcp = harness;
  return () => { if (window.__buildPartyWebMcp === harness) delete window.__buildPartyWebMcp; };
}
