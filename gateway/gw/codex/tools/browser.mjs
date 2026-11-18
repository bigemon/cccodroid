export function registerBrowserTool(registry,openBrowser){
 if(!openBrowser)return;
 registry.register({name:"cccodroid_open_browser",description:"Ask the active conversation UI to open an HTTP(S) URL in CCCDroid's browser/preview pane. Use for localhost development previews. Requires execution approval. This requests opening; it does not prove the page loaded. Verify with Android device screen tools or Chromium. Does not execute page JavaScript or automate a remote browser.",inputSchema:{type:"object",properties:{url:{type:"string",maxLength:8192}},required:["url"],additionalProperties:false},handler:async({url},ctx)=>{
  let parsed;try{parsed=new URL(url);}catch{throw new Error("Invalid browser URL");}
  if(!["http:","https:"].includes(parsed.protocol))throw new Error("Only HTTP(S) browser URLs are supported");
  await openBrowser(parsed.href,ctx.callId);return "Requested the active UI to open "+parsed.href+". Verify the page with screen_read/screenshot or Chromium before claiming success.";
 }});
}
