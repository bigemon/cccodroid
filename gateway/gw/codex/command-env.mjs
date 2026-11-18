import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, PREFIX, CHILD_ENV_KEY, INSTANCE_ID } from "../config.mjs";
import { which } from "./tools/exec.mjs";

// 使用独立的工具环境，不借用 Claude 厂商配置，不加载 shell 登录配置。
export function commandEnvironment() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/.test(k)
    || /^(OPENAI_API_KEY|OPENAI_ACCESS_TOKEN|CCAPP_TOKEN|CCAPP_AUTH_TOKEN|BASH_ENV|ENV|CCAPP_SELF_EXE)$/.test(k)) delete env[k];
  env.HOME = CFG.home; env.CI = "1"; env.NO_COLOR = "1"; env.TERM = "dumb";
  env[CHILD_ENV_KEY] = INSTANCE_ID;
  env.CCAPP_RUN = "1";
  env.PATH = [...new Set([PREFIX && path.join(PREFIX, "bin"), process.env.CCAPP_BIN,
    path.dirname(process.execPath), path.join(CFG.home, ".cccodroid", "bin"),
    path.join(PATHS.toolchain, "payload", "bin"), ...String(process.env.PATH || "").split(":"),
    "/system/bin", "/system/xbin"].filter(Boolean))].join(":");
  env.TMPDIR = process.env.TMPDIR || (PREFIX ? path.join(PREFIX, "tmp") : CFG.home);
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  if (process.env.CCAPP_BIONIC_PRELOAD) env.LD_PRELOAD = process.env.CCAPP_BIONIC_PRELOAD;
  else if (PREFIX && process.env.CCAPP_EXEC === "direct") {
    // Modern target-28 clients clear LD_PRELOAD. Command children still need
    // Termux's direct-mode shebang adaptation for /bin/* and /usr/bin/env.
    // Scope this to bionic command children; never preload the Codex server.
    const preload = path.join(PREFIX, "lib", "libtermux-exec-direct-ld-preload.so");
    if (fs.existsSync(preload)) env.LD_PRELOAD = env.CCAPP_BIONIC_PRELOAD = preload;
  }
  if (!/utf-?8/i.test(env.LC_ALL || env.LANG || "")) env.LANG = "C.UTF-8";
  const shell = process.env.CCAPP_SHELL || which("bash", env.PATH);
  if (!shell || !fs.existsSync(shell)) throw new Error("A Bash shell is required for Codex command tools");
  env.SHELL = shell;
  return { shell, env };
}
