'use strict';
/*
 * crypt.js —— Minecraft 正版验证加密握手
 *
 * 正版服（online-mode=true）的验证原理：
 *
 *   1. 客户端发 Login Start（带用户名 + UUID）
 *   2. 服务端回 Encryption Request：
 *        - Server ID（字符串，现代服务端通常为空串）
 *        - Public Key（DER 格式的 X.509 RSA 公钥，一般 1024 位）
 *        - Verify Token（随机字节，用来证明我们真的持有共享密钥）
 *        - Should Authenticate（是否要去 Mojang 验证）
 *   3. 客户端：
 *        a. 随机生成 16 字节共享密钥（AES-128）
 *        b. 用服务端公钥 RSA/PKCS1 加密它 → Shared Secret
 *        c. 用同一个公钥加密 Verify Token → Verify Token(密文)
 *        d. 如果 Should Authenticate：
 *             serverId = SHA1(serverId + 共享密钥 + 服务端公钥DER)  ← 特殊拼接格式
 *             把 serverId 发到 Mojang 会话服务器：join 请求，附带 accessToken
 *             服务端稍后调 hasJoined 反查，比对通过才放行
 *        e. 回 Encryption Response
 *        f. 之后所有流量用 AES-128-CFB8 + 共享密钥加解密
 */

const crypto = require('crypto');

/**
 * 计算 Mojang 要求的 serverId 哈希
 *
 * 这里的拼接方式很古怪，但必须严格照做：
 *   1. serverId 以 ASCII 写入（注意：是字节写入，Java 的 getBytes("ISO_8859_1")）
 *   2. 共享密钥直接追加
 *   3. 公钥直接追加
 *   4. 取 SHA-1
 *   5. 转成十六进制字符串
 *   6. 按 160 位二进制补码解释为有符号整数，再转十六进制（不补前导零）
 *      —— 对应 Java new BigInteger(digest).toString(16)，不能只加负号
 */

/* ==========================================================================
 * AES-128-CFB8：跨运行时兼容实现（**关键坑，必读**）
 * ==========================================================================
 *
 * Minecraft 的加密握手固定用 **AES-128-CFB8**（段长 1 字节的 CFB）。
 *
 * 问题是：`crypto.createCipheriv('aes-128-cfb8', ...)` 在**不同运行时不一定可用**：
 *
 *   | 运行时                    | 底层加密库   | 有没有 cfb8 |
 *   |---------------------------|-------------|------------|
 *   | 系统 Node 22（开发/自检）  | OpenSSL 3.5 | ✅ 有       |
 *   | **打包后的 Electron 33**   | **BoringSSL** | ❌ **没有** |
 *
 * Electron 为减小体积用了 BoringSSL，并且**裁掉了 CFB8**（实测只剩 28 个 cipher）。
 * 后果极其阴险：命令行 `node src/selftest.js` 一路全绿，一打包成 exe 就报
 *
 *     Unknown cipher
 *
 * 而且报错点在 `createCipheriv`，跟"加密握手逻辑"看起来毫无关系，极易查错方向。
 * （真实事故：正版登录时 Mojang 登记都成功了，最后卡在这一句。）
 *
 * 解法（与 PrismarineJS/node-minecraft-protocol 的官方做法一致）：
 *   能用原生 cfb8 就用；不能用就拿 **ECB 块加密**手写 CFB8。
 *   CFB8 的定义本身就只依赖"用密钥加密一个 16 字节块"这个操作：
 *
 *       CFB8 加密一个字节 P：
 *         a. 对当前 16 字节移位寄存器做 AES-ECB 加密 → 取首字节 K
 *         b. 密文 C = P XOR K，每个字节都做一次（段长 1）
 *         c. 移位寄存器左移 1 字节，把 C 补到尾部
 *
 *   解密对称：寄存器里的输入是**密文**，输出明文 = C XOR K。
 */

/** 该运行时的 crypto 是否原生支持 aes-128-cfb8（结果缓存，避免反复探测） */
let _nativeCfb8Supported = null;
function nativeCfb8Supported() {
  if (_nativeCfb8Supported !== null) return _nativeCfb8Supported;
  try {
    _nativeCfb8Supported = crypto.getCiphers().includes('aes-128-cfb8');
  } catch (e) {
    _nativeCfb8Supported = false;
  }
  return _nativeCfb8Supported;
}

/**
 * 基于 AES-ECB 手写的 CFB8 流。
 * 只依赖 `aes-128-ecb`（BoringSSL 保留了这个），因此任何运行时都能用。
 *
 * 状态机与 Node 的 Cipheriv 保持同构：`update(buf) -> buf`，可任意多次调用，
 * 内部维护移位寄存器，保证流式连续性（丢一次就会全程错位）。
 */
