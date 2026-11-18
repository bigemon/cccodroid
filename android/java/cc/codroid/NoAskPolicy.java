package cc.codroid;

/** Versioned noask values retain the user's selected duration; legacy numeric deadlines still load. */
final class NoAskPolicy {
    static final long MAX = 30L * 24 * 3600 * 1000;
    static final int PERMANENT = -1;
    static final int[] HOURS = {1, 4, 24, 72, 168, 720, PERMANENT};
    static int normalize(int hours) {
        for (int allowed : HOURS) if (allowed == hours) return hours;
        return 24;
    }
    /** Exactly one native warning per change; permanent replaces the ordinary dialog. */
    static String warning(boolean change,int hours){return !change?"":normalize(hours)==PERMANENT?"noask_permanent":"noask";}
    static String value(int hours, long now) {
        int h = normalize(hours);
        return h == PERMANENT ? "permanent" : String.valueOf(now + h * 3600000L) + ":" + h;
    }
    static long until(String value, long now) {
        if ("permanent".equals(value)) return Long.MAX_VALUE;
        if (value == null) return 0;
        try {
            String[] parts = value.split(":", -1);
            if (parts.length > 2) return 0;
            long t = Long.parseLong(parts[0]);
            if (parts.length == 2) {
                int h = Integer.parseInt(parts[1]);
                if (h == PERMANENT || normalize(h) != h || t > now + h * 3600000L + 60000) return 0;
            }
            return t > now && t <= now + MAX + 60000 ? t : 0;
        } catch (RuntimeException e) { return 0; }
    }
    static int hours(String value, long now) {
        long t = until(value, now);
        if (t == 0) return 24;
        if (t == Long.MAX_VALUE) return PERMANENT;
        int colon = value.indexOf(':');
        if (colon >= 0) return Integer.parseInt(value.substring(colon + 1));
        long remaining = t - now;
        for (int h : HOURS) if (h > 0 && h * 3600000L >= remaining) return h;
        return 720;
    }
}
