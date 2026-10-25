package xyz.baixur.mcbridge;

import java.util.function.Consumer;

final class PurchaseKeySequence {
    interface Actions {
        boolean valid(boolean swapped);
        boolean shiftReady();
        void hold();
        void swap();
        void release();
    }
    private Actions actions;
    private Consumer<String> complete;
    private long deadline;
    private int ticks;
    private boolean swapped;
    boolean active() { return actions != null; }
    void start(Actions next, long expiresAt, Consumer<String> result) {
        if (active()) throw new IllegalStateException("Menu key sequence already running");
        actions = next; complete = result; deadline = expiresAt; ticks = 0; swapped = false;
        try { actions.hold(); }
        catch (RuntimeException error) { finish("Could not hold Shift"); }
    }
    void tick(long now) {
        if (!active()) return;
        try {
            if (now > deadline || !actions.valid(swapped)) { finish("Menu key sequence expired or session changed"); return; }
            ticks++;
            if (!swapped && ticks >= 4 && actions.shiftReady()) {
                actions.swap(); swapped = true; ticks = 0;
            } else if (swapped && ticks >= 2) finish(null);
        } catch (RuntimeException error) { finish("Menu key dispatch failed"); }
    }
    void cancel() { if (active()) finish("Menu key sequence cancelled"); }
    private void finish(String error) {
        Actions previous = actions; Consumer<String> result = complete;
        actions = null; complete = null;
        try { previous.release(); }
        catch (RuntimeException failure) { error = "Could not restore Shift state"; }
        result.accept(error);
    }
}
