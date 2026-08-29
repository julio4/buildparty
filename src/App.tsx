import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Actor, JsonObject, ParticipantProfile, RuntimeState, SandboxBlock, WebMcpOperation } from "./domain.ts";
import { api, responseError } from "./browser-api.ts";
import { createWebMcpExecutor, useNativeWebMcp } from "./webmcp-react.ts";
import { usePartySubscription } from "./electric.ts";
import { usePartyPresence, type PresentParticipant } from "./presence-client.ts";
import { SandboxFrame } from "./SandboxFrame.tsx";
import { approximateRowDataLabel, deleteBlockConfirmation, nextReviewState, resolvePartyCapability, restoreRevisionConfirmation, reviewFeedback, RuntimeStateWriter, type ReviewState } from "./workspace.ts";
import "./app.css";

type Participant = { id: string; name: string; kind: Actor["kind"] };
type Revision = { id: string; version: number; source: string; changed_block_ids: string[]; summary: string | null; actor_identity_id: string; created_at: string; snapshot_available: boolean; snapshot_pruned: boolean; snapshot_bytes: number | null };
type StorageUsage = { accountedRowBytes: number; scope: "party_row_data_only"; quotaBytes: null };
type PartyView = {
  party: { id: string; title: string; lifecycle: "initialized" | "in_review" | "revising" | "finalized"; createdAt: string; finalizedAt: string | null };
  artifact: null | { format: "buildparty.artifact/v1"; title: string; blocks: SandboxBlock[] };
  runtimeState: RuntimeState | null;
  version: number | null;
  openFeedback: number;
  participants: Participant[];
  revisions: Revision[];
  access: "owner" | "share";
  availableOperations: WebMcpOperation[];
  availableApiOperations: WebMcpOperation[];
  humanOperations: string[];
};
type Feedback = { id: string; block_id: string; anchorStatus: "active" | "archived"; kind: string; body: string; status: "open" | "resolved"; actor_identity_id: string; created_at: string; responses: { id: string; body: string | null; resolved: boolean; actor_identity_id: string; created_at: string }[] };
type AuditEvent = { id: number; event_type: string; actor_identity_id: string; created_at: string };
type Workspace = { view: PartyView; feedback: Feedback[]; events: AuditEvent[]; storage?: StorageUsage };
type ParticipantSession = { participant: Participant; participantToken: string };
type CreatedParty = ParticipantSession & { party: { id: string }; ownerUrl: string; shareUrl: string; ownerCapability: string; shareCapability: string };
type WebMcpExecute = (name: WebMcpOperation, input?: unknown) => Promise<unknown>;
type SetWebMcp = (execute: WebMcpExecute) => void;

export default function App() {
  const [path, setPath] = useState(location.pathname);
  const currentExecutor = useRef<WebMcpExecute | undefined>(undefined);
  const activateParty = useCallback(({ partyId, capability }: { partyId: string; capability: string }) => {
    currentExecutor.current = createWebMcpExecutor({ partyId, capability, localStorage, sessionStorage, navigate: navigateSpa });
  }, []);
  const landingExecutor = useMemo(() => createWebMcpExecutor({ localStorage, sessionStorage, navigate: navigateSpa, onPartyCreated: activateParty }), [activateParty]);
  currentExecutor.current ??= landingExecutor;
  const execute = useCallback<WebMcpExecute>((name, input) => currentExecutor.current!(name, input), []);
  const setWebMcp = useCallback<SetWebMcp>(next => { currentExecutor.current = next; }, []);
  useNativeWebMcp(execute);
  useEffect(() => { const update = () => setPath(location.pathname); addEventListener("popstate", update); return () => removeEventListener("popstate", update); }, []);
  const match = path.match(/^\/party\/([0-9a-f-]+)$/i);
  return match ? <PartyPage partyId={match[1]!} setWebMcp={setWebMcp} /> : <Landing setWebMcp={setWebMcp} webMcp={landingExecutor} />;
}

