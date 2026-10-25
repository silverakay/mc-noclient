package xyz.baixur.mcbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Optional;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ServerboundChatCommandPacket;
import net.minecraft.network.protocol.game.ServerboundChatCommandSignedPacket;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.Style;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class BridgeMod implements ClientModInitializer {
    private static final Logger LOG = LoggerFactory.getLogger("MCNoClientBridge");
    private static final int MAX_FRAME = 512 * 1024;
    private static final ActionRegistry ACTIONS = new ActionRegistry();
    private static volatile Link link;
    private static Link reportedLink;
    private static ClientPacketListener gameConnection;
    private static final GameOfflineState OFFLINE = new GameOfflineState();
    private static String reportedOfflineSession;
    private static String session;
    private static Path configDir;
    private static volatile String localUsername = "";
    private static long lastPlayers;
    private static long lastPurchasePoll;
    private static long lastPolicyCheck;
    private static boolean automationBlocked;
    private static final MonitorSafety MONITOR = new MonitorSafety();
    private static boolean bridgeDispatch;
    private static final PurchaseMenus PURCHASE = new PurchaseMenus();

    @Override
    public void onInitializeClient() {
        configDir = FabricLoader.getInstance().getConfigDir();
        ClientTickEvents.END_CLIENT_TICK.register(mc -> {
            try { tick(mc); } catch (RuntimeException e) { failLocal(e); }
        });
        Thread worker = new Thread(BridgeMod::connectLoop, "mcbridge-local-connector");
        worker.setDaemon(true); worker.start();
        String version = FabricLoader.getInstance().getModContainer("mc_noclient_bridge")
            .orElseThrow().getMetadata().getVersion().getFriendlyString();
        LOG.info("Local bridge {} loaded; passive command-only monitor available; no second Minecraft login; pairing required", version);
    }

    private static boolean ready(Minecraft mc, ClientPacketListener connection) {
        return connection != null && mc.level != null && mc.player != null
            && !mc.hasSingleplayerServer() && connection.getConnection().isConnected()
            && connection.hasClientLoaded() && connection.getServerData() != null;
    }

    private static void tick(Minecraft mc) {
        localUsername = mc.getUser().getName();
        sync(mc);
        if (link == null || session == null) return;
        PURCHASE.tick();
        long now = System.currentTimeMillis();
        if (now - lastPurchasePoll >= 200) { lastPurchasePoll = now; sendPurchase(mc); }
        if (now - lastPolicyCheck >= 5000) {
            lastPolicyCheck = now;
            boolean blocked = helperConflict();
            if (blocked != automationBlocked) { automationBlocked = blocked; sendState(); }
        }
        if (now - lastPlayers >= 3000) {
            lastPlayers = now;
            JsonArray players = new JsonArray();
            for (var player : gameConnection.getListedOnlinePlayers()) {
                if (players.size() >= 4096) break;
                JsonObject data = new JsonObject();
                data.addProperty("name", player.getProfile().name());
                data.addProperty("uuid", player.getProfile().id().toString());
                data.addProperty("latency", player.getLatency()); players.add(data);
            }
            JsonObject frame = frame("players"); frame.add("players", players); emit(frame);
        }
    }

    private static void sync(Minecraft mc) {
        ClientPacketListener current = mc.getConnection();
        if (!ready(mc, current)) current = null;
        Link active = link;
        String offlineSession = OFFLINE.disconnectedSession();
        if (current == gameConnection && active == reportedLink && Objects.equals(offlineSession, reportedOfflineSession)) return;
        ACTIONS.clear(); MONITOR.reset(); PURCHASE.reset(); gameConnection = current; reportedLink = active;
        session = current == null || active == null ? null : UUID.randomUUID().toString();
        if (session != null) OFFLINE.online(session, current.getConnection()::isConnected);
        reportedOfflineSession = OFFLINE.disconnectedSession();
        automationBlocked = helperConflict(); lastPlayers = 0;
        sendState();
    }

    public static void invalidate() {
        ACTIONS.clear(); MONITOR.reset(); PURCHASE.reset(); gameConnection = null; session = null; reportedLink = null;
        sendState();
    }

    private static JsonObject frame(String kind) {
        JsonObject value = new JsonObject(); value.addProperty("kind", kind);
        if (session != null) value.addProperty("session", session);
        return value;
    }

    private static void sendPurchase(Minecraft mc) {
        if (link == null || !link.purchase || session == null || !ready(mc, gameConnection)) return;
        JsonObject value = PURCHASE.poll(mc);
        if (value != null) {
            value.addProperty("kind", "purchase_menu"); value.addProperty("session", session); emit(value);
        }
    }

    public static void purchaseScreen(ClientPacketListener source, int id, String title) {
        Minecraft mc = Minecraft.getInstance();
        if (!mc.isSameThread() || source != gameConnection || link == null || !link.purchase || session == null) return;
        PURCHASE.opened(mc.gui.screen(), id, title);
    }

    private static void sendState() {
        JsonObject value = frame("state"); value.addProperty("online", session != null);
        String offlineSession = OFFLINE.disconnectedSession();
        if (session == null && offlineSession != null) {
            value.addProperty("gameDisconnected", true);
            value.addProperty("offlineSession", offlineSession);
        }
        if (session != null) {
            ServerAddress address = ServerAddress.parseString(gameConnection.getServerData().ip);
            value.addProperty("host", address.getHost()); value.addProperty("port", address.getPort());
            value.addProperty("username", gameConnection.getLocalGameProfile().name());
            value.addProperty("automationBlocked", automationBlocked);
        }
        emit(value);
    }

    private static boolean emit(JsonObject value) {
        Link active = link;
        return active != null && active.send(value);
    }

    private static boolean monitorReady(Minecraft mc) {
        Link own = link;
        return mc.isSameThread() && own != null && own.monitor && !own.monitorBroken
            && session != null && gameConnection == mc.getConnection() && ready(mc, gameConnection);
    }

    private static void monitorFailure(RuntimeException error) {
        Link own = link;
        if (own != null && !own.monitorBroken) {
            own.monitorBroken = true;
            LOG.warn("Passive monitor stopped after {}; chat bridge and game unchanged", error.getClass().getSimpleName());
        }
    }

    private static void observe(JsonObject event) {
        if (event != null && MONITOR.allow(System.nanoTime()) && !emitObservation(event)) MONITOR.drop();
    }

    private static boolean emitObservation(JsonObject event) {
        Link own = link;
        if (own == null || !own.monitor || own.monitorBroken || session == null) return false;
        JsonObject value = frame("observation");
        event.addProperty("at", System.currentTimeMillis()); value.add("event", event);
        return own.sendObservation(value);
    }

    public static void captureOutgoing(Connection source, Packet<?> packet) {
        // Only actual commands: no inventory, screen, item-use or payload inspection.
        if (!(packet instanceof ServerboundChatCommandPacket || packet instanceof ServerboundChatCommandSignedPacket)) return;
        try {
            Minecraft mc = Minecraft.getInstance();
            if (!monitorReady(mc) || source != gameConnection.getConnection() || !source.isConnected()) return;
            JsonObject event = packet instanceof ServerboundChatCommandPacket command
                ? MonitorSafety.command(command.command(), false)
                : MonitorSafety.command(((ServerboundChatCommandSignedPacket)packet).command(), true);
            if (event != null) { event.addProperty("origin", bridgeDispatch ? "bridge" : "game"); observe(event); }
        } catch (RuntimeException e) { monitorFailure(e); }
    }

    public static void capture(ClientPacketListener source, Component component, String type, String sender) {
        try { captureMessage(source, component, type, sender); }
        catch (RuntimeException e) { failLocal(e); }
    }

    private static void failLocal(RuntimeException error) {
        Link own = link;
        if (own != null) {
            own.close(); ACTIONS.clear();
            LOG.warn("Local bridge stopped after {}; game connection unchanged", error.getClass().getSimpleName());
        }
    }

    private static void captureMessage(ClientPacketListener source, Component component, String type, String sender) {
        Minecraft mc = Minecraft.getInstance();
        if (!mc.isSameThread() || source != mc.getConnection() || link == null) return;
        sync(mc);
        if (source != gameConnection || session == null) return;
        JsonArray runs = new JsonArray();
        HashMap<String, String> ids = new HashMap<>();
        int[] length = { 0 };
        component.visit((style, text) -> {
            if (runs.size() >= 2048 || length[0] >= 65536) return Optional.of(Boolean.TRUE);
            String clipped = text.substring(0, Math.min(text.length(), 65536 - length[0]));
            length[0] += clipped.length();
            JsonObject run = new JsonObject(); run.addProperty("text", clipped);
            if (style.getColor() != null) run.addProperty("color", String.format("#%06x", style.getColor().getValue() & 0xffffff));
            run.addProperty("bold", style.isBold()); run.addProperty("italic", style.isItalic());
            run.addProperty("underlined", style.isUnderlined()); run.addProperty("strikethrough", style.isStrikethrough());
            if (style.getHoverEvent() instanceof HoverEvent.ShowText hover)
                run.addProperty("hover", hover.value().getString(2048));
            if ("system".equals(type)) {
                JsonObject click = click(style.getClickEvent(), ids);
                if (click != null) run.add("click", click);
            }
            runs.add(run); return Optional.empty();
        }, Style.EMPTY);
        JsonObject value = frame("chat"); value.addProperty("source", type); value.add("runs", runs);
        if (sender != null) value.addProperty("sender", sender);
        emit(value);
    }

    private static JsonObject click(ClickEvent event, HashMap<String, String> ids) {
        if (event == null) return null;
        JsonObject value = new JsonObject();
        if (event instanceof ClickEvent.RunCommand command) {
            String id = ids.computeIfAbsent(command.command(), c -> ACTIONS.register(c, System.currentTimeMillis()));
            if (id == null) return null;
            value.addProperty("action", "run_command"); value.addProperty("value", command.command()); value.addProperty("remoteId", id);
        } else if (event instanceof ClickEvent.SuggestCommand command) {
            value.addProperty("action", "suggest_command"); value.addProperty("value", command.command());
        } else if (event instanceof ClickEvent.CopyToClipboard copy) {
            value.addProperty("action", "copy_to_clipboard"); value.addProperty("value", copy.value());
        } else if (event instanceof ClickEvent.OpenUrl url) {
            value.addProperty("action", "open_url"); value.addProperty("value", url.uri().toString());
        } else return null;
        return value;
    }

    private static boolean helperConflict() {
        if (!FabricLoader.getInstance().isModLoaded("redpacket")) return false;
        Path file = configDir.resolve("redpacket.json");
        try {
            if (!Files.exists(file)) return false;
            if (Files.size(file) > 65536) return true;
            JsonObject config = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            return !config.has("enabled") || config.get("enabled").getAsBoolean();
        } catch (Exception e) { return true; }
    }

    private static void execute(Link own, JsonObject request) {
        Minecraft mc = Minecraft.getInstance();
        sync(mc);
        String id = string(request, "id");
        String requestedSession = string(request, "session");
        JsonObject response = frame("result"); response.addProperty("id", id);
        response.addProperty("session", requestedSession);
        try {
            long deadline = request.get("expiresAt").getAsLong();
            long now = System.currentTimeMillis();
            if (link != own || !own.open() || !own.id.equals(string(request, "link"))
                || !requestedSession.equals(session) || !ready(mc, gameConnection)
                || now > deadline || deadline - now > 6000) throw new IllegalStateException("Session or request expired");
            String command;
            bridgeDispatch = true;
            if (request.has("control")) {
                if (!own.disconnect || !string(request, "control").equals("disconnect"))
                    throw new IllegalStateException("Game disconnect capability unavailable");
                String target = string(request, "player");
                var names = gameConnection.getListedOnlinePlayers().stream().map(p -> p.getProfile().name()).toList();
                if (!DisconnectPolicy.targetOnline(target, names))
                    throw new IllegalStateException("Selected player is no longer online");
                ACTIONS.clear(); PURCHASE.reset(); MONITOR.reset();
                mc.disconnectFromWorld(Component.literal("Bridge online-player exit"));
                if (ready(mc, mc.getConnection())) throw new IllegalStateException("Game is still online after disconnect");
            } else if (request.has("purchase")) {
                if (!own.purchase || helperConflict()) throw new IllegalStateException("Purchase capability unavailable or automation blocked");
                sendPurchase(mc);
                if (string(request, "purchase").equals("open")) {
                    PURCHASE.open(mc, deadline, () -> link == own && own.open() && requestedSession.equals(session)
                        && ready(mc, gameConnection) && !helperConflict(), error -> {
                            response.addProperty("ok", error == null);
                            if (error != null) response.addProperty("error", error);
                            own.send(response);
                        });
                    return;
                }
                PURCHASE.execute(mc, request);
                sendPurchase(mc);
            } else if (request.has("actionId")) {
                if (request.has("automatic") && request.get("automatic").getAsBoolean() && helperConflict())
                    throw new IllegalStateException("Other red packet helper enabled or unreadable");
                command = ACTIONS.take(string(request, "actionId"), now);
                if (command == null) throw new IllegalStateException("Server action expired or consumed");
                gameConnection.sendCommand(command);
            } else {
                String value = string(request, "value");
                if (value.isBlank() || value.length() > 32767 || value.chars().anyMatch(c -> c < 32 || c == 127))
                    throw new IllegalStateException("Invalid manual message");
                switch (string(request, "manual")) {
                    case "command" -> gameConnection.sendCommand(value);
                    case "chat" -> gameConnection.sendChat(value);
                    default -> throw new IllegalStateException("Invalid manual operation");
                }
            }
            response.addProperty("ok", true);
        } catch (Exception e) {
            response.addProperty("ok", false);
            response.addProperty("error", e instanceof IllegalStateException ? e.getMessage() : "Game dispatch failed; no retry");
        } finally {
            bridgeDispatch = false;
        }
        own.send(response);
    }

    private static String string(JsonObject object, String field) {
        return object.has(field) ? object.get(field).getAsString() : "";
    }

    private static void connectLoop() {
        while (true) {
            try {
                Path file = configDir.resolve("mc-noclient-bridge.json");
                if (!Files.exists(file)) { Thread.sleep(5000); continue; }
                if (Files.size(file) > 4096) throw new IllegalArgumentException("Pairing file too large");
                JsonObject config = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
                String username = localUsername;
                for (int port : BridgeDiscovery.ports(config, username, System.currentTimeMillis())) {
                    try { connect(config, port, username); break; }
                    catch (Exception ignored) { /* A busy local app never disconnects Minecraft; try the next listener. */ }
                }
            } catch (Exception e) {
                // Never log the pairing token or contents of private config files.
            }
            try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
        }
    }

    private static void connect(JsonObject config, int port, String username) throws Exception {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 2000);
            socket.setTcpNoDelay(true); socket.setSoTimeout(15000);
            write(socket.getOutputStream(), BridgeHandshake.hello(string(config, "token"), username));
            JsonObject welcome = read(socket.getInputStream());
            if (!"welcome".equals(string(welcome, "kind")) || welcome.get("version").getAsInt() != 1
                || !string(welcome, "link").matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("Pairing rejected");
            boolean monitoring = BridgeHandshake.monitorEnabled(welcome);
            Link own = new Link(socket, string(welcome, "link"), monitoring, BridgeHandshake.purchaseEnabled(welcome),
                BridgeHandshake.disconnectEnabled(welcome)); link = own;
            LOG.info("Local app paired; passive outgoing monitor negotiated: {}; awaiting current game session", monitoring);
            Thread writer = new Thread(own::writeLoop, "mcbridge-local-writer"); writer.setDaemon(true); writer.start();
            try {
                while (own.open()) {
                    JsonObject request = read(socket.getInputStream());
                    if ("heartbeat".equals(string(request, "kind"))) continue;
                    if (!"execute".equals(string(request, "kind")) || !own.id.equals(string(request, "link"))
                        || !string(request, "id").matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("Invalid request");
                    long now = System.currentTimeMillis();
                    own.requests.entrySet().removeIf(e -> e.getValue() < now);
                    if (own.requests.containsKey(string(request, "id"))) continue;
                    long expires = request.get("expiresAt").getAsLong();
                    if (expires - now > 6000) throw new IllegalArgumentException("Request expiry too long");
                    own.requests.put(string(request, "id"), expires);
                    if (own.requests.size() > 4096 || own.pending.incrementAndGet() > 32) throw new IllegalArgumentException("Request limit");
                    Minecraft.getInstance().execute(() -> {
                        try { execute(own, request); } finally { own.pending.decrementAndGet(); }
                    });
                }
            } finally { own.close(); LOG.info("Local bridge closed; no Minecraft reconnect or queued resend"); }
        }
    }

    private static JsonObject read(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int c; (c = input.read()) != -1;) {
            if (c == '\n') return JsonParser.parseString(bytes.toString(StandardCharsets.UTF_8)).getAsJsonObject();
            if (bytes.size() >= MAX_FRAME) throw new IllegalArgumentException("Frame too large");
            bytes.write(c);
        }
        throw new IllegalStateException("Local connection closed");
    }

    private static void write(OutputStream output, JsonObject frame) throws Exception {
        byte[] bytes = (frame.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_FRAME) throw new IllegalArgumentException("Frame too large");
        output.write(bytes); output.flush();
    }

    private static final class Link {
        final Socket socket;
        final String id;
        final boolean monitor;
        final boolean purchase;
        final boolean disconnect;
        boolean monitorBroken;
        final ArrayBlockingQueue<JsonObject> output = new ArrayBlockingQueue<>(128);
        final HashMap<String, Long> requests = new HashMap<>();
        final AtomicInteger pending = new AtomicInteger();
        private long sequence;

        Link(Socket socket, String id, boolean monitor, boolean purchase, boolean disconnect) {
            this.socket = socket; this.id = id; this.monitor = monitor; this.purchase = purchase; this.disconnect = disconnect;
        }
        boolean open() { return !socket.isClosed() && link == this; }
        synchronized boolean send(JsonObject value) {
            if (!open()) return false;
            value.addProperty("seq", ++sequence);
            if (output.offer(value)) return true;
            close(); return false;
        }
        synchronized boolean sendObservation(JsonObject value) {
            // Reserve queue capacity for chat, state, player lists and execution replies.
            if (!open() || output.remainingCapacity() <= 32) return false;
            value.addProperty("seq", ++sequence); return output.offer(value);
        }
        void close() {
            if (link == this) link = null;
            output.clear();
            try { socket.close(); } catch (Exception e) {}
        }
        void writeLoop() {
            try {
                long heartbeat = System.nanoTime();
                while (open()) {
                    JsonObject value = output.poll(500, TimeUnit.MILLISECONDS);
                    if (value != null) write(socket.getOutputStream(), value);
                    if (System.nanoTime() - heartbeat >= TimeUnit.SECONDS.toNanos(5)) {
                        JsonObject ping = new JsonObject(); ping.addProperty("kind", "heartbeat"); send(ping);
                        heartbeat = System.nanoTime();
                    }
                }
            } catch (Exception e) { close(); }
        }
    }
}
