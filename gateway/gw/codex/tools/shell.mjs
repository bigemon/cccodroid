// 结构化 Shell：只接受固定动作，不接受任意命令字符串
//
// 为什么不给自由命令：
//   - Android 上没有内核沙箱可用，自由命令等于把整个应用 UID 交出去；
//   - 固定动作 + argv 数组，命令注入面为零；
//   - 需要新命令时改这里的枚举，而不是让模型自由拼字符串。

import fs from "node:fs";
import { ToolError } from "../paths.mjs";
import { runProcess, which } from "./exec.mjs";

const ACTIONS = ["pwd", "node_version", "git_branch", "git_log", "list_symlinks"];

export function registerShellTools(registry, { guard, env = null } = {}) {
  const processEnv = env ? { env, inheritEnv: false } : {};
  registry.register({
    name: "cccodroid_shell",
    description:
      "Run one of a fixed set of read-only actions in the workspace. This is NOT a general shell: action must be one of pwd, node_version, git_branch, git_log, list_symlinks.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ACTIONS, description: "Fixed action name" },
        cwd: { type: "string", description: "Directory relative to the working directory. Default '.'" },
        limit: { type: "integer", description: "For git_log: number of commits (default 5)" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: async ({ action, cwd, limit = 5 } = {}) => {
      const dir = cwd ? guard.resolve(cwd) : guard.cwd;
      switch (action) {
        case "pwd":
          return dir;
        case "node_version": {
          const res = await runProcess({ ...processEnv, cmd: process.execPath, args: ["--version"], cwd: dir, timeoutMs: 10000 });
          return res.stdout.trim() || res.stderr.trim();
        }
        case "git_branch": {
          const res = await runProcess({ ...processEnv, cmd: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: dir, timeoutMs: 10000 });
          if (res.code !== 0) throw new ToolError("git-branch-failed", res.stderr.slice(0, 400));
          return res.stdout.trim();
        }
        case "git_log": {
          const n = Math.max(1, Math.min(50, Number(limit) || 5));
          const res = await runProcess({ ...processEnv, cmd: "git", args: ["log", "--oneline", "-n", String(n)], cwd: dir, timeoutMs: 15000 });
          if (res.code !== 0) throw new ToolError("git-log-failed", res.stderr.slice(0, 400));
          return res.stdout.trim() || "(还没有提交)";
        }
        case "list_symlinks": {
          const out = [];
          const walk = (abs, depth) => {
            if (depth > 4 || out.length > 200) return;
            for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
              if (e.name === ".git" || e.name === "node_modules") continue;
              const full = `${abs}/${e.name}`;
              if (e.isSymbolicLink()) out.push(`${full} -> ${fs.readlinkSync(full)}`);
              else if (e.isDirectory()) walk(full, depth + 1);
            }
          };
          walk(dir, 0);
          return out.length ? out.join("\n") : "(没有符号链接)";
        }
        default:
          throw new ToolError("unknown-action", `不支持的 action: ${action}`);
      }
    },
  });

  registry.register({
    name: "cccodroid_run_tests",
    description:
      "Run the project's test entry with a fixed runner. runner=node executes `node <path>`; npm runs `npm test`; python executes `python3 <path>`; make runs `make`. Only runs inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        runner: { type: "string", enum: ["node", "npm", "python", "make"], description: "Test runner" },
        path: { type: "string", description: "Script path for node/python runners" },
        cwd: { type: "string", description: "Directory relative to the working directory. Default '.'" },
        timeoutMs: { type: "integer", description: "Timeout in ms, default 60000, cap 180000" },
      },
      required: ["runner"],
      additionalProperties: false,
    },
    timeoutMs: 200000,
    handler: async ({ runner, path: rel, cwd, timeoutMs = 60000 } = {}) => {
      const dir = cwd ? guard.resolve(cwd) : guard.cwd;
      const timeout = Math.max(1000, Math.min(180000, Number(timeoutMs) || 60000));

      let cmd;
      let args;
      if (runner === "node") {
        if (!rel) throw new ToolError("path-required", "runner=node 需要 path");
        const file = guard.resolve(rel);
        cmd = process.execPath;
        args = [file];
      } else if (runner === "python") {
        const py = which("python3") || which("python");
        if (!py) throw new ToolError("python-missing", "找不到 python3");
        if (!rel) throw new ToolError("path-required", "runner=python 需要 path");
        cmd = py;
        args = [guard.resolve(rel)];
      } else if (runner === "npm") {
        const npm = which("npm");
        if (!npm) throw new ToolError("npm-missing", "找不到 npm");
        cmd = npm;
        args = ["test", "--silent"];
      } else if (runner === "make") {
        const make = which("make");
        if (!make) throw new ToolError("make-missing", "找不到 make");
        cmd = make;
        args = [];
      } else {
        throw new ToolError("unknown-runner", `不支持的 runner: ${runner}`);
      }

      const res = await runProcess({ ...processEnv, cmd, args, cwd: dir, timeoutMs: timeout, maxBytes: 128 * 1024 });
      const header = `$ ${runner}${rel ? ` ${rel}` : ""}  (cwd=${guard.display(dir)}, exit=${res.code}, ${res.ms}ms${res.timedOut ? ", TIMEOUT" : ""})`;
      const body = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
      return `${header}\n${body || "(无输出)"}`;
    },
  });
}
