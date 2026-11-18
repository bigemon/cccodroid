import fs from "node:fs";
import path from "node:path";
import {SETTINGS} from "../settings-store.mjs";
import {PATHS} from "../config.mjs";
// 同步原子提交：取最新设置快照，只更新 Codex 子项，成功后再更新内存。
export function writeCodexSettings(patch){
 const settings={...SETTINGS,codex:{...(SETTINGS.codex||{}),...patch}},temp=PATHS.settings+".codex-defaults-"+process.pid;
 try{
  fs.mkdirSync(path.dirname(PATHS.settings),{recursive:true});
  fs.writeFileSync(temp,JSON.stringify(settings,null,2),{mode:0o600});fs.renameSync(temp,PATHS.settings);
 }catch{try{fs.unlinkSync(temp);}catch{}throw Object.assign(new Error("Codex 设置未能保存，请检查存储后重试。"),{status:502});}
 SETTINGS.codex=settings.codex;
}
