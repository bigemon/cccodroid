// 搜索工具：优先用系统 rg（Termux 里的 aarch64 原生版本），没有则退回纯 JS 遍历
//
// 注意：Codex 包自带的 codex-path/rg 是 glibc 动态二进制，Android 上跑不了；
// 这里用的是 PATH 里的 rg，与 Codex 无关。

import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../paths.mjs";
import { runProcess, which } from "./exec.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", ".gradle", "build", "dist", "__pycache__", ".cache"]);

export function registerSearchTools(registry, { guard, rgPath = null } = {}) {
  const rg = rgPath || which("rg");

  registry.register({
    name: "cccodroid_search",
    description:
      "Search file contents with a regular expression (falls back to plain substring if fixedString is true). Returns matching lines as path:line:text, capped at maxResults.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regexp (or literal string when fixedString=true)" },
        path: { type: "string", description: "Directory or file to search, relative to the working directory. Default '.'" },
        glob: { type: "string", description: "Only search files matching this glob, e.g. '*.js'" },
        fixedString: { type: "boolean", description: "Treat pattern as a literal string" },
        maxResults: { type: "integer", description: "Max matches, default 100, cap 500" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    timeoutMs: 30000,
    handler: async ({ pattern, path: rel = ".", glob = null, fixedString = false, maxResults = 100 }) => {
      if (!pattern) throw new ToolError("empty-pattern");
      const target = guard.resolve(rel);
      const cap = Math.max(1, Math.min(500, Number(maxResults) || 100));

      if (rg) {
        const args = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "400", "--max-filesize", "2M"];
        if (fixedString) args.push("--fixed-strings");
        if (glob) args.push("--glob", glob);
        args.push("--", pattern, target);
        const res = await runProcess({ cmd: rg, args, cwd: guard.cwd, timeoutMs: 25000, maxBytes: 200 * 1024 });
        const lines = res.stdout.split("\n").filter(Boolean);
        if (res.code === 1 && lines.length === 0) return `没有匹配：${pattern}（${guard.display(target)}）`;
        if (res.code !== 0 && res.code !== 1) {
          throw new ToolError("search-failed", `rg 退出码 ${res.code}: ${res.stderr.slice(0, 400)}`);
        }
        const shown = lines.slice(0, cap).map((l) => l.replace(`${target}/`, "").replace(target, guard.display(target)));
        const more = lines.length > cap ? `\n… 还有 ${lines.length - cap} 条未显示` : "";
        return `${shown.join("\n")}${more}\n(${lines.length} 条匹配, ${res.ms}ms)`;
      }

      return jsSearch({ target, pattern, glob, fixedString, cap });
    },
  });
}

function jsSearch({ target, pattern, glob, fixedString, cap }) {
  let re;
  try {
    re = fixedString ? null : new RegExp(pattern, "i");
  } catch (err) {
    throw new ToolError("bad-pattern", `正则不合法: ${err.message}`);
  }
  const needle = fixedString ? pattern.toLowerCase() : null;
  const out = [];
  let scanned = 0;

  const matches = (line) => (re ? re.test(line) : line.toLowerCase().includes(needle));

  const walk = (abs) => {
    if (out.length >= cap) return;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        walk(path.join(abs, e.name));
      }
      return;
    }
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
    if (glob) {
      const rx = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
      if (!rx.test(path.basename(abs))) return;
    }
    scanned += 1;
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && out.length < cap; i += 1) {
      if (matches(lines[i])) out.push(`${abs}:${i + 1}:${lines[i].slice(0, 400)}`);
    }
  };

  walk(target);
  if (!out.length) return `没有匹配：${pattern}（扫描 ${scanned} 个文件）`;
  return `${out.join("\n")}\n(${out.length} 条匹配, 扫描 ${scanned} 个文件)`;
}
