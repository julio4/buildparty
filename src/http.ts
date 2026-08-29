import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { ELECTRIC_PROTOCOL_QUERY_PARAMS } from "@electric-sql/client";
import { AppError, parseBearerAuthorization } from "./domain.ts";
import { PresenceServer, type PresenceOptions } from "./presence.ts";
import type { BuildPartyService } from "./service.ts";

export const shapes = {
  party: { table: "parties", columns: "id,title,lifecycle,created_at,finalized_at", where: "id = $1" },
  artifact: { table: "artifacts", columns: "party_id,format,title,blocks,runtime_state,version,updated_at", where: "party_id = $1" },
  feedback: { table: "feedback", columns: "id,party_id,block_id,kind,body,status,actor_identity_id,created_at,resolved_at,resolved_by_identity_id", where: "party_id = $1" },
  revisions: { table: "revisions", columns: "id,party_id,version,source,changed_block_ids,feedback_ids,summary,actor_identity_id,created_at,snapshot_available,snapshot_pruned,snapshot_bytes", where: "party_id = $1" },
  participants: { table: "participants", columns: "party_id,identity_id,display_name,kind,first_seen_at,last_seen_at", where: "party_id = $1" },
  audit: { table: "audit_events", columns: "id,party_id,event_type,actor_identity_id,details,created_at", where: "party_id = $1" },
  final: { table: "final_versions", columns: "id,party_id,name,source_version,actor_identity_id,open_feedback_overridden,created_at", where: "party_id = $1" },
} as const;
type ShapeName = keyof typeof shapes;
const electricProtocolParams = new Set<string>(ELECTRIC_PROTOCOL_QUERY_PARAMS);

type ServerOptions = { electricUrl: string; electricSecret?: string; fetch?: typeof fetch; presence?: PresenceOptions; staticDir?: string; ready?: () => Promise<void> };

export function createApiServer(service: BuildPartyService, options: ServerOptions) {
  const fetcher = options.fetch ?? fetch;
  const presence = new PresenceServer(options.presence);
  const server = createServer(async (req, res) => {
    try {
      const rawPath = (req.url ?? "/").split(/[?#]/, 1)[0] ?? "/";
      const url = new URL(req.url ?? "/", "http://localhost");
      const securityPath = decodeSecurityPath(rawPath);
      const isApiPath = securityPath === undefined || [securityPath, url.pathname].some(path => path === "/api" || path.startsWith("/api/"));
      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/api/ready" && options.ready) { await options.ready(); return json(res, 200, { ok: true }); }
      if (options.staticDir && !isApiPath && (req.method === "GET" || req.method === "HEAD")) return staticFile(req, res, url, options.staticDir);
      if (req.method === "POST" && url.pathname === "/api/init") { await body(req); return json(res, 200, service.init()); }
      if (req.method === "POST" && url.pathname === "/api/parties") return json(res, 201, await service.createParty(await body(req)));

      const match = url.pathname.match(/^\/api\/parties\/([0-9a-f-]+)(.*)$/i);
      if (!match) throw new AppError("NOT_FOUND", "endpoint not found", 404);
      const partyId = match[1]!;
      const tail = match[2]!;
      const capability = parseBearerAuthorization(req.headers.authorization);
      if (!capability) throw new AppError("FORBIDDEN", "bearer capability is required", 403);
      const participantToken = req.headers["x-participant-token"];
      if (req.method === "POST" && tail === "/presence-ticket") {
        const access = await service.authorizePresence(partyId, capability, participantToken);
        return json(res, 201, presence.issueTicket(partyId, access));
      }
      const shapeMatch = tail.match(/^\/shapes\/(party|artifact|feedback|revisions|participants|audit|final)$/);
      if (req.method === "GET" && shapeMatch) {
        await service.authorizeShape(partyId, capability);
        return proxyShape(req, res, url, partyId, shapeMatch[1] as ShapeName, options, fetcher);
      }
      if (req.method === "POST" && tail === "/participants") return json(res, 201, await service.joinParty(partyId, capability, await body(req)));
      if (req.method === "GET" && tail === "") return json(res, 200, await service.getParty(partyId, capability, participantToken));
      if (req.method === "PUT" && tail === "/artifact") return json(res, 200, await service.setArtifact(partyId, capability, participantToken, await body(req)));
      if (req.method === "PATCH" && tail === "/blocks") return json(res, 200, await service.updateBlocks(partyId, capability, participantToken, await body(req)));
      if (req.method === "DELETE" && tail === "/blocks") return json(res, 200, await service.deleteBlocks(partyId, capability, participantToken, await body(req)));
      const restoreMatch = tail.match(/^\/revisions\/([0-9a-f-]+)\/restore$/i);
      if (req.method === "POST" && restoreMatch) return json(res, 200, await service.restoreRevision(partyId, capability, participantToken, restoreMatch[1], await body(req)));
      if (req.method === "POST" && tail === "/feedback") return json(res, 201, await service.addFeedback(partyId, capability, participantToken, await body(req)));
      if (req.method === "GET" && tail === "/feedback") return json(res, 200, await service.getFeedback(partyId, capability, participantToken, url.searchParams.get("status") ?? "all"));
      const responseMatch = tail.match(/^\/feedback\/([0-9a-f-]+)\/respond$/i);
      if (req.method === "POST" && responseMatch) return json(res, 201, await service.respondToFeedback(partyId, capability, participantToken, responseMatch[1], await body(req)));
      if (req.method === "POST" && tail === "/finalize") {
        const result = await service.finalizeParty(partyId, capability, participantToken, await body(req));
        presence.finalizeParty(partyId);
        return json(res, 201, result);
      }
      if (req.method === "GET" && tail === "/final") return json(res, 200, await service.getFinalArtifact(partyId, capability, participantToken));
      if (req.method === "GET" && tail === "/final/export") {
        const final = await service.getFinalArtifact(partyId, capability, participantToken);
        return attachment(res, final.name, final.html);
      }
      if (req.method === "GET" && tail === "/events") return json(res, 200, await service.getAuditEvents(partyId, capability, participantToken));
      if (req.method === "GET" && tail === "/storage") return json(res, 200, await service.getStorage(partyId, capability, participantToken));
      throw new AppError("NOT_FOUND", "endpoint not found", 404);
    } catch (error) {
      if (error instanceof AppError) return json(res, error.status, { error: error.code, message: error.message });
      console.error(error);
      return json(res, 500, { error: "INTERNAL_ERROR", message: "unexpected server error" });
    }
  });
  presence.attach(server);
  return server;
}

function decodeSecurityPath(rawPath: string) {
  let path = rawPath;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) return path.replace(/\/{2,}/g, "/");
      path = decoded;
    }
  } catch { /* reject malformed paths from static fallback */ }
  return undefined;
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

