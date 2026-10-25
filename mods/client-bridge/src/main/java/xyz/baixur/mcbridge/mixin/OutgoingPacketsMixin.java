package xyz.baixur.mcbridge.mixin;

import io.netty.channel.ChannelFutureListener;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.Packet;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import xyz.baixur.mcbridge.BridgeMod;

@Mixin(value = Connection.class, remap = false)
public abstract class OutgoingPacketsMixin {
    @Inject(method = "send(Lnet/minecraft/network/protocol/Packet;Lio/netty/channel/ChannelFutureListener;Z)V", at = @At("TAIL"))
    private void mcbridge$outgoing(Packet<?> packet, ChannelFutureListener listener, boolean flush, CallbackInfo ci) {
        BridgeMod.captureOutgoing((Connection)(Object)this, packet);
    }
}
