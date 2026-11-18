import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {screenToken,bindScreenToken,registerScreenClient,codexScreenWitness} from '../gw/codex/screen-witness.mjs';
const child=pid=>Object.assign(new EventEmitter(),{pid,exitCode:null,signalCode:null});
const a=screenToken('thread-a'),b=screenToken('thread-b');assert.notEqual(a,b);assert.equal(screenToken('thread-a'),a);
const anon=screenToken();bindScreenToken('new-thread',anon);assert.equal(screenToken('new-thread'),anon);
const ca=child(123401),cb=child(123402),revokeA=registerScreenClient(ca,a),revokeB=registerScreenClient(cb,b);
assert.equal(codexScreenWitness(process.pid,ca.pid),a);assert.equal(codexScreenWitness(ca.pid,999),a);
assert.equal(codexScreenWitness(process.pid,cb.pid),b);assert.equal(codexScreenWitness(process.pid,999),'');
assert.equal(codexScreenWitness(999,ca.pid),'');
ca.exitCode=0;assert.equal(codexScreenWitness(process.pid,ca.pid),'');ca.emit('exit');
revokeB();assert.equal(codexScreenWitness(process.pid,cb.pid),'');
const replacement=child(123402),again=screenToken('thread-b'),revokeNew=registerScreenClient(replacement,again);
cb.emit('exit');assert.equal(codexScreenWitness(process.pid,replacement.pid),b); // old PID cleanup cannot delete a replacement
revokeA();revokeNew();assert.equal(codexScreenWitness(process.pid,123402),'');
console.log('PASS screen witness: thread isolation, anonymous binding, idle reconnect identity, unknown process rejection, exit/dispose and PID reuse');