function Landing({ setWebMcp, webMcp }: { setWebMcp: SetWebMcp; webMcp: WebMcpExecute }) {
  const [identity, setIdentity] = useState(loadIdentity);
  const [title, setTitle] = useState("");
  const [created, setCreated] = useState<CreatedParty>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => setWebMcp(webMcp), [setWebMcp, webMcp]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); saveIdentity(identity);
    try {
      const value = await api<CreatedParty>("/api/parties", { method: "POST", body: JSON.stringify({ title, participant: identity }) });
      sessionStorage.setItem(`buildparty.capability.${value.party.id}`, value.ownerCapability);
      sessionStorage.setItem(`buildparty.share.${value.party.id}`, value.shareCapability);
      saveParticipantSession(value.party.id, value);
      setCreated(value);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  return <main className="landing">
    <nav className="brand" aria-label="BuildParty"><span className="brand-mark">BP</span><strong>BuildParty</strong></nav>
    <div className="hero-grid">
      <section className="hero-copy"><h1>Build together.</h1><p>One shared canvas where agents publish interactive work and people respond directly to what they can see.</p></section>
      <section className="create-card" aria-labelledby="create-heading">
        {!created ? <><span className="step">Start a workspace</span><h2 id="create-heading">Create a party</h2><p className="muted">You’ll receive separate owner and reviewer links.</p>
          <form onSubmit={create}>
            <label>Your display name<input required maxLength={80} value={identity.name} onChange={e => setIdentity({ ...identity, name: e.target.value })} autoComplete="name" /></label>
            <label>Workspace title<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} placeholder="Q4 launch review" autoFocus /></label>
            {error && <p className="alert error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create workspace"}</button>
          </form></> : <CreatedLinks created={created} />}
      </section>
    </div>
  </main>;
}

function CreatedLinks({ created }: { created: CreatedParty }) {
  const [copied, setCopied] = useState("");
  const copy = async (label: string, value: string) => { await navigator.clipboard.writeText(value); setCopied(label); };
  return <div className="success-panel"><span className="success-icon">✓</span><h2>Party created</h2><p className="muted">Keep the owner link private. Send the reviewer link to collaborators.</p>
    <button className="primary" onClick={() => location.assign(created.ownerUrl)}>Open owner workspace</button>
    <button onClick={() => void copy("reviewer", created.shareUrl)}>{copied === "reviewer" ? "Reviewer link copied" : "Copy reviewer link"}</button>
    <button className="quiet" onClick={() => void copy("owner", created.ownerUrl)}>{copied === "owner" ? "Owner link copied" : "Copy owner link"}</button>
  </div>;
}

