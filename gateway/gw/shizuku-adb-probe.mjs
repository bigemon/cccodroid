import net from "node:net";

export function localPortOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = value => { s.destroy(); resolve(value); };
    s.setTimeout(500, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}
// CNXN receives STLS from a wireless-debugging endpoint. Probe before handing
// ports from ss to adb so unrelated local HTTP/services cannot stall discovery.
export function localAdbTls(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: "127.0.0.1", port });
    let data = Buffer.alloc(0), finished = false;
    const done = value => { if (finished) return; finished = true; s.destroy(); resolve(value); };
    s.setTimeout(500, () => done(false));
    s.on("error", () => done(false));
    s.on("end", () => done(false));
    s.on("data", b => {
      data = Buffer.concat([data, b]);
      if (data.length >= 4) done(data.subarray(0, 4).toString() === "STLS");
    });
    s.on("connect", () => {
      const body = Buffer.from("host::\0");
      const packet = Buffer.alloc(24 + body.length);
      const cnxn = 0x4e584e43;
      [cnxn, 0x01000001, 4096, body.length, [...body].reduce((a, b) => a + b, 0), (cnxn ^ 0xffffffff) >>> 0]
        .forEach((v, i) => packet.writeUInt32LE(v, i * 4));
      body.copy(packet, 24); s.write(packet);
    });
  });
}
