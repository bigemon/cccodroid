#!/usr/bin/env python3
"""Run exact A11y read methods with simulated Android nodes/provider and clock.
This is a host contract test, not Android/Binder or Chromium integration."""
from pathlib import Path
import subprocess
import tempfile
import hashlib
import json

root = Path(__file__).resolve().parent.parent
source = (root / "android/java/cc/codroid/A11y.java").read_text()

def method(marker):
    start = source.index(marker)
    i = source.index("{", start) + 1
    depth = 1
    while depth:
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
        i += 1
    return source[start:i]

start = source.index("    private static final class ReadSnapshot")
end = source.index("    /** 编号的指纹", start)
sig_start = source.index("    private static String sig(")
sig_end = source.index("    /** 上一次 node()", sig_start)
literal = source[start:end] + source[sig_start:sig_end] + method("    private static AccessibilityNodeInfo node(") + method("    static JSONObject withScreen(")
prefix = """package cc.codroid;
import java.util.*;
import android.graphics.Rect;
import android.util.Log;
import android.view.accessibility.*;
import org.json.JSONObject;
class A11y {
 static final String TAG="fixture";
 static A11y self;static final Object LOCK=new Object();
 static final List<AccessibilityNodeInfo> nodes=new ArrayList<>();
 static final List<String> sigs=new ArrayList<>();static String miss="";
 java.util.function.Supplier<AccessibilityNodeInfo> provider;int rootCalls,invalidations;
 List<AccessibilityWindowInfo> windows=Collections.emptyList();
 AccessibilityNodeInfo getRootInActiveWindow(){rootCalls++;return provider.get();}
 List<AccessibilityWindowInfo> getWindows(){return windows;}
 boolean clearCachedSubtree(AccessibilityNodeInfo root){invalidations++;return true;}
 static void touch(){}static long settle(int before){return 0;}static void disarm(){}
 static AccessibilityNodeInfo testNode(int id){return node(id);}
}
"""
# The only substituted code is the surrounding Android service, nodes, JSON,
# sleep/clock, and action-settle interfaces. The methods under test are literal.
files = {
    "A11y.java": prefix.rsplit("}", 1)[0] + literal + "\n}\n",
    "AwaitValue.java": (root / "android/java/cc/codroid/AwaitValue.java").read_text(),
    "WebViewReadTest.java": (root / "android/tests/cc/codroid/WebViewReadTest.java").read_text(),
    "Priv.java": "package cc.codroid;class Priv {static boolean blocked;static boolean asking(){return blocked;}}",
    "MainActivity.java": "package cc.codroid;class MainActivity {static boolean blocked;static boolean guarding(){return blocked;}}",
    "Tr.java": "package cc.codroid;class Tr {static String t(String s){return s;}}",
    "TestClock.java": """package cc.codroid;
public class TestClock {
 public static long now;public static boolean interrupt;public static Runnable afterSleep;
 static void reset(){now=0;interrupt=false;afterSleep=null;}
}
""",
    "Thread.java": """package cc.codroid;
class Thread {
 static java.lang.Thread currentThread(){return java.lang.Thread.currentThread();}
 static void sleep(long ms)throws InterruptedException {
  if(TestClock.interrupt)throw new InterruptedException();
  TestClock.now+=ms;if(TestClock.afterSleep!=null)TestClock.afterSleep.run();
 }
}
""",
    "android/os/SystemClock.java": "package android.os;public class SystemClock {public static long uptimeMillis(){return cc.codroid.TestClock.now;}}",
    "android/os/Build.java": "package android.os;public class Build {public static class VERSION {public static int SDK_INT=35;}}",
    "android/util/Log.java": "package android.util;public class Log {public static int w(String tag,String text,Throwable error){return 0;}}",
    "android/graphics/Rect.java": """package android.graphics;
public class Rect {public int left=0,top=0,right=100,bottom=200;
 public int width(){return right-left;}public int height(){return bottom-top;}
 public int centerX(){return (right+left)/2;}public int centerY(){return (bottom+top)/2;}}
""",
    "android/view/accessibility/AccessibilityWindowInfo.java": """package android.view.accessibility;
public class AccessibilityWindowInfo {
 int id;String title;public AccessibilityWindowInfo(int id,String title){this.id=id;this.title=title;}
 public boolean isActive(){return true;}public int getId(){return id;}public CharSequence getTitle(){return title;}
}
""",
    "org/json/JSONObject.java": """package org.json;
public class JSONObject extends java.util.LinkedHashMap<String,Object> {
 public JSONObject put(String k,Object v){super.put(k,v);return this;}
 public int getInt(String k){return ((Number)get(k)).intValue();}
 public String getString(String k){return (String)get(k);}
 public String optString(String k){Object v=get(k);return v==null?"":v.toString();}
 public boolean optBoolean(String k){return Boolean.TRUE.equals(get(k));}
 public boolean has(String k){return containsKey(k);}
}
""",
    "android/view/accessibility/AccessibilityNodeInfo.java": """package android.view.accessibility;
import android.graphics.Rect;
public class AccessibilityNodeInfo {
 public String cls="FrameLayout",text="",pkg="fixture",desc;public AccessibilityNodeInfo[] children={};
 public boolean click=false,refreshOk=true,visible=true,pw=false;public int refreshes,windowId=1,width=100;
 public Runnable visit;
 public CharSequence getPackageName(){return pkg;}public CharSequence getClassName(){return cls;}
 public CharSequence getText(){return text;}public CharSequence getContentDescription(){return desc;}public String getViewIdResourceName(){return null;}
 public boolean isVisibleToUser(){if(visit!=null)visit.run();return visible;}
 public boolean isPassword(){return pw;}public boolean isClickable(){return click;}
 public boolean isLongClickable(){return false;}public boolean isEditable(){return false;}public boolean isScrollable(){return false;}
 public boolean isCheckable(){return false;}public boolean isChecked(){return false;}public boolean isFocused(){return false;}
 public boolean isSelected(){return false;}public boolean isEnabled(){return true;}
 public int getChildCount(){return children.length;}public AccessibilityNodeInfo getChild(int i){return children[i];}
 public void getBoundsInScreen(Rect r){r.right=width;}public boolean refresh(){refreshes++;return refreshOk;}
 public int getWindowId(){return windowId;}
}
""",
}
with tempfile.TemporaryDirectory(prefix="a11y-read-contract-") as directory:
    tmp = Path(directory)
    for name, body in files.items():
        path = tmp / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    java_sources = [str(p) for p in tmp.rglob("*.java")]
    classes = tmp / "classes"
    subprocess.run(["javac", "-nowarn", "-d", str(classes), *java_sources], check=True)
    subprocess.run(["java", "-cp", str(classes), "cc.codroid.WebViewReadTest"], check=True)
print(json.dumps({"productionSourceSha256": hashlib.sha256(source.encode()).hexdigest(),
                  "literalMethods": ["read", "walk", "sig", "clip", "node", "withScreen"],
                  "scope": "source-derived host fixture; Android provider/clock/settle simulated"}))
