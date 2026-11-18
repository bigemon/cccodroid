// 权限在宿主工具执行入口检查；不把模型提示词或 externalSandbox 声明当成隔离。
export const CODEX_PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];
export const SHARED_READ_TOOLS=new Set(["cccodroid_pwd","cccodroid_read_file","cccodroid_read_image","cccodroid_list_files","cccodroid_search","cccodroid_git_status","cccodroid_git_diff","cccodroid_git_log","cccodroid_shell"]);
const READ_TOOLS = new Set(["cccodroid_pwd", "cccodroid_read_file", "cccodroid_read_image", "cccodroid_list_files",
  "cccodroid_search", "cccodroid_git_status", "cccodroid_git_diff", "cccodroid_git_log",
  "cccodroid_shell", "cccodroid_ask_user", "cccodroid_update_plan", "cccodroid_read_command", "cccodroid_stop_command", "cccodroid_list_commands"]);
const EDIT_TOOLS = new Set(["cccodroid_write_file", "cccodroid_edit_file"]);
export const toolEffect = name => READ_TOOLS.has(name) ? "read" : EDIT_TOOLS.has(name) ? "edit" : "execute";
export const validCodexMode = mode => CODEX_PERMISSION_MODES.includes(mode);

export function codexToolPolicy({ mode = "default", confirm = null } = {}) {
  let current = validCodexMode(mode) ? mode : "default", revision = 0;
  return {
    get mode() { return current; },
    setMode(mode) {
      if (!validCodexMode(mode)) return false;
      if (mode !== current) { current = mode; revision++; }
      return true;
    },
    async authorize({ name, args, callId, agentId, requestId }) {
      const effect = toolEffect(name);
      if (effect === "read" || current === "bypassPermissions" || (effect === "edit" && current === "acceptEdits")) return;
      const deny = message => { throw Object.assign(new Error(message), { code: "permission-denied" }); };
      if (current === "plan") deny("当前为计划模式：宿主不执行写文件或脚本。请先完成计划，等待用户切换执行模式。");
      const version = revision;
      if (!confirm || !await confirm({ name, args, callId, ...(agentId?{agentId}:{}), ...(requestId!==undefined?{requestId}:{}) })) deny("用户未批准这次工具操作。请说明受阻内容，不要换工具绕过。");
      if (version !== revision) deny("权限模式已变化，本次批准已失效，请重新评估操作。");
    },
  };
}
