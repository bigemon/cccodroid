package cc.codroid;
import android.content.*;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;

/** File-backed SharedPreferences contract fixture; executes the product Consent class on the JVM. */
public final class ConsentPersistenceTest {
    static File file;
    static SharedPreferences prefs;
    static final class C extends ContextWrapper {
        C() { super(null); }
        @Override public SharedPreferences getSharedPreferences(String name, int mode) { return prefs; }
        @Override public String getPackageName() { return "cc.codroid.test"; }
    }
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        file=new File(args[1]);
        Properties data=new Properties();
        if(file.exists())try(InputStream in=new FileInputStream(file)){data.load(in);}
        InvocationHandler reader=(proxy,method,a)->{
            String name=method.getName();
            if(name.equals("getString"))return data.getProperty((String)a[0],(String)a[1]);
            if(name.equals("getBoolean"))return Boolean.parseBoolean(data.getProperty((String)a[0],String.valueOf(a[1])));
            if(name.equals("contains"))return data.containsKey(a[0]);
            if(name.equals("edit")) {
                Properties changes=new Properties();Set<String> deleted=new HashSet<>();
                return Proxy.newProxyInstance(ConsentPersistenceTest.class.getClassLoader(),new Class[]{SharedPreferences.Editor.class},(p,m,b)->{
                    String op=m.getName();
                    if(op.startsWith("put")){changes.setProperty((String)b[0],String.valueOf(b[1]));deleted.remove(b[0]);return p;}
                    if(op.equals("remove")){deleted.add((String)b[0]);changes.remove(b[0]);return p;}
                    if(op.equals("commit")||op.equals("apply")){
                        for(String k:deleted)data.remove(k);data.putAll(changes);
                        try(OutputStream out=new FileOutputStream(file)){data.store(out,"isolated fixture");}
                        return op.equals("commit")?true:null;
                    }
                    throw new AssertionError(op);
                });
            }
            throw new AssertionError(name);
        };
        prefs=(SharedPreferences)Proxy.newProxyInstance(ConsentPersistenceTest.class.getClassLoader(),new Class[]{SharedPreferences.class},reader);
        // android.jar constructors are stubs; allocate a wrapper whose only used methods are overridden.
        Field f=sun.misc.Unsafe.class.getDeclaredField("theUnsafe");f.setAccessible(true);
        C c=(C)((sun.misc.Unsafe)f.get(null)).allocateInstance(C.class);
        check(!Consent.strong(c));
        Field ctx=Priv.class.getDeclaredField("ctx");ctx.setAccessible(true);ctx.set(null,c);
        if(args[0].equals("rules")){

            long screenUntil=System.currentTimeMillis()+7200000;
            check(!Priv.noAskScreen());
            Consent.grant(c,Consent.NOASK_SCREEN,"1");check(!Priv.noAskScreen());
            check(Consent.get(c,Consent.NOASK_SCREEN)==null);
            Consent.grant(c,Consent.DEV_ON,"1");Consent.grant(c,Consent.DEV_A11Y,"auto");
            Consent.grant(c,Consent.NOASK_SCREEN,"1");check(Priv.noAskScreen());check(!Priv.noAsk());
            Consent.grant(c,Consent.NOASK,String.valueOf(screenUntil));check(Priv.noAskScreen());
            Consent.grant(c,Consent.NOASK_SELF,String.valueOf(screenUntil));check(Priv.noAskSelf());check(Priv.noAskScreen());
            Consent.revoke(c,Consent.NOASK_SELF);check(Priv.noAskScreen());
            Consent.grant(c,Consent.NOASK,String.valueOf(screenUntil+1));check(Priv.noAskScreen());
            Consent.revoke(c,Consent.NOASK);check(Priv.noAskScreen());
            Consent.grant(c,Consent.NOASK,String.valueOf(System.currentTimeMillis()-1));check(!Priv.noAsk());check(Priv.noAskScreen());
            // Existing deadlines remain deadlines, independent of the command master.
            Consent.grant(c,Consent.NOASK_SCREEN,String.valueOf(screenUntil));check(Priv.noAskScreen());
            check(String.valueOf(screenUntil).equals(Consent.get(c,Consent.NOASK_SCREEN)));
            Consent.grant(c,Consent.NOASK_SCREEN,String.valueOf(System.currentTimeMillis()-1));check(!Priv.noAskScreen());
            Consent.grant(c,Consent.NOASK_SCREEN,String.valueOf(Long.MAX_VALUE));check(Priv.noAskScreen());
            Consent.grant(c,Consent.NOASK_SCREEN,"bad");check(!Priv.noAskScreen());
            // Revocation is sticky: re-enabling a feature does not restore the prior grant.
            Consent.grant(c,Consent.NOASK_SCREEN,"1");Consent.revoke(c,Consent.DEV_A11Y);check(!Priv.noAskScreen());
            Consent.grant(c,Consent.DEV_A11Y,"on");check(!Priv.noAskScreen());
            Consent.grant(c,Consent.NOASK_SCREEN,"1");check(Priv.noAskScreen());
            Consent.revoke(c,Consent.DEV_ON);check(!Priv.noAskScreen());
            Consent.grant(c,Consent.DEV_ON,"1");check(!Priv.noAskScreen());
            Consent.revoke(c,Consent.DEV_ON);Consent.revoke(c,Consent.DEV_A11Y);
            long until=System.currentTimeMillis()+3600000;
            check(!Priv.noAskSelf());
            Consent.grant(c,Consent.NOASK,String.valueOf(until));check(!Priv.noAskSelf());
            Consent.grant(c,Consent.NOASK_SELF,String.valueOf(until));check(Priv.noAskSelf());
            Consent.revoke(c,Consent.NOASK);check(!Priv.noAskSelf());
            check(Consent.get(c,Consent.NOASK_SELF)==null);
            Consent.grant(c,Consent.NOASK,String.valueOf(until+1000));
            Consent.grant(c,Consent.NOASK_SELF,String.valueOf(until));check(!Priv.noAskSelf());
            Consent.grant(c,Consent.NOASK_SELF,String.valueOf(until+1000));check(Priv.noAskSelf());
            Consent.grant(c,Consent.NOASK,String.valueOf(System.currentTimeMillis()-1));
            check(!Priv.noAskSelf());check(Consent.get(c,Consent.NOASK_SELF)==null);
            Consent.grant(c,Consent.NOASK,NoAskPolicy.value(-1,System.currentTimeMillis()));
            check(Priv.noAskUntil()==Long.MAX_VALUE);check(Priv.noAskHours()==-1);
            Consent.grant(c,Consent.NOASK_SELF,String.valueOf(Long.MAX_VALUE));check(Priv.noAskSelf());
            Consent.revoke(c,Consent.NOASK);check(!Priv.noAskSelf());
        }else if(args[0].equals("write")){
            Consent.grant(c,Consent.KEEPALIVE,"1");
            Consent.grant(c,Consent.NOASK,"123");
            Consent.grant(c,Consent.NOASK_SELF,"123");Consent.grant(c,Consent.NOASK_SCREEN,"1");
            Consent.grant(c,Consent.DEV_ON,"1");Consent.grant(c,Consent.DEV_A11Y,"auto");
            Consent.grant(c,Consent.SHZ_AUTO,"1");
            check(Consent.on(c,Consent.KEEPALIVE));
        }else if(args[0].equals("read")){
            check(Consent.on(c,Consent.KEEPALIVE));check(Consent.on(c,Consent.SHZ_AUTO));
            check("123".equals(Consent.get(c,Consent.NOASK)));
            check("123".equals(Consent.get(c,Consent.NOASK_SELF)));check(Priv.noAskScreen());
            Consent.revoke(c,Consent.NOASK);check(Priv.noAskScreen());
            Consent.revoke(c,Consent.NOASK_SCREEN);Consent.revoke(c,Consent.DEV_ON);Consent.revoke(c,Consent.DEV_A11Y);
            Consent.revoke(c,Consent.NOASK_SELF);
            Consent.revoke(c,Consent.KEEPALIVE);Consent.revoke(c,Consent.NOASK);Consent.revoke(c,Consent.SHZ_AUTO);
        }else{
            check(!Consent.on(c,Consent.KEEPALIVE));check(!Consent.on(c,Consent.SHZ_AUTO));check(!Consent.on(c,Consent.NOASK));check(!Priv.noAskScreen());
        }
        System.out.println("PASS "+args[0]+" in separate JVM, actual Consent + isolated file-backed prefs");
    }
}
