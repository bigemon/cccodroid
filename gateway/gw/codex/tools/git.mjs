// Git 只读工具：status / diff / log
//
// 只读，不含 add / commit / checkout / reset。
// 全部通过 argv 调用，不经过 shell；cwd 必须落在允许根目录内。

import { ToolError } from "../paths.mjs";
import { runProcess } from "./exec.mjs";
import {resolveReviewTarget} from "../review-target.mjs";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };

function baseArgs() {
  return ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "safe.directory=*"];
}

export function registerGitTools(registry, { guard } = {}) {
  const cwdOf = (rel) => (rel ? guard.resolve(rel) : guard.cwd);

  registry.register({
    name: "cccodroid_git_status",
    description: "Show git status (porcelain v1 with branch header) for a directory inside the workspace.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Directory relative to the working directory. Default '.'" } },
      additionalProperties: false,
    },
    handler: async ({ cwd } = {}) => {
      const dir = cwdOf(cwd);
      const res = await runProcess({ cmd: "git", args: [...baseArgs(), "status", "--porcelain=v1", "-b"], cwd: dir, env: GIT_ENV, timeoutMs: 15000 });
      if (res.code !== 0) throw new ToolError("git-status-failed", res.stderr.slice(0, 800) || `exit ${res.code}`);
      return res.stdout.trim() || "(工作区干净)";
    },
  });

  registry.register({
    name: "cccodroid_git_diff",
    description: "Show Git changes. Default: unstaged working changes; staged=true: staged changes. For branch reviews set base to the branch (diff from its merge base with HEAD). For commit reviews set commit to its hash (show that commit only). base, commit, and staged are mutually exclusive. Optionally limit to one path.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Directory relative to the working directory. Default '.'" },
        staged: { type: "boolean", description: "Show staged changes instead of unstaged" },
        base: { type: "string", description: "Local or remote-tracking branch to compare from its merge base with HEAD" },
        commit: { type: "string", description: "Commit hash to show, accepts an unambiguous short hash" },
        path: { type: "string", description: "Limit the diff to this path" },
        context: { type: "integer", description: "Unified context lines, default 3" },
      },
      additionalProperties: false,
    },
    handler: async ({ cwd, staged = false, base = null, commit = null, path: p = null, context = 3 } = {}) => {
      const dir = cwdOf(cwd);
      if(Number(base!=null)+Number(commit!=null)+Number(staged)>1)throw new ToolError("git-diff-target","Choose base, commit, or staged, not a combination");
      const flags=["--no-ext-diff","--no-textconv",`--unified=${Math.max(0,Math.min(20,Number(context)||3))}`];
      let args=[...baseArgs(),"diff",...flags];
      if(base!=null){
        const target=await resolveReviewTarget(dir,{type:"baseBranch",branch:base});
        const merge=await runProcess({cmd:"git",args:[...baseArgs(),"merge-base","HEAD",target.branch],cwd:dir,env:GIT_ENV,timeoutMs:10000,maxBytes:8192});
        const oid=merge.stdout.trim();
        if(merge.code!==0||merge.timedOut||merge.aborted||merge.truncated||!/^[a-f0-9]{40,64}$/.test(oid))throw new ToolError("git-diff-target","Cannot read merge base with selected branch");
        args.push(oid);
      }else if(commit!=null){
        const target=await resolveReviewTarget(dir,{type:"commit",sha:commit});
        args=[...baseArgs(),"show",...flags,"--format=fuller","--first-parent",target.sha];
      }else if(staged)args.push("--staged");
      if(p)args.push("--",guard.resolve(p,{allowMissing:true}));
      const res=await runProcess({cmd:"git",args,cwd:dir,env:GIT_ENV,timeoutMs:20000,maxBytes:200*1024});
      if(res.code!==0||res.timedOut||res.aborted)throw new ToolError("git-diff-failed",res.stderr.slice(0,800)||`exit ${res.code}`);
      return (res.stdout.trim()||"(没有差异)")+(res.truncated?"\n[输出已截断]":"");
    },
  });

  registry.register({
    name: "cccodroid_git_log",
    description: "Show recent commits as `git log --oneline -n <limit>`.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Directory relative to the working directory. Default '.'" },
        limit: { type: "integer", description: "Number of commits, default 10, cap 50" },
      },
      additionalProperties: false,
    },
    handler: async ({ cwd, limit = 10 } = {}) => {
      const dir = cwdOf(cwd);
      const n = Math.max(1, Math.min(50, Number(limit) || 10));
      const res = await runProcess({ cmd: "git", args: [...baseArgs(), "log", "--oneline", "-n", String(n)], cwd: dir, env: GIT_ENV, timeoutMs: 15000 });
      if (res.code !== 0) throw new ToolError("git-log-failed", res.stderr.slice(0, 800) || `exit ${res.code}`);
      return res.stdout.trim() || "(还没有提交)";
    },
  });
}
