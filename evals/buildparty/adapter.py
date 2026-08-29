"""Deterministic BuildParty v1 model for webmcp-bench.

`human_fixture_add_feedback` and `eval_full_journey` are harness-only supporting
infrastructure. They are intentionally never registered as native WebMCP tools.
"""

from copy import deepcopy
from html import escape
import json
import math
import re

PUBLIC_TOOLS = (
    "init", "create_party", "get_party", "set_artifact", "update_blocks",
    "delete_blocks", "restore_revision", "get_feedback", "respond_to_feedback",
    "finalize_party", "get_final_artifact",
)
AGENT_ID = "00000000-0000-4000-8000-000000000001"
HUMAN_ID = "00000000-0000-4000-8000-000000000002"
PARTY_ID = "00000000-0000-4000-8000-000000000003"
FEEDBACK_ID = "00000000-0000-4000-8000-000000000004"
RESPONSE_ID = "00000000-0000-4000-8000-000000000005"
REVISION_1 = "00000000-0000-4000-8000-000000000006"
REVISION_2 = "00000000-0000-4000-8000-000000000007"
FINAL_ID = "00000000-0000-4000-8000-000000000008"
HUMAN_FIXTURE_FEEDBACK_ID = "00000000-0000-4000-8000-000000000009"
AGENT_GUIDE = "BuildParty creates one seamless interactive artifact for human review. Keep this tab open. Initialize, then create exactly one room; keep the owner URL private and return labeled owner and reviewer URLs. If no supplied content suggests a room title, use BuildParty session. If this conversation already contains content, publish it; otherwise create the room and ask or work on the content. Use display name Owner when no useful name is known. Use one block for atomic work and stable blocks for independently reviewable sections. Source must be self-contained, no-network HTML/CSS/JS; standard named controls sync by default, data-bp-local stays local, and custom JS uses window.buildParty.getState/setState/patchState/subscribe. Precompile Mermaid/UML to inline SVG. Humans interact and comment while agents change source. Patterns: planning/RFC—blocks by decision or section; learning notebook—sections plus persistent exercises/progress; presentation—stable slide/section blocks; prototype or decision workshop—shared controls for assumptions, votes, and choices."
BLOCK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
UNSAFE_JSON_KEYS = {"__proto__", "prototype", "constructor"}
MAX_JSON_DEPTH = 16
MAX_JSON_SIZE = 100_000


def resolve_state(data: dict) -> str:
    party = data.get("party")
    if party is None:
        return "no_party"
    lifecycle = party.get("lifecycle")
    if lifecycle in {"initialized", "revising", "finalized"}:
        return lifecycle
    if lifecycle == "in_review":
        latest = (data.get("revisions") or [{}])[-1].get("source")
        if latest == "restore_revision":
            return "restored"
        if latest == "delete_blocks":
            return "zero_blocks" if not data.get("artifact", {}).get("blocks") else "deleted"
        return "in_review"
    return "unresolved"


def choose_tool(prompt: str, available: list[str]) -> str | None:
    text = prompt.lower()
    markers = (
        ("complete the entire deterministic journey", "eval_full_journey"),
        ("human fixture", "human_fixture_add_feedback"),
        ("initialize my agent", "init"),
        ("create a party", "create_party"),
        ("read the current party", "get_party"),
        ("publish the sandbox artifact", "set_artifact"),
        ("update only", "update_blocks"),
        ("patch only shared state", "update_blocks"),
        ("delete the feedback block", "delete_blocks"),
        ("delete the last block", "delete_blocks"),
        ("restore the whole", "restore_revision"),
        ("list open feedback", "get_feedback"),
        ("respond to the feedback without resolving", "respond_to_feedback"),
        ("resolve the linked feedback", "respond_to_feedback"),
        ("finalize with the explicit open-feedback override", "finalize_party"),
        ("finalize the zero-block artifact", "finalize_party"),
        ("read the immutable final artifact", "get_final_artifact"),
    )
    return next((tool for marker, tool in markers if marker in text and tool in available), None)


def _assert_object(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _exact(value, allowed, label="input"):
    extra = set(value) - set(allowed)
    if extra:
        raise ValueError(f"{label} has unknown field: {sorted(extra)[0]}")


def _validate_json_value(value, label, depth):
    if depth > MAX_JSON_DEPTH:
        raise ValueError(f"{label} is too deep")
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 1.7976931348623157e308:
            raise ValueError(f"{label} contains a non-JSON value")
        return
    if isinstance(value, float) and math.isfinite(value):
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json_value(item, f"{label}[{index}]", depth + 1)
        return
    if not isinstance(value, dict):
        raise ValueError(f"{label} contains a non-JSON value")
    for key, child in value.items():
        if not isinstance(key, str) or key in UNSAFE_JSON_KEYS:
            raise ValueError(f"{label} contains an unsafe key")
        _validate_json_value(child, f"{label}.{key}", depth + 1)


def _validate_json_object(value, label):
    result = _assert_object(value, label)
    _validate_json_value(result, label, 0)
    if len(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))) > MAX_JSON_SIZE:
        raise ValueError(f"{label} is too large")
    return deepcopy(result)


def _validate_runtime_state(value, artifact, label="runtimeState", validate_total=True):
    state = _validate_json_object(value, label) if validate_total else deepcopy(_assert_object(value, label))
    block_ids = {block["id"] for block in artifact["blocks"]}
    for block_id, block_state in state.items():
        if not BLOCK_ID.fullmatch(block_id) or block_id not in block_ids:
            raise ValueError(f"{label}.{block_id} does not match an artifact block")
        _validate_json_object(block_state, f"{label}.{block_id}")
    return state


def _validate_state_patch(value, artifact):
    return _validate_runtime_state(value, artifact, "statePatch")


