import { toolEffect } from "./permissions.mjs";
export const CODEX_TASK_TOOLS = [
  "cccodroid_pwd","cccodroid_read_file","cccodroid_read_image","cccodroid_list_files","cccodroid_search",
  "cccodroid_git_status","cccodroid_git_diff","cccodroid_git_log","cccodroid_shell",
  "cccodroid_write_file","cccodroid_edit_file","cccodroid_run_tests",
  "cccodroid_exec_command","cccodroid_read_command","cccodroid_write_command","cccodroid_stop_command",
  "cccodroid_update_plan",
];
export function codexTaskPolicy(perm, tools = "") {
  if(!["ro","proj","custom"].includes(perm))throw new Error("Codex 任务权限无效。");
  const allowed=String(tools||"").split(/[,，\n]/).map(s=>s.trim()).filter(Boolean);
  if(perm==="custom"&&allowed.some(name=>!CODEX_TASK_TOOLS.includes(name)))throw new Error("Codex 自定义权限请填写完整工具名，例如 cccodroid_read_file；不支持 Claude 工具表达式。");
  return {perm,allowed:perm==="custom"?[...new Set(allowed)]:[]};
}
export function taskToolAllowed(policy, name) {
  if(!policy)return false;
  if(policy.perm==="custom")return policy.allowed.includes(name);
  return toolEffect(name)==="read" || (policy.perm==="proj"&&toolEffect(name)==="edit");
}
