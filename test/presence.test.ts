import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { PresenceServer, type PresenceAccess } from "../src/presence.ts";

type Snapshot = { type: "presence"; participants: { id: string; name: string; kind: "human" | "agent"; activeBlockId?: string }[] };
type Peer = { ws: WebSocket; messages: Snapshot[]; cursor: number };

let server: Server;
let presence: PresenceServer;
let wsBase: string;
const access = (id: string, name: string, writable = true): PresenceAccess => ({ participant: { id, name, kind: "human" }, writable, blockIds: ["scope"] });

test.before(async () => {
  server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  presence = new PresenceServer({ ticketTtlMs: 35, heartbeatMs: 100, maxMessageBytes: 128, maxMessagesPerWindow: 10 });
  presence.attach(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/presence`;
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test("tickets expire and are consumed exactly once", async () => {
  const expired = presence.issueTicket("expired-party", access("expired", "Expired")).ticket;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await rejected(expired), 401);

  const ticket = presence.issueTicket("once-party", access("once", "Once")).ticket;
  const peer = await connect(ticket);
  assert.deepEqual((await next(peer)).participants.map(person => person.id), ["once"]);
  assert.equal(await rejected(ticket), 401);
  await close(peer);
});

test("party rooms isolate snapshots, broadcast active blocks, and clean joins and leaves", async () => {
  const alpha = await connect(presence.issueTicket("alpha-party", access("alpha", "Alpha")).ticket);
  const beta = await connect(presence.issueTicket("beta-party", access("beta", "Beta")).ticket);
  assert.deepEqual((await next(alpha)).participants.map(person => person.id), ["alpha"]);
  assert.deepEqual((await next(beta)).participants.map(person => person.id), ["beta"]);

  const alphaTwo = await connect(presence.issueTicket("alpha-party", access("alpha-two", "Alpha Two")).ticket);
  assert.deepEqual((await next(alpha, value => value.participants.length === 2)).participants.map(person => person.id), ["alpha", "alpha-two"]);
  assert.deepEqual((await next(alphaTwo, value => value.participants.length === 2)).participants.map(person => person.id), ["alpha", "alpha-two"]);
  alpha.ws.send(JSON.stringify({ type: "active-block", blockId: "scope" }));
  const active = await next(alphaTwo, value => value.participants.some(person => person.activeBlockId === "scope"));
  assert.equal(active.participants.find(person => person.id === "alpha")?.activeBlockId, "scope");

  await close(alphaTwo);
  assert.deepEqual((await next(alpha, value => value.participants.length === 1)).participants.map(person => person.id), ["alpha"]);
  assert.equal(beta.messages.flatMap(value => value.participants).some(person => person.id.startsWith("alpha")), false);
  await Promise.all([close(alpha), close(beta)]);
});

test("invalid, oversized, rate-excessive, and finalized-room messages are rejected", async () => {
  const invalid = await connect(presence.issueTicket("invalid-party", access("invalid", "Invalid")).ticket);
  await next(invalid);
  invalid.ws.send(JSON.stringify({ type: "cursor", x: 1 }));
  assert.equal(await closed(invalid.ws), 1008);

  const oversized = await connect(presence.issueTicket("oversized-party", access("oversized", "Oversized")).ticket);
  await next(oversized);
  oversized.ws.send(JSON.stringify({ type: "active-block", blockId: "x".repeat(200) }));
  assert.equal(await closed(oversized.ws), 1009);

  const rate = await connect(presence.issueTicket("rate-party", access("rate", "Rate")).ticket);
  await next(rate);
  for (let index = 0; index < 11; index++) rate.ws.send(JSON.stringify({ type: "active-block", blockId: index % 2 ? "scope" : null }));
  assert.equal(await closed(rate.ws), 1008);

  const finalParty = "final-party";
  const waitingTicket = presence.issueTicket(finalParty, access("waiting", "Waiting")).ticket;
  const finalized = await connect(presence.issueTicket(finalParty, access("viewer", "Viewer")).ticket);
  await next(finalized);
  finalized.ws.send(JSON.stringify({ type: "active-block", blockId: "scope" }));
  assert.equal((await next(finalized, value => value.participants.some(person => person.activeBlockId === "scope"))).participants[0]?.activeBlockId, "scope");
  presence.finalizeParty(finalParty);
  assert.equal((await next(finalized, value => value.participants.every(person => !person.activeBlockId))).participants[0]?.activeBlockId, undefined);
  finalized.ws.send(JSON.stringify({ type: "active-block", blockId: "scope" }));
  assert.equal(await closed(finalized.ws), 1008);
  const waiting = await connect(waitingTicket);
  await next(waiting);
  waiting.ws.send(JSON.stringify({ type: "active-block", blockId: "scope" }));
  assert.equal(await closed(waiting.ws), 1008);
});

test("WebSocket URLs and payloads contain only disposable presence data", async () => {
  const capability = "party-capability-must-not-leak";
  const participantToken = "participant-session-must-not-leak";
  const ticket = presence.issueTicket("credentials-party", access("safe", "Safe Viewer")).ticket;
  const peer = await connect(ticket);
  const snapshot = await next(peer);
  assert.equal(new URL(peer.ws.url).searchParams.size, 1);
  assert.equal(new URL(peer.ws.url).searchParams.get("ticket"), ticket);
  assert.doesNotMatch(peer.ws.url, new RegExp(`${capability}|${participantToken}`));
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(`${capability}|${participantToken}|ticket`));
  await close(peer);
});

async function connect(ticket: string): Promise<Peer> {
  const ws = new WebSocket(`${wsBase}?ticket=${encodeURIComponent(ticket)}`);
  const peer: Peer = { ws, messages: [], cursor: 0 };
  ws.on("message", data => peer.messages.push(JSON.parse(data.toString()) as Snapshot));
  await bounded<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return peer;
}

async function rejected(ticket: string) {
  const ws = new WebSocket(`${wsBase}?ticket=${encodeURIComponent(ticket)}`);
  return bounded<number>((resolve, reject) => {
    ws.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    ws.once("open", () => { ws.close(); reject(new Error("ticket unexpectedly accepted")); });
    ws.once("error", () => undefined);
  });
}

async function next(peer: Peer, predicate: (value: Snapshot) => boolean = () => true) {
  const found = peer.messages.slice(peer.cursor).findIndex(predicate);
  if (found >= 0) { peer.cursor += found + 1; return peer.messages[peer.cursor - 1]!; }
  return bounded<Snapshot>((resolve, reject) => {
    const listener = (data: WebSocket.RawData) => {
      const value = JSON.parse(data.toString()) as Snapshot;
      if (!predicate(value)) return;
      peer.cursor = peer.messages.indexOf(value) + 1;
      peer.ws.off("message", listener);
      resolve(value);
    };
    peer.ws.on("message", listener);
    peer.ws.once("error", reject);
  });
}

async function close(peer: Peer) {
  if (peer.ws.readyState === WebSocket.CLOSED) return;
  const done = closed(peer.ws);
  peer.ws.close(1000);
  await done;
}

function closed(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(1000);
  return bounded<number>((resolve, reject) => { ws.once("close", resolve); ws.once("error", reject); });
}

function bounded<T>(listen: (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("presence test timed out")), 2_000);
    timer.unref();
    listen(value => { clearTimeout(timer); resolve(value); }, reason => { clearTimeout(timer); reject(reason); });
  });
}
