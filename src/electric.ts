import { Shape, ShapeStream, type Row } from "@electric-sql/client";
import { useEffect } from "react";

export const partyShapeNames = ["party", "artifact", "feedback", "revisions", "participants", "audit", "final"] as const;
export type PartyShapeName = typeof partyShapeNames[number];

export function createPartyShape<T extends Row>(partyId: string, capability: string, name: PartyShapeName, signal?: AbortSignal) {
  return new Shape(new ShapeStream<T>({
    url: new URL(`/api/parties/${encodeURIComponent(partyId)}/shapes/${name}`, location.origin).toString(),
    headers: { Authorization: `Bearer ${capability}` },
    signal,
  }));
}

export function usePartySubscription(partyId: string | undefined, capability: string | undefined, onChange: () => void) {
  useEffect(() => {
    if (!partyId || !capability) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => { clearTimeout(timer); timer = setTimeout(onChange, 75); };
    const unsubscribe = createPartyShape(partyId, capability, "audit", controller.signal).subscribe(invalidate);
    return () => { clearTimeout(timer); unsubscribe(); controller.abort(); };
  }, [partyId, capability, onChange]);
}
