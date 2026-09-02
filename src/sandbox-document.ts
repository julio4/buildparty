import type { SandboxBlock } from "./domain.ts";

const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export const SANDBOX_MIN_HEIGHT = 48;
export const SANDBOX_MAX_HEIGHT = 12_000;
export const SANDBOX_DEFAULT_CSS = `*,*::before,*::after{box-sizing:border-box}html{color-scheme:light}body{margin:0;min-width:0;background:transparent;color:#20231f;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}:where(main,section,article,header,footer,nav,form){display:block}:where(h1,h2,h3,h4){margin:0 0 .6em;line-height:1.15}:where(p,ul,ol,dl,table,figure,blockquote){margin:.75em 0}:where(ul,ol){padding-left:1.5em}:where(img,svg,video,canvas){max-width:100%;height:auto}:where(table){width:100%;border-collapse:collapse}:where(th,td){padding:.55em;text-align:left;border-bottom:1px solid #d7dad2}:where(input,select,textarea,button){max-width:100%;font:inherit}:where(input,select,textarea){padding:.55em .65em;border:1px solid #b9beb4;border-radius:.4em;background:#fff;color:inherit}:where(button){padding:.55em .85em;border:1px solid #aeb4aa;border-radius:.5em;background:#f5f6f2;color:inherit;cursor:pointer}:where(a){color:#315c45;text-underline-offset:.15em}:where(:focus-visible){outline:3px solid rgba(49,92,69,.35);outline-offset:2px}`;

export function clampSandboxHeight(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(SANDBOX_MAX_HEIGHT, Math.max(SANDBOX_MIN_HEIGHT, Math.ceil(value))) : undefined;
}

export function clampSandboxAnchorOffset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(SANDBOX_MAX_HEIGHT, Math.round(value)) : undefined;
}

export function createSandboxDocument(block: SandboxBlock, channel: string, nonce: string): string {
  const source = scriptJson(block.source);
  const identity = scriptJson({ blockId: block.id, channel });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src-elem 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">${SANDBOX_DEFAULT_CSS}</style></head><body><div id="buildparty-root"></div><script nonce="${nonce}">(()=>{
const source=${source},identity=${identity},listeners=new Set(),bad=new Set(['__proto__','prototype','constructor']);let state={};
const clone=value=>structuredClone(value);
const valid=(value,depth=0)=>{if(depth>16)return false;if(value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return true;if(Array.isArray(value))return value.every(item=>valid(item,depth+1));if(typeof value!=='object')return false;return Object.entries(value).every(([key,item])=>!bad.has(key)&&valid(item,depth+1));};
const path=value=>typeof value==='string'&&value.length<=1024&&value.split('.').length<=16&&value.split('.').every(key=>key&&key.length<=64&&!bad.has(key)&&!/^(0|[1-9]\\d*)$/.test(key));
const send=message=>parent.postMessage({...identity,...message},'*');let resizeFrame=0,lastHeight=0;
const reportSize=()=>{resizeFrame=0;const height=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body.scrollHeight));if(Number.isFinite(height)&&height>0&&height!==lastHeight){lastHeight=height;send({type:'bp:resize',height});}};
const scheduleSize=()=>{if(!resizeFrame)resizeFrame=requestAnimationFrame(reportSize);};
const publish=next=>{if(!valid(next)||JSON.stringify(next).length>100000)return;state=clone(next);bind();for(const listener of listeners)listener(clone(state));};
const read=name=>{let value=state;for(const key of name.split('.')){if(!value||typeof value!=='object'||Array.isArray(value))return undefined;value=value[key];}return value;};
const bind=()=>document.querySelectorAll('input,select,textarea').forEach(control=>{if(control.hasAttribute('data-bp-local'))return;const name=control.getAttribute('name')||control.id;if(!path(name))return;const value=read(name);if(value===undefined)return;if(control instanceof HTMLInputElement&&(control.type==='checkbox'||control.type==='radio'))control.checked=control.type==='checkbox'?Boolean(value):String(value)===control.value;else control.value=String(value);});
window.buildParty={getState:()=>clone(state),setState:(name,value)=>{if(path(name)&&valid(value)&&JSON.stringify(value).length<=100000)send({type:'bp:set',path:name,value});},patchState:patch=>{if(valid(patch)&&patch&&!Array.isArray(patch)&&typeof patch==='object'&&JSON.stringify(patch).length<=100000)send({type:'bp:patch',patch});},subscribe:listener=>{if(typeof listener!=='function')throw new TypeError('listener must be a function');listeners.add(listener);return()=>listeners.delete(listener);}};
addEventListener('message',event=>{const message=event.data;if(event.source===parent&&message?.type==='bp:state'&&message.channel===identity.channel)publish(message.state);});
addEventListener('input',event=>{const control=event.target;if(!(control instanceof HTMLInputElement||control instanceof HTMLSelectElement||control instanceof HTMLTextAreaElement)||control.hasAttribute('data-bp-local'))return;const name=control.getAttribute('name')||control.id;if(!path(name)||(control instanceof HTMLInputElement&&control.type==='radio'&&!control.checked))return;const value=control instanceof HTMLInputElement&&control.type==='checkbox'?control.checked:control.value;window.buildParty.setState(name,value);});
addEventListener('click',event=>{const anchor=event.target instanceof Element?event.target.closest('a[href]'):null,href=anchor?.getAttribute('href')?.trim();if(!href?.startsWith('#'))return;event.preventDefault();let id;try{id=decodeURIComponent(href.slice(1));}catch{return;}const target=id?(document.getElementById(id)||document.getElementsByName(id)[0]):document.documentElement;if(target){target.scrollIntoView({behavior:'instant',block:'start'});send({type:'bp:anchor',offset:id?Math.max(0,target.getBoundingClientRect().top):0});}},true);
const style=document.createElement('style');style.nonce=${scriptJson(nonce)};style.textContent=source.css||'';document.head.append(style);document.getElementById('buildparty-root').innerHTML=source.html;bind();new ResizeObserver(scheduleSize).observe(document.documentElement);new ResizeObserver(scheduleSize).observe(document.getElementById('buildparty-root'));scheduleSize();send({type:'bp:ready'});
})()</script><script nonce="${nonce}">${escapeScript(block.source.js ?? "")}</script></body></html>`;
}

function escapeScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}
