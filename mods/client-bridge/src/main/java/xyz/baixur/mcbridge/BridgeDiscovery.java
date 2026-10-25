package xyz.baixur.mcbridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;

final class BridgeDiscovery {
    private BridgeDiscovery() {}

    static String pairingId(String token) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
    }

    static List<Integer> ports(JsonObject config, String username, long now) throws Exception {
        int legacyPort = config.get("port").getAsInt();
        String token = config.get("token").getAsString();
        if (config.get("version").getAsInt() != 1 || !"127.0.0.1".equals(config.get("host").getAsString())
            || legacyPort < 1024 || legacyPort > 65535 || !token.matches("[a-f0-9]{64}")
            || username == null || !username.matches("[A-Za-z0-9_]{1,16}"))
            throw new IllegalArgumentException("Invalid pairing or local account");
        if (!config.has("discoveryDirectory")) return List.of(legacyPort);
        Path directory = Path.of(config.get("discoveryDirectory").getAsString());
        if (!directory.isAbsolute()) throw new IllegalArgumentException("Discovery path must be absolute");
        // Discovery is authoritative when configured: never fall through to another account's legacy port.
        if (!Files.isDirectory(directory)) return List.of();
        String pairingId = pairingId(token);
        List<Integer> matched = new ArrayList<>(), unclaimed = new ArrayList<>();
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(p -> p.getFileName().toString().matches("[a-f0-9-]{36}\\.json")).limit(256).toList()) {
                try {
                    if (Files.size(file) > 4096) continue;
                    JsonObject endpoint = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
                    long expires = endpoint.get("expiresAt").getAsLong();
                    int port = endpoint.get("port").getAsInt();
                    String name = endpoint.get("username").getAsString();
                    var busy = endpoint.get("busy");
                    if (endpoint.get("version").getAsInt() != 1 || !pairingId.equals(endpoint.get("pairingId").getAsString())
                        || port < 1024 || port > 65535 || expires <= now || expires - now > 30000
                        || busy == null || !busy.isJsonPrimitive() || !busy.getAsJsonPrimitive().isBoolean() || busy.getAsBoolean()) continue;
                    if (username.equalsIgnoreCase(name)) matched.add(port);
                    else if (name.isEmpty()) unclaimed.add(port);
                } catch (Exception ignored) { /* A disappearing or invalid record cannot affect the game. */ }
            }
        }
        matched.sort(Integer::compareTo); unclaimed.sort(Integer::compareTo);
        matched.addAll(unclaimed);
        return List.copyOf(new LinkedHashSet<>(matched));
    }
}
