import { randomBytes } from "node:crypto";
import type { Artifact, RuntimeState } from "./domain.ts";
import { createSandboxDocument, SANDBOX_MAX_HEIGHT, SANDBOX_MIN_HEIGHT } from "./sandbox-document.ts";

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function renderFinalHtml(artifact: Artifact, runtimeState: RuntimeState): string {
  const nonce = randomBytes(18).toString("base64url");
  const frames = artifact.blocks.map(block => {
    const channel = randomBytes(18).toString("base64url");
    return { id: block.id, title: block.title ?? block.id, channel, document: createSandboxDocument(block, channel, nonce) };
  });
  const data = scriptJson({ frames, runtimeState, minHeight: SANDBOX_MIN_HEIGHT, maxHeight: SANDBOX_MAX_HEIGHT });
  const sections = frames.map(frame => `<section aria-label="${escapeHtml(frame.title)}"><div data-block="${escapeHtml(frame.id)}"></div></section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src-elem 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(artifact.title)}</title><style nonce="${nonce}">*{box-sizing:border-box}html,body,main,section{margin:0;padding:0}body{background:transparent}iframe{display:block;width:100%;height:${SANDBOX_MIN_HEIGHT}px;border:0;background:transparent}</style></head><body><main>${sections}</main><script nonce="${nonce}">(()=>{
const data=${data},bad=new Set(['__proto__','prototype','constructor']),byWindow=new Map(),state=structuredClone(data.runtimeState);
const valid=(value,depth=0)=>{if(depth>16)return false;if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return true;if(Array.isArray(value))return value.every(item=>valid(item,depth+1));if(typeof value!=='object')return false;return Object.entries(value).every(([key,item])=>!bad.has(key)&&valid(item,depth+1));};
const keys=value=>typeof value==='string'&&value.length<=1024&&value.split('.').length<=16&&value.split('.').every(key=>key&&key.length<=64&&!bad.has(key)&&!/^(0|[1-9]\\d*)$/.test(key))?value.split('.'):null;
const send=entry=>entry.frame.contentWindow?.postMessage({type:'bp:state',channel:entry.channel,state:structuredClone(state[entry.id]||{})},'*');
for(const entry of data.frames){const host=document.querySelector('[data-block="'+CSS.escape(entry.id)+'"]'),frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('height',String(data.minHeight));frame.title=entry.title;frame.srcdoc=entry.document;host.append(frame);entry.frame=frame;byWindow.set(frame.contentWindow,entry);frame.addEventListener('load',()=>{byWindow.set(frame.contentWindow,entry);send(entry);});}
addEventListener('message',event=>{const entry=byWindow.get(event.source),message=event.data;if(!entry||message?.channel!==entry.channel)return;if(message.type==='bp:ready'){send(entry);return;}if(message.type==='bp:resize'){const value=message.height,height=typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(data.maxHeight,Math.max(data.minHeight,Math.ceil(value))):0;if(height&&entry.frame.style.height!==height+'px')entry.frame.style.height=height+'px';return;}if(message.type==='bp:anchor'){const value=message.offset,offset=typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.min(data.maxHeight,Math.round(value)):-1;if(offset>=0)scrollTo(0,Math.max(0,scrollY+entry.frame.getBoundingClientRect().top+offset));return;}let next=structuredClone(state[entry.id]||{});if(message.type==='bp:patch'&&valid(message.patch)&&message.patch&&!Array.isArray(message.patch)&&typeof message.patch==='object')next={...next,...message.patch};else if(message.type==='bp:set'){const path=keys(message.path);if(!path||!valid(message.value))return;let target=next;for(const key of path.slice(0,-1)){if(Array.isArray(target[key]))return;if(!target[key]||typeof target[key]!=='object')target[key]={};target=target[key];}target[path.at(-1)]=message.value;}else return;if(!valid(next)||JSON.stringify(next).length>100000)return;state[entry.id]=next;send(entry);});
})()</script></body></html>`;
}
