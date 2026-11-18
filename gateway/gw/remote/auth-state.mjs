import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const hex = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const pass = value => value && value.v === 1 && typeof value.salt === "string" && typeof value.hash === "string";
function atomic(file, value) {
  const tmp = file + ".tmp." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  try {
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
// A single committed snapshot is authoritative for both the manager and proxy.
// Existing installations keep their old session key/token until the user saves
// an authentication change. No credentials are migrated merely by opening UI.
export class RemoteAuthStore {
  constructor(home, legacyAllowRt = () => false) {
    this.home = home;
    this.file = path.join(home, ".ccremote-auth.json");
    this.legacyAllowRt = legacyAllowRt;
  }
  legacySecret(name) {
    const file = path.join(this.home, name);
    try { const value = fs.readFileSync(file, "utf8").trim(); if (hex(value)) return value; } catch {}
    const value = crypto.randomBytes(32).toString("hex");
    atomic(file, value + "\n"); return value;
  }
  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    if (raw !== undefined) {
      let value;
      try { value = JSON.parse(raw); } catch {}
      if (!value || value.v !== 1 || !["password", "rt"].includes(value.mode) ||
          !hex(value.token) || !hex(value.key) || !hex(value.revision) ||
          (value.mode === "password" ? !pass(value.password) : value.password !== null) ||
          typeof value.allowRt !== "boolean") {
        throw new Error("认证状态损坏，请恢复认证配置");
      }
      return value;
    }
    let password = null;
    try { const p = JSON.parse(fs.readFileSync(path.join(this.home, ".ccremote-pass.json"), "utf8")); if (pass(p)) password = p; } catch {}
    const value = {
      v: 1, mode: password ? "password" : "rt", password,
      token: this.legacySecret(".ccremote-secret"),
      key: this.legacySecret(".ccremote-session-key"),
      allowRt: !!this.legacyAllowRt(),
    };
    value.revision = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    return value;
  }
  replace(next, expectedRevision) {
    const current = this.read();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      const e = new Error("认证设置已更改，请取消草稿后重新编辑"); e.status = 409; throw e;
    }
    const value = { ...current, ...next, v: 1, revision: crypto.randomBytes(32).toString("hex") };
    if (!["password", "rt"].includes(value.mode) || !hex(value.token) || !hex(value.key) ||
        (value.mode === "password" ? !pass(value.password) : value.password !== null))
      throw new Error("认证配置无效");
    atomic(this.file, JSON.stringify(value) + "\n");
    // The committed snapshot governs live readers. Mirror old files afterward
    // for rollback / legacy tools; a mirror failure cannot undo a committed save.
    this.compatibilityWarning = false;
    try {
      atomic(path.join(this.home, ".ccremote-session-key"), value.key + "\n");
      atomic(path.join(this.home, ".ccremote-secret"), value.token + "\n");
      const oldPass = path.join(this.home, ".ccremote-pass.json");
      if (value.password) atomic(oldPass, JSON.stringify(value.password) + "\n");
      else try { fs.unlinkSync(oldPass); } catch (e) { if (e.code !== "ENOENT") throw e; }
      const cfg = path.join(this.home, ".ccremote-config.json");
      if (fs.existsSync(cfg)) {
        const previous = JSON.parse(fs.readFileSync(cfg, "utf8"));
        atomic(cfg, JSON.stringify({ ...previous, allowRt: value.allowRt }) + "\n");
      }
    } catch { this.compatibilityWarning = true; }
    return value;
  }
  save({ mode, password, token }, revision) {
    const current = this.read();
    if (revision !== current.revision) {
      const e = new Error("认证设置已更改，请取消草稿后重新编辑"); e.status = 409; throw e;
    }
    if (!["password", "rt"].includes(mode)) throw new Error("认证模式无效");
    if (token !== undefined && !hex(token)) throw new Error("token 必须是 64 位十六进制字符串");
    if (mode === "password" && !password && current.mode !== "password") throw new Error("请先设置口令");
    const unchanged = mode === current.mode && !password && (!token || token === current.token) && !current.allowRt;
    if (unchanged) return { state: current, changed: false };
    const next = {
      mode, password: mode === "password" ? (password || current.password) : null,
      token: mode === "rt" && token ? token : crypto.randomBytes(32).toString("hex"),
      key: crypto.randomBytes(32).toString("hex"), allowRt: false,
    };
    return { state: this.replace(next, revision), changed: true };
  }
}
