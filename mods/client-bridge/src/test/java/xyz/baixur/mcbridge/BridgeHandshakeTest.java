package xyz.baixur.mcbridge;

import com.google.gson.JsonParser;

public final class BridgeHandshakeTest {
    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Bridge capability check failed");
    }

    public static void main(String[] args) {
        String token = "a".repeat(64);
        var hello = BridgeHandshake.hello(token);
        var named = BridgeHandshake.hello(token, "Tester");
        check(named.size() == 5 && named.get("username").getAsString().equals("Tester"));
        try { BridgeHandshake.hello(token, "bad name"); throw new AssertionError("Invalid account accepted"); }
        catch (IllegalArgumentException expected) {}
        check(hello.size() == 4);
        check(hello.get("kind").getAsString().equals("hello"));
        check(hello.get("version").getAsInt() == 1);
        check(hello.get("token").getAsString().equals(token));
        check(hello.getAsJsonObject("features").size() == 4);
        check(hello.getAsJsonObject("features").get("offlineState").getAsBoolean());
        check(BridgeHandshake.disconnectEnabled(hello));
        check(!BridgeHandshake.disconnectEnabled(null));
        check(!BridgeHandshake.disconnectEnabled(JsonParser.parseString("{\"features\":{\"disconnectGame\":\"true\"}}").getAsJsonObject()));
        check(BridgeHandshake.purchaseEnabled(hello));
        check(!BridgeHandshake.purchaseEnabled(null));
        check(!BridgeHandshake.purchaseEnabled(JsonParser.parseString("{\"features\":{\"purchaseMenus\":\"true\"}}").getAsJsonObject()));
        check(hello.getAsJsonObject("features").get("outboundMonitor").getAsJsonPrimitive().isBoolean());
        check(hello.getAsJsonObject("features").get("outboundMonitor").getAsBoolean());
        check(BridgeHandshake.monitorEnabled(hello));
        check(!BridgeHandshake.monitorEnabled(null));
        for (String json : new String[] {
            "{}", "{\"kind\":\"welcome\",\"version\":1}",
            "{\"features\":null}", "{\"features\":false}", "{\"features\":[]}",
            "{\"features\":\"true\"}", "{\"features\":{}}",
            "{\"features\":{\"outboundMonitor\":false}}",
            "{\"features\":{\"outboundMonitor\":null}}",
            "{\"features\":{\"outboundMonitor\":\"true\"}}",
            "{\"features\":{\"outboundMonitor\":1}}",
            "{\"features\":{\"outboundMonitor\":[]}}",
            "{\"features\":{\"outboundMonitor\":{}}}"
        }) check(!BridgeHandshake.monitorEnabled(JsonParser.parseString(json).getAsJsonObject()));
        check(BridgeHandshake.monitorEnabled(JsonParser.parseString(
            "{\"kind\":\"welcome\",\"version\":1,\"features\":{\"outboundMonitor\":true,\"unknown\":true}}"
        ).getAsJsonObject()));
        hello.getAsJsonObject("features").addProperty("outboundMonitor", false);
        check(BridgeHandshake.hello(token).getAsJsonObject("features").get("outboundMonitor").getAsBoolean());
        System.out.println("PASS BridgeHandshake: monitor advertisement, strict negotiation and legacy compatibility (no game/network)");
    }
}
