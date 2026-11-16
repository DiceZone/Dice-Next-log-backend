// SQLite（Node 内建 node:sqlite，无需编译原生模块）。
// logs 存日志的中继资料，日志本体在磁盘 blobs/；live_events 只存进行中的实时消息。
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { config, ensureDataDir } from './config.mjs';

ensureDataDir();

export const db = new DatabaseSync(resolve(config.dataDir, 'logs.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS logs (
  key         TEXT PRIMARY KEY,
  password    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  client      TEXT NOT NULL DEFAULT 'SealDice',
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'done',
  source      TEXT NOT NULL DEFAULT 'upload',
  uniform_id  TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  pinned      INTEGER NOT NULL DEFAULT 0,
  owner_hash  TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL DEFAULT '',
  last_seq    INTEGER NOT NULL DEFAULT 0,
  uploader_ip TEXT NOT NULL DEFAULT '',
  storage     TEXT NOT NULL DEFAULT 'local',
  bot_id      TEXT NOT NULL DEFAULT '',
  group_id    TEXT NOT NULL DEFAULT '',
  item_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS logs_status ON logs(status, updated_at);
CREATE INDEX IF NOT EXISTS logs_owner ON logs(owner_hash, status);

CREATE TABLE IF NOT EXISTS live_events (
  log_key TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (log_key, seq)
) WITHOUT ROWID;

-- 等待从某个存储位置删除的日志文件（位置暂时不可用时留待重试）。
CREATE TABLE IF NOT EXISTS blob_deletes (
  storage TEXT NOT NULL,
  key     TEXT NOT NULL,
  PRIMARY KEY (storage, key)
) WITHOUT ROWID;

-- 每份日志里发过言的账号（冒号前的平台前缀已去掉），供按参与者查询。
CREATE TABLE IF NOT EXISTS log_participants (
  log_key  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (log_key, user_id)
);
CREATE INDEX IF NOT EXISTS participants_user ON log_participants(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
`);

// 旧数据库补列。
const columns = new Set(db.prepare('PRAGMA table_info(logs)').all().map((column) => column.name));
const ADDED_COLUMNS = {
  storage: "TEXT NOT NULL DEFAULT 'local'",
  bot_id: "TEXT NOT NULL DEFAULT ''",
  group_id: "TEXT NOT NULL DEFAULT ''",
  item_count: 'INTEGER NOT NULL DEFAULT 0',
};
for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
  if (!columns.has(name)) db.exec(`ALTER TABLE logs ADD COLUMN ${name} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS logs_storage ON logs(storage, status)');
db.exec('CREATE INDEX IF NOT EXISTS logs_bot ON logs(bot_id, created_at)');
db.exec('CREATE INDEX IF NOT EXISTS logs_group ON logs(group_id, created_at)');
// 早先的版本把 uniform_id 一律当成骰娘号。Dice!Next 送来的 uniform_id 其实是群
// （如 QQ-Group:123456），这些记录改记到群号上。
db.exec(`UPDATE logs SET group_id = bot_id, bot_id = ''
         WHERE group_id = '' AND bot_id <> '' AND owner_hash = ''
           AND (lower(uniform_id) LIKE '%group:%' OR lower(uniform_id) LIKE '%channel:%' OR lower(uniform_id) LIKE '%guild:%')
           AND bot_id = substr(uniform_id, instr(uniform_id, ':') + 1)`);
// 海豹管理后台推送的日志 uniform_id 固定是 UI:1000，曾被误记成骰娘号 1000。清空后由内容补认。
db.exec(`UPDATE logs SET bot_id = '' WHERE owner_hash = '' AND uniform_id LIKE 'UI:%'
           AND bot_id = substr(uniform_id, instr(uniform_id, ':') + 1)`);

export function nowIso() {
  return new Date().toISOString();
}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ─── 可在后台调整的设置 ─────────────────────────────────────

export const SETTING_DEFS = {
  // 日志保留天数；0 表示不自动删除。
  retention_days: { def: config.defaultRetentionDays, min: 0, max: 36500 },
  // 单份日志的大小上限（MB）。
  max_upload_mb: { def: 5, min: 1, max: 100 },
  // 同一 IP 每小时可上传的次数；0 表示不限。
  upload_rate_per_hour: { def: 60, min: 0, max: 100000 },
  // 是否开放实时串流。
  live_enabled: { def: 1, min: 0, max: 1 },
  // 实时日志多久没有新消息后自动完结（小时）。
  live_idle_hours: { def: 360, min: 1, max: 8760 },
  // 单份实时日志累计的大小上限（MB）。
  live_max_mb: { def: 20, min: 1, max: 500 },
  // 自动封锁：window 分钟内出现 threshold 次可疑请求的 IP 封锁 hours 小时（0 为永久）。
  autoban_enabled: { def: 1, min: 0, max: 1 },
  autoban_threshold: { def: 40, min: 5, max: 100000 },
  autoban_window_minutes: { def: 10, min: 1, max: 1440 },
  autoban_hours: { def: 24, min: 0, max: 87600 },
  // 同一把骰娘密钥可同时进行的实时日志数量。
  live_max_per_owner: { def: 20, min: 1, max: 1000 },
};

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSettingStmt = db.prepare(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);
const delSettingStmt = db.prepare('DELETE FROM settings WHERE key = ?');

export function getRaw(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : null;
}

export function putRaw(key, value) {
  if (value === null) delSettingStmt.run(key);
  else putSettingStmt.run(key, String(value));
}

export function getSetting(key) {
  const def = SETTING_DEFS[key];
  const raw = getRaw(`cfg.${key}`);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? value : def.def;
}

export function allSettings() {
  return Object.fromEntries(Object.keys(SETTING_DEFS).map((key) => [key, getSetting(key)]));
}

// 返回出错的字段名；全部合法则写入并返回 null。
export function updateSettings(patch) {
  const next = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    const def = SETTING_DEFS[key];
    if (!def) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < def.min || value > def.max) return key;
    next[key] = value;
  }
  transaction(() => {
    for (const [key, value] of Object.entries(next)) putRaw(`cfg.${key}`, value);
  });
  return null;
}
