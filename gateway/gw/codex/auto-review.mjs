import {actionFingerprint} from "./auto-mcp.mjs";
const states=new Set(["inProgress","approved","denied","timedOut","aborted"]);
const labels={inProgress:"审核中",approved:"已允许",denied:"已拒绝",timedOut:"审核超时",aborted:"已取消"};
export class AutoReviewState{
 constructor({server,emit=()=>{},push=()=>{}}){this.closed=false;this.server=server;this.emit=emit;this.push=push;this.targets=new Map();this.reviews=new Map();this.permits=new Map();}
 target(item){if(this.closed)return;if(item?.type!=="mcpToolCall"||item.server!==this.server||typeof item.id!=="string")return;this.targets.set(item.id,{name:item.tool,args:item.arguments??{}});for(const r of this.reviews.values())this.grant(r);}
 grant(r){
  if(r.granted||r.status!=="approved"||!r.target)return;
  const a=this.targets.get(r.target);if(!a)return;
  const fp=actionFingerprint(a.name,a.args);this.permits.set(fp,(this.permits.get(fp)||0)+1);r.granted=true;
 }
 handle(method,p){
  if(this.closed)return true;
  if(!["item/autoApprovalReview/started","item/autoApprovalReview/completed"].includes(method))return false;
  if(typeof p.reviewId!=="string"||!states.has(p.review?.status))return true;
  let r=this.reviews.get(p.reviewId);if(r&&r.status!=="inProgress")return true;
  const status=p.review.status,rationale=typeof p.review.rationale==="string"?p.review.rationale.slice(0,3000):"";
  if(!r){r={id:p.reviewId,role:"note",key:"auto-review-"+p.reviewId,reviewer:"auto_review",status:"inProgress",target:typeof p.targetItemId==="string"?p.targetItemId:null,turnId:p.turnId};this.reviews.set(p.reviewId,r);this.push(r);}
  r.status=status;r.rationale=rationale;r.text="自动判断："+labels[status]+(rationale?"\n"+rationale:"");this.grant(r);
  this.emit({type:"note",key:r.key,text:r.text,autoReview:{id:r.id,status,rationale,reviewer:"auto_review"}});
  return true;
 }
 take(name,args){if(this.closed)return false;const fp=actionFingerprint(name,args),count=this.permits.get(fp)||0;if(!count)return false;this.permits.set(fp,count-1);return true;}
 close(){this.closed=true;for(const r of this.reviews.values())if(r.status==="inProgress"){r.status="aborted";r.text="自动判断：已取消";this.emit({type:"note",key:r.key,text:r.text,autoReview:{id:r.id,status:r.status,reviewer:"auto_review"}});}this.permits.clear();}
 snapshot(){return [...this.reviews.values()].map(({id,status,rationale})=>({id,status,rationale}));}
}
