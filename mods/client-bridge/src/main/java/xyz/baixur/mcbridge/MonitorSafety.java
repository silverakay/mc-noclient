package xyz.baixur.mcbridge;

import com.google.gson.JsonObject;
import java.util.Locale;
import java.util.Set;

public final class MonitorSafety {
    private static final Set<String> PRIVATE_COMMANDS = Set.of(
        "login", "l", "register", "reg", "changepassword", "changepass", "cp", "password",
        "passwd", "setpassword", "auth", "authenticate", "authme", "2fa", "otp", "pin", "email", "unregister");
    private long window;
    private int accepted;
    private int dropped;

    public static JsonObject command(String raw, boolean signed) {
        if (raw == null || raw.isBlank() || raw.length() > 32767
            || raw.chars().anyMatch(c -> c < 32 || c == 127)) return null;
        String value = raw.startsWith("/") ? raw.substring(1) : raw;
        int split = value.indexOf(' ');
        String root = split < 0 ? value : value.substring(0, split);
        String name = root.substring(root.lastIndexOf(':') + 1).toLowerCase(Locale.ROOT);
        boolean redacted = PRIVATE_COMMANDS.contains(name);
        boolean truncated = value.length() > 2047;
        if (root.isBlank() || root.length() > 255 || root.startsWith("/")
            || Character.isWhitespace(root.charAt(0)) || Character.isSpaceChar(root.charAt(0)) || root.charAt(0) == 0xfeff) return null;
        JsonObject event = new JsonObject(); event.addProperty("type", "command");
        event.addProperty("command", "/" + (redacted || truncated ? root : value));
        event.addProperty("redacted", redacted); event.addProperty("truncated", truncated);
        event.addProperty("signed", signed); return event;
    }

    public boolean allow(long nanos) {
        if (nanos - window >= 1_000_000_000L || nanos < window) { window = nanos; accepted = 0; }
        if (accepted >= 20) { drop(); return false; }
        accepted++; return true;
    }
    public void drop() { dropped = Math.min(1_000_000, dropped + 1); }
    public void restoreDropped(int count) { dropped = Math.min(1_000_000, dropped + count); }
    public int takeDropped() { int count = dropped; dropped = 0; return count; }
    public void reset() { window = 0; accepted = 0; dropped = 0; }
}
