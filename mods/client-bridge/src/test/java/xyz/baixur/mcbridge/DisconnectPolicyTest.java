package xyz.baixur.mcbridge;

import java.util.List;

public final class DisconnectPolicyTest {
    public static void main(String[] args) {
        if (!DisconnectPolicy.targetOnline("mango0v0", List.of("Tester", "MaNgO0v0"))) throw new AssertionError("Exact ID missing");
        for (String target : new String[] { "", "@mango0v0", "mango0v0 ", "mango0v0\n", "NameTooLong12345678", "other" }) {
            if (DisconnectPolicy.targetOnline(target, List.of("mango0v0"))) throw new AssertionError("Unsafe target accepted");
        }
        if (DisconnectPolicy.targetOnline("mango0v0", List.of("mangoOvO", "xmango0v0", "mango0v01")))
            throw new AssertionError("Different IDs must not match");
        if (DisconnectPolicy.targetOnline(null, List.of("mango0v0")) || DisconnectPolicy.targetOnline("mango0v0", null))
            throw new AssertionError("Missing evidence must not disconnect");
        System.out.println("PASS DisconnectPolicy: exact live ID, case, missing evidence and stale/unsafe target rejection");
    }
}
