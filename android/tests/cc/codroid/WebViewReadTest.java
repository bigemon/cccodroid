package cc.codroid;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.JSONObject;
import java.util.*;
/** Executes source-derived production read/walk/node/withScreen against isolated provider stubs. */
public final class WebViewReadTest {
 static int checks;
 static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
 static AccessibilityNodeInfo n(String cls,String text,AccessibilityNodeInfo...children){
  AccessibilityNodeInfo n=new AccessibilityNodeInfo();n.cls=cls;n.text=text;n.children=children;return n;
 }
 static AccessibilityNodeInfo empty(){AccessibilityNodeInfo n=n("android.webkit.WebView","");n.click=true;return n;}
 static AccessibilityNodeInfo full(String label){AccessibilityNodeInfo w=empty();w.children=new AccessibilityNodeInfo[]{n("android.widget.Button",label)};return w;}
 static A11y service(java.util.function.Supplier<AccessibilityNodeInfo> provider){
  TestClock.reset();Priv.blocked=false;MainActivity.blocked=false;android.os.Build.VERSION.SDK_INT=35;
  A11y s=new A11y();s.provider=provider;A11y.self=s;return s;
 }
 static void test(String name,Case run)throws Exception{run.run();checks++;System.out.println("PASS "+name);}
 interface Case{void run()throws Exception;}
 public static void main(String[]args)throws Exception{
  test("first delayed web content resolves within one read",()->{
   AccessibilityNodeInfo shell=empty(),ready=full("Ready");
   A11y s=service(()->TestClock.now<1000?shell:ready);JSONObject r=A11y.read(false);
   check(r.optBoolean("ok")&&r.getInt("count")==2&&!r.optBoolean("screen_partial"),"missing complete tree");
   check(TestClock.now==1000&&s.rootCalls>1,"must requery current root");
   check(s.invalidations>0&&A11y.nodes.get(1)==ready.children[0],"final node numbers differ");
  });
  test("ready one-button WebView has no artificial wait",()->{
   service(()->full("OK"));JSONObject r=A11y.read(false);
   check(r.getInt("count")==2&&TestClock.now==0&&!r.has("screen_partial"),"small page waited");
  });
  test("WebView exposing its own readable text does not wait",()->{
   AccessibilityNodeInfo web=empty();web.text="Accessible paragraph";service(()->web);
   JSONObject r=A11y.read(false);check(TestClock.now==0&&!r.has("screen_partial")&&r.getString("tree").contains("Accessible paragraph"),"accessible root text delayed");
  });
  test("toolbar controls do not hide an empty WebView subtree",()->{
   service(()->n("FrameLayout","",n("Button","back"),n("Button","menu"),empty()));
   JSONObject r=A11y.read(false);check(TestClock.now==2500&&r.optBoolean("screen_partial")&&r.getInt("count")==3,"toolbar masked empty web content");
  });
  test("persistent empty WebView returns bounded explicit partial success",()->{
   service(WebViewReadTest::empty);JSONObject r=A11y.read(false);
   check(r.optBoolean("ok")&&r.optBoolean("screen_partial")&&r.getInt("count")==1,"missing partial");
   check(TestClock.now==2500&&r.getString("screen_warning").contains("Do not repeat"),"unbounded wait");
  });
  test("all mode layout wrappers cannot bypass readiness wait",()->{
   service(()->n("FrameLayout","",n("LinearLayout","",empty())));JSONObject r=A11y.read(true);
   check(TestClock.now==2500&&r.optBoolean("screen_partial")&&r.getInt("count")==3,"layout count hid shell");
  });
  test("invisible web descendants do not count as ready content",()->{
   AccessibilityNodeInfo hidden=n("Button","hidden");hidden.visible=false;AccessibilityNodeInfo shell=empty();shell.children=new AccessibilityNodeInfo[]{hidden};
   service(()->shell);check(A11y.read(false).optBoolean("screen_partial")&&TestClock.now==2500,"hidden content ready");
  });
  test("obsolete root is replaced; false refresh never walks the old root again",()->{
   AccessibilityNodeInfo stale=empty();stale.refreshOk=false;AccessibilityNodeInfo ready=full("new");
   A11y s=service(()->TestClock.now==0?stale:ready);android.os.Build.VERSION.SDK_INT=32;
   JSONObject r=A11y.read(false);check(stale.refreshes>0&&s.rootCalls==2&&r.getString("tree").contains("new"),"obsolete root reused");
  });
  test("null root shares the same total readiness budget",()->{
   service(()->TestClock.now<500?null:empty());JSONObject r=A11y.read(false);
   check(TestClock.now==2500&&r.optBoolean("screen_partial"),"root and content budgets added up");
  });
  test("disappearing root never returns the previous partial snapshot",()->{
   service(()->TestClock.now==0?empty():null);JSONObject r=A11y.read(false);
   check(!r.optBoolean("ok")&&!r.has("tree")&&A11y.nodes.isEmpty(),"stale partial returned");
  });
  test("native empty window stays immediate and valid",()->{
   service(()->n("FrameLayout",""));JSONObject r=A11y.read(false);
   check(r.optBoolean("ok")&&r.getInt("count")==0&&TestClock.now==0,"native window delayed");
  });
  test("confirmation present at start prevents all provider queries",()->{
   A11y s=service(()->full("private"));Priv.blocked=true;JSONObject r=A11y.read(false);
   check(!r.optBoolean("ok")&&s.rootCalls==0&&A11y.nodes.isEmpty(),"confirmation leaked");
  });
  test("confirmation appearing during wait aborts and invalidates public nodes",()->{
   A11y s=service(WebViewReadTest::empty);TestClock.afterSleep=()->MainActivity.blocked=true;JSONObject r=A11y.read(false);
   check(!r.optBoolean("ok")&&s.rootCalls==1&&A11y.nodes.isEmpty(),"confirmation ignored");
  });
  test("confirmation appearing during traversal cannot be published",()->{
   AccessibilityNodeInfo ready=full("private");ready.children[0].visit=()->Priv.blocked=true;service(()->ready);
   JSONObject r=A11y.read(false);check(!r.optBoolean("ok")&&!r.has("tree")&&A11y.nodes.isEmpty(),"guard race leaked tree");
  });
  test("service replacement cannot publish the previous service snapshot",()->{
   service(WebViewReadTest::empty);TestClock.afterSleep=()->A11y.self=null;
   check(!A11y.read(false).optBoolean("ok")&&A11y.nodes.isEmpty(),"detached service published");
  });
  test("interruption is preserved and does not publish an intermediate snapshot",()->{
   AccessibilityNodeInfo original=n("Button","old");service(()->original);A11y.read(false);
   A11y.self.provider=WebViewReadTest::empty;TestClock.interrupt=true;boolean caught=false;
   try{A11y.read(false);}catch(InterruptedException expected){caught=java.lang.Thread.currentThread().isInterrupted();}
   check(caught&&A11y.nodes.get(0)==original,"interrupt lost or intermediate cache published");
   java.lang.Thread.interrupted();
  });
  test("intermediate retries leave public node numbers unchanged until final publish",()->{
   AccessibilityNodeInfo old=n("Button","old"),ready=full("final");A11y s=service(()->old);A11y.read(false);
   s.provider=()->{check(A11y.nodes.get(0)==old,"intermediate publication");return TestClock.now<300?empty():ready;};
   JSONObject r=A11y.read(false);check(r.getString("tree").contains("final")&&A11y.nodes.get(1)==ready.children[0],"final publication missing");
  });
  test("final cache still rejects a node whose label changed",()->{
   AccessibilityNodeInfo web=full("before");service(()->web);A11y.read(false);
   check(A11y.testNode(1)==web.children[0],"fresh node missing");web.children[0].text="after";
   check(A11y.testNode(1)==null,"changed node fingerprint accepted");
  });
  test("final package, window, bounds and text come from final root",()->{
   AccessibilityNodeInfo old=empty(),ready=full("destination");ready.pkg="new.app";ready.windowId=2;ready.width=400;
   A11y s=service(()->TestClock.now<200?old:ready);s.windows=Arrays.asList(new android.view.accessibility.AccessibilityWindowInfo(2,"new title"));
   JSONObject r=A11y.read(false);check(r.getString("package").equals("new.app")&&r.getString("window").equals("new title")&&r.getString("screen").equals("400x200"),"mixed metadata");
  });
  test("password text and description remain hidden while password node is usable",()->{
   AccessibilityNodeInfo pw=n("EditText","secret");pw.pw=true;pw.desc="secret description";AccessibilityNodeInfo w=empty();w.children=new AccessibilityNodeInfo[]{pw};
   service(()->w);JSONObject r=A11y.read(false);String tree=r.getString("tree");
   check(!tree.contains("secret")&&tree.contains("password")&&TestClock.now==0,"password regression");
  });
  test("successful action stays successful when its returned screen is partial",()->{
   service(WebViewReadTest::empty);JSONObject r=A11y.withScreen(new JSONObject().put("ok",true).put("via","action"),0);
   check(r.optBoolean("ok")&&r.optBoolean("screen_partial")&&r.has("screen_warning")&&r.getString("via").equals("action"),"success discarded");
  });
  test("failed action stays failed while attaching a partial screen",()->{
   service(WebViewReadTest::empty);JSONObject r=A11y.withScreen(new JSONObject().put("ok",false).put("message","unchanged"),0);
   check(!r.optBoolean("ok")&&r.optBoolean("screen_partial")&&r.getString("message").equals("unchanged"),"failure discarded");
  });
  test("guard failure after an action is only a screen error, not action replay or failure",()->{
   service(()->full("hidden"));MainActivity.blocked=true;
   JSONObject r=A11y.withScreen(new JSONObject().put("ok",true).put("via","action"),0);
   check(r.optBoolean("ok")&&r.has("screen_error")&&!r.has("tree"),"action semantics changed");
  });
  System.out.println(checks+"/"+checks+" source-derived read/guard/cache/receipt cases passed; Android provider and clock are simulated.");
 }
}
