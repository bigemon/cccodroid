package cc.codroid;

public final class AwaitValueTest {
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        long[] now={0}; int[] reads={0};
        Object ready=new Object();
        Object result=AwaitValue.poll(()->{reads[0]++;return reads[0]<3?null:ready;},()->false,2500,50,()->now[0],ms->now[0]+=ms);
        check(result==ready && reads[0]==3 && now[0]==100);
        now[0]=0;reads[0]=0;
        check(AwaitValue.poll(()->ready,()->false,2500,50,()->now[0],ms->{throw new AssertionError("ready root must not wait");})==ready);
        Object absent=AwaitValue.poll(()->{reads[0]++;return null;},()->false,120,50,()->now[0],ms->now[0]+=ms);
        check(absent==null && now[0]==120 && reads[0]==4);
        reads[0]=0;
        check(AwaitValue.poll(()->{reads[0]++;return ready;},()->true,2500,50,()->0,ms->{})==null && reads[0]==0);
        now[0]=0;reads[0]=0;
        check(AwaitValue.poll(()->{reads[0]++;return null;},()->now[0]>0,2500,50,()->now[0],ms->now[0]+=ms)==null && reads[0]==1);
        boolean interrupted=false;
        try { AwaitValue.poll(()->null,()->false,2500,50,()->0,ms->{throw new InterruptedException();}); }
        catch(InterruptedException e){interrupted=Thread.currentThread().isInterrupted();}
        check(interrupted);Thread.interrupted();
        System.out.println("PASS 6 readiness cases: transient null, immediate root, bounded absence, confirmation guard and cancellation");
    }
}
