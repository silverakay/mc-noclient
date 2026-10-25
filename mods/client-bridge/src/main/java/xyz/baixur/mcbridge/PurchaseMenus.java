package xyz.baixur.mcbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.inventory.ChestMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;

final class PurchaseMenus {
    private Screen screen;
    private String token = "";
    private String last = "";
    private int revision;
    private JsonObject current;
    private final PurchaseKeySequence keys = new PurchaseKeySequence();
    private int packetContainer = -1;
    private String packetTitle;
    private Screen packetScreen;
    private long screenGeneration;
    private long seenGeneration = -1;
    private long awaitingScreen = -1;

    void reset() {
        keys.cancel(); screen = null; token = ""; last = ""; revision = 0; current = null;
        packetContainer = -1; packetTitle = null; packetScreen = null; screenGeneration = 0; seenGeneration = -1; awaitingScreen = -1;
    }
    void opened(Screen opened, int id, String title) {
        packetScreen = opened; packetContainer = id; packetTitle = title; screenGeneration++;
    }
    void tick() { keys.tick(System.currentTimeMillis()); }
    static boolean allowedName(String title, String name) {
        return switch (title(title)) {
            case "芒果小镇主菜单" -> name.equals("小镇商店");
            case "系统商店" -> name.equals("系统收购") || name.equals("星露谷收购");
            case "星露谷收购商店" -> name.equals("农作物收购");
            default -> false;
        };
    }
    static String clean(String value) { return value.replaceAll("\u00a7[0-9a-fk-orxA-FK-ORX]", "").trim(); }
    static String title(String value) { return clean(value).replaceAll("[《》<>\\s]", ""); }
    private static boolean known(String name) {
        return switch (title(name)) {
            case "芒果小镇主菜单", "系统商店", "星露谷收购商店", "每日随机收购商店", "星露谷每日随机收购商店" -> true;
            default -> false;
        };
    }
    private static JsonObject item(ItemStack stack) {
        if (stack.isEmpty()) return null;
        JsonObject item = new JsonObject();
        item.addProperty("name", stack.getHoverName().getString(2048));
        item.addProperty("identifier", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        item.addProperty("count", stack.getCount());
        JsonArray lines = new JsonArray();
        var lore = stack.get(DataComponents.LORE);
        if (lore != null) for (var line : lore.lines()) { if (lines.size() >= 24) break; lines.add(line.getString(2048)); }
        item.add("lore", lines); return item;
    }
    JsonObject poll(Minecraft mc) {
        Screen activeScreen = mc.gui.screen();
        if (activeScreen == null) {
            if (current == null) return null;
            reset(); JsonObject frame = new JsonObject(); frame.add("menu", JsonNull.INSTANCE); return frame;
        }
        // Never publish the locally predicted cursor/slots after a navigation click.
        // Each verified navigation step opens a fresh server screen, even with id 119 reused.
        if (awaitingScreen == screenGeneration && screen == activeScreen) return null;
        awaitingScreen = -1;
        if (screen != activeScreen || seenGeneration != screenGeneration) {
            screen = activeScreen; seenGeneration = screenGeneration;
            token = UUID.randomUUID().toString(); revision = 0; last = "";
        }
        String actualTitle = packetScreen == activeScreen && packetContainer == mc.player.containerMenu.containerId && packetTitle != null
            ? packetTitle : activeScreen.getTitle().getString(2048);
        JsonObject menu = new JsonObject();
        menu.addProperty("id", mc.player.containerMenu.containerId > 0 ? mc.player.containerMenu.containerId : 1);
        menu.addProperty("token", token); menu.addProperty("title", actualTitle);
        JsonArray slots = new JsonArray();
        boolean supported = activeScreen instanceof AbstractContainerScreen<?> container && container.getMenu() instanceof ChestMenu
            && known(actualTitle);
        int size = supported ? ((ChestMenu)((AbstractContainerScreen<?>)activeScreen).getMenu()).getRowCount() * 9 : 0;
        for (int i = 0; i < size; i++) slots.add(item(mc.player.containerMenu.getSlot(i).getItem()));
        menu.add("slots", slots); menu.addProperty("expectedSlots", size);
        menu.add("cursor", item(mc.player.containerMenu.getCarried()));
        menu.addProperty("stateId", mc.player.containerMenu.getStateId());
        menu.addProperty("status", supported ? "ready" : "waiting");
        menu.addProperty("interactive", supported && mc.player.containerMenu.getCarried().isEmpty());
        String fingerprint = menu.toString();
        if (fingerprint.equals(last)) return null;
        last = fingerprint; menu.addProperty("revision", ++revision); current = menu;
        JsonObject frame = new JsonObject(); frame.add("menu", menu); return frame;
    }
    void open(Minecraft mc, long deadline, BooleanSupplier valid, Consumer<String> complete) {
        if (mc.gui.screen() != null || mc.player.isHandsBusy() || mc.options.keyShift.isDown()
            || mc.player.isShiftKeyDown() || mc.options.keySwapOffhand.isUnbound())
            throw new IllegalStateException("Close screens and release Shift before collecting");
        var connection = mc.getConnection();
        keys.start(new PurchaseKeySequence.Actions() {
            public boolean valid(boolean swapped) {
                return valid.getAsBoolean() && mc.getConnection() == connection && mc.player != null
                    && (swapped || mc.gui.screen() == null);
            }
            public boolean shiftReady() { return mc.player.isShiftKeyDown() && mc.player.getLastSentInput().shift(); }
            public void hold() { mc.options.keyShift.setDown(true); }
            public void swap() { KeyMapping.click(InputConstants.getKey(mc.options.keySwapOffhand.saveString())); }
            public void release() {
                mc.options.keyShift.setDown(false);
                // Toggle-sneak ignores setDown(false); restore its pre-request off state.
                if (mc.options.keyShift.isDown()) mc.options.keyShift.setDown(true);
            }
        }, deadline, complete);
    }
    void execute(Minecraft mc, JsonObject request) {
        String operation = request.get("purchase").getAsString();
        if (operation.equals("cancelOpen")) { keys.cancel(); return; }
        JsonObject target = request.getAsJsonObject("menu");
        if (current == null || !(mc.gui.screen() instanceof AbstractContainerScreen<?> container) || !(container.getMenu() instanceof ChestMenu)
            || target.get("id").getAsInt() != mc.player.containerMenu.containerId
            || !token.equals(target.get("token").getAsString()) || revision != target.get("revision").getAsInt()
            || !mc.player.containerMenu.getCarried().isEmpty()) throw new IllegalStateException("Purchase menu expired or cursor occupied");
        if (operation.equals("close")) { mc.player.closeContainer(); return; }
        if (!operation.equals("navigate")) throw new IllegalStateException("Unknown purchase operation");
        int slot = target.get("slot").getAsInt();
        String expected = slot < 0 || slot >= ((ChestMenu)container.getMenu()).getRowCount() * 9 ? ""
            : clean(mc.player.containerMenu.getSlot(slot).getItem().getHoverName().getString()).replaceAll("[\\[\\]【】\\s]", "");
        String actualTitle = current.get("title").getAsString();
        if (target.get("button").getAsInt() != 0 || !allowedName(actualTitle, expected))
            throw new IllegalStateException("Only validated purchase navigation is allowed; never selling");
        int matches = 0;
        for (int i = 0; i < ((ChestMenu)container.getMenu()).getRowCount() * 9; i++)
            if (clean(mc.player.containerMenu.getSlot(i).getItem().getHoverName().getString()).replaceAll("[\\[\\]【】\\s]", "").equals(expected)) matches++;
        if (matches != 1) throw new IllegalStateException("Ambiguous purchase navigation");
        awaitingScreen = screenGeneration;
        mc.gameMode.handleContainerInput(mc.player.containerMenu.containerId, slot, 0, ContainerInput.PICKUP, mc.player);
    }
}
