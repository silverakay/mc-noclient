package xyz.baixur.mcbridge;

import java.util.function.BooleanSupplier;

final class GameOfflineState {
    private String session;
    private BooleanSupplier connected;

    void online(String session, BooleanSupplier connected) {
        this.session = session;
        this.connected = connected;
    }

    String disconnectedSession() {
        return connected != null && !connected.getAsBoolean() ? session : null;
    }
}
