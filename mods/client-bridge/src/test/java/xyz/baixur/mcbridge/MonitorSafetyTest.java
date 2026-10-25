package xyz.baixur.mcbridge;

public final class MonitorSafetyTest {
    private static void check(boolean condition) { if (!condition) throw new AssertionError("Monitor safety check failed"); }
    public static void main(String[] args) {
        check(MonitorSafety.command("workbench", false).get("command").getAsString().equals("/workbench"));
        for (String root : new String[] {"login", "L", "register", "authme:login", "changepassword", "otp", "email"}) {
            var event = MonitorSafety.command(root + " PRIVATE_TEST_SECRET", true);
            check(event.get("redacted").getAsBoolean()); check(!event.toString().contains("PRIVATE_TEST_SECRET"));
        }
        check(MonitorSafety.command("bad\nPRIVATE", false) == null);
        check(MonitorSafety.command("", false) == null);
        check(MonitorSafety.command("//fixture", false) == null);
        check(MonitorSafety.command("x".repeat(32768), false) == null);
        var longCommand = MonitorSafety.command("fixture " + "x".repeat(3000), false);
        check(longCommand.get("truncated").getAsBoolean()); check(longCommand.get("command").getAsString().equals("/fixture"));
        MonitorSafety limiter = new MonitorSafety();
        for (int i = 0; i < 20; i++) check(limiter.allow(0));
        for (int i = 0; i < 10; i++) check(!limiter.allow(0));
        check(limiter.takeDropped() == 10); check(limiter.takeDropped() == 0);
        limiter.restoreDropped(40); check(limiter.takeDropped() == 40);
        check(limiter.allow(1_000_000_000L)); limiter.drop(); check(limiter.takeDropped() == 1);
        limiter.reset(); check(limiter.allow(0)); check(limiter.takeDropped() == 0);
        System.out.println("PASS MonitorSafety: command redaction, limits, control characters and bounded sampling (no game/network)");
    }
}