def _text(value, label, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{label} must be a non-empty string up to {maximum} characters")
    return value.strip()


def _expected_version(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("expectedVersion must be a positive integer")
    return value


def _summary(inputs):
    return _text(inputs["summary"], "summary", 500) if "summary" in inputs else None


def _block_ids(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 200:
        raise ValueError("blockIds must contain 1 to 200 IDs")
    if len(set(value)) != len(value):
        raise ValueError("blockIds must be unique")
    if any(not isinstance(item, str) or not BLOCK_ID.fullmatch(item) for item in value):
        raise ValueError("blockIds contains an invalid block ID")
    return value


def _open_feedback(data, active_only=False):
    active_ids = {block["id"] for block in (data.get("artifact") or {}).get("blocks", [])}
    return [item for item in data.get("feedback", []) if item.get("status") == "open" and (not active_only or item.get("block_id") in active_ids)]


def _feedback_view(data, items):
    active_ids = {block["id"] for block in (data.get("artifact") or {}).get("blocks", [])}
    return [{**deepcopy(item), "anchorStatus": "active" if item.get("block_id") in active_ids else "archived"} for item in items]


def _revision_id(version):
    suffix = {1: 6, 2: 7}.get(version, version + 7)
    return f"00000000-0000-4000-8000-{suffix:012d}"


def _snapshot_bytes(artifact, runtime_state):
    return len(json.dumps(artifact, sort_keys=True, separators=(",", ":"))) + len(json.dumps(runtime_state, sort_keys=True, separators=(",", ":")))


def _revision(data, source, changed, linked, summary=None):
    version = data["version"]
    artifact, runtime_state = deepcopy(data["artifact"]), deepcopy(data["runtime_state"])
    revision = {
        "id": _revision_id(version), "version": version, "source": source,
        "changed_block_ids": list(changed), "feedback_ids": list(linked),
        "summary": summary, "actor_identity_id": data["actor"]["id"],
        "created_at": f"2026-09-01T00:00:{version:02d}Z",
        "snapshot_available": True, "snapshot_pruned": False,
        "snapshot_bytes": _snapshot_bytes(artifact, runtime_state),
    }
    data["revisions"].append(revision)
    data.setdefault("_revision_snapshots", {})[revision["id"]] = {"artifact": artifact, "runtime_state": runtime_state}
    return revision


def _merge(current, patch):
    result = deepcopy(current)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def _initial_state(artifact):
    return {block["id"]: deepcopy(block.get("initialState", {})) for block in artifact["blocks"]}


def _validate_artifact(value):
    artifact = deepcopy(_assert_object(value, "artifact"))
    _exact(artifact, {"format", "title", "blocks"}, "artifact")
    if artifact.get("format") != "buildparty.artifact/v1":
        raise ValueError("artifact.format must be buildparty.artifact/v1")
    _text(artifact.get("title"), "artifact.title", 200)
    blocks = artifact.get("blocks")
    if not isinstance(blocks, list) or len(blocks) > 200:
        raise ValueError("artifact.blocks must contain 0 to 200 blocks")
    ids = []
    for index, block in enumerate(blocks):
        _assert_object(block, f"artifact.blocks[{index}]")
        _exact(block, {"id", "title", "kind", "source", "initialState"}, f"artifact.blocks[{index}]")
        block_id = block.get("id")
        if not isinstance(block_id, str) or not BLOCK_ID.fullmatch(block_id):
            raise ValueError(f"artifact.blocks[{index}].id is invalid")
        ids.append(block_id)
        if block.get("kind") != "sandbox":
            raise ValueError(f"artifact.blocks[{index}].kind must be sandbox")
        if "title" in block:
            _text(block["title"], f"artifact.blocks[{index}].title", 200)
        source = _assert_object(block.get("source"), f"artifact.blocks[{index}].source")
        _exact(source, {"html", "css", "js"}, f"artifact.blocks[{index}].source")
        if not isinstance(source.get("html"), str) or len(source["html"]) > 100000:
            raise ValueError(f"artifact.blocks[{index}].source.html is required")
        if any(key in source and (not isinstance(source[key], str) or len(source[key]) > 100000) for key in ("css", "js")):
            raise ValueError(f"artifact.blocks[{index}].source fields must be strings")
        if "initialState" in block:
            block["initialState"] = _validate_json_object(block["initialState"], f"artifact.blocks[{index}].initialState")
    if len(set(ids)) != len(ids):
        raise ValueError("artifact block IDs must be unique")
    return artifact


def _available_operations(data):
    if data.get("party") is None:
        return ["init", "create_party"]
    lifecycle = data["party"]["lifecycle"]
    reads = ["get_party", "get_feedback"]
    if lifecycle == "finalized":
        return reads + ["get_final_artifact"]
    if data.get("artifact") is None:
        return reads + ["set_artifact"]
    revisions = data.get("revisions", [])
    writes = ["set_artifact", "update_blocks"]
    if data["artifact"]["blocks"]:
        writes.append("delete_blocks")
    if any(item.get("snapshot_available") for item in revisions):
        writes.append("restore_revision")
    writes.append("respond_to_feedback")
    if data["party"].get("access") == "owner":
        writes.append("finalize_party")
    return reads + writes


def _next_action(data):
    if data["party"]["lifecycle"] == "finalized":
        return {"tool": "get_final_artifact", "reason": "retrieve the immutable final output"}
    if data.get("artifact") is None or data["party"]["lifecycle"] == "initialized":
        return {"tool": "set_artifact", "reason": "publish prepared content for review"}
    if _open_feedback(data):
        return {"tool": "get_feedback", "reason": "read and address open human feedback"}
    return {"tool": None, "reason": "wait for or continue human review; do not poll"}


def _mutable(data):
    if data["party"]["lifecycle"] == "finalized":
        raise ValueError("finalized parties are immutable")


def _script_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def _sandbox_document(block, channel):
    source = _script_json(block["source"])
    identity = _script_json({"blockId": block["id"], "channel": channel})
    script = (block["source"].get("js") or "").replace("</script", "<\\/script")
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'"></head><body><div id="buildparty-root"></div><script>(()=>{{
const source={source},identity={identity};let state={{}},listeners=new Set();
const send=message=>parent.postMessage({{...identity,...message}},'*');
const publish=next=>{{state=structuredClone(next);for(const listener of listeners)listener(structuredClone(state));}};
window.buildParty={{getState:()=>structuredClone(state),setState:(path,value)=>send({{type:'bp:set',path,value}}),patchState:patch=>send({{type:'bp:patch',patch}}),subscribe:listener=>{{listeners.add(listener);return()=>listeners.delete(listener);}}}};
addEventListener('message',event=>{{const message=event.data;if(event.source===parent&&message?.type==='bp:state'&&message.channel===identity.channel)publish(message.state);}});
const style=document.createElement('style');style.textContent=source.css||'';document.head.append(style);document.getElementById('buildparty-root').innerHTML=source.html;send({{type:'bp:ready'}});
}})()</script><script>{script}</script></body></html>'''


def _render_final_html(artifact, runtime_state):
    frames = [{"id": block["id"], "title": block.get("title", block["id"]), "channel": f"buildparty-final-{block['id']}", "document": _sandbox_document(block, f"buildparty-final-{block['id']}")} for block in artifact["blocks"]]
    data = _script_json({"frames": frames, "runtimeState": runtime_state})
    sections = "".join(f'<section><h2>{escape(frame["title"])}</h2><div data-block="{escape(frame["id"])}"></div></section>' for frame in frames)
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'; object-src 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>{escape(artifact["title"])}</title><style>*{{box-sizing:border-box}}body{{max-width:960px;margin:3rem auto;padding:0 1rem;font:16px/1.5 system-ui}}iframe{{display:block;width:100%;min-height:320px;border:1px solid #ccc}}</style></head><body><main><h1>{escape(artifact["title"])}</h1>{sections}</main><script>(()=>{{
const data={data},byWindow=new Map(),state=structuredClone(data.runtimeState);
const send=entry=>entry.frame.contentWindow?.postMessage({{type:'bp:state',channel:entry.channel,state:structuredClone(state[entry.id]||{{}})}},'*');
for(const entry of data.frames){{const host=document.querySelector('[data-block="'+CSS.escape(entry.id)+'"]'),frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.title=entry.title;frame.srcdoc=entry.document;host.append(frame);entry.frame=frame;frame.addEventListener('load',()=>{{byWindow.set(frame.contentWindow,entry);send(entry);}});}}
addEventListener('message',event=>{{const entry=byWindow.get(event.source),message=event.data;if(!entry||message?.channel!==entry.channel)return;if(message.type==='bp:ready'){{send(entry);return;}}const next=structuredClone(state[entry.id]||{{}});if(message.type==='bp:patch'&&message.patch&&typeof message.patch==='object'&&!Array.isArray(message.patch))Object.assign(next,message.patch);else if(message.type==='bp:set'&&typeof message.path==='string')next[message.path]=structuredClone(message.value);else return;state[entry.id]=next;send(entry);}});
}})()</script></body></html>'''


