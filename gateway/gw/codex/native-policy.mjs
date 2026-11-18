// 线程级审批基线：按声明的只读标记放行读取，其他原生工具交由宿主确认。
const object=v=>v&&typeof v==="object"&&!Array.isArray(v);
const mode=value=>{
  if(value==null||["auto","approve","writes"].includes(value))return "writes";
  if(value==="prompt")return value;
  throw new Error("原生工具审批配置包含当前不支持的模式。");
};
export function nativePolicyOverrides(response,{reviewer="user"}={}){
  if(!["user","auto_review"].includes(reviewer))throw new Error("Unsupported reviewer");
  const c=response?.config;if(!object(c))throw new Error("核心配置不可读取，未启用原生工具审批策略。");
  const overrides={approvals_reviewer:reviewer},stats={apps:0,servers:0,tools:0},changes=[];
  const set=(parts,value)=>{changes.push({parts,value});};
  function tools(prefix,settings,inheritedMode){
    if(settings==null)return;if(!object(settings))throw new Error("原生工具配置格式无法核验。");
    for(const [name,value]of Object.entries(settings)){
      if(!object(value))throw new Error("原生工具配置格式无法核验。");
      set([...prefix,"tools",name,"approval_mode"],mode(value.approval_mode??inheritedMode));stats.tools++;
    }
  }
  const apps=c.apps??{};if(!object(apps))throw new Error("原生应用配置格式无法核验。");
  const defaults=apps._default??{};if(!object(defaults))throw new Error("原生应用默认配置无法核验。");
  set(["apps","_default","default_tools_approval_mode"],mode(defaults.default_tools_approval_mode));
  set(["apps","_default","approvals_reviewer"],reviewer);
  for(const [id,value]of Object.entries(apps)){
    if(id==="_default")continue;if(!object(value))throw new Error("原生应用配置格式无法核验。");
    set(["apps",id,"default_tools_approval_mode"],mode(value.default_tools_approval_mode??defaults.default_tools_approval_mode));
    set(["apps",id,"approvals_reviewer"],reviewer);tools(["apps",id],value.tools,value.default_tools_approval_mode??defaults.default_tools_approval_mode);stats.apps++;
  }
  const servers=c.mcp_servers??{};if(!object(servers))throw new Error("原生 MCP 配置格式无法核验。");
  for(const [id,value]of Object.entries(servers)){
    if(!object(value))throw new Error("原生 MCP 配置格式无法核验。");
    set(["mcp_servers",id,"default_tools_approval_mode"],mode(value.default_tools_approval_mode));
    tools(["mcp_servers",id],value.tools,value.default_tools_approval_mode);stats.servers++;
  }
  // 0.166 的点路径解析器不识别引号转义。普通名称精确覆盖；特殊名称必须完整保留该配置表，
  // 再仅修改审批字段。不可部分替换表，否则会丢失 transport / enabled / env 等原有配置。
  // 完整表可能含凭据，仅经私有 stdio 返回同一核心，不可写日志、诊断或持久化。
  const whole=new Set(changes.filter(({parts})=>parts.some(p=>!/^[A-Za-z0-9_/-]+$/.test(p))).map(({parts})=>parts[0]));
  // config/read 将未设置的可选项补为 null；TOML 无 null，回传时须省略，否则核心转为空字符串。
  const copy=v=>Array.isArray(v)?v.map(copy):object(v)?Object.fromEntries(Object.entries(v).filter(([,x])=>x!==null).map(([k,x])=>[k,copy(x)])):v;
  for(const section of whole)overrides[section]=copy(c[section]??{});
  for(const {parts,value}of changes){
    if(!whole.has(parts[0])){overrides[parts.join(".")]=value;continue;}
    let target=overrides[parts[0]];
    for(const part of parts.slice(1,-1)){
      if(!Object.hasOwn(target,part)||!object(target[part]))Object.defineProperty(target,part,{value:{},writable:true,enumerable:true,configurable:true});
      target=target[part];
    }
    Object.defineProperty(target,parts.at(-1),{value,writable:true,enumerable:true,configurable:true});
  }
  return {overrides,snapshot:{state:"configured",minimum:"writes",reviewer,readOnlyBasis:"native-tool-annotations",...stats}};
}
