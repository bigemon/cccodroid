// 原生工具批准与 MCP 采集表单共用 RPC；只接已在 0.166.0 实测的空表单批准形态。
export const nativeApprovalResponse=action=>({action,content:action==="accept"?{}:null,_meta:null});
const object=v=>v&&typeof v==="object"&&!Array.isArray(v);
export function nativeToolApproval(msg,{threadId,turnId,maxArgumentBytes=null}){
  const p=msg?.params,meta=p?._meta,schema=p?.requestedSchema;
  if(msg?.method!=="mcpServer/elicitation/request"||msg.id==null||!p||!turnId
    ||p.threadId!==threadId||p.turnId!==turnId||p.mode!=="form"
    ||!object(meta)||meta.codex_approval_kind!=="mcp_tool_call"
    ||!object(schema)||schema.type!=="object"||!object(schema.properties)
    ||Object.keys(schema.properties).length||(schema.required!=null&&(!Array.isArray(schema.required)||schema.required.length))
    ||Object.keys(schema).some(k=>!["type","properties","required","$schema","additionalProperties"].includes(k))
    ||typeof p.serverName!=="string"||!p.serverName||p.serverName.length>160
    ||typeof p.message!=="string"||!p.message||p.message.length>4000
    ||!object(meta.tool_params))return null;
  let args;try{const text=JSON.stringify(meta.tool_params);if(maxArgumentBytes===null?text.length>32768:Buffer.byteLength(text)>maxArgumentBytes)return null;args=JSON.parse(text);}catch{return null;}
  return {requestId:msg.id,serverName:p.serverName,message:p.message,arguments:args,
    description:typeof meta.tool_description==="string"?meta.tool_description.slice(0,4000):""};
}

// 仅保存界面用的文本摘要，不把原生图片/base64 或未知对象写入事件和界面历史。
export function nativeToolResult(item){
  if(item.error)return String(item.error.message||"原生工具执行失败").slice(0,20000);
  const text=(Array.isArray(item.result?.content)?item.result.content:[]).map(c=>c?.type==="text"?(typeof c.text==="string"?c.text:""):"["+(typeof c?.type==="string"?c.type:"content")+"]").join("\n");
  return text.length>20000?text.slice(0,20000)+"\n…（显示已截断，核心仍收到完整结果）":text;
}
