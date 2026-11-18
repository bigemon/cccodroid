package cc.codroid;
public final class ConfirmationCountdownTest {
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) {
        ConfirmationCountdown g=new ConfirmationCountdown(10000,0);
        for(int i=1;i<10;i++)check(g.remaining(i*1000,true)>0);
        check(g.remaining(10000,true)==0);
        g=new ConfirmationCountdown(10000,0);
        check(g.remaining(5000,true)==9000);
        check(g.remaining(6000,false)==10000);
        check(g.remaining(60000,false)==10000);
        for(int i=1;i<10;i++)check(g.remaining(60000+i*1000,true)>0);
        check(g.remaining(70000,true)==0);
        g=new ConfirmationCountdown(15000,0);
        for(int i=1;i<15;i++)check(g.remaining(i*1000,true)>0);
        check(g.remaining(15000,false)==15000);
        for(int i=1;i<15;i++)check(g.remaining(15000+i*1000,true)>0);
        check(g.remaining(30000,true)==0);
        System.out.println("PASS sensitive warnings require 10 / 15 seconds foreground dwell, reset on background");
    }
}
