package xyz.baixur.mcbridge;

public final class GameOfflineStateTest {
    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Game offline evidence check failed");
    }

    public static void main(String[] args) {
        var state = new GameOfflineState();
        check(state.disconnectedSession() == null);
        boolean[] transport = { true };
        state.online("first", () -> transport[0]);
        check(state.disconnectedSession() == null);
        // A level/configuration transition alone cannot establish disconnection.
        check(state.disconnectedSession() == null);
        transport[0] = false;
        check("first".equals(state.disconnectedSession()));
        boolean[] next = { true };
        state.online("second", () -> next[0]);
        check(state.disconnectedSession() == null);
        next[0] = false;
        check("second".equals(state.disconnectedSession()));
        System.out.println("PASS GameOfflineState: no initial evidence, live transport/configuration isolation and exact disconnected session");
    }
}
