// Stable, session-scoped host bookmark keys. Does not edit core history or infer by text prefix.
import {createHash} from "node:crypto";
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0,40);
const token=v=>typeof v==="string"&&v.length>0&&v.length<=512;
export const isCodexAnchor=v=>typeof v==="string"&&/^cx[uml]_[a-f0-9]{40}$/.test(v);
export const userBookmarkAnchor=id=>token(id)?"cxu_"+hash(id):"";
export const assistantBookmarkAnchor=(turnId,itemId)=>token(turnId)&&token(itemId)?"cxm_"+hash(["assistant",turnId,itemId]):"";
export function anchorEntries(history,{from=0,to=history.items.length}={}){
 const out=[],users=new Map();
 for(let i=0;i<Math.min(to,history.items.length);i++){
  const m=history.items[i];if(!m||!["user","assistant"].includes(m.role)||typeof m.text!=="string")continue;
  let ordinal=0;if(m.role==="user"&&token(m.turnId)){ordinal=users.get(m.turnId)||0;users.set(m.turnId,ordinal+1);}
  if(i<from)continue;
  let uuid=m.role==="user"?userBookmarkAnchor(m.bookmarkId):assistantBookmarkAnchor(m.turnId,m.itemId);
  if(!uuid&&m.role==="user"&&token(m.turnId))uuid="cxm_"+hash(["user",m.turnId,ordinal,m.text]);
  if(!uuid)uuid="cxl_"+hash([history.epoch,i,m.role,m.text]);
  out.push({index:i,uuid,item:m});
 }
 return out;
}
export function locateAnchor(history,uuid){
 if(!isCodexAnchor(uuid))return null;
 const matches=anchorEntries(history).filter(x=>x.uuid===uuid);
 return matches.length===1?matches[0]:null; // duplicate native IDs are ambiguous, never pick the first.
}
export function anchoredItems(history,from,to){
 const anchors=new Map(anchorEntries(history,{from,to}).map(x=>[x.index,x.uuid]));
 return history.items.slice(from,to).map((m,i)=>anchors.has(from+i)?{...m,uuid:anchors.get(from+i)}:m);
}
