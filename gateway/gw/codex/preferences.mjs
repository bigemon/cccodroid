import {writeCodexSettings} from "./settings-write.mjs";
import crypto from "node:crypto";
import {SETTINGS} from "../settings-store.mjs";
import {preferenceModelCatalog,catalogEpoch} from "./catalog.mjs";
import {codexConfig} from "./config.mjs";
import {validDefaults,resolveModelDefaults} from "./model-defaults.mjs";
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const snapshot=()=>JSON.stringify([SETTINGS.codex?.defaults??null,codexConfig().bin,codexConfig().home]);
const revision=()=>crypto.createHash("sha256").update(snapshot()).digest("hex");
async function inspect(){
 const before=snapshot(),catalog=await preferenceModelCatalog();
 if(snapshot()!==before||catalog.epoch!==catalogEpoch())fail("Codex 设置已变化，请重新刷新偏好。");
 const configured=validDefaults(SETTINGS.codex?.defaults),defaults=configured?{...SETTINGS.codex.defaults}:{model:null,effort:null};
 const resolved=resolveModelDefaults(defaults,catalog.models);
 return {backend:"codex",configured,defaults,normalized:resolved.normalized,needsReset:configured&&(resolved.modelReset||resolved.effortReset),
  resolved:{model:resolved.model,effort:resolved.effort,warning:resolved.error},recommended:resolved.defaultModel,revision:revision(),catalogAt:catalog.capturedAt,
  models:catalog.models.map(m=>({id:m.id,name:m.name,hidden:m.hidden,isDefault:m.isDefault,effort:m.effort})),epoch:catalog.epoch};
}
const publicView=({epoch,...state})=>state;
export async function codexPreferences(){return publicView(await inspect());}
export async function setCodexPreferences(body){
 if(!body||typeof body!=="object"||Array.isArray(body)||!(/^[a-f0-9]{64}$/).test(body.revision||""))fail("偏好参数无效，请重新读取。",400);
 if(!["save","normalize"].includes(body.action)||body.action==="save"&&!validDefaults(body.defaults))fail("偏好参数无效，请重新选择。",400);
 const before=revision();if(body.revision!==before)fail("偏好已被其他操作修改，请重新刷新。");
 const state=await inspect();if(before!==revision()||state.epoch!==catalogEpoch())fail("偏好或账号已变化，请重新刷新。");
 const values=body.action==="normalize"?state.defaults:body.defaults,result=resolveModelDefaults(values,state.models);
 const next=result.normalized;
 if(body.action==="normalize"&&!state.needsReset)return {ok:true,saved:false,...publicView(state)};
 writeCodexSettings({defaults:next});
 return {ok:true,saved:true,...publicView({...state,configured:true,defaults:next,normalized:next,needsReset:false,
  resolved:{model:result.model,effort:result.effort,warning:result.error},revision:revision()}),reset:result.modelReset||result.effortReset};
}