def _export_checks(snapshot, artifact, runtime_state):
    exported = snapshot.get("html", "")
    bridge = ("window.buildParty", "getState", "setState", "patchState", "bp:ready", "bp:state", "bp:set", "sandbox','allow-scripts")
    forbidden = ("feedback", "revision", "capabilities", "ownerCapability", "shareCapability", "participantToken", "OWNER_FIXTURE", "SHARE_FIXTURE")
    return [
        _check("final-html-fidelity", "Interactive export is deterministically derived from exact block source and shared state", exported == _render_final_html(artifact, runtime_state), len(exported)),
        _check("final-html-bridge", "Nonempty exports contain sandboxed state bridges; zero-block exports remain real portable HTML", (not artifact["blocks"] and "<!doctype html>" in exported and "<main>" in exported) or all(marker in exported for marker in bridge), [marker for marker in bridge if marker in exported]),
        _check("final-html-private-data", "Interactive export excludes review history and capability material", not any(marker in exported for marker in forbidden), [marker for marker in forbidden if marker in exported]),
    ]


def invoke(tool: str, data: dict, inputs: dict) -> dict:
    _assert_object(inputs, "tool input")
    if tool == "eval_full_journey":
        return _full_journey(data, inputs)
    if tool == "human_fixture_add_feedback":
        return _human_feedback(data, inputs)
    if tool not in PUBLIC_TOOLS:
        raise ValueError(f"unknown tool: {tool}")

    if tool == "init":
        name = inputs.get("displayName")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("displayName is required")
        data["actor"] = {"id": AGENT_ID, "name": name.strip(), "kind": "agent"}
        data["agent_session"] = {"initialized": True, "participant_id": AGENT_ID}
        return {"identity": {"displayName": name.strip(), "kind": "agent"}, "operations": list(PUBLIC_TOOLS), "guide": AGENT_GUIDE, "nextAction": {"tool": "create_party" if data.get("party") is None else "get_party", "reason": "create one review room" if data.get("party") is None else "read current party state before acting"}}

    if tool == "create_party":
        if data.get("party") is not None or not data.get("agent_session", {}).get("initialized"):
            raise ValueError("call init before create_party")
        title = inputs.get("title")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("title is required")
        data.update({
            "party": {"id": PARTY_ID, "title": title.strip(), "lifecycle": "initialized", "access": "owner"},
            "participants": [deepcopy(data["actor"])], "artifact": None, "runtime_state": None,
            "version": None, "feedback": [], "revisions": [], "final": None,
            "capabilities": {"owner_role": "owner", "share_role": "share"},
        })
        return {"party": deepcopy(data["party"]), "ownerUrl": f"/party/{PARTY_ID}#cap=OWNER_FIXTURE", "shareUrl": f"/party/{PARTY_ID}#cap=SHARE_FIXTURE", "nextAction": {"tool": "set_artifact", "reason": "publish existing content or prepare it first"}}

    if data.get("party") is None:
        raise ValueError("party is unavailable")

    if tool in {"get_party", "get_feedback", "get_final_artifact"}:
        if tool == "get_party":
            _exact(inputs, set())
            result = {key: deepcopy(data.get(key)) for key in ("party", "artifact", "runtime_state", "version", "participants", "revisions")}
            result["availableOperations"] = _available_operations(data)
            result["openFeedback"] = len(_open_feedback(data))
            result["nextAction"] = _next_action(data)
            return result
        if tool == "get_feedback":
            _exact(inputs, {"status"})
            status = inputs.get("status", "all")
            if status not in {"open", "resolved", "all"}:
                raise ValueError("status must be open, resolved, or all")
            items = data["feedback"] if status == "all" else [item for item in data["feedback"] if item["status"] == status]
            return {"partyId": PARTY_ID, "status": status, "feedback": _feedback_view(data, items)}
        _exact(inputs, set())
        if data["party"]["lifecycle"] != "finalized" or data.get("final") is None:
            raise ValueError("party has not been finalized")
        return {"partyId": PARTY_ID, "lifecycle": "finalized", "final": deepcopy(data["final"])}

    _mutable(data)
    if tool == "set_artifact":
        _exact(inputs, {"artifact", "expectedVersion", "summary", "statePatch", "resetState"})
        artifact = _validate_artifact(inputs.get("artifact"))
        if "expectedVersion" in inputs and _expected_version(inputs["expectedVersion"]) != data.get("version"):
            raise ValueError("VERSION_CONFLICT")
        reset = inputs.get("resetState")
        if "resetState" in inputs and not isinstance(reset, bool):
            raise ValueError("resetState must be boolean")
        if reset is True and "statePatch" in inputs:
            raise ValueError("statePatch and resetState are mutually exclusive")
        state_patch = _validate_state_patch(inputs["statePatch"], artifact) if "statePatch" in inputs else None
        old_state = data.get("runtime_state") or {}
        defaults = _initial_state(artifact)
        carried = {block["id"]: deepcopy(old_state.get(block["id"], defaults[block["id"]])) for block in artifact["blocks"]}
        if reset is True:
            carried = defaults
        elif state_patch is not None:
            carried = _merge(carried, state_patch)
        carried = _validate_runtime_state(carried, artifact, validate_total=state_patch is not None)
        data["artifact"], data["runtime_state"] = artifact, carried
        data["version"] = (data.get("version") or 0) + 1
        data["party"]["lifecycle"] = "in_review"
        revision = _revision(data, "set_artifact", [block["id"] for block in artifact["blocks"]], [], inputs.get("summary"))
        return {"version": data["version"], "lifecycle": "in_review", "revision": deepcopy(revision), "availableOperations": _available_operations(data)}

    if tool == "update_blocks":
        _exact(inputs, {"updates", "statePatch", "resetState", "feedbackIds", "summary", "expectedVersion"})
        if data.get("artifact") is None or _expected_version(inputs.get("expectedVersion")) != data["version"]:
            raise ValueError("VERSION_CONFLICT or missing artifact")
        updates = inputs.get("updates", [])
        linked = inputs.get("feedbackIds", [])
        reset = inputs.get("resetState")
        if "resetState" in inputs and not isinstance(reset, bool):
            raise ValueError("resetState must be boolean")
        if reset is True and "statePatch" in inputs:
            raise ValueError("statePatch and resetState are mutually exclusive")
        state_patch = _validate_state_patch(inputs["statePatch"], data["artifact"]) if "statePatch" in inputs else None
        if not updates and state_patch is None and reset is not True:
            raise ValueError("an update needs block changes, statePatch, or resetState")
        if not updates and linked:
            raise ValueError("feedback can only be linked to a source update")
        by_id = {block["id"]: block for block in data["artifact"]["blocks"]}
        for update in updates:
            current = by_id.get(update.get("id"))
            if current is None:
                raise ValueError(f"unknown block: {update.get('id')}")
            if "title" in update:
                current["title"] = update["title"]
            if "source" in update:
                current["source"].update(deepcopy(update["source"]))
        known_open = {item["id"] for item in _open_feedback(data)}
        if any(item not in known_open for item in linked):
            raise ValueError("only open party feedback can be linked")
        if reset is True:
            data["runtime_state"] = _validate_runtime_state(_initial_state(data["artifact"]), data["artifact"], validate_total=False)
        elif state_patch is not None:
            data["runtime_state"] = _validate_runtime_state(_merge(data["runtime_state"], state_patch), data["artifact"])
        if not updates:
            return {"version": data["version"], "lifecycle": data["party"]["lifecycle"], "revision": None, "changedBlockIds": [], "runtimeState": deepcopy(data["runtime_state"]), "availableOperations": _available_operations(data)}
        data["version"] += 1
        if linked:
            data["party"]["lifecycle"] = "revising"
        revision = _revision(data, "update_blocks", [item["id"] for item in updates], list(linked), inputs.get("summary"))
        return {"version": data["version"], "lifecycle": data["party"]["lifecycle"], "revision": deepcopy(revision), "availableOperations": _available_operations(data)}

    if tool == "delete_blocks":
        _exact(inputs, {"blockIds", "expectedVersion", "summary"})
        summary = _summary(inputs)
        deleted_ids = _block_ids(inputs.get("blockIds"))
        wanted = _expected_version(inputs.get("expectedVersion"))
        if data.get("artifact") is None:
            raise ValueError("set an artifact before deleting blocks")
        if wanted != data["version"]:
            raise ValueError("VERSION_CONFLICT")
        existing = {block["id"] for block in data["artifact"]["blocks"]}
        missing = next((block_id for block_id in deleted_ids if block_id not in existing), None)
        if missing:
            raise ValueError(f"unknown block: {missing}")
        data["artifact"]["blocks"] = [block for block in data["artifact"]["blocks"] if block["id"] not in deleted_ids]
        data["runtime_state"] = {block_id: state for block_id, state in data["runtime_state"].items() if block_id not in deleted_ids}
        data["version"] += 1
        revision = _revision(data, "delete_blocks", deleted_ids, [], summary)
        return {"version": data["version"], "lifecycle": data["party"]["lifecycle"], "revision": deepcopy(revision), "deletedBlockIds": deleted_ids, "availableOperations": _available_operations(data)}

    if tool == "restore_revision":
        _exact(inputs, {"revisionId", "expectedVersion", "summary"})
        summary = _summary(inputs)
        revision_id = inputs.get("revisionId")
        if not isinstance(revision_id, str) or not UUID.fullmatch(revision_id):
            raise ValueError("revisionId must be a UUID")
        wanted = _expected_version(inputs.get("expectedVersion"))
        if data.get("artifact") is None:
            raise ValueError("set an artifact before restoring a revision")
        if wanted != data["version"]:
            raise ValueError("VERSION_CONFLICT")
        source = next((item for item in data["revisions"] if item["id"] == revision_id), None)
        if source is None:
            raise ValueError("revision not found")
        if source.get("snapshot_pruned"):
            raise ValueError("revision snapshot was pruned after finalization")
        snapshot = data.get("_revision_snapshots", {}).get(revision_id)
        if not source.get("snapshot_available") or snapshot is None:
            raise ValueError("revision snapshot is unavailable")
        current = {block["id"]: block for block in data["artifact"]["blocks"]}
        restored = _validate_artifact(snapshot["artifact"])
        after = {block["id"]: block for block in restored["blocks"]}
        changed = [block_id for block_id in dict.fromkeys([*current, *after]) if current.get(block_id) != after.get(block_id)]
        data["artifact"] = restored
        data["runtime_state"] = deepcopy(snapshot["runtime_state"])
        data["version"] += 1
        revision = _revision(data, "restore_revision", changed, [], summary)
        return {"version": data["version"], "lifecycle": data["party"]["lifecycle"], "revision": deepcopy(revision), "restoredFromRevisionId": revision_id, "restoredFromVersion": source["version"], "changedBlockIds": changed, "availableOperations": _available_operations(data)}

    if tool == "respond_to_feedback":
        _exact(inputs, {"feedbackId", "body", "revisionId", "resolve"})
        feedback = next((item for item in data["feedback"] if item["id"] == inputs.get("feedbackId")), None)
        revision_id = inputs.get("revisionId")
        revision = next((item for item in data["revisions"] if item["id"] == revision_id), None) if revision_id else None
        resolving = inputs.get("resolve") is True
        if data["actor"]["kind"] != "agent":
            raise ValueError("only agents can respond")
        if feedback is None:
            raise ValueError("feedback not found")
        if not inputs.get("body") and not revision_id and not resolving:
            raise ValueError("a response needs body, revisionId, or resolve")
        if resolving and not revision_id:
            raise ValueError("resolving feedback requires a linked revision")
        if revision_id and (revision is None or feedback["id"] not in revision["feedback_ids"]):
            raise ValueError("revision must explicitly address this feedback")
        if resolving:
            feedback["status"] = "resolved"
            feedback["resolved_by_identity_id"] = data["actor"]["id"]
        response = {"id": RESPONSE_ID, "body": inputs.get("body"), "revision_id": revision_id, "resolved": resolving, "actor_identity_id": data["actor"]["id"]}
        feedback.setdefault("responses", []).append(response)
        if not _open_feedback(data) and data["party"]["lifecycle"] == "revising":
            data["party"]["lifecycle"] = "in_review"
        return {"lifecycle": data["party"]["lifecycle"], "feedbackId": feedback["id"], "response": deepcopy(response), "availableOperations": _available_operations(data)}

    if tool == "finalize_party":
        _exact(inputs, {"name", "expectedVersion", "allowOpenFeedback"})
        name = _text(inputs.get("name"), "name", 200)
        if data["party"].get("access") != "owner":
            raise ValueError("FORBIDDEN: owner capability required")
        if data.get("artifact") is None or inputs.get("expectedVersion") != data["version"]:
            raise ValueError("VERSION_CONFLICT or missing artifact")
        open_count = len(_open_feedback(data, active_only=True))
        if open_count and inputs.get("allowOpenFeedback") is not True:
            raise ValueError("OPEN_FEEDBACK: explicit override required")
        data["final"] = {
            "id": FINAL_ID, "name": name, "source_version": data["version"],
            "blocks": deepcopy(data["artifact"]["blocks"]), "runtime_state": deepcopy(data["runtime_state"]),
            "actor_identity_id": data["actor"]["id"], "open_feedback_overridden": open_count > 0,
            "html": _render_final_html(data["artifact"], data["runtime_state"]),
        }
        data["party"]["lifecycle"] = "finalized"
        data["_revision_snapshots"] = {}
        for item in data["revisions"]:
            item["snapshot_available"], item["snapshot_pruned"] = False, True
        return {"lifecycle": "finalized", "final": deepcopy(data["final"]), "availableOperations": _available_operations(data)}

    raise ValueError(f"unknown tool: {tool}")


