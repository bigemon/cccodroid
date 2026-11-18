package cc.codroid;
public final class NoAskPolicyTest {
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) {
        long now=1800000000000L;
        for(int h:NoAskPolicy.HOURS) {
            String value=NoAskPolicy.value(h,now);
            check(NoAskPolicy.hours(value,now)==h);
            check(NoAskPolicy.until(value,now)==(h==-1?Long.MAX_VALUE:now+h*3600000L));
        }
        String thirty=NoAskPolicy.value(720,now);
        check(NoAskPolicy.hours(thirty,now+10L*24*3600000)==720);
        check(NoAskPolicy.until(thirty,now+30L*24*3600000)==0);
        check(NoAskPolicy.until("permanent",now+100L*365*24*3600000)==Long.MAX_VALUE);
        check(NoAskPolicy.until(String.valueOf(now+7L*24*3600000),now)>0);
        check(NoAskPolicy.until(String.valueOf(Long.MAX_VALUE),now)==0);
        check(NoAskPolicy.until(String.valueOf(now+31L*24*3600000),now)==0);
        check(NoAskPolicy.until(String.valueOf(now+3600000)+":900",now)==0);
        check(NoAskPolicy.until(String.valueOf(now+3600000)+":-1",now)==0);
        check(NoAskPolicy.until("invalid",now)==0);
        check(NoAskPolicy.normalize(900)==24);
        check(NoAskPolicy.warning(true,-1).equals("noask_permanent"));
        for(int h:NoAskPolicy.HOURS){check(NoAskPolicy.warning(false,h).equals(""));if(h!=-1)check(NoAskPolicy.warning(true,h).equals("noask"));}
        System.out.println("PASS permanent selects only the countdown warning; finite changes select only the ordinary warning");
        System.out.println("PASS noask finite/30-day/permanent values, legacy restore and invalid/expired grants");
    }
}