function PartyPage({ partyId, setWebMcp }: { partyId: string; setWebMcp: SetWebMcp }) {
  const capabilityResult = useMemo(() => resolvePartyCapability(location.href, partyId, sessionStorage), [partyId]);
  const capability = capabilityResult.capability;
  if (capabilityResult.cleanUrl !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, "", capabilityResult.cleanUrl);
  const [identity, setIdentity] = useState(loadIdentity);
  const [session, setSession] = useState<ParticipantSession | undefined>(() => loadParticipantSession(partyId));
  const [workspace, setWorkspace] = useState<Workspace>();
  const [loading, setLoading] = useState(Boolean(capability && session));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<ReviewState>({ open: false });
  const reviewReturnFocus = useRef<HTMLElement | null>(null);
  const participantHeaders = useMemo((): Record<string, string> => session ? { "X-Participant-Token": session.participantToken } : {}, [session]);

  const loadWorkspace = useCallback(async () => {
    if (!capability || !session) return;
    try {
      const headers = { Authorization: `Bearer ${capability}`, ...participantHeaders };
      const view = await api<PartyView>(`/api/parties/${partyId}`, { headers });
      let feedback: Feedback[] = [], events: AuditEvent[] = [], storage: StorageUsage | undefined;
      if (view.party.lifecycle !== "finalized") [feedback, events, storage] = await Promise.all([
        api<Feedback[]>(`/api/parties/${partyId}/feedback`, { headers }),
        api<AuditEvent[]>(`/api/parties/${partyId}/events`, { headers }),
        api<StorageUsage>(`/api/parties/${partyId}/storage`, { headers }),
      ]);
      setWorkspace({ view, feedback, events, storage }); setError("");
    } catch (reason) { setError(message(reason)); }
    finally { setLoading(false); }
  }, [partyId, capability, session, participantHeaders]);

  const writer = useMemo(() => new RuntimeStateWriter(
    async (statePatch, expectedVersion) => api(`/api/parties/${partyId}/blocks`, {
      method: "PATCH", headers: { Authorization: `Bearer ${capability}`, "X-Participant-Token": session?.participantToken ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, statePatch }),
    }),
    async () => {
      const view = await api<PartyView>(`/api/parties/${partyId}`, { headers: { Authorization: `Bearer ${capability}`, ...participantHeaders } });
      return { version: view.version!, runtimeState: view.runtimeState! };
    },
    (runtimeState, version) => setWorkspace(current => current ? { ...current, view: { ...current.view, runtimeState, version: version ?? current.view.version } } : current),
    reason => setError(`${message(reason)} Your unsaved change is kept; interact again to retry.`),
  ), [partyId, capability, session, participantHeaders]);

  const webMcp = useMemo(() => createWebMcpExecutor({ partyId, capability, localStorage, sessionStorage, onMutation: loadWorkspace, navigate: navigateSpa }), [partyId, capability, loadWorkspace]);
  useLayoutEffect(() => setWebMcp(webMcp), [setWebMcp, webMcp]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => { if (capability) void webMcp("get_party").catch(() => { /* init exposes the agent session bootstrap */ }); }, [capability, webMcp]);
  useEffect(() => { if (workspace?.view.runtimeState) writer.setRemote(workspace.view.runtimeState, workspace.view.version); }, [writer, workspace?.view.runtimeState, workspace?.view.version]);
  const mutableCapability = workspace?.view.party.lifecycle !== "finalized" && workspace ? capability : undefined;
  usePartySubscription(partyId, session ? mutableCapability : undefined, loadWorkspace);
  const presence = usePartyPresence(partyId, session ? mutableCapability : undefined, session?.participantToken, Boolean(mutableCapability));
  useEffect(() => { if (workspace?.view.party.lifecycle === "finalized") setReview({ open: false }); }, [workspace?.view.party.lifecycle]);

  const updateState = (blockId: string, state: JsonObject) => {
    if (workspace?.view.party.lifecycle === "finalized") setWorkspace(current => current ? { ...current, view: { ...current.view, runtimeState: { ...current.view.runtimeState, [blockId]: state } } } : current);
    else writer.update(blockId, state);
  };

  if (!capability) return <CenteredState title="Invitation required" detail="Open the complete owner or reviewer invitation link. This page does not have its capability key." action="Back to BuildParty" />;
  if (!session) return <JoinParty partyId={partyId} capability={capability} identity={identity} onIdentity={setIdentity} onJoined={created => { saveParticipantSession(partyId, created); setSession(created); setLoading(true); }} />;
  if (loading) return <LoadingState />;
  if (!workspace) return <SessionError detail={error || "The link may be incomplete or no longer valid."} onRetry={() => { sessionStorage.removeItem(participantSessionKey(partyId)); setSession(undefined); setError(""); }} />;

  const { view, feedback, events, storage } = workspace;
  const people = new Map(view.participants.map(person => [person.id, person.name]));
  const blocks = view.artifact?.blocks ?? [];
  const blockIds = blocks.map(block => block.id);
  if (view.party.lifecycle === "finalized") return <FinalizedWorkspace view={view} partyId={partyId} capability={capability} participantToken={session.participantToken} onState={updateState} />;
  const shareCapability = sessionStorage.getItem(`buildparty.share.${partyId}`);
  const linkCapability = view.access === "owner" && shareCapability ? shareCapability : capability;
  const headers = { Authorization: `Bearer ${capability}`, "X-Participant-Token": session.participantToken };
  const copyLink = async () => {
    await navigator.clipboard.writeText(`${location.origin}/party/${partyId}#cap=${encodeURIComponent(linkCapability)}`);
    setNotice(view.access === "owner" && shareCapability ? "Reviewer link copied" : "Access link copied");
  };
  const openReview = (blockId?: string) => {
    reviewReturnFocus.current = document.activeElement as HTMLElement | null;
    setReview(current => nextReviewState(blockIds, current, { type: "open", blockId: blockId ?? feedback.find(item => item.status === "open" && blockIds.includes(item.block_id))?.block_id }));
  };
  const closeReview = () => {
    setReview(current => nextReviewState(blockIds, current, { type: "close" }));
    requestAnimationFrame(() => reviewReturnFocus.current?.focus());
  };
  const deleteBlock = async (block: SandboxBlock) => {
    if (!confirm(deleteBlockConfirmation(block.title ?? block.id))) return;
    setError("");
    try {
      await writer.flush();
      await api(`/api/parties/${partyId}/blocks`, { method: "DELETE", headers, body: JSON.stringify({ blockIds: [block.id], expectedVersion: writer.currentVersion() ?? view.version, summary: `Delete ${block.title ?? block.id}` }) });
      setReview(current => nextReviewState(blockIds.filter(id => id !== block.id), current, { type: "select" }));
      setNotice(`${block.title ?? block.id} deleted; its feedback is archived.`); await loadWorkspace();
    } catch (reason) { setError(message(reason)); }
  };
  const restoreRevision = async (revision: Revision) => {
    if (!confirm(restoreRevisionConfirmation(revision.version))) return;
    setError("");
    try {
      await writer.flush();
      await api(`/api/parties/${partyId}/revisions/${revision.id}/restore`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: writer.currentVersion() ?? view.version, summary: `Restore revision v${revision.version}` }) });
      setNotice(`Revision v${revision.version} restored as a new revision.`); await loadWorkspace();
    } catch (reason) { setError(message(reason)); }
  };
  return <div className="app-shell">
    <header className="floating-topbar"><a className="brand compact" href="/"><span className="brand-mark">BP</span><strong>BuildParty</strong></a><span className="party-name">{view.artifact?.title ?? view.party.title}</span><span className="lifecycle-chip">{view.party.lifecycle.replace("_", " ")}</span><div className="top-actions">
      <PresenceBadges participants={presence.participants} connected={presence.connected} />
      <span className="identity-name">{session.participant.name}</span>
      <button className="share-button" aria-label={`Copy ${view.access === "owner" && shareCapability ? "reviewer" : "access"} link`} onClick={() => void copyLink()}>Share</button>
      <button className="review-button" onClick={() => openReview()}><span>{view.openFeedback}</span> Review</button>
    </div></header>
    {(error || notice) && <p className={`workspace-alert alert ${error ? "error" : "notice"}`} role={error ? "alert" : "status"}>{error || notice}</p>}
    <main className="artifact-canvas" aria-label={view.artifact?.title ?? view.party.title}>
      <h1 className="sr-only">{view.artifact?.title ?? view.party.title}</h1>
      {view.artifact ? blocks.length ? blocks.map(block => <ArtifactRegion key={block.id} block={block} state={view.runtimeState?.[block.id] ?? {}} feedback={feedback.filter(item => item.block_id === block.id)} active={review.blockId === block.id || presence.participants.some(person => person.activeBlockId === block.id && person.id !== session.participant.id)} canReview={view.humanOperations.includes("add_feedback") || feedback.some(item => item.block_id === block.id)} onActive={presence.setActiveBlock} onState={state => updateState(block.id, state)} onReview={() => openReview(block.id)} />) : <EmptyArtifact deliberate/> : <EmptyArtifact />}
    </main>
    {review.open && <ReviewPanel blocks={blocks} selectedBlockId={review.blockId} feedback={feedback} people={people} events={events} view={view} storage={storage} canComment={view.humanOperations.includes("add_feedback")} canDelete={view.availableApiOperations.includes("delete_blocks")} canRestore={view.availableApiOperations.includes("restore_revision")} onSelect={blockId => { setReview(current => nextReviewState(blockIds, current, { type: "select", blockId })); presence.setActiveBlock(blockId); }} onComment={async (blockId, body) => { await addComment(partyId, capability, session.participantToken, blockId, body); await loadWorkspace(); }} onDelete={deleteBlock} onRestore={restoreRevision} onClose={closeReview} finalize={view.access === "owner" && view.artifact ? <FinalizePanel view={view} partyId={partyId} capability={capability} participantToken={session.participantToken} beforeFinalize={async () => { await writer.flush(); return writer.currentVersion() ?? view.version; }} onDone={loadWorkspace} /> : undefined} />}
  </div>;
}

