package cc.codroid;

import java.util.function.IntConsumer;

/** Record the button choice, then publish it only after the guarded dialog has closed. */
final class ConfirmationAnswer {
    private final IntConsumer reply;
    private boolean chosen, closed;
    private int how;
    ConfirmationAnswer(IntConsumer reply) { this.reply = reply; }
    synchronized void choose(int value) {
        if (value < 0 || value > 3) throw new IllegalArgumentException("invalid confirmation answer");
        if (closed || chosen) return;
        chosen = true;
        how = value;
    }
    void dismiss() {
        int result;
        synchronized (this) {
            if (closed) return;
            closed = true;
            result = how; // Back, cancellation and timeout default to denial.
        }
        reply.accept(result);
    }
}
