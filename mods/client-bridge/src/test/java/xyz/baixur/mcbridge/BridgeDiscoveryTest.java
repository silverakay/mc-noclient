package xyz.baixur.mcbridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

public final class BridgeDiscoveryTest {
    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Bridge discovery check failed");
    }

    private static JsonObject record(Path directory, String name, int port, long expires) throws Exception {
        JsonObject value = new JsonObject();
        value.addProperty("version", 1); value.addProperty("pairingId", BridgeDiscovery.pairingId("a".repeat(64)));
        value.addProperty("username", name); value.addProperty("port", port);
        value.addProperty("busy", false); value.addProperty("expiresAt", expires);
        save(directory, value);
        return value;
    }

    private static void save(Path directory, JsonObject value) throws Exception {
        Files.writeString(directory.resolve(UUID.randomUUID() + ".json"), value.toString());
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 3 && args[0].equals("--ports")) {
            System.out.println(BridgeDiscovery.ports(JsonParser.parseString(Files.readString(Path.of(args[1]))).getAsJsonObject(),
                args[2], System.currentTimeMillis()));
            return;
        }
        Path directory = Files.createTempDirectory("mcbridge-discovery-");
        JsonObject config = new JsonObject();
        config.addProperty("version", 1); config.addProperty("host", "127.0.0.1");
        config.addProperty("port", 39248); config.addProperty("token", "a".repeat(64));
        try {
            check(BridgeDiscovery.ports(config, "Alice", 1000).equals(List.of(39248)));
            config.addProperty("discoveryDirectory", directory.toString());
            check(BridgeDiscovery.ports(config, "Alice", 1000).isEmpty());
            record(directory, "Alice", 40001, 20000);
            record(directory, "Bob", 40002, 20000);
            record(directory, "", 40003, 20000);
            record(directory, "Alice", 40004, 999);
            JsonObject bad = record(directory, "Alice", 40005, 20000);
            bad.addProperty("pairingId", "b".repeat(64)); bad.addProperty("port", 40006); save(directory, bad);
            bad.addProperty("pairingId", BridgeDiscovery.pairingId("a".repeat(64)));
            bad.addProperty("port", 40007); bad.addProperty("busy", true); save(directory, bad);
            bad.addProperty("port", 40008); bad.addProperty("busy", "false"); save(directory, bad);
            record(directory, "Alice", 40009, 40000);
            record(directory, "Alice", 80, 20000);
            Files.writeString(directory.resolve(UUID.randomUUID() + ".json"), "{");
            Files.writeString(directory.resolve(UUID.randomUUID() + ".json"), " ".repeat(4097));
            Files.writeString(directory.resolve(UUID.randomUUID() + ".json.tmp"), "{");
            check(BridgeDiscovery.ports(config, "aLiCe", 1000).equals(List.of(40001, 40005, 40003)));
            check(BridgeDiscovery.ports(config, "Bob", 1000).equals(List.of(40002, 40003)));
            check(BridgeDiscovery.ports(config, "Carol", 1000).equals(List.of(40003)));
            check(BridgeDiscovery.ports(config, "Alice", 50000).isEmpty());
            config.addProperty("discoveryDirectory", directory.resolve("missing").toString());
            check(BridgeDiscovery.ports(config, "Alice", 1000).isEmpty());
            config.addProperty("discoveryDirectory", "relative/path");
            try { BridgeDiscovery.ports(config, "Alice", 1000); throw new AssertionError("Relative discovery path accepted"); }
            catch (IllegalArgumentException expected) {}
        } finally {
            try (var files = Files.list(directory)) { for (Path file : files.toList()) Files.delete(file); }
            Files.delete(directory);
        }
        System.out.println("PASS BridgeDiscovery: account routing, legacy fallback, busy/expired/corrupt records and token isolation");
    }
}
