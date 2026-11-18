import assert from "node:assert/strict";
import { accessAddresses, urlHost, isWifiInterface } from "../gw/remote/access-addresses.mjs";

const ip = (address, internal = false) => ({address, internal});
const interfaces = {
  lo: [ip("127.0.0.1", true), ip("::1", true)],
  wlan0: [ip("192.0.2.10"), ip("2001:db8:1::10"), ip("fe80::10")],
  tun0: [ip("100.64.0.2"), ip("fd01::2"), ip("fe80::2%tun0")],
  rmnet_data0: [ip("198.51.100.2"), ip("2001:db8:2::2")],
  duplicate: [ip("192.0.2.10")],
  invalid: [ip("0.0.0.0"), ip("::"), ip("ff02::1"), ip("127.0.0.2"), ip("bad")],
};
const options = {host:"0.0.0.0",port:18792};
let checks = 0;
const test=(name,fn)=>{fn();checks++;console.log("ok "+name);};
test("IPv4 wildcard lists Wi-Fi, VPN and cellular without IPv6 or duplicates",()=>{
 const rows=accessAddresses(options,interfaces);
 assert.deepEqual(new Set(rows.map(r=>r.url)),new Set([
  "http://192.0.2.10:18792/","http://100.64.0.2:18792/","http://198.51.100.2:18792/"
 ]));
 assert.equal(rows.length,3);
});
test("specific bind lists only that interface",()=>{
 const rows=accessAddresses({...options,host:"192.0.2.10"},interfaces);
 assert.deepEqual(rows.map(r=>r.url),["http://192.0.2.10:18792/"]);
});
test("IPv6 wildcard lists both families and brackets IPv6 literals",()=>{
 const rows=accessAddresses({...options,host:"::"},interfaces);
 assert.equal(rows.length,6);
 assert(rows.some(r=>r.url==="http://[fd01::2]:18792/"));
 assert(rows.some(r=>r.url==="http://[2001:db8:2::2]:18792/"));
 assert(rows.every(r=>!r.url.includes("fe80")&&!r.url.includes("127.")));
});
test("specific IPv6 bind never lists unrelated NICs",()=>{
 assert.deepEqual(accessAddresses({...options,host:"2001:db8:1::10"},interfaces).map(r=>r.url),["http://[2001:db8:1::10]:18792/"]);
});
test("expanded IPv6 bind matches canonical interface addresses",()=>{
 assert.deepEqual(accessAddresses({...options,host:"2001:0db8:0001:0:0:0:0:0010"},interfaces).map(r=>r.url),["http://[2001:db8:1::10]:18792/"]);
});
test("scoped link-local bind is skipped without throwing",()=>{
 assert.deepEqual(accessAddresses({...options,host:"fe80::10%wlan0"},interfaces),[]);
});
test("local-only listeners expose no remote candidate",()=>{
 for(const host of ["127.0.0.1","127.0.0.2","::1","localhost"])
  assert.deepEqual(accessAddresses({...options,host},interfaces),[]);
});
test("explicit public hostname is preserved as configured",()=>{
 const rows=accessAddresses({...options,publicHost:"remote.example.invalid"},interfaces);
 assert(rows.some(r=>r.url==="http://remote.example.invalid:18792/"&&r.label==="对外地址"));
 assert.equal(rows.length,4);
});
test("explicit public IP deduplicates against interfaces",()=>{
 assert.equal(accessAddresses({...options,publicHost:"192.0.2.10"},interfaces).length,3);
});
test("legacy rt is retained for every candidate without lossy encoding",()=>{
 const rt="test+only/credential=";
 for(const r of accessAddresses({...options,rt},interfaces))assert.equal(new URL(r.url).searchParams.get("rt"),rt);
});
test("interface disappearance is reflected on next list",()=>{
 const next=structuredClone(interfaces);delete next.rmnet_data0;
 assert(!accessAddresses(options,next).some(r=>r.url.includes("198.51.100")));
 next.wlan0=[ip("192.0.2.20")];delete next.duplicate;
 assert(accessAddresses(options,next).some(r=>r.url.includes("192.0.2.20")));
 assert(!accessAddresses(options,next).some(r=>r.url.includes("192.0.2.10")));
});
test("no NICs yields an empty list without wildcard or loopback QR",()=>{
 assert.deepEqual(accessAddresses(options,{}),[]);
});
test("hostname listener retained without guessing NIC bindings",()=>{
 assert.deepEqual(accessAddresses({...options,host:"host.example.invalid"},interfaces).map(r=>r.url),["http://host.example.invalid:18792/"]);
});
test("URL authority brackets IPv6 exactly once and preserves IPv4 and DNS",()=>{
 assert.equal(urlHost("2001:db8::10"),"[2001:db8::10]");
 assert.equal(urlHost("[::1]"),"[::1]");
 assert.equal(urlHost("192.0.2.10"),"192.0.2.10");
 assert.equal(urlHost("remote.example.invalid"),"remote.example.invalid");
});
test("common Android Wi-Fi names include hotspot and Wi-Fi Direct",()=>{
 for(const name of ["wlan0","wlan2","wifi0","swlan0","ap0","p2p0"])assert.equal(isWifiInterface(name),true,name);
 for(const name of ["rmnet_data2","tun0","eth0","lo","wlan","wireguard0"])assert.equal(isWifiInterface(name),false,name);
});
test("Wi-Fi classification survives deduplication and comes first in both families",()=>{
 const rows=accessAddresses({...options,host:"::"},interfaces);
 assert.deepEqual(rows.slice(0,2).map(r=>r.wifi),[true,true]);
 assert(rows.slice(0,2).every(r=>r.label.startsWith("wlan0")));
 assert(rows.slice(2).every(r=>r.wifi===false));
});
test("public-host deduplication does not erase Wi-Fi metadata",()=>{
 const rows=accessAddresses({...options,publicHost:"192.0.2.10"},interfaces);
 assert.equal(rows[0].wifi,true);assert.equal(rows[0].label,"wlan0 · IPv4");
 assert.equal(rows.length,3);
});
test("only Wi-Fi interfaces produce no other-address entries",()=>{
 const rows=accessAddresses({...options,host:"::"},{wlan0:interfaces.wlan0});
 assert.equal(rows.length,2);assert(rows.every(r=>r.wifi));
});
console.log(checks+"/"+checks+" passed");
