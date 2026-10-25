'use strict';
/*
 * client.js —— 26.2 协议客户端
 *
 * 不做任何图形渲染，因此不需要游戏客户端、不需要显卡。
 * 它就相当于「一个只有网络层、没有画面的玩家」。
 *
 * 登录时序（26.2 实测流程）：
 *   C→S Handshake(nextState=2)
 *   C→S Login Start(username, uuid)
 *   S→C [Login Success]                 （离线服直接到这一步）
 *   C→S Login Acknowledged
 *   ==== 进入配置阶段 ====
 *   S→C Registry Data / Feature Flags / Select Known Packs ...
 *   S→C Finish Configuration
 *   C→S Acknowledge Finish Configuration
 *   ==== 进入 Play 阶段 ====
 *   S→C Login (play) / Synchronize Player Position ...
 *   C→S Confirm Teleportation
 *   ...保活循环...
 */

const net = require('net');
const crypto = require('crypto');
const dns = require('dns');
const {
  ByteWriter, ByteReader, PacketDecoder, encodePacket,
  PACKET_ID: P, PROTOCOL_VERSION, MC_VERSION,
} = require('./proto');
const { decodeComponent, readRoot, componentToText, componentToRuns } = require('./nbt');
const {
  computeServerHash, generateSharedSecret, rsaEncrypt,
  parsePublicKey, joinMojangSession,
  createCipher, createDecipher, usingNativeCfb8,
} = require('./crypt');
const { ServerFeatures, decode: decodeFeature, text: featureText } = require('./server_features');
const { MenuKeySequence } = require('./menu_key_sequence');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 离线模式 UUID：和原版一致 = MD5("OfflinePlayer:<name>")，且把版本位改成 3 */
function offlineUUID(name) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;    // version 3
  md5[8] = (md5[8] & 0x3f) | 0x80;    // variant
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';

/* ---------------- 聊天组件解析辅助 ----------------
 * 26.x 的文本组件是**匿名 NBT**（无根名），且末尾常跟非 NBT 的布尔/可选字段，
 * 所以不能用「把剩余字节整包丢给解析器」的写法 —— 必须先按 NBT 的真实长度
 * 走完游标，才能继续读后面的字段。
 */

/** 从协议读取器当前位置读一个匿名 NBT，并把游标推进到 NBT 之后 */
function readNbtFrom(r) {
  const { value, bytesRead } = readRoot(r.buf.subarray(r.p));
  r.p += bytesRead;
  return value;
}

/**
 * 解析「以字符串形式」给出的文本组件。
 *
 * ❗登录阶段（login）的 packet_disconnect.reason 类型是 **string** 而不是 NBT ——
 *   这与 configuration / play 阶段的同类包**不一样**（protocol.json 里写得很清楚）。
 *   所以这里不能复用 NBT 解析器，得按 JSON 文本组件处理，并容错纯文本。
 */
function parseTextComponentString(s) {
  if (typeof s !== 'string' || !s) return s || '';
  const t = s.trim();
  if (t[0] !== '{' && t[0] !== '[') return s;          // 不是 JSON，原样返回
  try {
    const parsed = JSON.parse(t);
    const out = componentToText(parsed);
    return out || s;
  } catch (e) {
    return s;                                          // JSON 坏了也别丢原文
  }
}

/**
 * 跳过 ChatTypesHolder（聊天类型标识）。
 * 编码规则（已用真实抓包验证）：VarInt id —— 0 表示后面跟内联定义，非 0 表示
 * 引用注册表、后面**没有**额外字节。
 *   实例：`21 ... 05 08 0006 "Server" 00` 里的 `05` 就是非 0 引用，
 *   紧跟其后的 `08` 已经是下一个字段（name）的起始。
 */
function skipChatTypeHolder(r) {
  const id = r.varint();
  if (id !== 0) return;                 // 引用注册表 → 没有内联数据
  // 内联定义：ChatTypes = { chat: ChatType, narration: ChatType }
  for (let k = 0; k < 2; k++) {
    r.str();                            // translationKey
    const n = r.varint();               // parameters 数量
    for (let i = 0; i < n; i++) r.varint();
    readNbtFrom(r);                     // style
  }
}

/**
 * 从 player_chat 的剩余字段取发送者显示名和服务端修饰过的正文。
 *
 * ❗这段是**尽力而为**：字段多、版本间会漂移，失败绝不能影响正文显示。
 *   因此调用方必须 try/catch，字段不完整时保留已读取的纯文本正文。
 */
function readChatDetails(r) {
  r.i64();                              // timestamp
  r.i64();                              // salt
  const n = r.varint();                 // previousMessages 条数
  if (n < 0 || n > 4096) throw new Error('previousMessages 数量异常: ' + n);
  for (let i = 0; i < n; i++) {
    const id = r.varint();
    if (id === 0) r.raw(256);           // id=0 时跟一个 256 字节签名
  }
  const content = r.bool() ? readNbtFrom(r) : null; // unsignedChatContent
  const filterType = r.varint();
  if (filterType === 2) {               // filterTypeMask
    const m = r.varint();
    if (m < 0 || m > 4096) throw new Error('filterTypeMask 数量异常: ' + m);
    for (let i = 0; i < m; i++) r.i64();
  }
  skipChatTypeHolder(r);                // type
  const sender = componentToText(readNbtFrom(r)) || null;
  return { sender, content };
}

class MCClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port=25565]
   * @param {string} [opts.username]
   * @param {string} [opts.version='26.2']  仅支持 26.2
   * @param {function} [opts.log]
   */
  constructor(opts = {}) {
    this.host = opts.host;
    this.port = opts.port || 25565;
    this.username = (opts.username || 'Steve').slice(0, 16);
    // 正版账号：UUID 必须用微软档案里的真实 UUID；
    // 离线模式：才用 MD5("OfflinePlayer:<name>") 推算
    this.uuid = opts.uuid || offlineUUID(this.username);
    this.log = opts.log || (() => {});
    this.onChat = opts.onChat || (() => {});
    this.onEvent = opts.onEvent || (() => {});

    this.socket = null;
    this.decoder = new PacketDecoder();
    this.state = 'idle';        // idle|login|config|play|closed
    this.threshold = -1;
    this.entityId = null;
    this.playerPos = null;
    this.keepAliveId = null;
    this.lastKeepAliveAt = 0;
    this.lastReceivedAt = 0;
    this._networkError = '';
    this.timer = null;
    this.alive = false;
    this.stats = { sent: 0, received: 0, chats: 0, uptimeFrom: 0 };

    /* ---- 正版验证相关 ---- */
    this.isPremium = false;             // 是否使用正版账号进服
    this.accessToken = opts.accessToken || null;
    this.profileId = opts.profileId || null;
    this.sharedSecret = null;           // AES-128 共享密钥
    this.encrypted = false;             // 是否已启用加密
    // 加解密流：必须提前声明为 null，避免「encrypted=true 但流未就绪」的竞态
    this._cipher = null;
    this._decipher = null;
    this._unknownPackets = new Set();
    this.features = new ServerFeatures({ onPlayers: (players) => this.onEvent('players', players),
      onMenu: (menu) => this.onEvent('menu', menu) });
    this.menuKeys = new MenuKeySequence({
      isCurrent: () => this.state === 'play' && !!this.socket && !this.socket.destroyed && this.socket.writable !== false,
      hasMenu: () => !!this.features.menu,
      input: (sneak) => this.send(P.playPlayerInput, (w) => w.u8(sneak ? 0x20 : 0)),
      swap: () => this.send(P.playPlayerAction, (w) => { w.varint(6); w.i64(0n); w.i8(0); w.varint(0); }),
    });
    this._completion = null;
    this._completionId = 0;
    this._lastCompletionAt = 0;
    this._loaded = false;
    this._signedPending = 0;
    this._lastSeen = [];
    this._lastSignature = null;
    this._signatureCursor = 0;
    this.chatDiagnostics = {
      received: { player: 0, system: 0, profileless: 0, actionbar: 0 },
      emitted: { player: 0, system: 0, profileless: 0, actionbar: 0 },
      errors: { player: 0, system: 0, profileless: 0, actionbar: 0 },
      detailFallbacks: 0, teleports: 0, teleportReplies: 0, lastTeleportId: null,
      positionErrors: 0, lastError: '', playPackets: {},
      pluginChannels: {}, featureErrors: {}, loadedReplies: 0, chatAcks: 0,
    };
  }

  getChatDiagnostics() { return JSON.parse(JSON.stringify(this.chatDiagnostics)); }

  getPlayers() { return this.features.getPlayers(); }

  featurePacket(name, method, r) {
    try { this.features[method](r.raw(r.remaining)); }
    catch (e) {
      this.chatDiagnostics.featureErrors[name] = (this.chatDiagnostics.featureErrors[name] || 0) + 1;
      if (this.chatDiagnostics.featureErrors[name] === 1) this.log('[扩展] ' + name + '：' + e.message);
      if (name === '菜单') this.features.menuFailure(e);
    }
  }

  handleCustomPayload(r) {
    try {
      const channel = r.str();
      if (!/^[a-z0-9_.-]+:[a-z0-9/_.-]+$/.test(channel) || channel.length > 256) throw new Error('通道名称无效');
      const channels = this.chatDiagnostics.pluginChannels;
      if (!Object.hasOwn(channels, channel) && Object.keys(channels).length >= 64) return;
      const record = channels[channel] || (channels[channel] = { packets: 0, bytes: 0 });
      record.packets++; record.bytes += r.remaining;
      if (channel === 'minecraft:brand') record.brand = r.str().slice(0, 128);
    } catch (e) {
      const errors = this.chatDiagnostics.featureErrors;
      errors.plugin = (errors.plugin || 0) + 1;
    }
  }

  sendLoaded() {
    if (this._loaded || this.state !== 'play') return;
    this._loaded = true;
    this.send(P.playPlayerLoaded);
    this.chatDiagnostics.loadedReplies++;
  }

  cancelCompletion(error = '连接状态已变化') {
    const request = this._completion;
    this._completion = null;
    if (request) { clearTimeout(request.timer); request.resolve({ ok: false, error }); }
  }

  completeCommand(text) {
    if (this.state !== 'play') return Promise.resolve({ ok: false, error: '未连接服务器' });
    if (typeof text !== 'string' || !text.startsWith('/') || text.length > 2048 || /[\x00-\x1f\x7f]/.test(text)) {
      return Promise.resolve({ ok: false, error: '补全内容无效' });
    }
    if (Date.now() - this._lastCompletionAt < 200) return Promise.resolve({ ok: false, error: '补全请求过快' });
    this._lastCompletionAt = Date.now();
    this.cancelCompletion('新的补全请求已替代旧请求');
    const id = ++this._completionId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.cancelCompletion('服务器未返回补全结果'), 3000);
      this._completion = { id, text, resolve, timer };
      this.send(P.playTabComplete, (w) => { w.varint(id); w.str(text); });
    });
  }

  handleCompletion(r) {
    const request = this._completion;
    if (!request) return;
    try {
      const result = decodeFeature('packet_tab_complete', r.raw(r.remaining));
      if (result.transactionId !== request.id) return;
      if (result.start < 0 || result.length < 0 || result.start + result.length > request.text.length
        || result.matches.length > 512) throw new Error('补全范围无效');
      const seen = new Set();
      const matches = result.matches.filter((part) => typeof part.match === 'string' && part.match.length <= 2048
        && !/[\x00-\x1f\x7f]/.test(part.match) && !seen.has(part.match) && seen.add(part.match))
        .map((part) => ({ text: part.match, tooltip: featureText(part.tooltip) }));
      clearTimeout(request.timer); this._completion = null;
      request.resolve({ ok: true, start: result.start, length: result.length, matches });
    } catch (e) { this.cancelCompletion('补全数据无法解析：' + e.message); }
  }

  closeMenu(id) {
    if (this.state !== 'play' || !this.features.menu || this.features.menu.id !== id) return false;
    this.send(P.playCloseWindow, (w) => w.varint(id));
    this.features.dismissMenu();
    return true;
  }

  openServerMenu() {
    return this.menuKeys.open();
  }

  cancelServerMenuOpen() { this.menuKeys.cancel(); }

  clickMenu(request) {
    if (this.state !== 'play' || !this.socket || this.socket.destroyed || this.socket.writable === false) {
      return { ok: false, error: '未连接服务器，菜单点击未发送' };
    }
    const click = this.features.beginClick(request);
    if (!click.ok) return click;
    try {
      // No inventory prediction: let the server send authoritative slot/cursor corrections.
      // 26.2 uses optional HashedStack, not the full ItemStack from older protocols.
      this.send(P.playWindowClick, (w) => {
        w.varint(click.id); w.varint(click.stateId); w.i16(click.slot); w.i8(click.button);
        w.varint(0); w.varint(0); w.bool(false);
      });
      return { ok: true };
    } catch (e) {
      this.features.menuFailure(new Error('点击提交状态不确定，请关闭菜单后重新打开'));
      return { ok: false, error: '菜单点击未确认，不会自动重试' };
    }
  }

  chatFailure(kind, error) {
    this.chatDiagnostics.errors[kind]++;
    this.chatDiagnostics.lastError = kind + ': ' + error.message;
    this.log('[聊天] ' + kind + ' 解析失败: ' + error.message);
  }

  emitChat(kind, text, meta) {
    if (!text) return;
    this.chatDiagnostics.emitted[kind]++;
    this.stats.chats++;
    this.onChat(text, { ...meta, origin: kind });
  }

  /** 只对同一阶段的同一未知包记录一次，避免服务器高频包刷屏。 */
  logUnknownPacket(phase, id, remaining) {
    const key = phase + ':' + id;
    if (this._unknownPackets.has(key)) return;
    this._unknownPackets.add(key);
    this.log(`[${phase}] 未处理服务端包 0x${id.toString(16)}（${remaining} 字节）`);
  }

  enterPlay() {
    if (this.state === 'play') return;
    this.state = 'play';
    if (!this.lastReceivedAt) this.lastReceivedAt = Date.now();
    this.onEvent('join', null);
    this.startKeepAliveLoop();
  }

  /* ---------------- 连接 ---------------- */

  /** 处理 SRV 记录（很多服务器 www 域名指向非默认端口） */
  static resolveSrv(host) {
    return new Promise((resolve) => {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return resolve(null);
      dns.resolveSrv('_minecraft._tcp.' + host, (err, recs) => {
        if (err || !recs || !recs.length) return resolve(null);
        recs.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
        resolve({ host: recs[0].name, port: recs[0].port });
      });
    });
  }

  async connect(timeoutMs = 12000) {
    if (this.state === 'closed') throw new Error('连接已取消');
    let host = this.host, port = this.port;
    if (port === 25565) {
      const srv = await MCClient.resolveSrv(this.host);
      if (srv) { host = srv.host; port = srv.port; this.log(`[SRV] 解析到 ${host}:${port}`); }
    }
    this.connectHost = host;
    this.connectPort = port;
    if (this.state === 'closed') throw new Error('连接已取消');

    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      sock.setNoDelay(true);
      this.socket = sock;

      let settled = false;
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch (e) {}
        reject(new Error('连接超时（' + host + ':' + port + '）'));
      }, timeoutMs);

      sock.on('connect', () => {
        clearTimeout(to);
        if (settled) return;
        settled = true;
        this.log(`[TCP] 已连接 ${host}:${port}`);
        this.lastReceivedAt = Date.now();
        this.sendHandshake();
        this.sendLoginStart();
        resolve();
      });

      sock.on('data', (chunk) => {
        this.lastReceivedAt = Date.now();
        this.stats.received += chunk.length;
        // 加密启用后，先解密再解包
        let plain;
        try {
          plain = this.encrypted ? this._decipher.update(chunk) : chunk;
        } catch (e) {
          this.log('[错误] 解密失败: ' + e.message);
          this.onEvent('error', '解密失败：' + e.message, { retryable: false });
          this.close();
          return;
        }
        if (!plain || !plain.length) return;

        // ❗必须「边解边处理」：Set Compression 包之后紧跟的包是按压缩格式封的，
        //   只有先处理完 Set Compression 并更新 threshold，后面的包才能正确解出。
        //   一次性 drain 再遍历会导致同 chunk 内的加密请求被解成垃圾（正版登录静默失败）。
        try {
          this.decoder.push(plain, (p) => {
            try { this.handlePacket(p); } catch (e) { this.log('[错误] ' + e.message); }
          });
        } catch (e) {
          this.log('[错误] 解包失败: ' + e.message);
          if (e.code === 'BAD_ZLIB') {
            this.onEvent('error', '协议数据损坏：' + e.message, { retryable: false });
            this.close();
          }
          return;
        }
      });

      sock.on('error', (e) => {
        clearTimeout(to);
        this.log('[网络错误] ' + e.message);
        this._networkError = e.message;
        if (!settled) { settled = true; reject(e); }
        else this.onEvent('error', e.message);
      });

      sock.on('close', () => {
        this.cancelCompletion();
        this.features.dismissMenu();
        clearTimeout(to);
        if (!settled) {
          settled = true;
          reject(new Error(this.state === 'closed' ? '连接已取消' : '连接已关闭'));
        }
        this.alive = false;
        if (this.state !== 'closed') {
          this.state = 'closed';
          this.log('[断开] 连接已关闭');
          this.onEvent('close', { reason: this._networkError || '网络连接已关闭', retryable: true });
        }
        this.state = 'closed';
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
      });
    });
  }

  /** 握手：告诉服务器我们是谁、要进哪个阶段 */
  sendHandshake() {
    const w = new ByteWriter();
    w.varint(P.handshake);
    w.varint(PROTOCOL_VERSION);
    w.str(this.host);                    // 服务器地址（用于 BungeeCord 转发）
    w.u16(this.port);
    w.varint(2);                         // 2 = 登录
    this.write(w.build());
    this.state = 'login';
  }

  sendLoginStart() {
    const w = new ByteWriter();
    w.varint(P.loginStart);
    w.str(this.username);
    w.uuid(this.uuid);                   // 26.2 要求带 UUID
    this.write(w.build());
    const mode = this.accessToken ? '正版账号认证' : '离线模式';
    this.log(`[登录] 以 ${this.username} 发起登录（${mode}）`);
  }

  /* ---------------- 正版加密握手 ---------------- */

  /**
   * 处理服务端的 Encryption Request
   * 这是正版验证服才会走到的分支。
   */
  async handleEncryptionRequest(r) {
    if (this.state === 'closed') return;
    try {
      const serverId = r.str();
      const pubKeyLen = r.varint();
      const pubKeyDer = Buffer.from(r.raw(pubKeyLen));
      const tokenLen = r.varint();
      const verifyToken = Buffer.from(r.raw(tokenLen));
      const shouldAuth = r.remaining >= 1 ? r.bool() : true;

      this.log('[验证] 服务端要求加密握手' + (shouldAuth ? '（正版验证）' : '（仅加密）'));

      if (shouldAuth && !this.accessToken) {
        this.log('');
        this.log('============================================');
        this.log(' 这是正版验证服，但你还没有登录微软账号。');
        this.log(' 请先在界面里点「登录微软账号」，再连接。');
        this.log('============================================');
        this.onEvent('need-auth', null);
        this.close();
        return;
      }

      // 1. 解析服务端公钥
      const pubKey = parsePublicKey(pubKeyDer);

      // 2. 生成 16 字节共享密钥
      const secret = generateSharedSecret();
      this.sharedSecret = secret;

      // 3. 用服务端公钥加密共享密钥和验证令牌
      const encSecret = rsaEncrypt(pubKey, secret);
      const encToken = rsaEncrypt(pubKey, verifyToken);

      // 4. 正版验证：先向 Mojang 登记本次连接
      if (shouldAuth) {
        const hash = computeServerHash(serverId, secret, pubKeyDer);
        this.log('[验证] 正在向 Mojang 登记会话...');
        await joinMojangSession(this.accessToken, this.profileId, hash);
        if (this.state === 'closed' || !this.socket || this.socket.destroyed) return;
        this.log('[验证] Mojang 登记成功，等待服务端核验');
      }

      // 5. 建立加解密流（注意：必须在发送 Response 之前就位）
      //    ❗不能用 crypto.createCipheriv('aes-128-cfb8')：打包后的 Electron
      //      用 BoringSSL，没有 cfb8 模式，会抛 "Unknown cipher"。
      //      createCipher/createDecipher 会在原生缺失时回退到手写 CFB8。
      this._cipher = createCipher(secret, secret);
      this._decipher = createDecipher(secret, secret);

      // 6. 发自家的 Encryption Response —— 这条包本身仍是明文
      const w = new ByteWriter();
      w.varint(P.loginEncryptionResponse);
      w.varint(encSecret.length); w.raw(encSecret);
      w.varint(encToken.length); w.raw(encToken);
      this.socket.write(encodePacket(w.build(), this.threshold));

      // 7. 从此之后全走加密
      this.encrypted = true;
      if (shouldAuth) this.isPremium = true;
      this.log('[验证] 加密已启用（AES-128-CFB8' +
        (usingNativeCfb8() ? '，原生实现' : '，兼容实现') + '）');
      this.onEvent('encrypted', { premium: shouldAuth });
    } catch (e) {
      if (this.state === 'closed') return;
      this.log('[验证失败] ' + e.message);
      this.onEvent('error', '正版验证失败：' + e.message, { retryable: !!e.temporary || /fetch failed|timeout|超时|网络/i.test(e.message) });
      this.close();
    }
  }

  /* ---------------- 发包 ---------------- */

  acknowledgeResourcePack(r, packetId) {
    const uuid = r.uuid();
    r.str();                            // url
    r.str();                            // hash
    const forced = r.bool();
    if (r.remaining > 0 && r.bool()) readNbtFrom(r);
    // Headless compatibility, matching Mineflayer: no download or rendering.
    // These are protocol receipts only; no chat message or command is sent.
    for (const status of [3, 0]) {       // accepted, successfully_loaded
      this.send(packetId, (w) => { w.uuid(uuid); w.varint(status); });
    }
    this.log('[资源包] 已应答' + (forced ? '强制' : '可选') + '资源包请求（无界面兼容模式，不下载或渲染）');
  }

  write(payload) {
    if (!this.socket || this.socket.destroyed) return;
    const frame = encodePacket(payload, this.threshold);
    // 启用加密后，所有出站流量都要先走 AES-128-CFB8
    this.socket.write(this.encrypted ? this._cipher.update(frame) : frame);
    this.stats.sent += frame.length;
  }

  send(packetId, build) {
    const w = new ByteWriter();
    w.varint(packetId);
    if (build) build(w);
    this.write(w.build());
  }

  /* ---------------- 收包分发 ---------------- */

  handlePacket(body) {
    const r = new ByteReader(body);
    const id = r.varint();               // 注意：id 会被 varint 解成正数
    switch (this.state) {
      case 'login': return this.onLoginPacket(id, r);
      case 'config': return this.onConfigPacket(id, r);
      case 'play': return this.onPlayPacket(id, r);
      default: return;
    }
  }

  onLoginPacket(id, r) {
    switch (id) {
      case P.loginDisconnect: {
        // ❗login 阶段的 reason 是 **string**（JSON 文本组件），不是 NBT
        let text = '';
        try { text = parseTextComponentString(r.str()); } catch (e) { text = ''; }
        this.log('[被拒绝] ' + (text || '(无法解析原因)'));
        this.onEvent('kick', text);
        this.close();
        return;
      }
      case P.loginEncryption: {
        // 26.2 的 login_encryption = 服务端发来的 Encryption Request
        this.handleEncryptionRequest(r);
        return;
      }
      case P.loginCompress: {
        this.threshold = r.varint();
        this.decoder.threshold = this.threshold;
        this.log(`[压缩] 阈值 = ${this.threshold}`);
        return;
      }
      case P.loginPluginRequest: {
        // 官方客户端也一律回答「不支持」，直接照做
        const msgId = r.varint();
        r.str();                          // channel
        this.send(0x02, (w) => { w.varint(msgId); w.bool(false); });
        return;
      }
      case P.loginCookieRequest: {
        // Cookie 是登录阶段的可选扩展；不保存服务端数据，只回空值表示不支持。
        const key = r.str();
        this.send(P.loginCookieResponse, (w) => {
          w.str(key);
          w.bool(false);
        });
        return;
      }
      case P.loginSuccess: {
        this.uuid = r.uuid();
        const name = r.str();
        this.log(`[登录成功] ${name} (${this.uuid})`);
        this.send(P.loginAcknowledged);
        this.state = 'config';
        this.sendClientSettings();
        this.log('[配置] 登录确认已发送，等待服务器配置阶段');
        this.onEvent('login', { username: name, uuid: this.uuid });
        return;
      }
      default:
        this.logUnknownPacket('登录', id, r.remaining);
        return;
    }
  }

  onConfigPacket(id, r) {
    switch (id) {
      case P.cfgCookieRequest: {
        // Cookie 请求不应阻塞进入游戏；返回「没有值」即可。
        const key = r.str();
        this.send(P.cfgCookieResponse, (w) => {
          w.str(key);
          w.bool(false);
        });
        return;
      }
      case P.cfgCustomPayloadC: {
        // 服务端插件通道是单向通知；不向插件回发任何业务数据。
        this.handleCustomPayload(r);
        return;
      }
      case P.cfgDisconnect: {
        const text = decodeComponent(r.raw(r.remaining));
        this.log('[配置阶段被断开] ' + (text || ''));
        this.onEvent('kick', text);
        this.close();
        return;
      }
      case P.cfgKeepAliveC: {
        const kid = r.i64();
        this.send(P.cfgKeepAlive, (w) => w.i64(kid));
        return;
      }
      case P.cfgPing: {
        const v = r.i32();
        this.send(P.cfgPong, (w) => w.i32(v));
        return;
      }
      case P.cfgResetChat:
        this._signedPending = 0; this._lastSeen = []; this._lastSignature = null; this._signatureCursor = 0;
        return;
      case P.cfgSelectKnownC: {
        // 服务端列出它知道的资源包；我们一个都不认，回空列表
        this.send(P.cfgSelectKnown, (w) => w.varint(0));
        return;
      }
      case P.cfgCodeOfConduct: {
        this.send(P.cfgAcceptConduct);
        return;
      }
      case P.cfgResourcePackC: {
        this.acknowledgeResourcePack(r, P.cfgResourcePack);
        return;
      }
      case P.cfgRemoveResourcePackC:
        if (r.remaining > 0 && r.bool()) r.uuid();
        return;
      case P.cfgStoreCookie:
        r.str();
        const cookieLen = r.varint();
        if (cookieLen < 0 || cookieLen > r.remaining) throw new Error('Cookie 长度非法: ' + cookieLen);
        r.raw(cookieLen);
        return;
      case P.cfgTransfer: {
        const host = r.str();
        const port = r.varint();
        this.log(`[配置] 服务端要求转移到 ${host}:${port}，当前版本不自动转移`);
        return;
      }
      case P.cfgRegistryData:
        return;                           // 世界数据，我们不需要
      case P.cfgFeatureFlags:
        return;
      case P.cfgTags:
      case P.cfgCustomReportDetails:
      case P.cfgServerLinks:
      case P.cfgClearDialog:
      case P.cfgShowDialog:
        return;
      case P.cfgFinishC: {
        this.send(P.cfgFinish);
        this.log('[配置] 完成，进入游戏');
        this.enterPlay();
        return;
      }
      default:
        // 某些代理会在配置阶段插入扩展包。先记录编号，不能让它静默地
        // 看起来像“登录成功但没有聊天”，也不应影响后续标准包。
        this.logUnknownPacket('配置', id, r.remaining);
        // 兼容少数把客户端直接切进 Play 的代理：遇到明确的 Play 包时
        // 立即切换状态并继续按 Play 解码。
        if (id === P.playLogin || id === P.playSystemChat ||
            id === P.playPlayerChat || id === P.playProfilelessChat ||
            id === P.playActionBar || id === P.playKeepAliveC) {
          this.log('[配置] 检测到直接进入 Play，继续接收服务器数据');
          this.enterPlay();
          this.onPlayPacket(id, r);
        }
        return;
    }
  }

  onPlayPacket(id, r) {
    const d = this.chatDiagnostics;
    if (id >= 0 && id <= 512) d.playPackets[id] = (d.playPackets[id] || 0) + 1;
    const kind = id === P.playPlayerChat ? 'player' : id === P.playSystemChat ? 'system'
      : id === P.playProfilelessChat ? 'profileless' : id === P.playActionBar ? 'actionbar' : null;
    if (kind) d.received[kind]++;
    try { return this._onPlayPacket(id, r); }
    catch (e) {
      if (!kind) throw e;
      this.chatFailure(kind, e);
    }
  }

  _onPlayPacket(id, r) {
    switch (id) {
      case P.playPlayerInfoC: return this.featurePacket('玩家列表', 'playerInfo', r);
      case P.playPlayerRemoveC: return this.featurePacket('玩家列表', 'playerRemove', r);
      case P.playOpenWindowC: return this.featurePacket('菜单', 'openMenu', r);
      case P.playWindowItemsC: return this.featurePacket('菜单', 'windowItems', r);
      case P.playSetSlotC: return this.featurePacket('菜单', 'setSlot', r);
      case P.playSetCursorC: return this.featurePacket('菜单', 'setCursor', r);
      case P.playCloseWindowC: return this.featurePacket('菜单', 'closeMenu', r);
      case P.playTabCompleteC: return this.handleCompletion(r);
      case P.playCustomPayloadC: return this.handleCustomPayload(r);
      case P.playRespawnC:
        this._loaded = false;
        this.cancelCompletion();
        this.features.dismissMenu();
        return;
      case P.playResourcePackC:
        this.acknowledgeResourcePack(r, P.playResourcePack);
        return;
      case P.playRemoveResourcePackC:
        if (r.remaining > 0 && r.bool()) r.uuid();
        return;
      case P.playKeepAliveC: {
        const kid = r.i64();
        this.keepAliveId = kid;
        this.lastKeepAliveAt = Date.now();
        this.send(P.playKeepAlive, (w) => w.i64(kid));
        return;
      }
      case P.playPingC: {
        const v = r.i32();
        this.send(P.playPong, (w) => w.i32(v));
        return;
      }
      case P.playKick: {
        const text = decodeComponent(r.raw(r.remaining));
        this.log('[被踢出] ' + (text || ''));
        this.onEvent('kick', text);
        this.close();
        return;
      }
      case P.playLogin: {
        this._loaded = false;
        this.entityId = r.i32();
        this.send(P.playCustomPayload, (w) => { w.str('minecraft:brand'); w.str('mc-noclient'); });
        this.log('[世界] 已进入世界，实体ID = ' + this.entityId);
        return;
      }
      case P.playPositionC: {
        // 同步坐标 —— 必须回执，否则服务器会一直等
        this.chatDiagnostics.teleports++;
        try {
          const teleportId = r.varint();
          const x = r.f64(), y = r.f64(), z = r.f64();
          r.f64(); r.f64(); r.f64();      // delta movement, not coordinates
          const yaw = r.f32(), pitch = r.f32();
          const flags = r.i32();
          const previous = this.playerPos || { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
          const nextPosition = {
            x: x + (flags & 1 ? previous.x : 0),
            y: y + (flags & 2 ? previous.y : 0),
            z: z + (flags & 4 ? previous.z : 0),
            yaw: yaw + (flags & 8 ? previous.yaw : 0),
            pitch: pitch + (flags & 16 ? previous.pitch : 0),
          };
          if (!Object.values(nextPosition).every(Number.isFinite)) throw new Error('坐标含非有限数值');
          this.playerPos = nextPosition;
          this.send(P.playTeleportConfirm, (w) => w.varint(teleportId));
          this.send(P.playPositionLook, (w) => {
            const pos = this.playerPos;
            w.f64(pos.x); w.f64(pos.y); w.f64(pos.z); w.f32(pos.yaw); w.f32(pos.pitch); w.u8(0);
          });
          this.chatDiagnostics.teleportReplies++;
          this.chatDiagnostics.lastTeleportId = teleportId;
          this.sendLoaded();
          this.log(`[坐标] ${this.playerPos.x.toFixed(1)}, ${this.playerPos.y.toFixed(1)}, ${this.playerPos.z.toFixed(1)}`);
        } catch (e) {
          this.chatDiagnostics.positionErrors++;
          this.log('[坐标] 解析跳过: ' + e.message);
        }
        return;
      }
      case P.playSystemChat: {
        /* 官方结构：content(anonymousNbt) + isActionBar(bool)
         * ❗必须先按 NBT 长度推进游标，再读那个 bool ——
         *   旧写法「把剩余字节整包丢给解析器」在加入 isActionBar 后会读错。 */
        const node = readNbtFrom(r);
        const isActionBar = r.remaining > 0 ? r.bool() : false;
        const segments = componentToRuns(node);
        const text = segments.map((part) => part.text).join('');
        if (text) {
          this.emitChat('system', text, { type: isActionBar ? 'actionbar' : 'system', segments });
        }
        return;
      }
      case P.playPlayerChat: {
        /* 官方结构（protocol.json packet_player_chat）：
         *   globalIndex(varint) + senderUuid(UUID) + index(varint)
         *   + signature(option[buffer 256]) + plainMessage(string) + …（一堆签名相关字段）
         * ❗旧的 `r.bool()` 只读了「签名是否存在」，**没有跳过那 256 字节**；
         *   一旦服务端带签名（正版验签环境常见），后面读到的正文就是错位的垃圾。
         */
        try {
          r.varint();                              // globalIndex
          const senderUuid = r.uuid();             // senderUuid
          r.varint();                              // index
          const signature = r.bool() ? r.raw(256) : null;
          if (signature && signature.length !== 256) throw new Error('聊天签名截断');
          const plain = r.str();                   // plainMessage
          if (signature && (!this._lastSignature || !signature.equals(this._lastSignature))) {
            this._lastSignature = Buffer.from(signature);
            this._lastSeen[this._signatureCursor] = Buffer.from(signature);
            this._signatureCursor = (this._signatureCursor + 1) % 20;
            if (++this._signedPending > 64) {
              this.send(P.playChatAck, (w) => w.varint(this._signedPending));
              this._signedPending = 0; this.chatDiagnostics.chatAcks++;
            }
          }
          // 发送者显示名在包尾，字段多、易漂移 → 尽力而为，失败不影响正文
          let sender = null, content = plain;
          try {
            const details = readChatDetails(r);
            sender = details.sender;
            if (details.content !== null) content = details.content;
          } catch (e) { this.chatDiagnostics.detailFallbacks++; }
          const segments = componentToRuns(content);
          const text = segments.map((part) => part.text).join('');
          this.emitChat('player', text, { type: 'player', sender, uuid: senderUuid, segments });
        } catch (e) {
          this.chatFailure('player', e);
        }
        return;
      }
      case P.playProfilelessChat: {
        /* ❗这个包原先完全没处理。它是「没有档案的聊天」：
         *   服务端控制台 /say、NPC 对话、部分插件广播都走这里。
         *   结构：message(anonymousNbt) + type(ChatTypesHolder)
         *         + name(anonymousNbt) + target(option[anonymousNbt])
         *   已用真实抓包验证：`21 08 0012"…" 05 08 0006"Server" 00`
         */
        try {
          const msgNode = readNbtFrom(r);          // message
          skipChatTypeHolder(r);                   // type
          const nameNode = readNbtFrom(r);         // name（发送者显示名）
          if (r.remaining > 0 && r.bool()) readNbtFrom(r);   // target（可选）
          const segments = componentToRuns(msgNode);
          const text = segments.map((part) => part.text).join('');
          const sender = componentToText(nameNode);
          if (text) {
            this.emitChat('profileless', text, { type: 'system', sender: sender || null, segments });
          }
        } catch (e) {
          this.chatFailure('profileless', e);
        }
        return;
      }
      case P.playActionBar: {
        // 快捷栏上方的提示文字。结构简单：text(anonymousNbt)
        try {
          const segments = componentToRuns(readNbtFrom(r));
          const text = segments.map((part) => part.text).join('');
          this.emitChat('actionbar', text, { type: 'actionbar', segments });
        } catch (e) { this.chatFailure('actionbar', e); }
        return;
      }
      case P.playStartConfig: {
        // 服务器要重开配置阶段（换世界/换服），回执一次即可
        this.cancelServerMenuOpen();
        this.send(P.playConfigurationAcknowledged);
        this.cancelCompletion();
        this.features.reset();
        this.state = 'config';
        this.onEvent('reconfig', null);
        return;
      }
      default:
        return;
    }
  }

  /* ---------------- 保活 ---------------- */

  startKeepAliveLoop() {
    // 幂等：重复进入 play 阶段时不能叠加两个定时器
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.alive = true;
    this.stats.uptimeFrom = Date.now();
    let tick = 0;
    this.timer = setInterval(() => {
      if (!this.alive || !this.socket || this.socket.destroyed) {
        // 连接已死 → 自己收摊，不然定时器会一直空转
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        return;
      }
      tick++;
      if (this.lastReceivedAt && Date.now() - this.lastReceivedAt > 90000) {
        this.log('[网络超时] 90 秒未收到服务器数据');
        this.close();
        this.onEvent('close', { reason: '网络接收超时', retryable: true });
        return;
      }
      // 3 秒没收到服务端保活 → 发 flying 心跳维持连接。
      // 注意：只在真的"静默"时才发，避免把带宽浪费在无意义的包上。
      if (this.lastKeepAliveAt && Date.now() - this.lastKeepAliveAt > 3000) {
        this.send(P.playFlying, (w) => w.u8(0));
      }
      // 每 15 秒回一次 client_command(request_stats)
      if (tick % 15 === 0) {
        this.send(P.playClientCommand, (w) => w.varint(1));
      }
    }, 1000);
  }

  /* ---------------- 对外动作 ---------------- */

  /** 发一条聊天消息 */
  say(text) {
    if (this.state !== 'play') return false;
    this.send(P.playChatMessage, (w) => {
      w.str(text);
      w.i64(Date.now());
      w.i64(0n);                          // salt
      w.bool(false);                      // 无签名（离线服不需要签名）
      w.varint(this._signedPending);
      const acknowledged = Buffer.alloc(3);
      for (let i = 0; i < 20; i++) {
        if (this._lastSeen[(this._signatureCursor + i) % 20]) acknowledged[i >> 3] |= 1 << (i & 7);
      }
      w.raw(acknowledged);
      w.u8(0);                            // checksum
    });
    this._signedPending = 0;
    return true;
  }

  /** 以玩家身份执行一条命令（命令前不加 /） */
  command(cmd) {
    if (this.state !== 'play') return false;
    this.send(P.playChatCommand, (w) => w.str(cmd));
    return true;
  }

  /** 上报客户端设置，让服务器知道我们存在 */
  sendClientSettings() {
    if (this.state !== 'config' && this.state !== 'play') return;
    this.send(this.state === 'config' ? P.cfgSettings : P.playSettings, (w) => {
      w.str('zh_cn');
      w.i8(8);                            // 视距
      w.varint(0);                        // 聊天模式
      w.bool(true);                       // 聊天颜色
      w.u8(0x7f);                         // 皮肤部件
      w.varint(1);                        // 主手：右手
      w.bool(false);                      // 文本过滤
      w.bool(true);                       // 允许出现在玩家列表
      w.varint(0);                        // 粒子效果：全部
    });
  }

  close() {
    this.cancelServerMenuOpen();
    this.alive = false;
    this.state = 'closed';
    this.cancelCompletion();
    this.features.dismissMenu();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.socket) { try { this.socket.destroy(); } catch (e) {} }
  }

  uptimeText() {
    if (!this.stats.uptimeFrom) return '0秒';
    const s = Math.floor((Date.now() - this.stats.uptimeFrom) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}时${m}分` : (m > 0 ? `${m}分${s % 60}秒` : `${s}秒`);
  }
}

/* ============================================================
 * 服务器状态查询（Server List Ping）—— 不需要登录，只读信息
 * ============================================================ */
async function pingServer(host, port = 25565, timeoutMs = 8000) {
  let h = host, p = port;
  const srv = await MCClient.resolveSrv(host);
  if (srv && port === 25565) { h = srv.host; p = srv.port; }

  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: h, port: p });
    sock.setNoDelay(true);
    const t0 = Date.now();
    let buf = Buffer.alloc(0);
    let stage = 0;                       // 0=等状态响应 1=等pong

    const to = setTimeout(() => { try { sock.destroy(); } catch (e) {} reject(new Error('查询超时')); }, timeoutMs);

    sock.on('connect', () => {
      // Handshake(nextState=1) + Status Request
      const w = new ByteWriter();
      w.varint(0x00); w.varint(PROTOCOL_VERSION); w.str(host); w.u16(p); w.varint(1);
      const hs = w.build();
      const pkt = new ByteWriter(); pkt.varint(hs.length); pkt.raw(hs);
      sock.write(pkt.build());
      sock.write(Buffer.from([0x01, 0x00]));   // Status Request
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const len = tryReadVarIntLocal(buf);
        if (!len) break;
        if (buf.length < len.size + len.value) break;
        const body = buf.subarray(len.size, len.size + len.value);
        buf = buf.subarray(len.size + len.value);
        const r = new ByteReader(body);
        const id = r.varint();
        if (id === 0x00 && stage === 0) {
          stage = 1;
          const json = JSON.parse(r.str());
          const latency = Date.now() - t0;
          // 接着发 Ping，测真实延迟
          const pw = new ByteWriter();
          pw.varint(0x01); pw.i64(BigInt(Date.now()));
          const pb = pw.build();
          const pf = new ByteWriter(); pf.varint(pb.length); pf.raw(pb);
          sock.write(pf.build());
          json.__latency = latency;
          json.__host = `${h}:${p}`;
          // 不返回，等 pong
          setTimeout(() => { clearTimeout(to); try { sock.destroy(); } catch (e) {} resolve(json); }, 120);
        }
      }
    });

    sock.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

function tryReadVarIntLocal(buf) {
  let result = 0, shift = 0, i = 0;
  for (;;) {
    if (i >= buf.length) return null;
    const b = buf[i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) return null;
  }
  return { value: result, size: i };
}

module.exports = { MCClient, pingServer, offlineUUID, MC_VERSION, PROTOCOL_VERSION };
