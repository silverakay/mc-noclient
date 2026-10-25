package xyz.baixur.mcbridge;

final class DisconnectPolicy {
    private DisconnectPolicy() {}

    static boolean targetOnline(String target, Iterable<String> players) {
        if (target == null || !target.matches("[A-Za-z0-9_]{1,16}") || players == null) return false;
        for (String name : players) if (target.equalsIgnoreCase(name)) return true;
        return false;
    }
}
