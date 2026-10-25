import com.mojang.serialization.Lifecycle;
import io.netty.buffer.Unpooled;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.ArrayList;
import java.util.EnumSet;
import com.mojang.authlib.GameProfile;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.chat.LastSeenMessagesValidator;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundOpenScreenPacket;
import net.minecraft.network.protocol.game.ClientboundContainerSetContentPacket;
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket;
import net.minecraft.network.protocol.game.ClientboundCommandSuggestionsPacket;
import net.minecraft.network.protocol.game.ServerboundChatAckPacket;
import net.minecraft.network.protocol.game.ServerboundChatPacket;
import net.minecraft.world.inventory.MenuType;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.ItemLore;
import net.minecraft.world.level.GameType;
import net.minecraft.SharedConstants;
import net.minecraft.core.Holder;
import net.minecraft.core.MappedRegistry;
import net.minecraft.core.RegistrationInfo;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.Registries;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.chat.ChatType;
import net.minecraft.network.chat.ChatTypeDecoration;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.FilterMask;
import net.minecraft.network.chat.LastSeenMessages;
import net.minecraft.network.chat.MessageSignature;
import net.minecraft.network.chat.SignedMessageBody;
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket;
import net.minecraft.server.Bootstrap;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.world.entity.player.ChatVisiblity;

// Offline codec calls only: no server main, sockets, accounts, or real messages.
class OfficialChatCodecCheck {
    private static <T> void feature(String name, RegistryAccess registries,
                                   StreamCodec<? super RegistryFriendlyByteBuf, T> codec, T packet) {
        var buffer = new RegistryFriendlyByteBuf(Unpooled.buffer(), registries);
        try {
            codec.encode(buffer, packet);
            byte[] bytes = new byte[buffer.readableBytes()]; buffer.readBytes(bytes);
            Bootstrap.STDOUT.println("FEATURE_PACKET " + name + " " + Base64.getEncoder().encodeToString(bytes));
        } finally { buffer.release(); }
    }

    private static MessageSignature signature(int index) {
        byte[] bytes = new byte[256]; java.nio.ByteBuffer.wrap(bytes).putInt(index);
        return new MessageSignature(bytes);
    }

