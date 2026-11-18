import { runProcess } from "./tools/exec.mjs";
export const DIFF_LIMIT = 128 * 1024;
export function coreDiff(turnId, text) {
  return { id: turnId + ":core", source: "core", text: String(text || "").slice(0, DIFF_LIMIT),
    truncated: String(text || "").length > DIFF_LIMIT, at: Date.now() };
}
// 工作区快照明确包含本轮之前的改动；不将它当成模型本轮产生的 patch。
export async function workspaceDiff(cwd) {
  const base = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false"];
  const call = args => runProcess({cmd:"git",args:[...base,...args],cwd,env:{GIT_TERMINAL_PROMPT:"0",GIT_PAGER:"cat"},timeoutMs:10000,maxBytes:DIFF_LIMIT});
  const probe=await call(["rev-parse","--is-inside-work-tree"]);
  if(probe.code!==0||probe.stdout.trim()!=="true")return null;
  const unstaged=await call(["diff","--no-ext-diff","--no-textconv"]);
  const staged=await call(["diff","--cached","--no-ext-diff","--no-textconv"]);
  const untracked=await call(["ls-files","--others","--exclude-standard"]);
  if([unstaged,staged,untracked].some(r=>r.code!==0||r.timedOut||r.aborted))throw new Error("无法读取完整 Git 差异");
  const text=["--- Unstaged ---",unstaged.stdout||"(none)","--- Staged ---",staged.stdout||"(none)",
    "--- Untracked paths (content not included) ---",untracked.stdout||"(none)"].join("\n");
  return {source:"workspace",text:text.slice(0,DIFF_LIMIT),truncated:text.length>DIFF_LIMIT||[unstaged,staged,untracked].some(r=>r.truncated),at:Date.now()};
}
