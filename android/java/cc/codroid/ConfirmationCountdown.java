package cc.codroid;
/** Requires continuous foreground dwell; leaving the dialog resets the warning countdown. */
final class ConfirmationCountdown {
    private final long duration;
    private long readMs, last;
    ConfirmationCountdown(long duration, long now) { this.duration=duration; this.last=now; }
    long remaining(long now, boolean foreground) {
        if (!foreground) readMs=0;
        else readMs+=Math.max(0, Math.min(1000, now-last));
        last=now;
        return Math.max(0,duration-readMs);
    }
}
