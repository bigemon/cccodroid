package cc.codroid;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Never wait for Android Keystore on a lifecycle/UI thread.
 * Tokens issued during warmup remain valid for this process; persisted notification tokens
 * are checked after the single background load completes, with a bounded pending lifetime.
 */
final class IntentKeys {
    interface Timer { void later(Runnable task, long delayMs); }
    private final String session;
    private volatile String persistent;
    private volatile boolean ready;
    private boolean started;
    private final ArrayList<Pending> pending = new ArrayList<>();
    private static final int MAX_PENDING = 32;
    static final long CHECK_TIMEOUT_MS = 8000;

    IntentKeys() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b & 255));
        session = hex.toString();
    }

    void start(Supplier<String> loader, Consumer<Runnable> launch) {
        synchronized (this) {
            if (started) return;
            started = true;
        }
        try { launch.accept(() -> {
            String key = null;
            try { key = loader.get(); } catch (Throwable ignored) {}
            finishLoad(key);
        }); } catch (RuntimeException e) { finishLoad(null); }
    }

    private void finishLoad(String key) {
        ArrayList<Pending> answers;
        synchronized (this) {
            persistent = valid(key) ? key : null;
            ready = true;
            answers = new ArrayList<>(pending);
            pending.clear();
        }
        for (Pending p : answers) p.answer.accept(matches(p.token));
    }

    String current() { String key = persistent; return key == null ? session : key; }
    boolean matches(String token) {
        return equal(token, session) || equal(token, persistent);
    }

    void check(String token, Timer timer, Consumer<Boolean> answer) {
        Pending wait = null;
        boolean accepted;
        synchronized (this) {
            accepted = matches(token);
            if (!accepted && !ready && valid(token) && pending.size() < MAX_PENDING) {
                wait = new Pending(token, answer);
                pending.add(wait);
            }
        }
        if (wait == null) { answer.accept(accepted); return; }
        Pending p = wait;
        timer.later(() -> {
            boolean expired;
            synchronized (IntentKeys.this) { expired = pending.remove(p); }
            if (expired) p.answer.accept(false);
        }, CHECK_TIMEOUT_MS);
    }

    private static boolean valid(String token) {
        return token != null && (token.length() == 48 || token.length() == 64)
            && token.matches("[0-9a-f]+");
    }
    private static boolean equal(String a, String b) {
        return a != null && b != null && MessageDigest.isEqual(
            a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
    private static final class Pending {
        final String token;
        final Consumer<Boolean> answer;
        Pending(String token, Consumer<Boolean> answer) { this.token = token; this.answer = answer; }
    }
}
