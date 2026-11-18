// QQ 图片 rkey：新版 QQ 图床（multimedia.nt.qq.com.cn）的图片链接要带它，约一小时过期。
//
// 从 BDC 公寓站取（凭据与骰娘密钥校验共用「骰娘密钥校验凭据」），取到后缓存 30 分钟，
// 到点再取，循环往复。染色器经本站的公开接口拿（routes/rkey.mjs）；公寓那边的接口不对外。
// 取不到时继续用手上那份，直到它过期；没有可用的就让染色器照原样显示链接。
import { site } from './site.mjs';

const REFRESH = 30 * 60 * 1000;
const RETRY = 2 * 60 * 1000;
const TIMEOUT = 10 * 1000;
// 剩不到这么久就不再给出去：染色器拿到后还要用一阵
const MIN_REMAINING = 60 * 1000;
const PREFIX = '&rkey=';
const RKEY = /^[A-Za-z0-9_\-*.]{8,200}$/;

let cached = null;
let lastError = '';
let lastAttemptAt = null;
let timer = null;

function clean(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim().startsWith(PREFIX) ? value.trim().slice(PREFIX.length) : value.trim();
  return RKEY.test(text) ? text : '';
}

function usable(entry, now = Date.now()) {
  return Boolean(entry) && entry.expired_time * 1000 - now >= MIN_REMAINING;
}

// 向公寓取一次。成功返回 true；失败时手上那份照用。
export async function refreshRkey() {
  lastAttemptAt = new Date().toISOString();
  if (!site.bdcRkeyUrl || !site.bdcVerifyToken) {
    lastError = 'not configured';
    return false;
  }
  try {
    const response = await fetch(site.bdcRkeyUrl, {
      headers: { 'X-Log-Service-Token': site.bdcVerifyToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) {
      lastError = `HTTP ${response.status}`;
      return false;
    }
    const data = await response.json();
    const entry = {
      private_rkey: clean(data.private_rkey),
      group_rkey: clean(data.group_rkey),
      expired_time: Number(data.expired_time) || 0,
      fetched_at: new Date().toISOString(),
    };
    if ((!entry.private_rkey && !entry.group_rkey) || !usable(entry)) {
      lastError = 'no usable rkey in response';
      return false;
    }
    cached = entry;
    lastError = '';
    return true;
  } catch (err) {
    lastError = String(err?.message || err).slice(0, 200);
    return false;
  }
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(loop, ms);
  timer.unref?.();
}

async function loop() {
  const ok = await refreshRkey();
  schedule(ok ? REFRESH : RETRY);
}

// 服务启动时调用一次，之后自己循环。
export function startRkeyRefresher() {
  loop();
}

// 后台改了地址或凭据：立刻重取，并从这一刻重新计时。
export function restartRkeyRefresher() {
  clearTimeout(timer);
  loop();
}

// 给染色器的：没有可用的返回 null。
export function currentRkey() {
  if (!usable(cached)) return null;
  return { private_rkey: cached.private_rkey, group_rkey: cached.group_rkey, expired_time: cached.expired_time };
}

// 给后台看的：配好没有、手上那份何时取得何时到期、最近一次失败的原因。rkey 本身不回传。
export function rkeyStatus() {
  return {
    configured: Boolean(site.bdcRkeyUrl && site.bdcVerifyToken),
    fetched_at: cached?.fetched_at || null,
    expires_at: cached ? new Date(cached.expired_time * 1000).toISOString() : null,
    usable: usable(cached),
    last_attempt_at: lastAttemptAt,
    last_error: lastError || null,
  };
}
