package xyz.baixur.mcbridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.objectweb.asm.AnnotationVisitor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

public final class MixinTargetTest {
    public static void main(String[] args) throws Exception {
        checkReleaseResources(args.length == 0 ? null : args[0]);
        checkBridgeWiring();
        int total = check("ClientPacketListener", "/net/minecraft/client/multiplayer/ClientPacketListener.class", "ChatPacketsMixin", 4)
            + check("Connection", "/net/minecraft/network/Connection.class", "OutgoingPacketsMixin", 1)
            + check("ClientPacketListener", "/net/minecraft/client/multiplayer/ClientPacketListener.class", "PurchaseScreenMixin", 1);
        if (total != 6) throw new AssertionError("Expected six chat/command/purchase-title hooks");
        System.out.println("PASS MixinTarget: six non-cancelling chat/command/purchase-title descriptors match local 26.2 bytecode (not a runtime launch)");
    }

    private static JsonObject resourceJson(String path) throws Exception {
        InputStream input = MixinTargetTest.class.getResourceAsStream(path);
        if (input == null) throw new AssertionError("Missing packaged resource: " + path);
        try (var reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        }
    }

    private static void checkReleaseResources(String expectedVersion) throws Exception {
        var metadata = resourceJson("/fabric.mod.json");
        if (!metadata.get("id").getAsString().equals("mc_noclient_bridge")
            || !metadata.get("environment").getAsString().equals("client")
            || !metadata.getAsJsonObject("depends").get("minecraft").getAsString().equals("26.2")
            || expectedVersion != null && !metadata.get("version").getAsString().equals(expectedVersion))
            throw new AssertionError("Wrong packaged bridge identity, version or target");
        var entrypoints = metadata.getAsJsonObject("entrypoints").getAsJsonArray("client");
        if (entrypoints.size() != 1 || !entrypoints.get(0).getAsString().equals("xyz.baixur.mcbridge.BridgeMod"))
            throw new AssertionError("Wrong client entrypoint");
        var mixinFiles = metadata.getAsJsonArray("mixins");
        if (mixinFiles.size() != 1 || !mixinFiles.get(0).getAsString().equals("mc-noclient-bridge.mixins.json"))
            throw new AssertionError("Monitor mixin configuration must be loaded");
        var mixins = resourceJson("/mc-noclient-bridge.mixins.json");
        if (!mixins.get("required").getAsBoolean()
            || !mixins.get("compatibilityLevel").getAsString().equals("JAVA_25")
            || !mixins.get("package").getAsString().equals("xyz.baixur.mcbridge.mixin")
            || mixins.getAsJsonObject("injectors").get("defaultRequire").getAsInt() != 1)
            throw new AssertionError("Passive hooks must be required with the correct runtime");
        Set<String> names = new HashSet<>();
        for (var name : mixins.getAsJsonArray("client")) names.add(name.getAsString());
        if (!names.equals(Set.of("ChatPacketsMixin", "OutgoingPacketsMixin", "PurchaseScreenMixin"))
            || mixins.getAsJsonArray("client").size() != 3)
            throw new AssertionError("Expected chat, command and authoritative purchase-title mixins");
        for (String type : new String[] { "BridgeMod", "BridgeHandshake", "BridgeDiscovery", "GameOfflineState", "MonitorSafety", "ActionRegistry",
            "PurchaseMenus", "PurchaseKeySequence", "DisconnectPolicy", "mixin/PurchaseScreenMixin", "mixin/ChatPacketsMixin", "mixin/OutgoingPacketsMixin" }) {
            try (var input = MixinTargetTest.class.getResourceAsStream("/xyz/baixur/mcbridge/" + type + ".class")) {
                if (input == null) throw new AssertionError("Missing packaged class: " + type);
            }
        }
        for (String removed : new String[] { "mixin/ContainerInputMixin", "BridgeMod$ClickSnapshot", "FishingControl" }) {
            try (var input = MixinTargetTest.class.getResourceAsStream("/xyz/baixur/mcbridge/" + removed + ".class")) {
                if (input != null) throw new AssertionError("Obsolete feature class packaged: " + removed);
            }
        }
        System.out.println("PASS PackagedResources: release identity and chat/command monitor hooks retained");
    }