class Cfb8 {
  /**
   * @param {Buffer} key 16 字节密钥（Minecraft 里 key == iv == sharedSecret）
   * @param {Buffer} iv  16 字节初始向量
   * @param {boolean} decrypt true=解密流，false=加密流
   */
  constructor(key, iv, decrypt) {
    if (!Buffer.isBuffer(key) || key.length !== 16) {
      throw new Error('CFB8 需要 16 字节密钥');
    }
    if (!Buffer.isBuffer(iv) || iv.length !== 16) {
      throw new Error('CFB8 需要 16 字节初始向量');
    }
    this.decryptMode = !!decrypt;
    // 移位寄存器：初始为 IV，之后每处理 1 字节就左移并追加一个密文字节
    this.shift = Buffer.from(iv);
    // 当前寄存器对应的 ECB 输出块（CFB8 每个字节都会重算，这里只存最近一次结果）
    this._keystreamBlock = null;

    // ⚠️ ECB 不要 IV，且必须关掉自动填充，否则每块都会被补到 32 字节
    this.ecb = crypto.createCipheriv('aes-128-ecb', key, null);
    this.ecb.setAutoPadding(false);
  }

  /** 重算当前移位寄存器对应的 ECB 输出块（CFB8 每字节调用一次） */
  _refill() {
    this._keystreamBlock = this.ecb.update(this.shift);
    // 防御：ECB 一次 update 应该正好吐 16 字节
    if (!this._keystreamBlock || this._keystreamBlock.length < 16) {
      throw new Error('AES-ECB 输出异常，无法建立 CFB8 密钥流');
    }
  }

  /**
   * 处理一段数据（加密或解密，取决于构造时的 decrypt 标志）
   * @param {Buffer} buf
   * @returns {Buffer}
   */
  update(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(buf.length);

    for (let i = 0; i < buf.length; i++) {
      // ❗CFB8 的密钥流**每个字节都要重算**：因为移位寄存器每处理一个字节就变了，
      //   而 CFB8 的密钥流是「对当前寄存器做一次 AES-ECB 加密，取首字节」。
      //   （CFB128 才是每 16 字节重算一次 —— 千万别按 CFB128 的节奏来。）
      this._refill();
      const k = this._keystreamBlock[0];
      const inByte = buf[i];
      const outByte = inByte ^ k;
      out[i] = outByte;

      // 寄存器左移 1 字节，尾部补入的永远是**密文**字节 ——
      // 加密时密文就是 outByte；解密时密文是输入的 inByte。
      const feedback = this.decryptMode ? inByte : outByte;
      // 用 copyWithin 原地左移，避免每个字节都分配新 Buffer
      this.shift.copyWithin(0, 1, 16);
      this.shift[15] = feedback;
    }
    return out;
  }
}

/**
 * 创建加密流：优先原生 cfb8，不可用则回退到手写实现
 * @param {Buffer} key 16 字节
 * @param {Buffer} iv  16 字节
 */
function createCipher(key, iv) {
  if (nativeCfb8Supported()) {
    return crypto.createCipheriv('aes-128-cfb8', key, iv);
  }
  return new Cfb8(key, iv, false);
}

/** 创建解密流：同 createCipher，优先原生 */
function createDecipher(key, iv) {
  if (nativeCfb8Supported()) {
    return crypto.createDecipheriv('aes-128-cfb8', key, iv);
  }
  return new Cfb8(key, iv, true);
}

/** 供测试与诊断：当前运行时是否原生支持 cfb8 */
function usingNativeCfb8() {
  return nativeCfb8Supported();
}

function computeServerHash(serverId, sharedSecret, publicKeyDer) {
  // Guava 的 Hashing.sha1().putString(serverId, ISO_8859_1) 对 >0xFF 的码点会直接抛错。
  // Node 的 latin1 则会静默截断（& 0xFF），导致算出的 hash 和服务端不一致却毫无提示。
  // 现代服务端 serverId 恒为空串，但一旦有人乱填就可能静默失败 → 这里显式拦截。
  if (typeof serverId !== 'string') {
    throw new Error('serverId 必须是字符串，实际为 ' + typeof serverId);
  }
  for (let i = 0; i < serverId.length; i++) {
    if (serverId.charCodeAt(i) > 0xff) {
      throw new Error(`serverId 含非 ISO-8859-1 字符（位置 ${i}），无法与服务端算出一致哈希`);
    }
  }
  if (!Buffer.isBuffer(sharedSecret) || sharedSecret.length !== 16) {
    throw new Error('共享密钥必须是 16 字节 Buffer');
  }
  const h = crypto.createHash('sha1');
  h.update(Buffer.from(serverId, 'latin1'));   // ISO-8859-1 / ASCII
  h.update(sharedSecret);
  h.update(publicKeyDer);
  const digest = h.digest('hex');
  return BigInt.asIntN(160, BigInt('0x' + digest)).toString(16);
}

/** 生成 16 字节 AES-128 共享密钥 */
function generateSharedSecret() {
  return crypto.randomBytes(16);
}

/**
 * 用服务端公钥做 RSA/PKCS1 加密
 *
 * RSA PKCS#1 v1.5 的最大明文长度 = 模长字节数 - 11。
 * 若服务端给了 512 位（64 字节）密钥，16 字节共享密钥能过、但某些令牌会超；
 * 更常见的是密钥本身被解析错。这里提前给出可读报错，而不是让 Node 抛
 * "data too large for key size" 这种看不懂的信息。
 */
