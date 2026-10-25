package xyz.baixur.mcbridge.mixin;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.protocol.game.ClientboundOpenScreenPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import xyz.baixur.mcbridge.BridgeMod;

@Mixin(value = ClientPacketListener.class, remap = false)
public abstract class PurchaseScreenMixin {
    @Inject(method = "handleOpenScreen", at = @At("TAIL"))
    private void mcbridge$purchaseScreen(ClientboundOpenScreenPacket packet, CallbackInfo ci) {
        if (Minecraft.getInstance().isSameThread())
            BridgeMod.purchaseScreen((ClientPacketListener)(Object)this, packet.getContainerId(), packet.getTitle().getString(2048));
    }
}
