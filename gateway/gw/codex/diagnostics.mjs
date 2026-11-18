// 只读诊断：配置值严格白名单；不返回 layers、instructions、认证字段或原始异常。
import fs from "node:fs";
import { CFG } from "../config.mjs";
import { SETTINGS } from "../settings-store.mjs";
import { agentClient } from "./agent.mjs";
import { getCodexSession } from "./store.mjs";
import { codexEffective } from "./catalog.mjs";
import { codexDiagnosticSource } from "./run.mjs";
import { DEFAULT_SERVER_ARGS } from "./session.mjs";
import { MAX_SLEEP_GRACE_MS } from "./sleep.mjs";
import { buildToolRegistry } from "./tools/index.mjs";

import { safeConfig } from "./diagnostic-view.mjs";
export async function codexDiagnostics(sid = null) {
  const rec = sid ? getCodexSession(sid) : null;
  if (sid && !rec) return { error: "unknown_codex_session" };
  const cwd = rec?.cwd || (fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home);
  const cwdAvailable = fs.existsSync(cwd);
  const source = codexDiagnosticSource(sid);
  const selected = await codexEffective(sid);
  let config = { state: "unavailable", fields: {} };
  try {
    if (!cwdAvailable) throw new Error("cwd-unavailable");
    const client = source?.client || await agentClient();
    config = { state: "available", fields: safeConfig(await client.call("config/read", { cwd, includeLayers: false }, 20000)) };
  } catch { /* old cores may not support config/read; selected/host capabilities still available */ }
  const registry = source?.registry || buildToolRegistry({ roots: [cwdAvailable ? cwd : CFG.home], cwd: cwdAvailable ? cwd : CFG.home, askUser: async () => ({ answers: {} }), updatePlan: async () => {} }).registry;
  return {
    backend: "codex", sessionId: sid || null, cwd, cwdAvailable,
    selected: { model: selected.model, effort: selected.effortRun, permissionMode: selected.permissionMode,
      source: rec ? "session" : SETTINGS.codex?.permissionMode ? "codex-default" : "default" },
    runtime: source?.snapshot || null,
    config,
    capabilities: {
      nativePlan: source ? (source.snapshot.nativePlanSupported ? "supported" : "unsupported") : "unprobed",
      planProgress: { adapted: true, observed: !!rec?.observed?.planProgress,
        nativeObserved: !!rec?.observed?.nativePlanProgress, hostToolObserved: !!rec?.observed?.hostPlanProgress },
      planTool: !sid ? "new-thread" : ((source?.snapshot.declaredTools || rec?.hostTools)?.includes("cccodroid_update_plan") || rec?.observed?.hostPlanProgress) ? "declared" : "unknown",
      hostInteractions:{adapted:true,hostTransport:"native-mcp",scope:"active-parent-thread",unattended:false,dynamicToolReplacement:false},
      messagePhases: { adapted: true, observed: !!rec?.observed?.messagePhases },
      reasoningSummary: { adapted: true, observed: !!rec?.observed?.reasoningSummary },
      subagents:{adapted:true,source:"core-activity",readTools:"native-mcp",writes:"scoped-files-and-fixed-tests",writeScope:"observed-direct-child-active-parent-turn"},
      autoReview:{adapted:true,reviewer:"auto_review",hostTransport:"native-mcp",changeTiming:"between-turns",unattended:false},
      nativeToolApprovals:{adapted:true,scope:"core-prompts",minimum:"writes",readOnlyBasis:"native-tool-annotations",forms:{mode:"form",scope:"active-turn",types:["string","boolean","number","integer","enum","enum-array"],maxFields:10},urlFlows:false,unattended:false},
      skills:{explicitInput:true,lastSubmitted:rec?.lastSkillInputs||null,executionEvidence:"not-reported-by-core"},
      images: "localImage",
      imageGeneration:{adapted:true,transport:"native",display:"existing-tool-image-preview",artifacts:"workspace-files",unattended:false},
      sleep:{adapted:true,transport:"native",display:"existing-tool-step",idleGrace:"reported-duration",maxIdleGraceMs:MAX_SLEEP_GRACE_MS,unattended:false},
      deviceTools:{transport:"native-mcp",settings:"android-device-tools",state:source?.snapshot.deviceTools||"not-loaded"},
      commandExecution: { runtimeAvailable: source?.snapshot.commandToolsAvailable ?? null,
        declared: !!rec?.hostTools?.includes("cccodroid_exec_command"), lifetime: "turn-or-explicit-background", pty: true, backgroundRunning:source?.snapshot.backgroundCommands||0 },
      shell: (source ? source.snapshot.commandToolsAvailable : rec?.hostTools?.includes("cccodroid_exec_command")) ? "host-managed-command-sessions" : "fixed-actions-and-test-runners",
      tools: registry.specs().map(t => t.name),
      // 这是宿主注册表，并不冒充旧线程 dynamicTools 已更新。
      toolScope: source ? "registered-host-tools" : "new-thread-host-tools",
      disabledNative: DEFAULT_SERVER_ARGS.filter((_, i) => i % 2 === 1&&DEFAULT_SERVER_ARGS[i-1]==="--disable"),
    },
    capturedAt: new Date().toISOString(),
  };
}
