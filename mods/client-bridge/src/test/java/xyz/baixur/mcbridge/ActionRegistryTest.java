package xyz.baixur.mcbridge;

public final class ActionRegistryTest {
    public static void main(String[] args) {
        ActionRegistry registry = new ActionRegistry();
        check(!ActionRegistry.valid("/")); check(!ActionRegistry.valid("//claim"));
        check(!ActionRegistry.valid("/ claim")); check(!ActionRegistry.valid("/claim\nother"));
        check(!ActionRegistry.valid("/claim\u0000")); check(!ActionRegistry.valid("claim"));
        String first = registry.register("/fixture packet", 1000);
        String duplicate = registry.register("/fixture packet", 1001);
        check("fixture packet".equals(registry.take(first, 1002)));
        check(registry.take(first, 1003) == null); check(registry.take(duplicate, 1003) == null);
        check(registry.register("/fixture packet", 1004) == null);
        check(registry.register("/fixture packet", 122000) != null);
        String stale = registry.register("/fixture stale", 2000);
        check(registry.take(stale, 123000) == null);
        String old = registry.register("/fixture old", 2000);
        registry.clear(); check(registry.take(old, 2001) == null);
        String rollback = registry.register("/fixture rollback", 2000);
        check(registry.take(rollback, 1000) == null);
        for (int i = 0; i < 5000; i++) registry.register("/fixture " + i, 2000);
        check(registry.take("not-a-registered-id", 2001) == null);
        System.out.println("PASS ActionRegistry: validation, at-most-once, duplicate, TTL, reset, clock rollback, bounds");
    }
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
}
