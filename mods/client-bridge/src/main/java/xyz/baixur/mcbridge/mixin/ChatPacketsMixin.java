package xyz.baixur.mcbridge.mixin;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket;
import net.minecraft.network.protocol.game.ClientboundDisguisedChatPacket;
import net.minecraft.network.protocol.game.ClientboundStartConfigurationPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import xyz.baixur.mcbridge.BridgeMod;

@Mixin(value = ClientPacketListener.class, remap = false)
public abstract class ChatPacketsMixin {
    @Inject(method = "handleSystemChat", at = @At("HEAD"))
    private void mcbridge$system(ClientboundSystemChatPacket packet, CallbackInfo ci) {
        if (Minecraft.getInstance().isSameThread())
            BridgeMod.capture((ClientPacketListener)(Object)this, packet.content(), packet.overlay() ? "actionbar" : "system", null);
    }

    @Inject(method = "handlePlayerChat", at = @At("HEAD"))
    private void mcbridge$player(ClientboundPlayerChatPacket packet, CallbackInfo ci) {
        if (!Minecraft.getInstance().isSameThread()) return;
        Component content = packet.unsignedContent() != null ? packet.unsignedContent() : Component.literal(packet.body().content());
        ClientPacketListener listener = (ClientPacketListener)(Object)this;
        var player = listener.getPlayerInfo(packet.sender());
        BridgeMod.capture(listener, packet.chatType().decorate(content), "player", player == null ? null : player.getProfile().name());
    }

    @Inject(method = "handleDisguisedChat", at = @At("HEAD"))
    private void mcbridge$disguised(ClientboundDisguisedChatPacket packet, CallbackInfo ci) {
        if (Minecraft.getInstance().isSameThread())
            BridgeMod.capture((ClientPacketListener)(Object)this, packet.chatType().decorate(packet.message()), "player", null);
    }

    @Inject(method = "handleConfigurationStart", at = @At("TAIL"))
    private void mcbridge$config(ClientboundStartConfigurationPacket packet, CallbackInfo ci) {
        if (Minecraft.getInstance().isSameThread()) BridgeMod.invalidate();
    }
}