    private static void features(String[] args) throws Exception {
        var registries = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY);
        var id = UUID.fromString("00000000-0000-0000-0000-000000000001");
        var players = new ClientboundPlayerInfoUpdatePacket(
            EnumSet.allOf(ClientboundPlayerInfoUpdatePacket.Action.class), List.of());
        // Offline fixture: a packet without a live ServerPlayer or a running server.
        var entries = ClientboundPlayerInfoUpdatePacket.class.getDeclaredField("entries");
        entries.setAccessible(true);
        entries.set(players, List.of(new ClientboundPlayerInfoUpdatePacket.Entry(id,
            new GameProfile(id, "CodecPlayer"), true, 42, GameType.SURVIVAL,
            Component.literal("Codec display"), true, 300, null)));
        feature("players", registries, ClientboundPlayerInfoUpdatePacket.STREAM_CODEC, players);
        feature("menu", registries, ClientboundOpenScreenPacket.STREAM_CODEC,
            new ClientboundOpenScreenPacket(300, MenuType.GENERIC_9x1, Component.literal("Codec menu")));
        // Bind fixture defaults without loading a world or starting the server.
        Items.DIAMOND.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY);
        Items.STONE.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY);
        var stack = new ItemStack(Items.DIAMOND, 3);
        stack.set(DataComponents.CUSTOM_NAME, Component.literal("Codec item"));
        stack.set(DataComponents.LORE, new ItemLore(List.of(Component.literal("Codec lore"))));
        var slots = new ArrayList<ItemStack>();
        for (int i = 0; i < 45; i++) slots.add(i == 0 ? stack : ItemStack.EMPTY);
        feature("contents", registries, ClientboundContainerSetContentPacket.STREAM_CODEC,
            new ClientboundContainerSetContentPacket(300, 7, slots, ItemStack.EMPTY));
        feature("slot", registries, ClientboundContainerSetSlotPacket.STREAM_CODEC,
            new ClientboundContainerSetSlotPacket(300, 8, 1, new ItemStack(Items.STONE, 2)));
        feature("completion", registries, ClientboundCommandSuggestionsPacket.STREAM_CODEC,
            new ClientboundCommandSuggestionsPacket(1, 1, 2, List.of(
                new ClientboundCommandSuggestionsPacket.Entry("help", Optional.of(Component.literal("Codec tip"))))));
        var validator = new LastSeenMessagesValidator(20);
        for (int i = 1; i <= 65; i++) { validator.addPending(signature(i)); validator.addPending(signature(i)); }
        var ackBuffer = new FriendlyByteBuf(Unpooled.wrappedBuffer(Base64.getDecoder().decode(args[1])));
        try {
            var ack = ServerboundChatAckPacket.STREAM_CODEC.decode(ackBuffer);
            if (ack.offset() != 65 || ackBuffer.readableBytes() != 0) throw new AssertionError("ACK mismatch");
            validator.applyOffset(ack.offset());
        } finally { ackBuffer.release(); }
        for (int i = 66; i <= 68; i++) validator.addPending(signature(i));
        var chatBuffer = new FriendlyByteBuf(Unpooled.wrappedBuffer(Base64.getDecoder().decode(args[2])));
        try {
            var chat = ServerboundChatPacket.STREAM_CODEC.decode(chatBuffer);
            if (chatBuffer.readableBytes() != 0) throw new AssertionError("Chat trailing bytes");
            var seen = validator.applyUpdate(chat.lastSeenMessages()).entries();
            if (seen.size() != 20 || !seen.get(0).equals(signature(49)) || !seen.get(19).equals(signature(68)))
                throw new AssertionError("Last-seen window mismatch");
            Bootstrap.STDOUT.println("FEATURE_ACK_VALID 65 20");
        } finally { chatBuffer.release(); }
    }
    private static void emit(String name, RegistryAccess registries,
                             Holder<ChatType> type, boolean signed, boolean decorated) {
        byte[] signature = new byte[256];
        Arrays.fill(signature, (byte) 0xAB);
        var body = new SignedMessageBody.Packed("codec-body", Instant.ofEpochMilli(1700000000000L),
            123456L, LastSeenMessages.Packed.EMPTY);
        var bound = new ChatType.Bound(type, Component.literal("CodecSender"), Optional.empty());
        var packet = new ClientboundPlayerChatPacket(300,
            UUID.fromString("00000000-0000-0000-0000-000000000001"), 7,
            signed ? new MessageSignature(signature) : null, body,
            decorated ? Component.literal("codec-decorated") : null,
            FilterMask.PASS_THROUGH, bound);
        var buffer = new RegistryFriendlyByteBuf(Unpooled.buffer(), registries);
        try {
            ClientboundPlayerChatPacket.STREAM_CODEC.encode(buffer, packet);
            byte[] bytes = new byte[buffer.readableBytes()];
            buffer.readBytes(bytes);
            Bootstrap.STDOUT.println("CODEC_PACKET " + name + " " + Base64.getEncoder().encodeToString(bytes));
        } finally { buffer.release(); }
    }

    public static void main(String[] args) throws Exception {
        SharedConstants.tryDetectVersion();
        Bootstrap.bootStrap();
        if (SharedConstants.getProtocolVersion() != 776) throw new AssertionError("Wrong server protocol");
        if (args[0].equals("features")) { features(args); return; }
        if (args[0].equals("items")) {
            for (var item : BuiltInRegistries.ITEM) {
                Bootstrap.STDOUT.println("ITEM " + BuiltInRegistries.ITEM.getId(item) + " "
                    + BuiltInRegistries.ITEM.getKey(item) + " " + item.getDescriptionId());
            }
            return;
        }
        var settingsBuffer = new FriendlyByteBuf(Unpooled.wrappedBuffer(Base64.getDecoder().decode(args[0])));
        try {
            var settings = new ClientInformation(settingsBuffer);
            if (settings.chatVisibility() != ChatVisiblity.FULL || settings.textFilteringEnabled()
                || !settings.language().equals("zh_cn") || settingsBuffer.readableBytes() != 0) {
                throw new AssertionError("Client settings not decoded as full, unfiltered Chinese chat");
            }
            Bootstrap.STDOUT.println("CODEC_SETTINGS FULL zh_cn unfiltered");
        } finally { settingsBuffer.release(); }

        var registry = new MappedRegistry<ChatType>(Registries.CHAT_TYPE, Lifecycle.stable());
        var type = new ChatType(ChatTypeDecoration.withSender("chat.type.text"),
            ChatTypeDecoration.withSender("chat.type.text.narrate"));
        var reference = registry.register(ChatType.CHAT, type, RegistrationInfo.BUILT_IN);
        registry.freeze();
        var registries = new RegistryAccess.ImmutableRegistryAccess(List.of(registry));
        emit("unsigned-reference", registries, reference, false, false);
        emit("signed-reference", registries, reference, true, false);
        emit("signed-decorated", registries, reference, true, true);
        emit("signed-inline", registries, Holder.direct(type), true, false);
    }
}