function rsaEncrypt(publicKey, data) {
  let maxLen = Infinity;
  try {
    if (publicKey && publicKey.asymmetricKeyDetails) {
      const bits = publicKey.asymmetricKeyDetails.modulusLength;
      if (bits) maxLen = Math.floor(bits / 8) - 11;
    }
  } catch (e) { /* 拿不到就跳过检查 */ }
  if (data.length > maxLen) {
    throw new Error(
      `要加密的数据 ${data.length} 字节，超过该 RSA 公钥上限 ${maxLen} 字节（PKCS#1 v1.5）`
    );
  }
  return crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    data
  );
}

/**
 * 解析服务端送来的公钥（DER 格式的 X.509 SubjectPublicKeyInfo）
 * 如果解析失败，尝试当作 PKCS#1 再试一次
 */
function parsePublicKey(derBuffer) {
  try {
    return crypto.createPublicKey({ key: derBuffer, format: 'der', type: 'spki' });
  } catch (e) {
    // 少数服务端送的是裸 PKCS#1；手工包一层 SPKI 头
    try {
      const SPKI_PREFIX = Buffer.from('30819f300d06092a864886f70d010101050003818d00', 'hex');
      return crypto.createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, derBuffer]),
        format: 'der',
        type: 'spki',
      });
    } catch (e2) {
      throw new Error('无法解析服务端公钥：' + e.message);
    }
  }
}

/**
 * 加密流包装器：把明文的 socket 读写变成 AES-128-CFB8 加解密流
 *
 * 注意：CFB8 是流式加密，加解密各自维护独立的偏移状态。
 * 这里用 Node 的 Cipheriv/Decipheriv，因为 CFB8 在 Node 里被当作流密码处理，
 * update() 可以逐块调用，不需要固定块大小。
 */
class EncryptedSocket {
  constructor(socket, sharedSecret) {
    if (!Buffer.isBuffer(sharedSecret) || sharedSecret.length !== 16) {
      throw new Error('共享密钥必须是 16 字节 Buffer（AES-128）');
    }
    this.socket = socket;
    // ❗用 createCipher/createDecipher 而不是直接 createCipheriv('aes-128-cfb8')：
    //   打包后的 Electron 用 BoringSSL，没有 cfb8，直接调会抛 "Unknown cipher"。
    //   工厂内部会在原生缺失时回退到手写 CFB8。
    this.cipher = createCipher(sharedSecret, sharedSecret);
    this.decipher = createDecipher(sharedSecret, sharedSecret);
    this.enabled = true;
  }

  /**
   * 发送前加密
   * 注意：用 `!== false` 判断而不是 `!this.enabled`。
   * CFB8 是流密码，cipher 状态必须严格连续 —— 一旦中途「跳过」一次加密，
   * 后面的所有字节都会错位。所以只有显式置为 false 才旁路。
   */
  encrypt(buf) {
    if (this.enabled === false) return buf;
    return this.cipher.update(buf);
  }

  /** 收到后解密（同上，只认显式 false） */
  decrypt(buf) {
    if (this.enabled === false) return buf;
    return this.decipher.update(buf);
  }
}

/**
 * 向 Mojang 会话服务器登记本次连接（正版验证的核心一步）
 *
 * 服务端稍后会带着同样的参数去调 hasJoined，
 * 只有这里登记成功、且 accessToken 有效，服务端才会放行。
 *
 * @param {string} accessToken  Minecraft 的 access_token
 * @param {string} profileId    玩家 UUID（带横线）
 * @param {string} serverHash   computeServerHash() 的结果
 */
async function joinMojangSession(accessToken, profileId, serverHash, timeoutMs = 15000) {
  if (!accessToken) throw new Error('缺少 accessToken，无法向 Mojang 登记');
  if (!profileId) throw new Error('缺少 profileId（正版 UUID），无法向 Mojang 登记');

  // ❗必须带超时：这一步卡住会让整个连接流程永久挂起（界面一直显示"连接中"）
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('https://sessionserver.mojang.com/session/minecraft/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        accessToken,
        selectedProfile: profileId,
        serverId: serverHash,
      }),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`Mojang 会话登记超时（${Math.round(timeoutMs / 1000)} 秒无响应），请检查网络后重试`);
    }
    throw new Error('Mojang 会话登记请求失败：' + (e && e.message));
  } finally {
    clearTimeout(to);
  }

  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (res.status === 401) hint = '（accessToken 无效）';
    else if (res.status === 403) hint = '（令牌无效、已过期，或账号没有该游戏所有权）';
    else if (res.status === 400) hint = '（请求参数有误）';
    else if (res.status === 429) hint = '（请求过于频繁，稍后再试）';
    throw new Error(`Mojang 会话登记失败 HTTP ${res.status} ${hint} ${text.slice(0, 200)}`);
  }
  return true;
}

module.exports = {
  computeServerHash,
  generateSharedSecret,
  rsaEncrypt,
  parsePublicKey,
  EncryptedSocket,
  joinMojangSession,
  // CFB8 跨运行时兼容层（Electron/BoringSSL 缺 cfb8 时的手写回退）
  createCipher,
  createDecipher,
  Cfb8,
  usingNativeCfb8,
};