def _human_feedback(data, inputs):
    _exact(inputs, {"blockId", "kind", "body"})
    _mutable(data)
    if data.get("artifact") is None or not any(block["id"] == inputs.get("blockId") for block in data["artifact"]["blocks"]):
        raise ValueError("feedback block does not exist")
    feedback_id = FEEDBACK_ID if not any(item["id"] == FEEDBACK_ID for item in data["feedback"]) else HUMAN_FIXTURE_FEEDBACK_ID
    feedback = {
        "id": feedback_id, "block_id": inputs["blockId"], "kind": inputs.get("kind", "change"),
        "body": inputs["body"], "status": "open", "actor_identity_id": HUMAN_ID, "responses": [],
    }
    data["feedback"].append(feedback)
    if not any(item["id"] == HUMAN_ID for item in data["participants"]):
        data["participants"].append({"id": HUMAN_ID, "name": "Riley Reviewer", "kind": "human"})
    return {"supportingInfrastructure": True, "humanFixtureAction": "add_feedback", "feedback": deepcopy(feedback)}


def _full_journey(data, inputs):
    artifact = inputs["artifact"]
    invoke("create_party", data, {"title": inputs["partyTitle"]})
    invoke("set_artifact", data, {"artifact": artifact, "summary": "Initial publish"})
    _human_feedback(data, {"blockId": "hero", "kind": "change", "body": "Make the call to action specific."})
    probes = {}
    data["party"]["access"] = "share"
    try:
        invoke("finalize_party", data, {"name": "Denied", "expectedVersion": 1, "allowOpenFeedback": True})
    except ValueError as exc:
        probes["share_finalize"] = str(exc)
    data["party"]["access"] = "owner"
    try:
        invoke("finalize_party", data, {"name": "Denied", "expectedVersion": 1})
    except ValueError as exc:
        probes["open_feedback_without_override"] = str(exc)
    revision = invoke("update_blocks", data, {
        "expectedVersion": 1, "updates": [{"id": "hero", "source": {"html": "<button>Start the review</button>"}}],
        "statePatch": {"hero": {"clicks": 3}}, "feedbackIds": [FEEDBACK_ID], "summary": "Address reviewer CTA feedback",
    })["revision"]
    invoke("respond_to_feedback", data, {"feedbackId": FEEDBACK_ID, "body": "Updated only the CTA.", "revisionId": revision["id"], "resolve": True})
    invoke("finalize_party", data, {"name": inputs["finalName"], "expectedVersion": 2})
    frozen = deepcopy(data["final"])
    try:
        invoke("update_blocks", data, {"expectedVersion": 2, "updates": [{"id": "hero", "title": "Forbidden"}]})
    except ValueError as exc:
        probes["post_finalize_mutation"] = str(exc)
    data["capability_probes"] = probes
    data["final_unchanged_after_probe"] = data["final"] == frozen
    return {"supportingInfrastructure": True, "journey": "create→share/human feedback→revise→resolve→finalize", "probes": probes}


