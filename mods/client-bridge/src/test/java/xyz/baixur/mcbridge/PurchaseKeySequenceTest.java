package xyz.baixur.mcbridge;

import java.util.ArrayList;

public final class PurchaseKeySequenceTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("Unsafe menu key timing"); }
    public static void main(String[] args) {
        var events = new ArrayList<String>();
        boolean[] ready = {false}, valid = {true};
        PurchaseKeySequence.Actions actions = new PurchaseKeySequence.Actions() {
            public boolean valid(boolean swapped) { return valid[0]; }
            public boolean shiftReady() { return ready[0]; }
            public void hold() { events.add("hold"); }
            public void swap() { events.add("swap"); }
            public void release() { events.add("release"); }
        };
        var sequence = new PurchaseKeySequence();
        sequence.start(actions, 5000, error -> events.add(error == null ? "ok" : "error"));
        for (int i = 0; i < 5; i++) sequence.tick(i * 50);
        check(events.equals(java.util.List.of("hold")));
        ready[0] = true; sequence.tick(300);
        check(events.equals(java.util.List.of("hold", "swap")));
        sequence.tick(350); check(sequence.active());
        sequence.tick(400); check(!sequence.active());
        check(events.equals(java.util.List.of("hold", "swap", "release", "ok")));
        events.clear(); sequence.start(actions, 5000, error -> events.add(error)); sequence.cancel();
        sequence.tick(500); check(events.size() == 3 && events.get(1).equals("release") && !events.contains("swap"));
        events.clear(); sequence.start(actions, 5000, error -> events.add(error)); valid[0] = false;
        sequence.tick(600); check(!sequence.active() && !events.contains("swap"));
        System.out.println("PASS PurchaseKeySequence: wait for sent sneak across ticks, one swap, delayed release and cancellation");
    }
}
