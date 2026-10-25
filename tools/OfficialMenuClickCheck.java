import io.netty.buffer.Unpooled;
import java.util.Base64;
import net.minecraft.SharedConstants;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.HashedStack;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.protocol.game.ServerboundContainerClickPacket;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

// Offline codec verification only. No world, player, network or server main.
class OfficialMenuClickCheck {
    public static void main(String[] args) {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
        if (SharedConstants.getProtocolVersion() != 776) throw new AssertionError("Wrong protocol");
        var menu = new AbstractContainerMenu(null, 300) {
            { addSlot(new Slot(new SimpleContainer(1), 0, 0, 0)); }
            public boolean stillValid(Player player) { return true; }
            public ItemStack quickMoveStack(Player player, int slot) { return ItemStack.EMPTY; }
        };
        menu.initializeContents(-1, java.util.List.of(ItemStack.EMPTY), ItemStack.EMPTY);
        if (menu.getStateId() != -1) throw new AssertionError("Vanilla must retain full-content state -1");
        menu.setItem(0, 7, ItemStack.EMPTY);
        menu.setItem(0, -1, ItemStack.EMPTY);
        if (menu.getStateId() != -1) throw new AssertionError("Vanilla must retain slot-update state -1");
        Bootstrap.STDOUT.println("MENU_STATE_MINUS_ONE_RETAINED");
        var registries = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY);
        if (args.length != 2 && args.length != 4) throw new AssertionError("Expected left/right states 7 and optionally -1");
        for (int index = 0; index < args.length; index++) {
            int button = index % 2;
            int expectedState = index < 2 ? 7 : -1;
            byte[] bytes = Base64.getDecoder().decode(args[index]);
            var buffer = new RegistryFriendlyByteBuf(Unpooled.wrappedBuffer(bytes), registries);
            try {
                var packet = ServerboundContainerClickPacket.STREAM_CODEC.decode(buffer);
                if (buffer.isReadable() || packet.containerId() != 300 || packet.stateId() != expectedState
                    || packet.slotNum() != 15 || packet.buttonNum() != button
                    || packet.containerInput() != ContainerInput.PICKUP || !packet.changedSlots().isEmpty()
                    || !packet.carriedItem().equals(HashedStack.EMPTY)) throw new AssertionError("Invalid click");
                var output = new RegistryFriendlyByteBuf(Unpooled.buffer(), registries);
                try {
                    ServerboundContainerClickPacket.STREAM_CODEC.encode(output, packet);
                    byte[] actual = new byte[output.readableBytes()]; output.readBytes(actual);
                    if (!java.util.Arrays.equals(bytes, actual)) throw new AssertionError("Round-trip mismatch");
                } finally { output.release(); }
                Bootstrap.STDOUT.println("MENU_CLICK_VALID button=" + button + " state=" + expectedState);
            } finally { buffer.release(); }
        }
    }
}
