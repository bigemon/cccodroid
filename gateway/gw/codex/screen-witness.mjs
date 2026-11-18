// Owned Codex app-server identity for the existing signed native process witness.
import crypto from "node:crypto";
const sessions = new Map(), clients = new Map();
const valid = t => typeof t === "string" && /^[a-f0-9]{32}$/.test(t);
export function screenToken(sid = null) {
  if (sid && sessions.has(sid)) return sessions.get(sid);
  const token = crypto.randomBytes(16).toString("hex");
  bindScreenToken(sid, token);
  return token;
}
export function bindScreenToken(sid, token) {
  if (!sid || !valid(token)) return;
  sessions.set(sid, token);
  while (sessions.size > 500) sessions.delete(sessions.keys().next().value);
}
export function registerScreenClient(child, token) {
  if (!child?.pid || !valid(token)) return () => {};
  const entry = { child, token };
  clients.set(child.pid, entry);
  const revoke = () => { if (clients.get(child.pid) === entry) clients.delete(child.pid); };
  child.once("exit", revoke);
  child.once("error", revoke);
  return revoke;
}
export function codexScreenWitness(ancestor, top) {
  for (const {child,token} of clients.values()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (ancestor === process.pid ? top === child.pid : ancestor === child.pid) return token;
  }
  return "";
}