    private static void checkBridgeWiring() throws Exception {
        Set<String> calls = new HashSet<>();
        Set<String> outgoingTypes = new HashSet<>();
        try (var input = MixinTargetTest.class.getResourceAsStream("/xyz/baixur/mcbridge/BridgeMod.class")) {
            new ClassReader(input).accept(new ClassVisitor(Opcodes.ASM9) {
                @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                    if (Set.of("captureScreen", "snapshotClick", "clearClick").contains(name))
                        throw new AssertionError("Menu monitoring still present: " + name);
                    boolean outgoing = name.equals("captureOutgoing");
                    return new MethodVisitor(Opcodes.ASM9) {
                        @Override public void visitTypeInsn(int opcode, String type) {
                            if (outgoing && opcode == Opcodes.INSTANCEOF) outgoingTypes.add(type);
                        }
                        @Override public void visitMethodInsn(int opcode, String owner, String name, String descriptor, boolean isInterface) {
                            calls.add(owner + "." + name);
                        }
                    };
                }
            }, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        }
        if (!outgoingTypes.equals(Set.of("net/minecraft/network/protocol/game/ServerboundChatCommandPacket",
            "net/minecraft/network/protocol/game/ServerboundChatCommandSignedPacket")))
            throw new AssertionError("Outgoing observation must select only real command packets");
        for (String call : new String[] { "GameOfflineState.online", "GameOfflineState.disconnectedSession", "BridgeDiscovery.ports", "BridgeHandshake.hello", "BridgeHandshake.monitorEnabled", "BridgeHandshake.disconnectEnabled", "DisconnectPolicy.targetOnline", "MonitorSafety.command" }) {
            if (!calls.contains("xyz/baixur/mcbridge/" + call)) throw new AssertionError("Packaged bridge is not wired to " + call);
        }
        if (!calls.contains("net/minecraft/client/Minecraft.disconnectFromWorld")) throw new AssertionError("Game disconnect is not wired");
        System.out.println("PASS BridgeWiring: actual command packets only; capability negotiation remains connected");
    }

    private static int check(String target, String resource, String mixin, int count) throws Exception {
        Set<String> targets = new HashSet<>();
        try (InputStream input = MixinTargetTest.class.getResourceAsStream(resource)) {
            new ClassReader(input).accept(new ClassVisitor(Opcodes.ASM9) {
                @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                    targets.add(name + descriptor); return null;
                }
            }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        }
        int[] found = { 0 };
        try (InputStream input = MixinTargetTest.class.getResourceAsStream("/xyz/baixur/mcbridge/mixin/" + mixin + ".class")) {
            new ClassReader(input).accept(new ClassVisitor(Opcodes.ASM9) {
                @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                    return new MethodVisitor(Opcodes.ASM9) {
                        @Override public AnnotationVisitor visitAnnotation(String type, boolean visible) {
                            if (!type.equals("Lorg/spongepowered/asm/mixin/injection/Inject;")) return null;
                            return new AnnotationVisitor(Opcodes.ASM9) {
                                @Override public void visit(String field, Object value) {
                                    if (field.equals("cancellable") && Boolean.TRUE.equals(value))
                                        throw new AssertionError("Monitor must never cancel packets or input");
                                }
                                @Override public AnnotationVisitor visitArray(String field) {
                                    if (!field.equals("method")) return null;
                                    return new AnnotationVisitor(Opcodes.ASM9) {
                                        @Override public void visit(String ignored, Object value) {
                                            String expected = descriptor.replace("Lorg/spongepowered/asm/mixin/injection/callback/CallbackInfo;", "");
                                            String method = value.toString();
                                            String name = method.contains("(") ? method.substring(0, method.indexOf('(')) : method;
                                            if (!targets.contains(name + expected) || (method.contains("(") && !method.equals(name + expected)))
                                                throw new AssertionError("Mixin target mismatch: " + target + "." + value + " " + expected);
                                            found[0]++;
                                        }
                                    };
                                }
                            };
                        }
                    };
                }
            }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        }
        if (found[0] != count) throw new AssertionError("Unexpected hook count for " + mixin);
        return found[0];
    }
}