function FinalizedWorkspace({ view, partyId, capability, participantToken, onState }: { view: PartyView; partyId: string; capability: string; participantToken: string; onState: (blockId: string, state: JsonObject) => void }) {
  const title = view.artifact?.title ?? view.party.title;
  const blocks = view.artifact?.blocks ?? [];
  return <div className="app-shell finalized-workspace"><header className="final-title-pill"><span className="brand-mark">BP</span><strong>{title}</strong></header><div className="final-download"><ExportButton partyId={partyId} capability={capability} participantToken={participantToken} title={title}/></div><main className="artifact-canvas" aria-label={title}><h1 className="sr-only">{title}</h1>{blocks.length ? blocks.map(block => <section className="artifact-region" key={block.id}><SandboxFrame block={block} state={view.runtimeState?.[block.id] ?? {}} onChange={state => onState(block.id, state)}/></section>) : <section className="empty-artifact"><div className="empty-glyph">◇</div><h2>Final artifact has no blocks</h2><p>This deliberate empty canvas is the immutable final snapshot.</p></section>}</main></div>;
}

function ArtifactRegion({ block, state, feedback, active, canReview, onActive, onState, onReview }: { block: SandboxBlock; state: JsonObject; feedback: Feedback[]; active: boolean; canReview: boolean; onActive: (blockId: string | null) => void; onState: (state: JsonObject) => void; onReview: () => void }) {
  const open = feedback.filter(item => item.status === "open").length;
  const resolved = feedback.length - open;
  return <section className={`artifact-region${active ? " active" : ""}`} id={block.id} aria-labelledby={`${block.id}-title`} onPointerEnter={() => onActive(block.id)} onPointerLeave={() => onActive(null)} onFocus={() => onActive(block.id)}><h2 className="sr-only" id={`${block.id}-title`}>{block.title ?? block.id}</h2><SandboxFrame block={block} state={state} onChange={onState} />{canReview && <button className={`feedback-pin${open ? " has-open" : ""}`} onClick={onReview} aria-label={`Review ${block.title ?? block.id}: ${open} open, ${resolved} resolved`}><span>{open || resolved || "+"}</span><small>{open ? "open" : resolved ? "resolved" : "comment"}</small></button>}</section>;
}

