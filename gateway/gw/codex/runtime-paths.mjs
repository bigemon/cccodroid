import fs from "node:fs";
import path from "node:path";
import {runtimeVersion} from "./runtime-release.mjs";
// Compatibility fallback for the previously installed managed runtime, not the first-install target.
export const CODEX_RUNTIME_VERSION="0.166.0";
export function codexRuntimePaths(home,version=null){
 const root=path.join(home,".local/share/cccodroid/codex"),active=path.join(root,"active.json");
 let selected=version;
 if(!selected)try{
  const saved=JSON.parse(fs.readFileSync(active,"utf8"));
  if(!runtimeVersion(saved.version))throw Error("invalid runtime version");
  selected=saved.version;
 }catch(err){if(err.code!=="ENOENT")throw Error("Codex 当前版本记录无法读取，已保留原环境；请检查后重试");}
 selected ||= CODEX_RUNTIME_VERSION;
 if(!runtimeVersion(selected))throw Error("Codex 版本号无效");
 const release=path.join(root,"releases",selected);
 return {root,active,version:selected,release,bin:path.join(release,"bin/codex"),home:path.join(home,".codex"),
  archive:path.join(root,"downloads",selected+".tar.zst.part")};
}
