// 默认轮次内命令；显式 background 跨轮次保留，PTY 复用应用内的执行助手。
export const COMMAND_TOOLS=new Set(["cccodroid_exec_command","cccodroid_read_command","cccodroid_write_command","cccodroid_stop_command","cccodroid_resize_command","cccodroid_list_commands"]);
export const COMMAND_WRITES=new Set(["cccodroid_exec_command","cccodroid_write_command","cccodroid_resize_command"]);
export function registerCommandTools(registry,commands){
 if(!commands)return;
 const object=properties=>({type:"object",properties,additionalProperties:false});
 const id={type:"string",description:"Command id from this conversation; use list_commands after another turn. Other conversations and manual terminals are inaccessible."};
 const wait={type:"integer",description:"Wait 1-10000ms; default 1000."};
 const register=(name,description,properties,required,handler)=>registry.register({name,description,inputSchema:{...object(properties),...(required.length?{required}:{})},timeoutMs:15000,handler});
 register("cccodroid_exec_command","Run a Bash command with live output and execution approval. Returns id, running, exitCode, output and nextCursor. background=true explicitly keeps a managed server/process across turns until stopped or the gateway/session closes; default commands stop at turn end. Background commands have no deadline unless timeout_ms is provided. tty=true requests a PTY for terminal input and Ctrl-C. No login shell config. Use read/write/resize/stop/list_command(s) to manage ids. Processes use the app UID, not an OS sandbox.",
 {command:{type:"string",maxLength:20000},cwd:{type:"string"},yield_time_ms:wait,timeout_ms:{type:"integer",description:"Optional deadline in ms; default 120000 for foreground, none for background; max 1800000 for foreground and 86400000 for background."},background:{type:"boolean"},tty:{type:"boolean"},rows:{type:"integer"},cols:{type:"integer"}},["command"],(args,ctx)=>commands.start(args,ctx.signal,ctx.callId));
 register("cccodroid_read_command","Read/wait for an existing managed command in this conversation, including background commands from earlier turns. Omit cursor to consume unread output; explicit cursor rereads the retained bounded buffer. Does not execute.",{command_id:id,cursor:{type:"integer"},wait_ms:wait,max_output_chars:{type:"integer"}},["command_id"],args=>commands.poll(args));
 register("cccodroid_write_command","Send text or EOF to a running command, with execution approval. PTY accepts terminal input including Ctrl-C. Pipes do not translate Ctrl-C into a signal; use stop_command.",{command_id:id,chars:{type:"string",maxLength:65536},eof:{type:"boolean"},wait_ms:wait},["command_id"],args=>commands.input(args));
 register("cccodroid_resize_command","Resize an existing running PTY, with execution approval. Does not start a new process.",{command_id:id,rows:{type:"integer"},cols:{type:"integer"},wait_ms:wait},["command_id"],args=>commands.resize(args));
 register("cccodroid_stop_command","Stop one managed command and its owned children, including a background process from an earlier turn; return final status/output.",{command_id:id},["command_id"],args=>commands.stop(args));
 register("cccodroid_list_commands","List this conversation's retained managed command ids, running/exit status and recent bounded output. Does not start execution; manual terminals and other conversations are excluded.",{},[],()=>commands.list());
}
