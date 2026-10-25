package xyz.baixur.mcbridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

final class BridgeHandshake {
    private BridgeHandshake() {}

    static JsonObject hello(String token) {
        JsonObject hello = new JsonObject();
        hello.addProperty("kind", "hello"); hello.addProperty("version", 1);
        hello.addProperty("token", token);
        JsonObject features = new JsonObject(); features.addProperty("outboundMonitor", true);
        features.addProperty("purchaseMenus", true);
        features.addProperty("disconnectGame", true);
        features.addProperty("offlineState", true);
        hello.add("features", features);
        return hello;
    }

    static JsonObject hello(String token, String username) {
        if (username == null || !username.matches("[A-Za-z0-9_]{1,16}"))
            throw new IllegalArgumentException("Invalid local bridge account");
        JsonObject hello = hello(token);
        hello.addProperty("username", username);
        return hello;
    }

    static boolean monitorEnabled(JsonObject welcome) {
        return enabled(welcome, "outboundMonitor");
    }
    static boolean purchaseEnabled(JsonObject welcome) {
        return enabled(welcome, "purchaseMenus");
    }
    static boolean disconnectEnabled(JsonObject welcome) {
        return enabled(welcome, "disconnectGame");
    }
    private static boolean enabled(JsonObject welcome, String name) {
        if (welcome == null) return false;
        JsonElement features = welcome.get("features");
        if (features == null || !features.isJsonObject()) return false;
        JsonElement flag = features.getAsJsonObject().get(name);
        return flag != null && flag.isJsonPrimitive() && flag.getAsJsonPrimitive().isBoolean()
            && flag.getAsBoolean();
    }
}
