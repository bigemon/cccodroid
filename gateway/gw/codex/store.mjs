// Codex 会话索引与历史存储
//
// 目录：$HOME/.ccapp-codex/
//   sessions.json       索引：threadId → { id, backend, threadId, cwd, title, model, createdAt, updatedAt }
//   <threadId>.json     历史 items（与 Claude 的 /api/session/:id 同形状）
//
// 只写自己的目录，不碰 ~/.claude 下的任何东西。

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CFG, log } from "../config.mjs";
import {HistoryMetadataCache,historyStamp,historyFileStamp,historyDigest,plainHistoryArray} from "./history-metadata.mjs";
const HISTORY_META = new HistoryMetadataCache();

const DIR = path.join(CFG.home, ".ccapp-codex");
const INDEX = path.join(DIR, "sessions.json");

function ensureDir() {
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  } catch {}
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj, onWritten = null) {
  ensureDir();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const text = JSON.stringify(obj, null, 2);
    const data = onWritten ? Buffer.from(text, "utf8") : text;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
    onWritten?.(historyFileStamp(file), historyDigest(data));
    return true;
  } catch (err) {
    log(`[codex] 写 ${path.basename(file)} 失败: ${err.message}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
}

export function loadIndex() {
  const j = readJson(INDEX, null);
  if (j && j.version === 1 && j.sessions && typeof j.sessions === "object") return j;
  return { version: 1, sessions: {} };
}

function saveIndex(idx) {
  writeJson(INDEX, idx);
}

/** 合并进 /api/sessions 的条目（与 Claude 的 listSessions 输出同字段） */
export function listCodexSessions() {
  const idx = loadIndex();
  return Object.values(idx.sessions)
    .filter(s => s?.backend === "codex" && !s.trash)
    .map((s) => {
      let mtime = s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0;
      let sizeKb = 0;
      try {
        const f = path.join(DIR, `${s.id}.json`);
        const st = fs.statSync(f);
        mtime = Math.max(mtime, st.mtimeMs);
        sizeKb = Math.round(st.size / 1024);
      } catch {}
      return {
        id: s.id,
        backend: "codex",
        title: s.title || "(无标题)",
        cwd: s.cwd || "",
        mtime,
        sizeKb,
        created: s.createdAt ? Date.parse(s.createdAt) || 0 : 0,
        pinned: 0,
        renamed: false,
        archived: false,
        currentProject: false,
        model: s.model || null,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function getCodexSession(id, { includeTrashed = false } = {}) {
  const idx=loadIndex();
  if (!id || !Object.hasOwn(idx.sessions, id)) return null;
  const s = idx.sessions[id];
  return s && s.backend === "codex" && (includeTrashed || !s.trash) ? s : null;
}

export function isCodexSession(id) {
  return Boolean(getCodexSession(id));
}

export function upsertCodexSession(rec) {
  const idx = loadIndex();
  const prev = idx.sessions[rec.id] || {};
  if (prev.trash) throw new Error("会话在回收站中，请先恢复。");
  idx.sessions[rec.id] = {
    ...prev,
    ...rec,
    backend: "codex",
    createdAt: prev.createdAt || rec.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveIndex(idx);
  return idx.sessions[rec.id];
}

export function touchCodexSession(id, patch = {}) {
  const idx = loadIndex();
  if (!idx.sessions[id] || idx.sessions[id].trash) return null;
  Object.assign(idx.sessions[id], patch, { updatedAt: new Date().toISOString() });
  saveIndex(idx);
  return idx.sessions[id];
}

export function readHistory(id) { return loadHistory(id); }

function loadHistory(id, remember = true) {
  if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) return {items:[],complete:false,epoch:"missing"};
  const file = path.join(DIR, id + ".json");
  HISTORY_META.forget(file);
  let j, fd, before, after, digest;
  try {
    fd=fs.openSync(file,"r");before=remember?historyStamp(fs.fstatSync(fd,{bigint:true})):null;
    let bytes=fs.readFileSync(fd);digest=remember?historyDigest(bytes):null;const text=bytes.toString("utf8");bytes=null;
    j=JSON.parse(text);after=remember?historyStamp(fs.fstatSync(fd,{bigint:true})):null;
  } catch(err) {
    if(err.code!=="ENOENT")throw Object.assign(new Error("Codex 历史记录无法读取，未覆盖原文件。"),{status:409});
    return {items:[],complete:false,epoch:"missing"};
  } finally { if(fd!==undefined)fs.closeSync(fd); }
  if(!Array.isArray(j?.items))throw Object.assign(new Error("Codex 历史记录格式异常，未覆盖原文件。"),{status:409});
  const history={items:j.items,complete:j.version===2 ? j.complete===true : j.items.length<2000,
    epoch:j.epoch && j.epoch!=="legacy" ? j.epoch : "legacy:"+id,source:j.source||"host"};
  if(remember&&before===after)HISTORY_META.remember(file,after,digest,history);
  return history;
}

export function saveItems(id, items, options = {}) {
  if(!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id) || !Array.isArray(items) || getCodexSession(id,{includeTrashed:true})?.trash)return false;
  const file=path.join(DIR,id+".json");
  let prev;try{prev=HISTORY_META.get(file);if(!prev){const {complete,epoch,source}=loadHistory(id,false);prev={complete,epoch,source};}}catch(err){log("[codex] "+err.message);return false;}
  const record={version:2,id,items,
    complete:options.complete ?? prev.complete,epoch:options.newEpoch ? randomUUID() : prev.epoch==="missing"||prev.epoch==="legacy" ? randomUUID() : prev.epoch,
    source:options.source||prev.source||"host"};
  HISTORY_META.forget(file);
  return writeJson(file,record,plainHistoryArray(items)?(stamp,digest)=>HISTORY_META.remember(file,stamp,digest,record):null);
}

// 删除意图先落盘；未完成同步时阻止下一轮使用旧界面缓存。
export function setHistoryMutation(id, mutation, {clearDerived=false}={}) {
  const idx=trashIndex(),rec=idx.sessions[id];
  if(!rec||rec.backend!=="codex"||rec.trash)throw new Error("会话不可用，未更新历史操作状态。");
  if(mutation)rec.historyMutation=mutation;else delete rec.historyMutation;
  if(clearDerived)for(const key of ["plan","usage","subagents","subagentsAt","lastSkillInputs"])delete rec[key];
  rec.updatedAt=new Date().toISOString();
  if(!writeJson(INDEX,idx))throw new Error("历史操作状态保存失败。");
}
export function readItems(id) { return readHistory(id).items; }

export function backupHistory(id) {
  readHistory(id);ensureDir();
  const src=path.join(DIR,id+".json");
  if(!fs.existsSync(src))return null;
  const name=id+".history-backup-"+randomUUID()+".json";
  fs.copyFileSync(src,path.join(DIR,name),fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(DIR,name),0o600);return name;
}

export function removeCodexSession(id) {
  const idx = loadIndex();
  if (!idx.sessions[id] || idx.sessions[id].trash) return false;
  delete idx.sessions[id];
  saveIndex(idx);
  try {
    fs.rmSync(path.join(DIR, `${id}.json`), { force: true });
  } catch {}
  return true;
}

// 记录包导入：只新增，不覆盖既有索引/历史；索引提交失败时清理本次新建文件。
export function restoreCodexRecord(record,data,mtime=null){
 if(!record||typeof record.id!=="string"||!(/^[A-Za-z0-9_-]{1,200}$/).test(record.id)||["__proto__","constructor","prototype"].includes(record.id)||!Buffer.isBuffer(data))throw new Error("Codex 记录参数无效，未导入。");
 ensureDir();
 let idx;
 try{idx=JSON.parse(fs.readFileSync(INDEX,"utf8"));}
 catch(err){if(err.code!=="ENOENT")throw new Error("Codex 会话索引无法读取，未导入或覆盖原索引。");idx={version:1,sessions:{}};}
 if(idx?.version!==1||!idx.sessions||typeof idx.sessions!=="object"||Array.isArray(idx.sessions))throw new Error("Codex 会话索引格式异常，未导入。");
 const file=path.join(DIR,record.id+".json");
 if(Object.hasOwn(idx.sessions,record.id)||fs.existsSync(file))return false;
 fs.writeFileSync(file,data,{flag:"wx",mode:0o600});
 try{
  if(mtime)fs.utimesSync(file,new Date(),new Date(mtime));
  idx.sessions[record.id]={...record,backend:"codex"};
  if(!writeJson(INDEX,idx))throw new Error("Codex 会话索引保存失败，未导入。");
 }catch(err){fs.unlinkSync(file);throw err;}
 return true;
}

// 本机回收站只提交索引状态，不移动/改写历史，更不改原生 Codex 线程。
// 严格读取用于破坏性操作；损坏索引不能被当成空索引覆盖。
function trashIndex() {
  let idx;
  try { idx=JSON.parse(fs.readFileSync(INDEX,"utf8")); }
  catch(err) { if(err.code==="ENOENT")return {version:1,sessions:{}};throw new Error("Codex 会话索引无法读取，原记录已保留。"); }
  if(idx?.version!==1||!idx.sessions||typeof idx.sessions!=="object"||Array.isArray(idx.sessions))throw new Error("Codex 会话索引格式异常，原记录已保留。");
  return idx;
}
// 项目移动只原子更新 cwd；损坏/过期索引和写盘失败均保留原记录。
export function moveCodexRecordCwd(id,cwd,expectedCwd){
  if(typeof cwd!=="string"||!path.isAbsolute(cwd))throw new Error("目标工作目录无效。");
  const idx=trashIndex(),rec=trashRecord(idx,id);
  if(!rec||rec.trash||rec.cwd!==expectedCwd)throw Object.assign(new Error("会话记录已变化，请刷新后再移动。"),{status:409});
  rec.cwd=cwd;
  if(!writeJson(INDEX,idx))throw Object.assign(new Error("会话工作目录保存失败，原记录已保留。"),{status:500});
  return rec;
}
function trashRecord(idx,id) {
  if(typeof id!=="string"||!(/^[A-Za-z0-9_-]{1,200}$/).test(id)||!Object.hasOwn(idx.sessions,id))return null;
  const rec=idx.sessions[id];return rec?.id===id&&rec.backend==="codex"?rec:null;
}
function commitTrash(idx) {
  if(!writeJson(INDEX,idx))throw new Error("Codex 回收站保存失败，请重试。");
}
const trashView=rec=>rec?.trash?{...rec.trash,id:rec.id,backend:"codex",scope:"app-records",cwd:rec.cwd||""}:null;
export function codexTrashMeta(id) {
  return trashView(getCodexSession(id,{includeTrashed:true}));
}
export function listCodexTrash() {
  return Object.values(loadIndex().sessions).filter(s=>s?.backend==="codex"&&s.trash).map(trashView);
}
export function trashCodexRecord(id,metadata={}) {
  const idx=trashIndex(),rec=trashRecord(idx,id);
  if(!rec)return {ok:false,error:"not found"};
  if(rec.trash)return {ok:true};
  const st=fs.statSync(path.join(DIR,id+".json"));
  if(!st.isFile())throw new Error("Codex 历史文件不可用，未移入回收站。");
  rec.trash={deletedAt:Date.now(),title:metadata.title||rec.title||"(无标题)",renamed:metadata.renamed===true,pinned:metadata.pinned||0,mtime:st.mtimeMs,size:st.size};
  commitTrash(idx);return {ok:true};
}
export function restoreCodexTrash(id) {
  const idx=trashIndex(),rec=trashRecord(idx,id);
  if(!rec?.trash)return {ok:false,error:"not found"};
  if(rec.trash.purging)return {ok:false,error:"记录正在清理，无法恢复；请重试彻底删除。"};
  if(!fs.statSync(path.join(DIR,id+".json")).isFile())throw new Error("Codex 历史文件不可用，未恢复。");
  const meta={...rec.trash};delete rec.trash;commitTrash(idx);
  return {ok:true,meta};
}
export function purgeCodexTrash(id) {
  const idx=trashIndex(),rec=trashRecord(idx,id);
  if(!rec?.trash)return false;
  // 先持久化清理状态；中途失败仍留在回收站，可重试，不能把不完整历史恢复出来。
  rec.trash.purging=true;commitTrash(idx);
  for(const name of fs.readdirSync(DIR)) {
    if(name===id+".json"||(name.startsWith(id+".history-backup-")&&name.endsWith(".json")))fs.rmSync(path.join(DIR,name),{force:true});
  }
  delete idx.sessions[id];commitTrash(idx);return true;
}

export const CODEX_DIR = DIR;

// Strict read for cross-backend bookmark ownership: unreadable is not the same as missing.
export function codexBookmarkIndex() {
  try { return {ok:true,sessions:trashIndex().sessions}; }
  catch { return {ok:false,sessions:null}; }
}
