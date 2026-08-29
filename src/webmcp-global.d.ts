/// <reference types="vite/client" />

interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute(input?: unknown): Promise<unknown> | unknown;
}

interface ModelContextToolSummary { name: string }

interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<void> | void;
  getTools?(): Promise<ModelContextToolSummary[]>;
}

interface Document { modelContext?: ModelContext }
