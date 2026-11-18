import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 使用当前 Node，避免 Android 上缺少 /usr/bin/env 导致 mock 启动失败。
export function fakeCodexBin(dir) {
  const shell = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const script = fileURLToPath(new URL("../fake-codex.mjs", import.meta.url));
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const bin = path.join(dir, "fake-codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bin, "#!" + shell + "\nexec " + quote(process.execPath) + " " + quote(script) + ' "$@"\n', { mode: 0o700 });
  return bin;
}
