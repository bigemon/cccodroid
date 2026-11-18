// 其余原生权限请求的保守回退：只接受少量明确的只读命令。
// 结构化升级、原生文件变更仍拒绝（写入走宿主工具）。
// 明确的原生 MCP 工具批准已由 native-approvals / questions 接入 UI；
// 普通表单、URL 及未知请求不在此处自动批准。

const SANDBOX_ESCALATION_RE =
  /(sandbox|沙箱|权限错误|permission denied|outside (the )?sandbox|沙箱外|提权|escalat|elevat|override|override sandbox)/i;

const ALLOWED_COMMAND_PATTERNS = [
  /^pwd$/,
  /^git status( --short)?$/,
  /^git rev-parse --show-toplevel$/,
  /^command -v git$/,
];

export const DEFAULT_POLICY = { allowedCwds: [], allowSessionWrites: false, allowNetworkEscalation: false };

function deny(category, detail = null) {
  return { decision: "decline", category, detail };
}

function hasEscalationFields(p) {
  return Boolean(
    p?.additionalPermissions ||
      p?.proposedExecpolicyAmendment ||
      (Array.isArray(p?.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length) ||
      p?.networkApprovalContext,
  );
}

function cwdAllowed(cwd, allowedCwds) {
  if (!allowedCwds || allowedCwds.length === 0) return true;
  if (!cwd) return false;
  return allowedCwds.some((root) => cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`));
}

function decisionsAllowPlainAccept(available) {
  if (!Array.isArray(available) || available.length === 0) return true;
  return available.some((d) => d === "accept" || d === "acceptForSession");
}

function commandActionsAreReadOnly(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return true;
  return actions.every((a) => a && ["read", "listFiles", "search"].includes(a.type));
}

function commandIsAllowlisted(cmd) {
  if (typeof cmd !== "string") return false;
  const s = cmd.trim();
  if (!s || s.length > 200) return false;
  if (/[|&;`$<>]/.test(s)) return false;
  return ALLOWED_COMMAND_PATTERNS.some((re) => re.test(s));
}

/** 评估一个审批类 server request */
export function evaluateApproval(msg, policy = DEFAULT_POLICY) {
  const method = String(msg?.method || "");
  const p = msg?.params || {};

  if (method === "item/commandExecution/requestApproval") {
    if (p.kind && p.kind !== "command") return deny("non-command-kind", { kind: p.kind });
    if (hasEscalationFields(p)) return deny("structured-escalation");
    if (typeof p.reason === "string" && SANDBOX_ESCALATION_RE.test(p.reason)) return deny("sandbox-escalation-reason");
    if (!decisionsAllowPlainAccept(p.availableDecisions)) return deny("no-plain-accept");
    if (!commandActionsAreReadOnly(p.commandActions)) return deny("non-read-command-actions");
    if (!cwdAllowed(p.cwd, policy.allowedCwds)) return deny("cwd-not-allowed", { cwd: p.cwd });
    if (!commandIsAllowlisted(p.command)) return deny("command-not-allowlisted", { command: String(p.command || "").slice(0, 120) });
    return { decision: "accept", category: "allowlisted-readonly" };
  }
  if (method === "item/fileChange/requestApproval") return deny("file-change");
  if (method === "item/permissions/requestApproval") return deny("permission-request");
  if (method === "item/tool/requestUserInput") return deny("user-input");
  if (method === "mcpServer/elicitation/request") return deny("mcp-elicitation");
  if (method === "account/chatgptAuthTokens/refresh") return deny("auth-token-refresh");
  if (method === "attestation/generate") return deny("attestation");
  if (method === "item/tool/call") return deny("dynamic-tool-handled-elsewhere");
  return deny("unknown-request", { method });
}

export class ApprovalBroker {
  constructor({ policy = DEFAULT_POLICY, log = () => {} } = {}) {
    this.policy = policy;
    this.log = log;
    this.seen = new Set();
    this.events = [];
  }
  handle(msg) {
    const id = msg?.id;
    if (id !== undefined && id !== null) {
      if (this.seen.has(id)) {
        const rec = { id, method: msg?.method, decision: "decline", category: "duplicate-request" };
        this.events.push(rec);
        return { decision: "decline", category: "duplicate-request" };
      }
      this.seen.add(id);
    }
    const result = evaluateApproval(msg, this.policy);
    this.events.push({ id: id ?? null, method: msg?.method, ...result });
    return result;
  }
}

export function buildApprovalResponse(method, decision) {
  const accept = decision?.decision === "accept";
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: accept ? "accept" : "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    default:
      return null;
  }
}
