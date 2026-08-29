import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Actor } from "./domain.ts";

export type PresenceAccess = { participant: Actor; writable: boolean; blockIds: string[] };
type Ticket = PresenceAccess & { partyId: string; expiresAt: number };
type Client = WebSocket & { alive: boolean; messages: number; rateWindow: number; room: Room; member: Member };
type Member = { participant: Actor; sockets: Set<Client>; activeBlockId?: string };
type Room = Map<string, Member>;

export type PresenceOptions = {
  ticketTtlMs?: number;
  heartbeatMs?: number;
  maxMessageBytes?: number;
  maxMessagesPerWindow?: number;
  rateWindowMs?: number;
  now?: () => number;
};

export class PresenceServer {
  private readonly tickets = new Map<string, Ticket>();
  private readonly rooms = new Map<string, Room>();
  private readonly finalized = new Set<string>();
  private readonly sockets: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;

  constructor(private options: PresenceOptions = {}) {
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: options.maxMessageBytes ?? 512 });
  }

  attach(server: Server) {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/api/presence") return rejectUpgrade(socket, 404);
      const values = [...url.searchParams];
      if (values.length !== 1 || values[0]?.[0] !== "ticket") return rejectUpgrade(socket, 401);
      const access = this.consumeTicket(values[0][1]);
      if (!access) return rejectUpgrade(socket, 401);
      this.sockets.handleUpgrade(request, socket, head, ws => this.join(ws, access));
    });
    const interval = this.options.heartbeatMs ?? 30_000;
    this.heartbeat = setInterval(() => this.ping(), interval);
    this.heartbeat.unref();
    server.on("close", () => {
      clearInterval(this.heartbeat);
      for (const socket of this.sockets.clients) socket.terminate();
      this.sockets.close();
    });
  }

  issueTicket(partyId: string, access: PresenceAccess) {
    const now = (this.options.now ?? Date.now)();
    this.clearExpiredTickets(now);
    const value = randomBytes(32).toString("base64url");
    const expiresAt = now + (this.options.ticketTtlMs ?? 10_000);
    this.tickets.set(value, { partyId, ...access, writable: access.writable && !this.finalized.has(partyId), expiresAt });
    return { ticket: value, expiresAt };
  }

  finalizeParty(partyId: string) {
    this.finalized.add(partyId);
    for (const ticket of this.tickets.values()) if (ticket.partyId === partyId) ticket.writable = false;
    const room = this.rooms.get(partyId);
    if (!room) return;
    for (const member of room.values()) member.activeBlockId = undefined;
    this.broadcast(room);
  }

  consumeTicket(value: string): Ticket | undefined {
    const ticket = this.tickets.get(value);
    this.tickets.delete(value);
    return ticket && ticket.expiresAt > (this.options.now ?? Date.now)() ? ticket : undefined;
  }

  private join(socket: WebSocket, ticket: Ticket) {
    const room = this.rooms.get(ticket.partyId) ?? new Map<string, Member>();
    this.rooms.set(ticket.partyId, room);
    const member = room.get(ticket.participant.id) ?? { participant: ticket.participant, sockets: new Set<Client>() };
    room.set(ticket.participant.id, member);
    const client = socket as Client;
    Object.assign(client, { alive: true, messages: 0, rateWindow: (this.options.now ?? Date.now)(), room, member });
    member.sockets.add(client);
    client.on("pong", () => { client.alive = true; });
    client.on("message", (data, binary) => this.message(client, ticket, data, binary));
    client.on("close", () => this.leave(ticket.partyId, client));
    client.on("error", () => undefined);
    this.broadcast(room);
  }

  private message(client: Client, ticket: Ticket, data: RawData, binary: boolean) {
    const size = Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : data.byteLength;
    if (binary) return client.close(1003, "text messages only");
    if (size > (this.options.maxMessageBytes ?? 512)) return client.close(1009, "message too large");
    const now = (this.options.now ?? Date.now)();
    if (now - client.rateWindow >= (this.options.rateWindowMs ?? 10_000)) { client.rateWindow = now; client.messages = 0; }
    if (++client.messages > (this.options.maxMessagesPerWindow ?? 20)) return client.close(1008, "message rate exceeded");
    let value: unknown;
    try { value = JSON.parse(data.toString()); } catch { return client.close(1008, "invalid message"); }
    if (!ticket.writable || this.finalized.has(ticket.partyId) || !activeBlockMessage(value, ticket.blockIds)) return client.close(1008, "invalid message");
    client.member.activeBlockId = value.blockId ?? undefined;
    this.broadcast(client.room);
  }

  private leave(partyId: string, client: Client) {
    client.member.sockets.delete(client);
    if (client.member.sockets.size === 0) client.room.delete(client.member.participant.id);
    if (client.room.size === 0) this.rooms.delete(partyId);
    else this.broadcast(client.room);
  }

  private broadcast(room: Room) {
    const participants = [...room.values()].map(member => ({
      ...member.participant,
      ...(member.activeBlockId ? { activeBlockId: member.activeBlockId } : {}),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const message = JSON.stringify({ type: "presence", participants });
    for (const member of room.values()) for (const socket of member.sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }

  private ping() {
    this.clearExpiredTickets((this.options.now ?? Date.now)());
    for (const socket of this.sockets.clients as Set<Client>) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false;
      socket.ping();
    }
  }

  private clearExpiredTickets(now: number) {
    for (const [value, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(value);
  }
}

function activeBlockMessage(value: unknown, blockIds: string[]): value is { type: "active-block"; blockId: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 2 && message.type === "active-block" &&
    (message.blockId === null || (typeof message.blockId === "string" && blockIds.includes(message.blockId)));
}

function rejectUpgrade(socket: Duplex, status: 401 | 404) {
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