function ReviewPanel({ blocks, selectedBlockId, feedback, people, events, view, storage, canComment, canDelete, canRestore, onSelect, onComment, onDelete, onRestore, onClose, finalize }: { blocks: SandboxBlock[]; selectedBlockId?: string; feedback: Feedback[]; people: Map<string, string>; events: AuditEvent[]; view: PartyView; storage?: StorageUsage; canComment: boolean; canDelete: boolean; canRestore: boolean; onSelect: (blockId: string) => void; onComment: (blockId: string, body: string) => Promise<void>; onDelete: (block: SandboxBlock) => Promise<void>; onRestore: (revision: Revision) => Promise<void>; onClose: () => void; finalize?: ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;
  useEffect(() => {
    close.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closeAction.current(); };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, []);
  const selected = blocks.find(block => block.id === selectedBlockId) ?? blocks[0];
  const grouped = reviewFeedback(blocks.map(block => block.id), feedback);
  const threads = selected ? grouped.active.filter(item => item.block_id === selected.id) : [];
  const open = threads.filter(item => item.status === "open").length;
  return <aside className="review-panel" aria-labelledby="review-title">
    <header><div><span className="eyebrow">Review workspace</span><h2 id="review-title">{selected?.title ?? "Artifact review"}</h2></div><button ref={close} className="panel-close" aria-label="Close review" onClick={onClose}>×</button></header>
    {blocks.length > 0 ? <label className="block-picker">Block<select value={selected?.id} onChange={event => onSelect(event.target.value)}>{blocks.map(block => <option key={block.id} value={block.id}>{block.title ?? block.id}</option>)}</select></label> : <p className="zero-block-note">{view.artifact ? `This revision has zero blocks. ${canRestore ? "Revision restore remains available below." : "No revision snapshot is available to restore."}` : "No artifact has been published yet."}</p>}
    <div className="review-stats"><span><b>{open}</b> open</span><span><b>{threads.length - open}</b> resolved</span><span><b>v{view.version ?? 0}</b> revision</span></div>
    {storage && <p className="storage-usage">{approximateRowDataLabel(storage.accountedRowBytes)}</p>}
    {selected && canDelete && <button className="destructive block-delete" onClick={() => void onDelete(selected)}>Delete {selected.title ?? selected.id}</button>}
    <section className="review-section" aria-labelledby="threads-title"><h3 id="threads-title">Feedback</h3>{threads.length ? <div className="panel-threads">{threads.map(item => <FeedbackThread key={item.id} item={item} people={people} />)}</div> : <p className="side-empty">{selected ? "No feedback on this block yet." : "No active block feedback."}</p>}{canComment && selected && <CommentComposer block={selected} onComment={body => onComment(selected.id, body)} />}</section>
    {grouped.archived.length > 0 && <section className="review-section archived-feedback" aria-labelledby="archived-title"><h3 id="archived-title">Removed blocks</h3><p>Open feedback here is archived and non-blocking. Agents can still respond; it remains auditable and returns to its block when restored.</p><div className="panel-threads">{grouped.archived.map(item => <FeedbackThread key={item.id} item={item} people={people} archived/>)}</div></section>}
    <History revisions={view.revisions} events={events} people={people} canRestore={canRestore} onRestore={onRestore}/>
    {finalize}
  </aside>;
}

function CommentComposer({ block, onComment }: { block: SandboxBlock; onComment: (body: string) => Promise<void> }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await onComment(body); setBody(""); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } };
  return <form className="comment-form" onSubmit={submit}><label htmlFor={`comment-${block.id}`}>Comment on {block.title ?? block.id}</label><textarea id={`comment-${block.id}`} required maxLength={10_000} value={body} onChange={event => setBody(event.target.value)} placeholder="What should the agent know?"/>{error && <p className="alert error" role="alert">{error} Your comment is still here—try again.</p>}<button className="primary" disabled={busy}>{busy ? "Posting…" : error ? "Retry comment" : "Post comment"}</button></form>;
}

