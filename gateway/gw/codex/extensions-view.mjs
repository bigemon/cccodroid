const short=(v,max=200)=>typeof v==="string"?v.slice(0,max):"";
export function skillInventory(response,cwd){
  const entries=response?.data;
  if(!Array.isArray(entries))throw new Error("invalid-skills");
  const entry=entries.find(e=>e.cwd===cwd);
  if(!entry||!Array.isArray(entry.skills)||!Array.isArray(entry.errors))throw new Error("invalid-cwd");
  const skills=entry.skills.slice(0,200).map(s=>({name:short(s.name),path:short(s.path,4096),
    scope:["user","repo","system","admin"].includes(s.scope)?s.scope:"unknown",enabled:s.enabled===true}));
  return {state:"available",source:"core-discovery",skills,errorCount:entry.errors.length,truncated:entry.skills.length>skills.length};
}
export function mcpConfigured(response){
  const servers=response?.config?.mcp_servers;
  if(servers==null)return [];
  if(typeof servers!=="object"||Array.isArray(servers))throw new Error("invalid-mcp-config");
  return Object.entries(servers).slice(0,200).map(([name,c])=>({name:short(name),enabled:c?.enabled!==false}));
}
export function instructionConfig(response){
  const c=response?.config||{},max=c.project_doc_max_bytes;
  return {maxBytes:Number.isSafeInteger(max)&&max>=0?max:null,
    fallbackNames:Array.isArray(c.project_doc_fallback_filenames)?c.project_doc_fallback_filenames.filter(v=>typeof v==="string"&&/^[A-Za-z0-9._-]{1,80}$/.test(v)).slice(0,20):[]};
}
const statuses=["notStarted","starting","connected","authenticationRequired","failed","cancelled","disabled"];
export function mcpInventoryEntry(server){
  const tools=Object.keys(server.tools||{});
  return {name:short(server.name),status:statuses.includes(server.runtimeStatus)?server.runtimeStatus:"unknown",
    auth:["unsupported","notLoggedIn","bearerToken","oAuth"].includes(server.authStatus)?server.authStatus:"unknown",
    tools:tools.slice(0,100).map(v=>short(v)),toolCount:tools.length,toolsTruncated:tools.length>100,toolsUnavailable:!!server.toolsError};
}
export async function readMcpInventory(client,sid){
  const servers=[],seen=new Set();let cursor=null;
  do{
    const page=await client.call("mcpServerStatus/list",{threadId:sid,detail:"toolsAndAuthOnly",limit:50,...(cursor?{cursor}:{})},10000);
    if(!Array.isArray(page.data)||!("nextCursor"in page))throw new Error("invalid-mcp-page");
    if(servers.length+page.data.length>200)throw new Error("mcp-limit");
    servers.push(...page.data.map(mcpInventoryEntry));
    cursor=page.nextCursor;
    if(cursor!=null&&(typeof cursor!=="string"||!cursor||seen.has(cursor)))throw new Error("mcp-cursor");
    if(cursor)seen.add(cursor);
  }while(cursor);
  return {state:"available",scope:"thread",servers};
}
