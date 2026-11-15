// 骰娘金钥校验。
// 接了 BDC：向账号站询问，只发送金钥的 SHA-256，明文不出本机。
//   POST <校验地址>   头 X-Log-Service-Token: <凭据>
//   请求 {"key_sha256": "<hex>"}
//   回应 {"valid": true, "platform": "onebot_v11", "bot_id": "123456", "bot_name": "…"} 或 {"valid": false}
// 没接 BDC：比对 .env 的 LIVE_STATIC_KEYS 里列出的金钥（只知道金钥有效，不知道是哪个骰娘）。
import { config } from './config.mjs';
import { site } from './site.mjs';
import { HttpError } from './http.mjs';
import { sha256 } from './store.mjs';

const VALID_TTL = 10 * 60 * 1000;
const INVALID_TTL = 60 * 1000;
const cache = new Map();
const staticHashes = new Set(config.liveStaticKeys.map(sha256));

// 校验地址或凭据在后台改过之后，旧的校验结果不再可信。
let cachedFor = '';
function freshCache() {
  const current = `${site.bdcVerifyUrl}\n${site.bdcVerifyToken}`;
  if (current !== cachedFor) {
    cache.clear();
    cachedFor = current;
  }
  return cache;
}

export function liveAuthConfigured() {
  return Boolean(site.bdcVerifyUrl && site.bdcVerifyToken) || staticHashes.size > 0;
}

async function ask(keyHash) {
  const response = await fetch(site.bdcVerifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Log-Service-Token': site.bdcVerifyToken },
    body: JSON.stringify({ key_sha256: keyHash }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reply = await response.json();
  return {
    valid: reply.valid === true,
    botId: String(reply.bot_id ?? '').slice(0, 64),
    platform: String(reply.platform ?? '').slice(0, 32),
  };
}

// 返回 { hash, botId, platform }：hash 是金钥的哈希，作为日志的归属标记。金钥无效时抛 403。
export async function verifyKey(key) {
  if (!key) throw new HttpError(401, { success: false, message: 'Missing key' });
  const hash = sha256(key);
  if (staticHashes.has(hash)) return { hash, botId: '', platform: '' };
  if (!site.bdcVerifyUrl || !site.bdcVerifyToken) {
    throw new HttpError(403, { success: false, message: 'Invalid key' });
  }

  let entry = freshCache().get(hash);
  const age = entry ? Date.now() - entry.checked : Infinity;
  if (!entry || age >= (entry.valid ? VALID_TTL : INVALID_TTL)) {
    try {
      entry = { ...(await ask(hash)), checked: Date.now() };
      cache.set(hash, entry);
    } catch (err) {
      // 账号站暂时问不到：之前验过有效的沿用旧结果，没验过的请对方稍后重试。
      if (!entry || !entry.valid) {
        throw new HttpError(503, { success: false, message: 'Key verification is temporarily unavailable' });
      }
      console.warn(`[bdc] 账号站暂时无法访问（${err.message}），沿用 ${hash.slice(0, 8)} 之前的有效结果`);
    }
  }
  if (!entry.valid) throw new HttpError(403, { success: false, message: 'Invalid key' });
  return { hash, botId: entry.botId, platform: entry.platform };
}

setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [hash, entry] of cache) if (entry.checked < cutoff) cache.delete(hash);
}, 3600 * 1000).unref();
