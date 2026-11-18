// 已验证历史只缓存元数据和摘要；每次命中仍核验磁盘字节，不保留 items 或正文。
import fs from "node:fs";
import crypto from "node:crypto";
export const historyDigest = data => crypto.createHash("sha256").update(data).digest("hex");
export function historyStamp(stat) {
  if (!stat?.isFile() || !["dev","ino","size","mtimeNs","ctimeNs"].every(k => typeof stat[k] === "bigint") || stat.ino === 0n) return null;
  return ["dev","ino","size","mtimeNs","ctimeNs"].map(k => stat[k].toString()).join(":");
}
export function historyFileStamp(file) {
  try { return historyStamp(fs.statSync(file, { bigint: true })); } catch { return null; }
}
export class HistoryMetadataCache {
  constructor(limit = 64) { this.limit = limit; this.entries = new Map(); }
  forget(file) { this.entries.delete(file); }
  get(file) {
    const entry = this.entries.get(file);
    if (!entry) return null;
    try {
      if (entry.stamp !== historyFileStamp(file) || entry.digest !== historyDigest(fs.readFileSync(file))) { this.forget(file); return null; }
    } catch { this.forget(file); return null; }
    this.entries.delete(file); this.entries.set(file, entry);
    return { ...entry.meta };
  }
  remember(file, stamp, digest, { complete, epoch, source }) {
    this.forget(file);
    if (!stamp || stamp !== historyFileStamp(file) || !/^[a-f0-9]{64}$/.test(digest || "") || typeof complete !== "boolean" || typeof epoch !== "string" || !epoch || epoch.length > 256 || typeof source !== "string" || !source || source.length > 128) return;
    this.entries.set(file, { stamp, digest, meta: { complete, epoch, source } });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
  }
}
// 自定义数组序列化可能把 items 写成非数组；这种情况保留下一次完整解析。
export function plainHistoryArray(items) {
  try {
    return Object.getPrototypeOf(items) === Array.prototype && !Object.hasOwn(items, "toJSON")
      && !Object.hasOwn(Array.prototype, "toJSON") && !Object.hasOwn(Object.prototype, "toJSON");
  } catch { return false; }
}