function PresenceBadges({ participants, connected }: { participants: PresentParticipant[]; connected: boolean }) {
  return <div className={`presence-badges${connected ? " connected" : ""}`} aria-label={connected ? `${participants.length} connected` : "Presence reconnecting"} title={participants.map(person => person.name).join(", ")}>
    {participants.slice(0, 4).map(person => <span key={person.id}>{initials(person.name)}</span>)}
    {participants.length > 4 && <span>+{participants.length - 4}</span>}<small>{connected ? "online" : "reconnecting"}</small>
  </div>;
}

function FeedbackThread({ item, people, archived = false }: { item: Feedback; people: Map<string, string>; archived?: boolean }) {
  return <div className={`thread ${item.status}${archived ? " archived" : ""}`}><div className="thread-meta"><span className="status-dot"/><strong>{people.get(item.actor_identity_id) ?? item.actor_identity_id}</strong><span>{formatDate(item.created_at)}</span><span>{archived ? `${item.status} · archived` : item.status}</span></div><p>{item.body}</p>
    {item.responses.map(response => <div className="response" key={response.id}><span>↳ {people.get(response.actor_identity_id) ?? "Agent"}</span>{response.body && <p>{response.body}</p>}{response.resolved && <small>Marked resolved</small>}</div>)}
  </div>;
}

