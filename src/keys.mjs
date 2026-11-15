// 本站签发的骰娘密钥：不接 BDC 的自建站用它开放实时串流与骰娘查询。
// 库里只存密钥的 SHA-256 与开头几位（供辨认），明文只在签发时返回一次。
import { randomBytes, createHash } from 'node:crypto';
import { db, nowIso, transaction } from './db.mjs';

db.exec(`
CREATE TABLE IF NOT EXISTS bot_keys (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  bot_id       TEXT NOT NULL DEFAULT '',
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT ''
);
`);

export const KEY_PREFIX = 'dnlog_';
const MAX_KEYS = 5000;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function view(row) {
  return {
    id: row.id,
    name: row.name,
    bot_id: row.bot_id,
    key_prefix: row.key_prefix,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

export function listKeys() {
  return db.prepare('SELECT * FROM bot_keys ORDER BY id DESC').all().map(view);
}

export function enabledKeyCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM bot_keys WHERE enabled = 1').get().n;
}

// 一次签发 count 把，返回带明文的列表。多把时备注后面加上序号。
export function issueKeys({ name, botId, count }) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM bot_keys').get().n;
  if (total + count > MAX_KEYS) return null;
  const insert = db.prepare(
    'INSERT INTO bot_keys(name, bot_id, key_hash, key_prefix, created_at) VALUES(?, ?, ?, ?, ?)',
  );
  const issued = [];
  transaction(() => {
    for (let i = 0; i < count; i++) {
      const key = KEY_PREFIX + randomBytes(32).toString('base64url');
      const label = count > 1 && name ? `${name} #${i + 1}` : name;
      const result = insert.run(label, botId, sha256(key), key.slice(0, KEY_PREFIX.length + 6), nowIso());
      issued.push({ id: Number(result.lastInsertRowid), name: label, bot_id: botId, key });
    }
  });
  return issued;
}

export function updateKey(id, patch) {
  const sets = [];
  const args = [];
  for (const [column, value] of Object.entries(patch)) {
    sets.push(`${column} = ?`);
    args.push(value);
  }
  if (sets.length) db.prepare(`UPDATE bot_keys SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  const row = db.prepare('SELECT * FROM bot_keys WHERE id = ?').get(id);
  return row ? view(row) : null;
}

export function deleteKey(id) {
  return db.prepare('DELETE FROM bot_keys WHERE id = ?').run(id).changes > 0;
}

// 校验用：返回 null（不是本站签发的）、{ enabled: false }（已停用）或 { enabled: true, botId }。
export function findLocalKey(keyHash) {
  const row = db.prepare('SELECT id, bot_id, enabled, last_used_at FROM bot_keys WHERE key_hash = ?').get(keyHash);
  if (!row) return null;
  if (row.enabled !== 1) return { enabled: false };
  // 最后使用时间一分钟内只记一次，追加消息很频繁时不必每次都写库。
  const now = nowIso();
  if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 60000) {
    db.prepare('UPDATE bot_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  return { enabled: true, botId: row.bot_id };
}
