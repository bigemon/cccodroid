// Codex 运行配置：可执行文件、CODEX_HOME、CA。
// 放在单独模块里，避免 catalog/agent 为了读配置而 import 整个 run.mjs（会把会话池一起拉进来）。

import fs from "node:fs";
import path from "node:path";
import {codexRuntimePaths} from "./runtime-paths.mjs";
import { CFG } from "../config.mjs";
import { SETTINGS } from "../settings-store.mjs";

// 隔离验收可传入设置快照，沿用正式运行的环境变量与 CA 默认值。
export function codexConfig(c = SETTINGS.codex || {}) {
  const managed=codexRuntimePaths(CFG.home);
  const bin = c.useManagedRuntime === true ? managed.bin : c.bin || process.env.CCAPP_CODEX_BIN || managed.bin;
  const home = c.home || process.env.CCAPP_CODEX_HOME || managed.home;
  const sslCertFile = c.sslCertFile || process.env.CCAPP_CODEX_CERT
    || (process.env.PREFIX ? path.join(process.env.PREFIX, "etc/tls/cert.pem") : "");
  return { bin, home, sslCertFile, projectsRoot: c.projectsRoot || CFG.workspace };
}

export function codexAvailable() {
  const c = codexConfig();
  return Boolean(c.bin && c.home && fs.existsSync(c.bin) && fs.existsSync(c.home));
}

/** 模型窗口等「按模型学到的」数据落盘位置（只存数字，不存用量） */
export function codexStateFile(name) {
  return path.join(CFG.home, name);
}