def _check(check_id, label, passed, observed):
    return {"id": check_id, "label": label, "passed": bool(passed), "observed": observed}


def _snapshot_matches(data, revision):
    snapshot = data.get("_revision_snapshots", {}).get(revision.get("id"))
    return snapshot == {"artifact": data.get("artifact"), "runtime_state": data.get("runtime_state")} and revision.get("snapshot_available") is True and revision.get("snapshot_pruned") is False


def transition_checks(initial: dict, final: dict, transition: dict) -> list[dict]:
    tool = transition["tool"]
    checks = []
    if tool in {"get_party", "get_feedback", "get_final_artifact"}:
        checks.append(_check("read-only", "Read operation preserves exact authoritative state", final == initial, final))
    elif tool == "init":
        expected = deepcopy(initial); expected["actor"] = {"id": AGENT_ID, "name": "Planning Agent", "kind": "agent"}; expected["agent_session"] = {"initialized": True, "participant_id": AGENT_ID}
        checks.append(_check("init-scope", "Init changes only the agent identity/session", final == expected, final.get("agent_session")))
    elif tool == "create_party":
        checks.extend([
            _check("roles", "Create establishes distinct owner and share capability roles", final.get("capabilities") == {"owner_role": "owner", "share_role": "share"}, final.get("capabilities")),
            _check("creator-attribution", "The initialized agent is the first participant", final.get("participants") == [initial.get("actor")], final.get("participants")),
            _check("empty-workspace", "Initialized party has no artifact, feedback, revisions, runtime state, or final", all(final.get(key) in (None, []) for key in ("artifact", "runtime_state", "version", "feedback", "revisions", "final")), {key: final.get(key) for key in ("artifact", "feedback", "final")}),
        ])
    elif tool == "set_artifact":
        checks.extend([
            _check("artifact-v1", "Exact sandbox artifact v1 is published", final.get("artifact", {}).get("format") == "buildparty.artifact/v1" and len(final["artifact"]["blocks"]) == 2, final.get("artifact")),
            _check("initial-state", "Shared state is initialized by block id", final.get("runtime_state") == {"hero": {"clicks": 0, "theme": "indigo"}, "details": {"expanded": False}}, final.get("runtime_state")),
            _check("publish-valid-state-shape", "Published runtime state is object-shaped and scoped to new artifact block IDs", set(final["runtime_state"]) <= {block["id"] for block in final["artifact"]["blocks"]} and all(isinstance(value, dict) for value in final["runtime_state"].values()), final["runtime_state"]),
            _check("publish-attribution", "Publish revision is attributed to the agent", final.get("revisions", [{}])[-1].get("actor_identity_id") == AGENT_ID, final.get("revisions")),
            _check("publish-snapshot", "Publish revision stores the complete artifact and runtime state snapshot", _snapshot_matches(final, final["revisions"][-1]), final["revisions"][-1]),
            _check("party-preserved", "Publishing preserves party identity and access", final.get("party", {}).get("id") == initial.get("party", {}).get("id") and final.get("party", {}).get("access") == initial.get("party", {}).get("access"), final.get("party")),
        ])
    elif tool == "human_fixture_add_feedback":
        item = final.get("feedback", [{}])[-1]
        checks.extend([
            _check("human-only-fixture", "Clearly named fixture creates human-attributed block feedback", item.get("actor_identity_id") == HUMAN_ID and item.get("block_id") == "hero", item),
            _check("fixture-preserves-artifact", "Human feedback does not mutate artifact or shared state", final.get("artifact") == initial.get("artifact") and final.get("runtime_state") == initial.get("runtime_state") and final.get("version") == initial.get("version"), {"artifact": final.get("artifact"), "runtime_state": final.get("runtime_state")}),
        ])
    elif tool == "update_blocks":
        if transition["id"] == "patch-runtime-state-only":
            checks.extend([
                _check("state-only-patch", "Runtime state patch merges without source changes", final["runtime_state"]["hero"] == {"clicks": 9, "theme": "indigo"} and final["artifact"] == initial["artifact"], final["runtime_state"]),
                _check("state-only-no-revision", "Runtime-state-only update preserves version and revision history", final["version"] == initial["version"] and final["revisions"] == initial["revisions"] and final.get("_revision_snapshots") == initial.get("_revision_snapshots"), {"version": final["version"], "revisions": final["revisions"]}),
                _check("state-only-valid-shape", "Runtime state remains object-shaped and scoped to current block IDs", set(final["runtime_state"]) <= {block["id"] for block in final["artifact"]["blocks"]} and all(isinstance(value, dict) for value in final["runtime_state"].values()), final["runtime_state"]),
            ])
        else:
            before = {block["id"]: block for block in initial["artifact"]["blocks"]}; after = {block["id"]: block for block in final["artifact"]["blocks"]}; revision = final["revisions"][-1]
            checks.extend([
                _check("targeted-source", "Only the targeted hero HTML changes", after["hero"]["source"]["html"] == "<button>Start the review</button>" and after["hero"]["source"]["css"] == before["hero"]["source"]["css"] and after["hero"]["source"]["js"] == before["hero"]["source"]["js"], after["hero"]),
                _check("unrelated-block", "Unrelated details block is byte-for-byte unchanged", after["details"] == before["details"], after["details"]),
                _check("state-preservation", "Target state patch merges while unrelated state is preserved", final["runtime_state"] == {"hero": {"clicks": 3, "theme": "indigo"}, "details": {"expanded": False}}, final["runtime_state"]),
                _check("revision-link-attribution", "Revision records target, feedback link, and agent attribution", revision.get("changed_block_ids") == ["hero"] and revision.get("feedback_ids") == [FEEDBACK_ID] and revision.get("actor_identity_id") == AGENT_ID, revision),
                _check("update-snapshot", "Source update revision stores the complete artifact and runtime state snapshot", _snapshot_matches(final, revision), revision),
                _check("feedback-still-open", "Updating links but does not silently resolve feedback", final["feedback"][0].get("status") == "open", final["feedback"][0]),
            ])
    elif tool == "delete_blocks":
        revision = final["revisions"][-1]
        deleted = [block_id for block_id in {block["id"] for block in initial["artifact"]["blocks"]} if block_id not in {block["id"] for block in final["artifact"]["blocks"]}]
        archived = _feedback_view(final, final["feedback"])[0]
        checks.extend([
            _check("delete-exact-ids", "Only explicit existing block IDs and their runtime state are removed", deleted == revision["changed_block_ids"] and all(block_id not in final["runtime_state"] for block_id in deleted), {"deleted": deleted, "state": final["runtime_state"]}),
            _check("delete-monotonic", "Delete creates the next version and attributed revision", final["version"] == initial["version"] + 1 and revision["version"] == final["version"] and revision["source"] == "delete_blocks" and revision["actor_identity_id"] == AGENT_ID, revision),
            _check("delete-snapshot", "Delete revision stores the complete remaining artifact and runtime state", _snapshot_matches(final, revision), revision),
            _check("archived-feedback", "Removed-block feedback remains open, archived, auditable, and nonblocking", archived["status"] == "open" and archived["anchorStatus"] == "archived" and len(_open_feedback(final, active_only=True)) == 0, archived),
            _check("zero-block-valid", "Deleting the last block may leave a valid artifact rather than deleting it", transition["id"] != "delete-last-block" or (final["artifact"]["blocks"] == [] and final["runtime_state"] == {}), final["artifact"]),
        ])
    elif tool == "restore_revision":
        revision = final["revisions"][-1]; source = initial["_revision_snapshots"][REVISION_1]
        feedback = _feedback_view(final, final["feedback"])[0]
        checks.extend([
            _check("restore-exact-snapshot", "Restore replaces the whole artifact and runtime state with the selected complete snapshot", final["artifact"] == source["artifact"] and final["runtime_state"] == source["runtime_state"], {"artifact": final["artifact"], "state": final["runtime_state"]}),
            _check("restore-monotonic", "Restore creates a distinct next-version head revision", final["version"] == initial["version"] + 1 and revision["version"] == final["version"] and revision["source"] == "restore_revision" and revision["id"] != REVISION_1, revision),
            _check("restore-snapshot", "New restore revision stores its own complete artifact and runtime state snapshot", _snapshot_matches(final, revision), revision),
            _check("feedback-reanchored", "Feedback re-anchors by its stable block ID when the block returns", feedback["block_id"] == "hero" and feedback["anchorStatus"] == "active", feedback),
        ])
    elif tool == "respond_to_feedback":
        feedback = final["feedback"][0]; response = feedback.get("responses", [{}])[-1]
        if transition["id"] == "respond-with-body":
            checks.extend([
                _check("body-only-response", "Body-only response is stored without a revision and leaves feedback open", response.get("body") == "I am investigating this request." and response.get("revision_id") is None and response.get("resolved") is False and feedback.get("status") == "open", response),
                _check("body-response-attribution", "Body-only response is attributed to the agent", response.get("actor_identity_id") == AGENT_ID, response),
                _check("body-response-preserves-work", "Body-only response preserves lifecycle, artifact, shared state, revisions, and version", final.get("party", {}).get("lifecycle") == "revising" and final.get("artifact") == initial.get("artifact") and final.get("runtime_state") == initial.get("runtime_state") and final.get("revisions") == initial.get("revisions") and final.get("version") == initial.get("version"), final.get("party")),
            ])
        else:
            checks.extend([
                _check("linked-resolution", "Resolution points to the revision that explicitly linked feedback", feedback.get("status") == "resolved" and response.get("revision_id") == REVISION_2 and FEEDBACK_ID in final["revisions"][-1]["feedback_ids"], {"feedback": feedback, "revision": final["revisions"][-1]}),
                _check("response-attribution", "Resolution is attributed to the agent", response.get("actor_identity_id") == AGENT_ID and feedback.get("resolved_by_identity_id") == AGENT_ID, response),
                _check("resolution-preserves-work", "Resolution does not mutate artifact, shared state, or version", final.get("artifact") == initial.get("artifact") and final.get("runtime_state") == initial.get("runtime_state") and final.get("version") == initial.get("version"), final.get("version")),
            ])
    elif tool == "finalize_party":
        snapshot = final.get("final", {})
        checks.extend([
            _check("owner-finalization", "Owner actor finalizes the matching version", initial.get("party", {}).get("access") == "owner" and snapshot.get("actor_identity_id") == AGENT_ID and snapshot.get("source_version") == initial.get("version"), snapshot),
            _check("feedback-finalization", "Only active open feedback requires an explicit recorded override", snapshot.get("open_feedback_overridden") is bool(_open_feedback(initial, active_only=True)), snapshot.get("open_feedback_overridden")),
            _check("exact-final-source", "Final blocks are an exact immutable source snapshot", snapshot.get("blocks") == initial.get("artifact", {}).get("blocks"), snapshot.get("blocks")),
            _check("exact-final-state", "Final shared state is an exact immutable snapshot", snapshot.get("runtime_state") == initial.get("runtime_state"), snapshot.get("runtime_state")),
            _check("final-preserves-live-source", "Finalization does not alter live artifact or shared state", final.get("artifact") == initial.get("artifact") and final.get("runtime_state") == initial.get("runtime_state"), final.get("runtime_state")),
            _check("final-prunes-snapshots", "Finalization retains lightweight revision metadata while pruning every heavy historical snapshot", not final.get("_revision_snapshots") and all(item.get("snapshot_available") is False and item.get("snapshot_pruned") is True and isinstance(item.get("snapshot_bytes"), int) for item in final.get("revisions", [])), final.get("revisions")),
            _check("final-retains-history", "Pruning preserves feedback and all lightweight revision fields", final.get("feedback") == initial.get("feedback") and all({key: after.get(key) for key in ("id", "version", "source", "changed_block_ids", "feedback_ids", "summary", "actor_identity_id", "created_at", "snapshot_bytes")} == {key: before.get(key) for key in ("id", "version", "source", "changed_block_ids", "feedback_ids", "summary", "actor_identity_id", "created_at", "snapshot_bytes")} for before, after in zip(initial.get("revisions", []), final.get("revisions", []), strict=True)), {"feedback": final.get("feedback"), "revisions": final.get("revisions")}),
            _check("final-availability", "Finalized availability excludes every mutation including delete and restore", _available_operations(final) == ["get_party", "get_feedback", "get_final_artifact"], _available_operations(final)),
        ])
        checks.extend(_export_checks(snapshot, initial["artifact"], initial["runtime_state"]))
    elif tool == "eval_full_journey":
        feedback = final["feedback"][0]; revision = final["revisions"][-1]; snapshot = final["final"]
        checks.extend([
            _check("journey-statuses", "Journey reaches finalized through two attributed revisions", [item["source"] for item in final["revisions"]] == ["set_artifact", "update_blocks"] and revision["actor_identity_id"] == AGENT_ID, final["revisions"]),
            _check("journey-targeting", "Journey changes only hero and preserves details/state", revision["changed_block_ids"] == ["hero"] and final["artifact"]["blocks"][1] == initial["journey_expected_details"] and final["runtime_state"]["details"] == {"expanded": False}, {"artifact": final["artifact"], "state": final["runtime_state"]}),
            _check("journey-feedback", "Human feedback is linked, resolved, and agent-attributed", feedback["actor_identity_id"] == HUMAN_ID and feedback["status"] == "resolved" and feedback["responses"][0]["actor_identity_id"] == AGENT_ID and feedback["responses"][0]["revision_id"] == revision["id"] and revision["feedback_ids"] == [feedback["id"]], feedback),
            _check("capability-and-override", "Share finalization and unoverridden open feedback are rejected", "owner capability required" in final["capability_probes"].get("share_finalize", "") and "explicit override required" in final["capability_probes"].get("open_feedback_without_override", ""), final.get("capability_probes")),
            _check("journey-final", "Resolved journey final stores exact source/state without override", snapshot["blocks"] == final["artifact"]["blocks"] and snapshot["runtime_state"] == final["runtime_state"] and snapshot["source_version"] == 2 and snapshot["open_feedback_overridden"] is False, snapshot),
            _check("immutable-probe", "Post-final mutation is rejected and exact final snapshot remains unchanged", "immutable" in final["capability_probes"].get("post_finalize_mutation", "") and final.get("final_unchanged_after_probe") is True, final.get("capability_probes")),
        ])
        checks.extend(_export_checks(snapshot, final["artifact"], final["runtime_state"]))
    return checks


