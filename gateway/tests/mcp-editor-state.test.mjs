import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app/08-extensions.js',import.meta.url),'utf8');
const start=source.indexOf('  let mcpEdit = null;'),end=source.indexOf('  $("tab-ext").addEventListener("click"',start);assert(start>=0&&end>start);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
 const elements=new Map(),gets=new Map(),writes=[],responses=[];
 const $=id=>{if(!elements.has(id)){const set=new Set();elements.set(id,{value:'',disabled:false,dataset:{},innerHTML:'',textContent:'',open:false,handlers:{},classList:{add:n=>set.add(n),remove:n=>set.delete(n),toggle:(n,on)=>on?set.add(n):set.delete(n),contains:n=>set.has(n)},addEventListener(type,fn){this.handlers[type]=fn;},querySelectorAll(){return [];},scrollIntoView(){}});}return elements.get(id);};
 const ctx={$,Set,encodeURIComponent,esc:s=>s,t:s=>s,toast:()=>{},confirm:()=>true,syncMcpHint(){},syncMcpIpTip(){},loadExtMcp(){},api:url=>{const name=new URL(url,'http://fixture').searchParams.get('name'),d=deferred();gets.set(name,d);return d.promise;},post:(url,body)=>{const d=deferred();writes.push({url,body});responses.push(d);return d.promise;}};
 vm.runInNewContext(source.slice(start,end)+'\nglobalThis.editor={open:openMcpEdit,close:endMcpEdit,current:()=>mcpEdit};',ctx);
 const reply=(name)=>({ok:true,name,transport:'http',target:'https://'+name+'.invalid/mcp',envNames:[],headerNames:[]});
 const open=async name=>{const p=ctx.editor.open(name);gets.get(name).resolve(reply(name));await p;};
 return {$,gets,writes,responses,editor:ctx.editor,reply,open,save:()=>$('ext-mcp-save').handlers.click(),add:()=>$('ext-mcp-add').handlers.click()};
}
test('MCP editor: a late A fetch cannot replace a newer B editor',async()=>{
 const f=fixture(),a=f.editor.open('A'),b=f.editor.open('B');f.gets.get('B').resolve(f.reply('B'));await b;f.gets.get('A').resolve(f.reply('A'));await a;assert.equal(f.editor.current().name,'B');assert.equal(f.$('ext-mcp-name').value,'B');
});
test('MCP editor: a late save cannot close another record opened meanwhile',async()=>{
 const f=fixture();await f.open('A');const save=f.save();assert.equal(f.writes[0].body.name,'A');await f.open('B');f.responses[0].resolve({ok:true});await save;assert.equal(f.editor.current()?.name,'B');assert.equal(f.$('ext-mcp-name').value,'B');
});
test('MCP editor: lock mutable fields while saving, then restore them on failure',async()=>{
 const f=fixture();await f.open('A');const save=f.save();for(const id of ['ext-mcp-name','ext-mcp-target','ext-mcp-env','ext-mcp-tr'])assert.equal(f.$(id).disabled,true,id);f.responses[0].resolve({ok:false});await save;for(const id of ['ext-mcp-name','ext-mcp-target','ext-mcp-env','ext-mcp-tr'])assert.equal(f.$(id).disabled,false,id);assert.equal(f.editor.current().name,'A');
});
test('MCP editor: cancelled loading cannot revive the old editor',async()=>{
 const f=fixture(),load=f.editor.open('A');f.editor.close();f.gets.get('A').resolve(f.reply('A'));await load;assert.equal(f.editor.current(),null);
});

test('MCP editor: old save cannot unlock a newer pending save',async()=>{
 const f=fixture();await f.open('A');const a=f.save();await f.open('B');const b=f.save();assert.equal(f.writes.length,2);f.responses[0].resolve({ok:true});await a;assert.equal(f.editor.current().name,'B');assert.equal(f.$('ext-mcp-save').disabled,true);f.responses[1].resolve({ok:false});await b;assert.equal(f.$('ext-mcp-save').disabled,false);
});
test('MCP editor: queued duplicate save does not submit twice',async()=>{
 const f=fixture();await f.open('A');const a=f.save();await f.save();assert.equal(f.writes.length,1);f.responses[0].resolve({ok:true});await a;assert.equal(f.editor.current(),null);
});
test('MCP add: late success cannot clear a newer editor',async()=>{
 const f=fixture();f.$('ext-mcp-name').value='new';f.$('ext-mcp-tr').value='http';const add=f.add();assert.equal(f.writes[0].url,'/api/ext/mcp/add');await f.open('B');f.responses[0].resolve({ok:true});await add;assert.equal(f.$('ext-mcp-name').value,'B');assert.equal(f.editor.current().name,'B');
});
test('MCP add: duplicate submission is ignored and failure keeps draft',async()=>{
 const f=fixture();f.$('ext-mcp-name').value='new';f.$('ext-mcp-tr').value='http';const add=f.add();await f.add();assert.equal(f.writes.length,1);assert.equal(f.$('ext-mcp-name').disabled,true);f.responses[0].resolve({ok:false});await add;assert.equal(f.$('ext-mcp-name').value,'new');assert.equal(f.$('ext-mcp-add').disabled,false);
});