function History({ revisions, events, people, canRestore, onRestore }: { revisions: Revision[]; events: AuditEvent[]; people: Map<string, string>; canRestore: boolean; onRestore: (revision: Revision) => Promise<void> }) {
  return <section className="side-card"><div className="side-title"><h2>Activity</h2></div><ol className="timeline">
    {events.slice(-7).reverse().map(event => <li key={event.id}><span className="timeline-dot"/><div><strong>{eventLabel(event.event_type)}</strong><p>{people.get(event.actor_identity_id) ?? event.actor_identity_id} · {formatDate(event.created_at)}</p></div></li>)}
  </ol>{revisions.length > 0 && <details><summary>{revisions.length} revision{revisions.length === 1 ? "" : "s"}</summary><div className="revision-list">{revisions.slice().reverse().map(revision => <div className="revision" key={revision.id}><p><b>v{revision.version}</b> {revision.summary || `${revision.changed_block_ids.length} block${revision.changed_block_ids.length === 1 ? "" : "s"} changed`} · {people.get(revision.actor_identity_id) ?? revision.actor_identity_id}</p>{revision.snapshot_available ? <><small className="snapshot-available">Snapshot available</small><button disabled={!canRestore} aria-label={`Restore revision v${revision.version}`} onClick={() => void onRestore(revision)}>Restore</button></> : <small>{revision.snapshot_pruned ? "Unavailable — snapshot pruned after finalization" : "Unavailable — legacy revision has no snapshot"}</small>}</div>)}</div></details>}</section>;
}

function FinalizePanel({ view, partyId, capability, participantToken, beforeFinalize, onDone }: { view: PartyView; partyId: string; capability: string; participantToken: string; beforeFinalize: () => Promise<number | null>; onDone: () => Promise<void> }) {
  const [name, setName] = useState(`${view.artifact?.title ?? view.party.title} — Final`);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { const expectedVersion = await beforeFinalize(); await api(`/api/parties/${partyId}/finalize`, { method: "POST", headers: { Authorization: `Bearer ${capability}`, "X-Participant-Token": participantToken }, body: JSON.stringify({ name, expectedVersion, allowOpenFeedback: override }) }); await onDone(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } };
  return <section className="side-card finalize"><span className="eyebrow">Owner action</span><h2>Finalize snapshot</h2><p>Locks this exact revision and shared state into a portable file.</p><form onSubmit={submit}><label>Snapshot name<input required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
    {view.openFeedback > 0 && <label className="override"><input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} /><span><b>{view.openFeedback} comments remain open.</b> Finalize anyway.</span></label>}
    {error && <p className="alert error" role="alert">{error}</p>}<button className="primary" disabled={busy || (view.openFeedback > 0 && !override)}>{busy ? "Finalizing…" : "Finalize party"}</button></form></section>;
}

function ExportButton({ partyId, capability, participantToken, title }: { partyId: string; capability: string; participantToken: string; title: string }) {
  const [busy, setBusy] = useState(false);
  const download = async () => { setBusy(true); try { const response = await fetch(`/api/parties/${partyId}/final/export`, { headers: { Authorization: `Bearer ${capability}`, "X-Participant-Token": participantToken } }); if (!response.ok) throw await responseError(response); const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = `${title}.html`; link.click(); URL.revokeObjectURL(url); } finally { setBusy(false); } };
  return <button onClick={() => void download()} disabled={busy}>{busy ? "Preparing…" : "Download interactive HTML"}</button>;
}

