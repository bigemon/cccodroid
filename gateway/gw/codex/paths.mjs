// 路径守卫：把所有工具的文件访问限制在允许根目录内
//
// 说明（不要高估它）：
//   - 这里做的是 realpath 解析后的前缀检查，能挡住 `..`、绝对路径、符号链接指向外部；
//   - 它挡不住宿主进程本身被攻破，也不是内核级隔离（Android 无 root 没有 bwrap）；
//   - 所有判断都基于真实路径，不做字符串长度游戏。

import fs from "node:fs";
import path from "node:path";

export class ToolError extends Error {
  constructor(code, message = code, detail = null) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.detail = detail;
  }
}

function isInside(target, root) {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}

/**
 * @param {string[]} roots 允许访问的根目录（必须存在）
 * @param {string} base   相对路径的解析基准（通常是会话 cwd）
 */
export function makePathGuard(roots, base = null) {
  if (!Array.isArray(roots) || roots.length === 0) throw new ToolError("no-roots");
  const realRoots = roots.map((r) => {
    const abs = path.resolve(r);
    if (!fs.existsSync(abs)) throw new ToolError("root-missing", `root does not exist: ${abs}`);
    return fs.realpathSync(abs);
  });
  const cwd = base ? fs.realpathSync(path.resolve(base)) : realRoots[0];

  /** 把输入路径规范化为真实绝对路径 */
  function resolve(input, { allowMissing = false } = {}) {
    if (typeof input !== "string" || input.length === 0) throw new ToolError("path-required");
    if (input.length > 4096) throw new ToolError("path-too-long");
    if (input.includes("\0")) throw new ToolError("path-nul");

    const abs = path.resolve(cwd, input);

    let real;
    if (fs.existsSync(abs)) {
      real = fs.realpathSync(abs);
    } else {
      if (!allowMissing) throw new ToolError("path-not-found", `not found: ${input}`);
      // 找到最近的存在祖先，再拼回相对尾巴（避免用不存在的路径绕过 realpath）
      const tails = [];
      let cur = abs;
      for (;;) {
        const parent = path.dirname(cur);
        if (parent === cur) throw new ToolError("path-not-found");
        tails.unshift(path.basename(cur));
        cur = parent;
        if (fs.existsSync(cur)) break;
      }
      real = path.join(fs.realpathSync(cur), ...tails);
    }

    if (!realRoots.some((root) => isInside(real, root))) {
      throw new ToolError("path-outside-root", `path is outside allowed roots: ${input}`, { real });
    }
    return real;
  }

  /** 相对根目录显示，用于日志与结果展示 */
  function display(real) {
    const root = realRoots
      .slice()
      .sort((a, b) => b.length - a.length)
      .find((r) => isInside(real, r));
    if (!root) return real;
    const rel = path.relative(root, real);
    return rel === "" ? "." : rel;
  }

  return { roots: realRoots, cwd, resolve, display };
}

/** 限制单次输出大小，避免把整个大文件灌回模型 */
export function clampText(text, maxBytes) {
  const buf = Buffer.from(String(text), "utf8");
  if (buf.length <= maxBytes) return { text: String(text), truncated: false, bytes: buf.length };
  const head = buf.subarray(0, maxBytes).toString("utf8");
  return { text: head, truncated: true, bytes: buf.length };
}
