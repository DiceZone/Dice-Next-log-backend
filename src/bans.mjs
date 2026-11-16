// IP 封锁：后台手动添加的，以及短时间内可疑请求过多时自动加上的。
// 被封锁的 IP 访问任何地址都回 403。内网与本机地址永不封锁——反向代理没把访客 IP 传过来时，
// 所有请求看上去都来自代理本身，不能因此把全站封掉。
import { db, nowIso, getSetting } from './db.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS ip_bans (
  id         INTEGER PRIMARY KEY,
  target     TEXT NOT NULL UNIQUE,
  reason     TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT ''
);
`);

// ─── 地址的整理与比较 ───────────────────────────────────────

function ipv4ToInt(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// 连接地址可能是 ::ffff:1.2.3.4 这种写法，统一成 1.2.3.4。
export function normalizeIp(ip) {
  const text = String(ip || '').trim().toLowerCase();
  return text.startsWith('::ffff:') && ipv4ToInt(text.slice(7)) !== null ? text.slice(7) : text;
}

// 把后台填的封锁目标整理成标准写法：单个 IPv4、IPv4 网段（/8 到 /32）或单个 IPv6。不合法返回 null。
export function normalizeTarget(input) {
  const text = normalizeIp(input);
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(text);
  if (cidr) {
    const base = ipv4ToInt(cidr[1]);
    const bits = Number(cidr[2]);
    if (base === null || bits < 8 || bits > 32) return null;
    if (bits === 32) return cidr[1];
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    const network = (base & mask) >>> 0;
    return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join('.')}/${bits}`;
  }
  if (ipv4ToInt(text) !== null) return text;
  if (/^[0-9a-f:]{3,39}$/.test(text) && text.includes(':')) return text;
  return null;
}

function inCidr(ip, target) {
  const [base, bits] = target.split('/');
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((value & mask) >>> 0) === ipv4ToInt(base);
}

function targetMatches(target, ip) {
  return target.includes('/') ? inCidr(ip, target) : target === ip;
}

// 内网、本机与保留地址。
export function isPrivateIp(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) {
    return ip === '' || ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
  }
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// ─── 封锁名单 ───────────────────────────────────────────────

// 名单读进内存；本进程改动后立刻重读，另外每分钟重读一次（指令行解除封锁时靠它生效）。
let cache = null;
let loadedAt = 0;

function load() {
  if (cache && Date.now() - loadedAt < 60000) return cache;
  const now = nowIso();
  db.prepare("DELETE FROM ip_bans WHERE expires_at <> '' AND expires_at < ?").run(now);
  const rows = db.prepare('SELECT * FROM ip_bans').all();
  cache = {
    exact: new Map(rows.filter((row) => !row.target.includes('/')).map((row) => [row.target, row])),
    ranges: rows.filter((row) => row.target.includes('/')),
  };
  loadedAt = Date.now();
  return cache;
}

function changed() {
  cache = null;
}

function active(row) {
  return row && (!row.expires_at || row.expires_at > nowIso()) ? row : null;
}

export function findBan(rawIp) {
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return null;
  const list = load();
  return active(list.exact.get(ip)) || active(list.ranges.find((row) => inCidr(ip, row.target))) || null;
}

export function listBans() {
  changed();
  load();
  return db.prepare('SELECT * FROM ip_bans ORDER BY id DESC').all();
}

// hours 为 0 表示永久。同一目标已在名单里时更新理由与期限。
export function addBan({ target, reason, source, hours }) {
  const now = nowIso();
  const expires = hours > 0 ? new Date(Date.now() + hours * 3600000).toISOString() : '';
  db.prepare(`
    INSERT INTO ip_bans(target, reason, source, created_at, expires_at) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(target) DO UPDATE SET reason = excluded.reason, source = excluded.source,
      created_at = excluded.created_at, expires_at = excluded.expires_at`)
    .run(target, String(reason || '').slice(0, 200), source, now, expires);
  changed();
  return db.prepare('SELECT * FROM ip_bans WHERE target = ?').get(target);
}

export function removeBan(id) {
  const done = db.prepare('DELETE FROM ip_bans WHERE id = ?').run(id).changes > 0;
  changed();
  return done;
}

// 指令行用：解除与这个 IP 相符的全部封锁（含网段）；传 all 则清空名单。
export function unban(text) {
  let removed = 0;
  if (text === 'all') {
    removed = db.prepare('DELETE FROM ip_bans').run().changes;
  } else {
    const ip = normalizeIp(text);
    for (const row of db.prepare('SELECT * FROM ip_bans').all()) {
      if (row.target === normalizeTarget(text) || targetMatches(row.target, ip)) {
        removed += db.prepare('DELETE FROM ip_bans WHERE id = ?').run(row.id).changes;
      }
    }
  }
  changed();
  return removed;
}

export function matchesTarget(target, rawIp) {
  return targetMatches(target, normalizeIp(rawIp));
}

// ─── 自动封锁 ───────────────────────────────────────────────

// 可疑请求：被拒绝的（401 / 403）、不存在的地址或日志（404）、触发限频的（429）。
// 扫描路径、猜日志密码、猜后台密码、猜骰娘密钥都会留下这些。
const SUSPICIOUS = new Set([401, 403, 404, 429]);
const strikes = new Map();

export function recordResponse(rawIp, status) {
  if (!SUSPICIOUS.has(status) || getSetting('autoban_enabled') !== 1) return;
  const ip = normalizeIp(rawIp);
  if (isPrivateIp(ip)) return;
  const windowMinutes = getSetting('autoban_window_minutes');
  const cutoff = Date.now() - windowMinutes * 60000;
  const recent = (strikes.get(ip) || []).filter((time) => time > cutoff);
  recent.push(Date.now());
  const threshold = getSetting('autoban_threshold');
  if (recent.length < threshold) {
    strikes.set(ip, recent);
    return;
  }
  strikes.delete(ip);
  addBan({
    target: ip,
    reason: `自动封锁：${windowMinutes} 分钟内出现 ${recent.length} 次可疑请求`,
    source: 'auto',
    hours: getSetting('autoban_hours'),
  });
  console.warn(`[封锁] ${ip} 在 ${windowMinutes} 分钟内出现 ${recent.length} 次可疑请求，已自动封锁`);
}

setInterval(() => {
  const cutoff = Date.now() - 24 * 3600000;
  for (const [ip, times] of strikes) {
    if (!times.some((time) => time > cutoff)) strikes.delete(ip);
  }
}, 10 * 60000).unref();
