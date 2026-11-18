export function normalizeAsyncQuestions(value) {
  if(!Array.isArray(value))return [];
  return value.slice(0,10).filter(q=>q&&typeof q.title==="string"&&q.title.trim()&&q.title.length<=4000).map(q=>({
    title:q.title,options:Array.isArray(q.options)?q.options.filter(x=>typeof x==="string"&&x.length>0&&x.length<=1000).slice(0,12):[]
  }));
}
export const HOST_INTERACTION_INSTRUCTIONS = "When an unresolved user choice is required to continue, use cccodroid_ask_user to show CCCDroid's choice card and wait for the submitted answer. It works in normal and plan modes. Never treat an accepted acknowledgement from request_user_input_async as a user answer. That native tool is nonblocking: its questions appear with an assistant message; continue only work independent of the answer. Do not ask for passwords or tokens.";