function JoinParty({ partyId, capability, identity, onIdentity, onJoined }: { partyId: string; capability: string; identity: ParticipantProfile; onIdentity: (identity: ParticipantProfile) => void; onJoined: (session: ParticipantSession) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); saveIdentity(identity);
    try { onJoined(await api<ParticipantSession>(`/api/parties/${partyId}/participants`, { method: "POST", headers: { Authorization: `Bearer ${capability}` }, body: JSON.stringify({ participant: identity }) })); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };
  return <main className="center-state"><div className="empty-glyph">→</div><span className="eyebrow">Participant session</span><h1>Join the party</h1><p>Choose the name attached to your comments and activity in this workspace.</p><form className="join-form" onSubmit={submit}><label>Display name<input required maxLength={80} value={identity.name} onChange={event => onIdentity({ ...identity, name: event.target.value })} autoFocus /></label>{error && <p className="alert error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "Joining…" : "Join workspace"}</button></form></main>;
}

function SessionError({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return <main className="center-state"><div className="empty-glyph">×</div><h1>We couldn’t open this party</h1><p role="alert">{detail}</p><button className="primary" onClick={onRetry}>Create a new participant session</button></main>;
}

function EmptyArtifact({ deliberate = false }: { deliberate?: boolean }) { return <section className="empty-artifact"><div className="empty-glyph">◇</div><h2>{deliberate ? "This revision has zero blocks" : "The room is ready"}</h2><p>{deliberate ? "The empty canvas is deliberate. Open Review to inspect archived feedback or restore a revision." : "An agent has created this party and is preparing the first interactive artifact. This view will refresh automatically."}</p></section>; }
function LoadingState() { return <main className="center-state" aria-busy="true"><div className="loader"/><span className="eyebrow">Joining party</span><h1>Opening the workspace…</h1><p>Fetching the latest revision and conversation.</p></main>; }
function CenteredState({ title, detail, action }: { title: string; detail: string; action: string }) { return <main className="center-state"><div className="empty-glyph">×</div><h1>{title}</h1><p>{detail}</p><a className="button primary" href="/">{action}</a></main>; }

async function addComment(partyId: string, capability: string, participantToken: string, blockId: string, body: string) {
  await api(`/api/parties/${partyId}/feedback`, { method: "POST", headers: { Authorization: `Bearer ${capability}`, "X-Participant-Token": participantToken }, body: JSON.stringify({ blockId, kind: "comment", body }) });
}

function loadIdentity(): ParticipantProfile { try { const value = JSON.parse(localStorage.getItem("buildparty.identity") ?? "null") as Partial<ParticipantProfile> | null; if (value?.name) return { name: value.name, kind: "human" }; } catch { /* replace corrupt preference */ } const identity = { name: "Guest reviewer", kind: "human" as const }; saveIdentity(identity); return identity; }
function saveIdentity(identity: ParticipantProfile) { localStorage.setItem("buildparty.identity", JSON.stringify(identity)); }
function participantSessionKey(partyId: string) { return `buildparty.participant.${partyId}`; }
function saveParticipantSession(partyId: string, session: ParticipantSession) { sessionStorage.setItem(participantSessionKey(partyId), JSON.stringify({ participant: session.participant, participantToken: session.participantToken })); }
function loadParticipantSession(partyId: string): ParticipantSession | undefined { try { const value = JSON.parse(sessionStorage.getItem(participantSessionKey(partyId)) ?? "null") as ParticipantSession | null; if (value?.participantToken && value.participant?.id) return value; } catch { /* replace corrupt session */ } return undefined; }
function message(reason: unknown) { return reason instanceof Error ? reason.message : "Something went wrong"; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function initials(value: string) { return value.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase(); }
function eventLabel(value: string) { return ({ party_created: "Party created", artifact_set: "Artifact added", blocks_updated: "Revision published", blocks_deleted: "Blocks deleted", revision_restored: "Revision restored", feedback_created: "Comment added", feedback_responded: "Feedback updated", party_finalized: "Party finalized" } as Record<string, string>)[value] ?? value.replaceAll("_", " "); }
function navigateSpa(value: string) { const url = new URL(value, location.href); history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`); dispatchEvent(new PopStateEvent("popstate")); }
