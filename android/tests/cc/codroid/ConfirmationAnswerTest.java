package cc.codroid;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class ConfirmationAnswerTest {
    static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    public static void main(String[] args) throws Exception {
        for (int value = 0; value <= 3; value++) {
            List<Integer> delivered = new ArrayList<>();
            final boolean[] attached = {true};
            CountDownLatch worker = new CountDownLatch(1);
            ConfirmationAnswer answer = new ConfirmationAnswer(how -> {
                check(!attached[0]); delivered.add(how); worker.countDown();
            });
            answer.choose(value);
            check(delivered.isEmpty() && worker.getCount() == 1); // Button click cannot release the device worker.
            attached[0] = false; // Android removes the guarded window before OnDismiss.
            answer.dismiss();
            check(worker.await(1, TimeUnit.SECONDS));
            check(delivered.size() == 1 && delivered.get(0) == value);
            answer.dismiss(); answer.choose(1);
            check(delivered.size() == 1);
        }
        List<Integer> cancelled = new ArrayList<>();
        ConfirmationAnswer back = new ConfirmationAnswer(cancelled::add);
        back.dismiss(); back.choose(3); back.dismiss();
        check(cancelled.size() == 1 && cancelled.get(0) == 0);
        List<Integer> once = new ArrayList<>();
        ConfirmationAnswer first = new ConfirmationAnswer(once::add);
        first.choose(0); first.choose(1); first.dismiss();
        check(once.size() == 1 && once.get(0) == 0);
        System.out.println("PASS 6 confirmation lifecycle cases: defer until dismissal, all scopes, cancellation and exactly-once delivery");
    }
}
