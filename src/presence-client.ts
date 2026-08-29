import { useCallback, useEffect, useRef, useState } from "react";
import type { Actor } from "./domain.ts";

export type PresentParticipant = Actor & { activeBlockId?: string };
type Snapshot = { type: "presence"; participants: PresentParticipant[] };

export function usePartyPresence(partyId: string, capability: string | undefined, participantToken: string | undefined, writable: boolean) {
  const [participants, setParticipants] = useState<PresentParticipant[]>([]);
  const [connected, setConnected] = useState(false);
  const socket = useRef<WebSocket | undefined>(undefined);
  const activeBlock = useRef<string | null>(null);

  useEffect(() => {
    activeBlock.current = null;
    if (!capability || !participantToken) { setParticipants([]); setConnected(false); return; }
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 250;
    const connect = async () => {
      try {
        const response = await fetch(`/api/parties/${encodeURIComponent(partyId)}/presence-ticket`, {
          method: "POST",
          headers: { Authorization: `Bearer ${capability}`, "X-Participant-Token": participantToken },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("presence ticket rejected");
        const { ticket } = await response.json() as { ticket: string };
        if (controller.signal.aborted) return;
        const url = new URL("/api/presence", location.origin);
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket);
        const ws = new WebSocket(url);
        socket.current = ws;
        ws.onopen = () => {
          if (socket.current !== ws) return;
          setConnected(true); delay = 250;
          if (writable && activeBlock.current) ws.send(JSON.stringify({ type: "active-block", blockId: activeBlock.current }));
        };
        ws.onmessage = event => {
          if (socket.current !== ws) return;
          try { const value: unknown = JSON.parse(String(event.data)); if (snapshot(value)) setParticipants(value.participants); } catch { /* ignore malformed server data */ }
        };
        ws.onclose = () => {
          if (socket.current !== ws) return;
          setConnected(false); setParticipants([]);
          if (!controller.signal.aborted) { retry = setTimeout(() => void connect(), delay); delay = Math.min(delay * 2, 5_000); }
        };
      } catch {
        if (!controller.signal.aborted) { retry = setTimeout(() => void connect(), delay); delay = Math.min(delay * 2, 5_000); }
      }
    };
    void connect();
    return () => { controller.abort(); clearTimeout(retry); const current = socket.current; socket.current = undefined; current?.close(); setConnected(false); setParticipants([]); };
  }, [partyId, capability, participantToken, writable]);

  const setActiveBlock = useCallback((blockId: string | null) => {
    activeBlock.current = blockId;
    if (writable && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "active-block", blockId }));
  }, [writable]);

  return { connected, participants, setActiveBlock };
}

function snapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object" || (value as Snapshot).type !== "presence" || !Array.isArray((value as Snapshot).participants)) return false;
  return (value as Snapshot).participants.every(participant => participant && typeof participant.id === "string" && typeof participant.name === "string" && (participant.kind === "human" || participant.kind === "agent"));
}
