// 两个新加的状态出口：本机自检（195-M.1）、工作岛（195-P.4）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { NEXT } from "../gw/http.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";

const { routeFeedback } = await import("../gw/feedback.mjs");
const { routeSettings } = await import("../gw/settings.mjs");
const W = await import("../gw/work-island.mjs");
const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x");
  for (const r of [routeFeedback, routeSettings]) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
  res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "st-")), oldBin = process.env.CCAPP_BIN;
after(() => { srv.close(); process.env.CCAPP_BIN = oldBin; fs.rmSync(bin, { recursive: true, force: true }); });
const call = async (p, post) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, post ? { method: "POST", body: "{}" } : {}); return { status: r.status, body: await r.json() }; };

test("本机自检：没有结果时如实说；点重新自检就跑，跑完能看到通过 / 失败项；跑着时不另起", async () => {
  fs.writeFileSync(path.join(bin, "cccodroid-selftest"), "#!/bin/sh\nsleep 0.5\necho 'PASS cc'\necho 'PASS git'\necho 'FAIL zig: not found'\necho 'INFO hw h264'\n", { mode: 0o755 });
  process.env.CCAPP_BIN = bin;
  const a = (await call("/api/env-facts")).body;
  assert.equal(a.supported, true);
  const r1 = (await call("/api/env-facts/rerun", true)).body;
  assert.equal(r1.running, true);
  const r2 = (await call("/api/env-facts/rerun", true)).body;
  assert.equal(r2.startedAt, r1.startedAt, "已经在跑就不另起");
  let s;
  for (let i = 0; i < 100; i++) { s = (await call("/api/env-facts")).body; if (!s.running) break; await new Promise((ok) => setTimeout(ok, 100)); }
  assert.equal(s.running, false);
  assert.equal(s.pass, 2);
  assert.deepEqual(s.fail, ["zig: not found"]);
  assert.equal(s.stale, false);
  assert.equal(s.error, null);
});

test("本机自检：没跑出结果 → error 写明原因，旧结果不被冲掉", async () => {
  fs.writeFileSync(path.join(bin, "cccodroid-selftest"), "#!/bin/sh\necho nothing\n", { mode: 0o755 });
  await call("/api/env-facts/rerun", true);
  let s;
  for (let i = 0; i < 100; i++) { s = (await call("/api/env-facts")).body; if (!s.running) break; await new Promise((ok) => setTimeout(ok, 100)); }
  assert.equal(s.error, "empty");
  assert.equal(s.pass, 2, "上一份结果还在");
});

test("工作岛：系统不许起服务 / 没装应用 → 状态带原因；重试会重新检测", async () => {
  const seam = W._islandForTest.seam, orig = { ...seam };
  const was = SETTINGS.workIsland;
  let n = 0, why = "blocked";
  seam.android = () => true;
  seam.detect = (cb) => { n++; cb(false, why, "Error: Can't start from invalid source"); };
  try {
    SETTINGS.workIsland = true;
    W.startWorkIsland();
    const s1 = (await call("/api/work-island")).body;
    assert.equal(s1.wanted, true);
    assert.equal(s1.started, false);
    assert.equal(s1.error.code, "blocked");
    assert.match(s1.error.detail, /invalid source/);
    why = "not_installed";
    const s2 = (await call("/api/work-island/retry", true)).body;
    assert.equal(n, 2, "重试重新检测了");
    assert.equal(s2.error.code, "not_installed");
  } finally { W.stopWorkIsland(); SETTINGS.workIsland = was; Object.assign(seam, orig); }
});

test("特权免确认时长：设置、网关与原生策略使用相同选项", () => {
  const src = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  const html = src("../web/index.html");
  const select = /<select[^>]*id="priv-na-hours"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
  const opts = [...select.matchAll(/<option value="(-?\d+)"/g)].map((m) => Number(m[1]));
  const gateway = /const hours = \[([\d, -]+)\]\.includes\(\+b\.hours\) \? \+b\.hours : 24/.exec(src("../gw/devside.mjs"));
  assert.ok(gateway);
  assert.deepEqual(opts, gateway[1].split(",").map(Number));
  assert.match(src("../web/app/10-settings-device.js"), /hours: Number\(select\.value\)/);
  const policy = src("../../android/java/cc/codroid/NoAskPolicy.java");
  const hours = /HOURS = \{([\d, ]+)PERMANENT\}/.exec(policy);
  const permanent = /PERMANENT = (-?\d+);/.exec(policy);
  assert.ok(hours && permanent);
  assert.deepEqual([...hours[1].split(",").filter((h) => h.trim()).map(Number), Number(permanent[1])], opts);
  assert.match(src("../../android/java/cc/codroid/Priv.java"), /NoAskPolicy\.normalize\(req\.optInt\("hours", 24\)\)/);
});
