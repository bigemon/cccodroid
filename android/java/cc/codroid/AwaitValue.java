package cc.codroid;

import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Bounded read-only readiness polling, with no wait when a value is already available. */
final class AwaitValue {
    interface Sleeper { void sleep(long millis) throws InterruptedException; }
    static <T> T poll(Supplier<T> read, BooleanSupplier stop, long budgetMs, long intervalMs,
                      LongSupplier clock, Sleeper sleeper) throws InterruptedException {
        long started = clock.getAsLong();
        for (;;) {
            if (stop.getAsBoolean()) return null;
            T value = read.get();
            if (value != null) return value;
            long left = budgetMs - (clock.getAsLong() - started);
            if (left <= 0) return null;
            try { sleeper.sleep(Math.min(left, Math.max(1, intervalMs))); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); throw e; }
        }
    }
}