def _self_check():
    assert len(PUBLIC_TOOLS) == 11 and len(set(PUBLIC_TOOLS)) == 11
    assert resolve_state({"party": None}) == "no_party"
    assert _block_ids(["hero", "details"]) == ["hero", "details"]
    artifact = {"format": "buildparty.artifact/v1", "title": "First", "blocks": []}
    assert _validate_artifact(artifact)["blocks"] == []
    data = {
        "party": {"id": PARTY_ID, "lifecycle": "initialized", "access": "owner"},
        "actor": {"id": AGENT_ID, "name": "Planning Agent", "kind": "agent"},
        "artifact": None, "runtime_state": None, "version": None,
        "feedback": [], "revisions": [], "final": None,
    }
    invoke("set_artifact", data, {"artifact": artifact})
    invoke("set_artifact", data, {"artifact": {**artifact, "title": "Replacement"}})
    assert data["version"] == 2 and data["artifact"]["title"] == "Replacement"
    state_data = deepcopy(data)
    state_artifact = {"format": "buildparty.artifact/v1", "title": "State", "blocks": [{"id": "hero", "kind": "sandbox", "source": {"html": "<p>State</p>"}, "initialState": {}}]}
    invoke("set_artifact", state_data, {"artifact": state_artifact, "expectedVersion": 2})
    deep = {"value": 1}
    for _ in range(18):
        deep = {"nested": deep}
    for invalid in (
        {"artifact": state_artifact, "expectedVersion": 2, "statePatch": {}, "resetState": True},
        {"artifact": state_artifact, "expectedVersion": 2, "statePatch": {"unknown": {"value": 1}}},
        {"artifact": state_artifact, "expectedVersion": 2, "statePatch": {"hero": {"__proto__": {}}}},
        {"artifact": state_artifact, "expectedVersion": 2, "statePatch": {"hero": deep}},
        {"artifact": state_artifact, "expectedVersion": 2, "statePatch": {"hero": {"value": "x" * 100_001}}},
    ):
        try:
            invoke("set_artifact", deepcopy(data), invalid)
            raise AssertionError(f"accepted invalid set state input: {invalid}")
        except ValueError:
            pass
    replacement = {"format": "buildparty.artifact/v1", "title": "Replacement state", "blocks": [{"id": "details", "kind": "sandbox", "source": {"html": "<p>Details</p>"}, "initialState": {"open": False}}]}
    replaced = deepcopy(state_data)
    invoke("set_artifact", replaced, {"artifact": replacement, "expectedVersion": 3})
    assert replaced["runtime_state"] == {"details": {"open": False}}
    for invalid in (
        {"expectedVersion": 3, "statePatch": {}, "resetState": True},
        {"expectedVersion": 3, "statePatch": {"unknown": {"value": 1}}},
        {"expectedVersion": 3, "statePatch": {"hero": []}},
        {"expectedVersion": 3, "statePatch": {"hero": {"__proto__": {}}}},
        {"expectedVersion": 3, "statePatch": {"hero": deep}},
        {"expectedVersion": 3, "statePatch": {"hero": {"value": "x" * 100_001}}},
    ):
        try:
            invoke("update_blocks", deepcopy(state_data), invalid)
            raise AssertionError(f"accepted invalid state input: {invalid}")
        except ValueError:
            pass
    assert UUID.fullmatch("00000000-0000-8000-8000-000000000001")
    assert not UUID.fullmatch("00000000-0000-9000-8000-000000000001")


if __name__ == "__main__":
    _self_check()
    print("adapter self-check passed: 11 public tools")
