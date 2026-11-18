package cc.codroid;

import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class IntentKeysTest {
    static int checks;
    static void check(boolean yes) { if (!yes) throw new AssertionError("check " + checks); checks++; }
    static final String OLD = "a".repeat(64);
    static final class Timers implements IntentKeys.Timer {
        final ArrayList<Runnable> tasks = new ArrayList<>();
        public void later(Runnable r, long ms) { check(ms == 8000); tasks.add(r); }
        void expire() { for (Runnable r : tasks) r.run(); tasks.clear(); }
    }
    public static void main(String[] args) throws Exception {
        IntentKeys keys = new IntentKeys();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
        AtomicInteger loads = new AtomicInteger();
        keys.start(() -> {
            loads.incrementAndGet(); entered.countDown();
            try { release.await(); } catch (InterruptedException e) { throw new RuntimeException(e); }
            return OLD;
        }, r -> new Thread(() -> { r.run(); finished.countDown(); }).start());
        check(entered.await(1, TimeUnit.SECONDS));
        keys.start(() -> { throw new AssertionError("second load"); }, r -> { throw new AssertionError("second worker"); });
        String during = keys.current();
        check(during.length() == 64 && !during.equals(OLD) && keys.matches(during));
        Timers timers = new Timers();
        ArrayList<Boolean> answers = new ArrayList<>();
        // With the actual loader held indefinitely, concurrent notification reads and
        // locally issued intent validation must all finish without waiting for release.
        CountDownLatch readers = new CountDownLatch(16);
        AtomicInteger good = new AtomicInteger();
        for (int n = 0; n < 16; n++) new Thread(() -> {
            if (keys.current().equals(during) && keys.matches(during)) good.incrementAndGet();
            readers.countDown();
        }).start();
        check(readers.await(1, TimeUnit.SECONDS) && good.get() == 16);
        keys.check(during, timers, answers::add);
        check(answers.equals(java.util.List.of(true)) && timers.tasks.isEmpty());
        answers.clear();
        keys.check(OLD, timers, answers::add);
        check(answers.isEmpty()); // Old notification deferred, never allowed before verification.
        keys.check("b".repeat(64), timers, answers::add);
        keys.check(null, timers, answers::add);
        keys.check("malformed", timers, answers::add);
        check(answers.equals(java.util.List.of(false, false)));
        release.countDown();
        check(finished.await(1, TimeUnit.SECONDS));
        check(loads.get() == 1 && keys.current().equals(OLD) && keys.matches(during) && keys.matches(OLD));
        check(answers.equals(java.util.List.of(false, false, true, false)));
        timers.expire(); check(answers.size() == 4); // No timeout double delivery.
        // A fresh process recognizes the persistent token but never another process's temporary token.
        IntentKeys next = new IntentKeys(); next.start(() -> OLD, Runnable::run);
        check(next.matches(OLD) && !next.matches(during));
        ArrayList<Boolean> rejected = new ArrayList<>();
        next.check(during, timers, rejected::add); check(rejected.equals(java.util.List.of(false)));
        // Slow/failed keystore: pending checks expire, current-process actions remain usable,
        // and late recovery cannot replay an expired destructive action.
        IntentKeys slow = new IntentKeys();
        ArrayList<Runnable> work = new ArrayList<>();
        slow.start(() -> OLD, work::add);
        ArrayList<Boolean> expired = new ArrayList<>();
        slow.check(OLD, timers, expired::add);
        timers.expire(); check(expired.equals(java.util.List.of(false)));
        work.get(0).run(); check(expired.size() == 1);
        slow.check(OLD, timers, expired::add); check(expired.equals(java.util.List.of(false, true)));
        IntentKeys failed = new IntentKeys();
        String fallback = failed.current();
        failed.start(() -> { throw new RuntimeException("keystore unavailable"); }, Runnable::run);
        check(failed.current().equals(fallback) && failed.matches(fallback) && !failed.matches(OLD));
        // Bound registrations from untrusted exported-intent callers.
        IntentKeys capped = new IntentKeys();
        ArrayList<Boolean> cap = new ArrayList<>();
        for (int n=0; n<40; n++) capped.check(OLD, timers, cap::add);
        check(cap.size() == 8 && timers.tasks.size() == 32);
        timers.expire(); check(cap.size() == 40 && !cap.contains(true));
        System.out.println("IntentKeysTest: " + checks + " checks passed (blocked loader, concurrency, restart, timeout, rejection)");
    }
}