async function staticFile(req: IncomingMessage, res: ServerResponse, url: URL, directory: string) {
  const root = resolve(directory);
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new AppError("NOT_FOUND", "asset not found", 404); }
  const candidate = resolve(root, `.${pathname}`);
  const safe = candidate === root || candidate.startsWith(`${root}${sep}`);
  const file = safe ? await stat(candidate).then(value => value.isFile() ? candidate : undefined).catch(() => undefined) : undefined;
  const selected = file ?? resolve(root, "index.html");
  const payload = await readFile(selected).catch(() => { throw new AppError("NOT_FOUND", "asset not found", 404); });
  const isIndex = selected === resolve(root, "index.html");
  res.writeHead(200, {
    "content-type": contentTypes[extname(selected)] ?? "application/octet-stream",
    "content-length": payload.length,
    "cache-control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
    "content-security-policy": "base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : payload);
}

async function proxyShape(req: IncomingMessage, res: ServerResponse, incoming: URL, partyId: string, shapeName: ShapeName, options: { electricUrl: string; electricSecret?: string }, fetcher: typeof fetch) {
  if (!options.electricSecret) throw new Error("ELECTRIC_SECRET is required for shape subscriptions");
  const shape = shapes[shapeName];
  const upstream = new URL("/v1/shape", options.electricUrl);
  for (const [key, value] of incoming.searchParams) if (electricProtocolParams.has(key)) upstream.searchParams.append(key, value);
  upstream.searchParams.set("table", shape.table);
  upstream.searchParams.set("columns", shape.columns);
  upstream.searchParams.set("where", shape.where);
  upstream.searchParams.set("params[1]", partyId);
  upstream.searchParams.set("secret", options.electricSecret);
  const response = await fetcher(upstream, { headers: { accept: req.headers.accept ?? "application/json" }, signal: AbortSignal.timeout(30_000) });
  const headers = Object.fromEntries(response.headers);
  delete headers["content-encoding"];
  delete headers["content-length"];
  headers["cache-control"] = "private, no-store";
  headers.vary = "Authorization";
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  Readable.fromWeb(response.body as never).pipe(res);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";", 1)[0] !== "application/json") throw new AppError("VALIDATION_ERROR", "content-type must be application/json", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new AppError("VALIDATION_ERROR", "request body is too large", 413);
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new AppError("VALIDATION_ERROR", "request body must be a JSON object", 400); }
}

function json(res: ServerResponse, status: number, value: unknown) {
  const payload = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

function attachment(res: ServerResponse, name: string, html: string) {
  const payload = Buffer.from(html, "utf8");
  const filename = `${name.replace(/[\\/]/g, "-") || "buildparty"}.html`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.length,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}
