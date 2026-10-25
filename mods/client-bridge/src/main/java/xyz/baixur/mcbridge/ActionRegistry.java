package xyz.baixur.mcbridge;

import java.util.LinkedHashMap;
import java.util.UUID;

public final class ActionRegistry {
    private record Entry(String command, long at) {}
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
    private final LinkedHashMap<String, Long> consumed = new LinkedHashMap<>();
    private static final long TTL = 120_000;

    public void clear() { entries.clear(); consumed.clear(); }

    public static boolean valid(String command) {
        return command != null && command.length() > 1 && command.length() <= 2048
            && command.charAt(0) == '/' && command.charAt(1) != '/'
            && !Character.isWhitespace(command.charAt(1))
            && command.chars().noneMatch(c -> c < 32 || c == 127);
    }

    public String register(String command, long now) {
        if (!valid(command)) return null;
        entries.entrySet().removeIf(e -> now - e.getValue().at > TTL);
        consumed.entrySet().removeIf(e -> now - e.getValue() > TTL);
        if (consumed.containsKey(command)) return null;
        String id = UUID.randomUUID().toString();
        entries.put(id, new Entry(command, now));
        while (entries.size() > 4096) entries.remove(entries.keySet().iterator().next());
        return id;
    }

    public String take(String id, long now) {
        Entry entry = entries.remove(id);
        if (entry == null || now < entry.at || now - entry.at > TTL || consumed.containsKey(entry.command)) return null;
        entries.entrySet().removeIf(e -> e.getValue().command.equals(entry.command));
        consumed.put(entry.command, now);
        while (consumed.size() > 4096) consumed.remove(consumed.keySet().iterator().next());
        return entry.command.substring(1);
    }
}
