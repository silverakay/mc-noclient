import io.netty.buffer.Unpooled;
import java.util.Base64;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.network.protocol.game.ServerboundPlayerInputPacket;

// Official 26.2 codecs only: no game loop, server launch, login or networking.
class OfficialMenuKeysCheck {
    public static void main(String[] args) {
        for (int index : new int[] { 0, 2 }) {
            var input = new FriendlyByteBuf(Unpooled.wrappedBuffer(Base64.getDecoder().decode(args[index])));
            try {
                var packet = ServerboundPlayerInputPacket.STREAM_CODEC.decode(input);
                var value = packet.input();
                if (input.isReadable() || value.shift() != (index == 0) || value.forward() || value.backward()
                    || value.left() || value.right() || value.jump() || value.sprint()) throw new AssertionError("Bad sneak input");
            } finally { input.release(); }
        }
        var action = new FriendlyByteBuf(Unpooled.wrappedBuffer(Base64.getDecoder().decode(args[1])));
        try {
            var packet = ServerboundPlayerActionPacket.STREAM_CODEC.decode(action);
            if (action.isReadable() || packet.getAction() != ServerboundPlayerActionPacket.Action.SWAP_ITEM_WITH_OFFHAND
                || !packet.getPos().equals(BlockPos.ZERO) || packet.getDirection() != Direction.DOWN || packet.getSequence() != 0)
                throw new AssertionError("Bad swap action");
        } finally { action.release(); }
        System.out.println("PASS official 26.2 codecs: sneak, swap-offhand, restore; no other input bits");
    }
}
