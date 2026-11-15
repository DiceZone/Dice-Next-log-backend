// 日志的存取：中继资料在 SQLite，完结日志的本体是原始压缩字节，存放位置见 storage.mjs。
import { randomInt, createHash, randomBytes } from 'node:crypto';
import * as zlib from 'node:zlib';
import { site } from './site.mjs';
import { db, nowIso, transaction, getSetting, getRaw, putRaw } from './db.mjs';
import { HttpError } from './http.mjs';
import { publish, publishEnd } from './hub.mjs';
import { LOCAL, writeLocal, removeLocal, readBlob, queueDelete, kickMover } from './storage.mjs';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_INFLATE = 64 * 1024 * 1024;
const MAX_PARTICIPANTS = 300;

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function randomKey(length) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const getStmt = db.prepare('SELECT * FROM logs WHERE key = ?');
const existsStmt = db.prepare('SELECT 1 FROM logs WHERE key = ?');
const insertStmt = db.prepare(`
  INSERT INTO logs(key, password, name, client, note, status, source, uniform_id, size,
                   owner_hash, token_hash, uploader_ip, bot_id, group_id, created_at, updated_at)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const deleteStmt = db.prepare('DELETE FROM logs WHERE key = ?');
const deleteEventsStmt = db.prepare('DELETE FROM live_events WHERE log_key = ?');
const deleteParticipantsStmt = db.prepare('DELETE FROM log_participants WHERE log_key = ?');

export function getLog(key) {
  return getStmt.get(key) || null;
}

export function shareUrl(log) {
  if (!site.frontendUrl) {
    throw new HttpError(500, '未配置染色器地址，请在后台「设置 → 站点配置」填写。Frontend URL is not configured.');
  }
  return `${site.frontendUrl}?key=${log.key}#${log.password}`;
}

function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

// 「QQ:123456」这类带平台前缀的账号，查询时只认冒号后面的部分。
export function bareId(value) {
  const text = String(value ?? '').trim();
  return text.slice(text.lastIndexOf(':') + 1).slice(0, 64);
}

// 骰娘号与群号：上传方明确给了就用给的。没给时看 uniform_id——
// 海豹送的是骰娘自己的账号（如 QQ:123456），Dice!Next 送的是群（如 QQ-Group:123456）。
export function resolveIds({ botId, groupId, uniformId }) {
  let bot = bareId(botId);
  let group = bareId(groupId);
  const uniform = String(uniformId ?? '');
  const bare = bareId(uniform);
  if (bare && bare !== bot && bare !== group) {
    const prefix = uniform.slice(0, Math.max(uniform.lastIndexOf(':'), 0));
    if (/group|channel|guild/i.test(prefix)) {
      if (!group) group = bare;
    } else if (!bot) {
      bot = bare;
    }
  }
  return { bot, group };
}

function insertRow(key, password, fields, createdAt, updatedAt) {
  const ids = resolveIds(fields);
  insertStmt.run(
    key, password, clip(fields.name, 200), clip(fields.client || 'SealDice', 32),
    clip(fields.note, 500), fields.status, fields.source, clip(fields.uniformId, 128),
    fields.size || 0, fields.ownerHash || '', fields.tokenHash || '', clip(fields.ip, 64),
    ids.bot, ids.group, createdAt, updatedAt,
  );
}

function insertLog(fields) {
  const password = String(randomInt(100000, 1000000));
  const now = nowIso();
  // 4 位 key 与旧站一致；连续撞名时加长，避免日志多了以后生成不出新 key。
  for (let attempt = 0; ; attempt++) {
    const key = randomKey(attempt < 8 ? 4 : 6);
    if (existsStmt.get(key)) continue;
    insertRow(key, password, fields, now, now);
    return getLog(key);
  }
}

// ─── 日志内容与参与者 ───────────────────────────────────────

// 把日志本体解成消息数组。认不出的格式（例如 Parquet）返回 null。
export function decodeItems(client, data) {
  let json;
  if (client === 'SealDice') {
    json = zlib.inflateSync(data, { maxOutputLength: MAX_INFLATE }).toString('utf8');
  } else if (client === 'DiceNext' && typeof zlib.zstdDecompressSync === 'function') {
    json = zlib.zstdDecompressSync(data, { maxOutputLength: MAX_INFLATE }).toString('utf8');
  } else {
    return null;
  }
  const parsed = JSON.parse(json);
  return Array.isArray(parsed.items) ? parsed.items : null;
}

const upsertParticipantStmt = db.prepare(`
  INSERT INTO log_participants(log_key, user_id, nickname) VALUES(?, ?, ?)
  ON CONFLICT(log_key, user_id) DO UPDATE SET nickname = excluded.nickname`);
const participantCountStmt = db.prepare('SELECT COUNT(*) AS n FROM log_participants WHERE log_key = ?');

function collectParticipants(items) {
  const found = new Map();
  for (const item of items) {
    const id = bareId(item && item.IMUserId);
    if (!id) continue;
    if (!found.has(id) && found.size >= MAX_PARTICIPANTS) continue;
    found.set(id, clip(item.nickname, 64));
  }
  return found;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

// 上传方没给骰娘号或群号时，从内容里认：
// 骰娘号是发出掷骰结果（isDice）最多的那个账号，群号是消息上的 GroupID。
// 旧站迁来的日志、海豹（不送群号）、Dice!Next（不送骰娘号）都靠这个补齐。
function inferIds(items) {
  return {
    bot: mostCommon(items.filter((item) => item && item.isDice).map((item) => bareId(item.IMUserId))),
    group: mostCommon(items.map((item) => bareId(item && item.GroupID))),
  };
}

// 用整份内容重建参与者名单与消息条数，并补上空着的骰娘号、群号。
function indexItems(key, items) {
  const found = collectParticipants(items);
  const ids = inferIds(items);
  transaction(() => {
    deleteParticipantsStmt.run(key);
    for (const [id, nickname] of found) upsertParticipantStmt.run(key, id, nickname);
    db.prepare('UPDATE logs SET item_count = ? WHERE key = ?').run(items.length, key);
    if (ids.bot) db.prepare("UPDATE logs SET bot_id = ? WHERE key = ? AND bot_id = ''").run(ids.bot, key);
    if (ids.group) db.prepare("UPDATE logs SET group_id = ? WHERE key = ? AND group_id = ''").run(ids.group, key);
  });
}

function indexData(key, client, data) {
  try {
    const items = decodeItems(client, data);
    if (items) indexItems(key, items);
  } catch (err) {
    console.warn(`[索引] ${key} 的内容无法解析：${err.message}`);
  }
}

// 给早先入库、骰娘号或群号还空着的日志补一遍（只做一次，在后台慢慢跑）。
export async function backfillIds() {
  if (getRaw('backfill.ids_v1')) return;
  const rows = db.prepare("SELECT key FROM logs WHERE status = 'done' AND (bot_id = '' OR group_id = '')").all();
  let filled = 0;
  for (const { key } of rows) {
    const log = getLog(key);
    if (!log || log.status !== 'done') continue;
    try {
      const items = decodeItems(log.client, await readData(log));
      if (items) {
        indexItems(key, items);
        const after = getLog(key);
        if (after && (after.bot_id !== log.bot_id || after.group_id !== log.group_id)) filled += 1;
      }
    } catch (err) {
      console.warn(`[补齐] ${key} 读取失败：${err.message}`);
    }
    // 让出事件循环，不挡住正常请求。
    await new Promise((done) => setImmediate(done));
  }
  putRaw('backfill.ids_v1', nowIso());
  if (rows.length) console.log(`[补齐] 检查 ${rows.length} 份日志，补上骰娘号或群号 ${filled} 份`);
}

export function participantsOf(key) {
  return db.prepare('SELECT user_id, nickname FROM log_participants WHERE log_key = ? ORDER BY rowid').all(key);
}

// ─── 一次性上传 ─────────────────────────────────────────────

// data 为上传方给的原始压缩字节。先写本地缓存，再由搬运程序搬到写入位置。
export function createLog({ name, client, note, source, uniformId, botId, groupId, ownerHash, data, ip }) {
  const log = insertLog({
    name, client, note, source, uniformId, botId, groupId, ownerHash, ip, status: 'done', size: data.length,
  });
  try {
    writeLocal(log.key, data);
  } catch (err) {
    deleteStmt.run(log.key);
    throw err;
  }
  // 解析参与者放到回应之后，不拖慢上传。
  setImmediate(() => indexData(log.key, log.client, data));
  kickMover();
  return log;
}

// 从旧站导入：保留原来的 key、密码与时间。返回 created / exists / conflict。
export function importLog({ key, password, name, client, note, createdAt, updatedAt, data }) {
  const existing = getLog(key);
  if (existing) return existing.password === password ? 'exists' : 'conflict';
  insertRow(key, password, {
    name, client, note, source: 'import', status: 'done', size: data.length,
  }, createdAt, updatedAt || createdAt);
  try {
    writeLocal(key, data);
  } catch (err) {
    deleteStmt.run(key);
    throw err;
  }
  indexData(key, client || 'SealDice', data);
  return 'created';
}

export function deleteLogs(keys) {
  let deleted = 0;
  for (const key of keys) {
    const log = getLog(key);
    if (!log) continue;
    transaction(() => {
      deleteEventsStmt.run(key);
      deleteParticipantsStmt.run(key);
      deleteStmt.run(key);
      // 不在本地的文件交给搬运程序删除（位置可能很慢或暂时离线）。
      if (log.status === 'done' && log.storage !== LOCAL) queueDelete(log.storage, key);
    });
    removeLocal(key);
    materialized.delete(key);
    if (log.status === 'live') publishEnd(key, { status: 'deleted' });
    deleted += 1;
  }
  if (deleted) kickMover();
  return deleted;
}

export function cleanupExpired() {
  const days = getSetting('retention_days');
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db
    .prepare("SELECT key FROM logs WHERE status = 'done' AND pinned = 0 AND created_at < ?")
    .all(cutoff);
  return deleteLogs(rows.map((row) => row.key));
}

// ─── 查询 ───────────────────────────────────────────────────

const SORTS = {
  created_desc: 'created_at DESC',
  created_asc: 'created_at ASC',
  size_desc: 'size DESC, created_at DESC',
};

function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

// filters：q（名称/Key/uniform_id/备注）、status、source、bot、group、participant（账号或昵称）、
// owner（{ hash, botId }：只看这把骰娘密钥或这个骰娘号名下的日志）。
export function searchLogs(filters, { page = 1, pageSize = 50, sort } = {}) {
  const where = [];
  const args = [];
  const q = (filters.q || '').trim();
  if (q) {
    const like = likePattern(q);
    where.push("(key LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR uniform_id LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  if (filters.status === 'done' || filters.status === 'live') {
    where.push('status = ?');
    args.push(filters.status);
  } else if (filters.status === 'pinned') {
    where.push('pinned = 1');
  }
  if (['upload', 'backup', 'w4123', 'live', 'import'].includes(filters.source)) {
    where.push('source = ?');
    args.push(filters.source);
  }
  const bot = bareId(filters.bot);
  if (bot) {
    where.push('bot_id = ?');
    args.push(bot);
  }
  const group = bareId(filters.group);
  if (group) {
    where.push('group_id = ?');
    args.push(group);
  }
  const participant = (filters.participant || '').trim();
  if (participant) {
    where.push("key IN (SELECT log_key FROM log_participants WHERE user_id = ? OR nickname LIKE ? ESCAPE '\\')");
    args.push(bareId(participant), likePattern(participant));
  }
  if (filters.owner) {
    const parts = ['owner_hash = ?'];
    args.push(filters.owner.hash);
    if (filters.owner.botId) {
      parts.push('bot_id = ?');
      args.push(filters.owner.botId);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const current = Math.max(Number(page) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM logs ${clause}`).get(...args).n;
  const rows = db
    .prepare(`SELECT * FROM logs ${clause} ORDER BY ${SORTS[sort] || SORTS.created_desc} LIMIT ? OFFSET ?`)
    .all(...args, size, (current - 1) * size);
  return { total, page: current, pageSize: size, rows };
}

// ─── 实时日志 ───────────────────────────────────────────────

const eventsStmt = db.prepare(
  'SELECT seq, payload FROM live_events WHERE log_key = ? AND seq > ? ORDER BY seq LIMIT ?',
);
const insertEventStmt = db.prepare('INSERT INTO live_events(log_key, seq, payload) VALUES(?, ?, ?)');
const bumpStmt = db.prepare('UPDATE logs SET last_seq = ?, size = size + ?, updated_at = ? WHERE key = ?');
const liveCountStmt = db.prepare("SELECT COUNT(*) AS n FROM logs WHERE owner_hash = ? AND status = 'live'");

export function startLive({ name, uniformId, botId, groupId, ownerHash, ip }) {
  if (liveCountStmt.get(ownerHash).n >= getSetting('live_max_per_owner')) {
    throw new HttpError(429, { success: false, message: 'Too many live logs in progress for this key' });
  }
  const token = randomBytes(32).toString('hex');
  const log = insertLog({
    name, uniformId, botId, groupId, ownerHash, ip,
    client: 'SealDice', source: 'live', status: 'live', tokenHash: sha256(token),
  });
  return { log, token };
}

// 续写：以一份已有日志的内容为起点，另开一份新的实时日志（新的 Key、密码与链接）。
// 原日志不受影响；换了骰娘、或想接着一份已完结的日志往下写时用。
export async function forkLive(source, { name, uniformId, botId, groupId, ownerHash, ip }) {
  if (liveCountStmt.get(ownerHash).n >= getSetting('live_max_per_owner')) {
    throw new HttpError(429, { success: false, message: 'Too many live logs in progress for this key' });
  }
  const items = source.status === 'live'
    ? buildItems(source.key)
    : decodeItems(source.client, await readData(source));
  if (!items) throw new HttpError(409, { success: false, message: 'This log format cannot be continued' });
  const payloads = items.map((item) => JSON.stringify({ op: 'add', item }));
  const bytes = payloads.reduce((sum, payload) => sum + Buffer.byteLength(payload), 0);
  if (bytes > getSetting('live_max_mb') * 1024 * 1024) {
    throw new HttpError(413, { success: false, message: 'Source log is larger than the live log size limit' });
  }
  const token = randomBytes(32).toString('hex');
  const log = insertLog({
    name: name || source.name,
    uniformId,
    botId,
    groupId: groupId || source.group_id,
    ownerHash,
    ip,
    note: `续写自 ${source.key}`,
    client: 'SealDice', source: 'live', status: 'live', tokenHash: sha256(token),
  });
  transaction(() => {
    payloads.forEach((payload, i) => insertEventStmt.run(log.key, i + 1, payload));
    bumpStmt.run(payloads.length, bytes, nowIso(), log.key);
  });
  indexItems(log.key, items);
  return { log: getLog(log.key), token };
}

function cleanEvent(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, { success: false, message: 'Invalid event' });
  const op = raw.op || 'add';
  let event;
  if (op === 'add') {
    const item = raw.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(400, { success: false, message: `Event ${raw.seq}: item is required` });
    }
    // 其余字段原样保留，染色器需要的两个字段在这里保证类型正确。
    event = { op, item: { ...item, message: String(item.message ?? ''), isDice: Boolean(item.isDice) } };
  } else if (op === 'edit') {
    event = { op, rawMsgId: raw.rawMsgId, message: String(raw.message ?? '') };
  } else if (op === 'delete') {
    event = { op, rawMsgId: raw.rawMsgId };
  } else {
    throw new HttpError(400, { success: false, message: `Event ${raw.seq}: unknown op` });
  }
  if (op !== 'add' && (raw.rawMsgId === undefined || raw.rawMsgId === null || raw.rawMsgId === '')) {
    throw new HttpError(400, { success: false, message: `Event ${raw.seq}: rawMsgId is required` });
  }
  const payload = JSON.stringify(event);
  if (Buffer.byteLength(payload) > MAX_EVENT_BYTES) {
    throw new HttpError(413, { success: false, message: `Event ${raw.seq}: too large` });
  }
  return { event, payload };
}

// 序号必须紧接着上一条：已收过的直接略过（重送安全），中间有缺口则整批拒收并回报 last_seq。
export function appendLive(log, rawEvents) {
  let last = log.last_seq;
  let bytes = 0;
  const accepted = [];
  for (const raw of rawEvents) {
    const seq = raw && raw.seq;
    if (!Number.isInteger(seq) || seq < 1) {
      throw new HttpError(400, { success: false, message: 'Event seq must be a positive integer' });
    }
    if (seq <= last) continue;
    if (seq !== last + 1) {
      throw new HttpError(409, { success: false, message: 'Sequence gap', last_seq: log.last_seq });
    }
    const cleaned = cleanEvent(raw);
    bytes += Buffer.byteLength(cleaned.payload);
    accepted.push({ seq, ...cleaned });
    last = seq;
  }
  if (accepted.length === 0) return log.last_seq;
  if (log.size + bytes > getSetting('live_max_mb') * 1024 * 1024) {
    throw new HttpError(413, { success: false, message: 'Live log size limit reached', last_seq: log.last_seq });
  }
  const speakers = collectParticipants(
    accepted.filter((item) => item.event.op === 'add').map((item) => item.event.item),
  );
  transaction(() => {
    for (const item of accepted) insertEventStmt.run(log.key, item.seq, item.payload);
    bumpStmt.run(last, bytes, nowIso(), log.key);
    // 进行中就能按参与者查到；完结时再按最终内容重建一次。
    let room = MAX_PARTICIPANTS - participantCountStmt.get(log.key).n;
    for (const [id, nickname] of speakers) {
      if (room <= 0) break;
      upsertParticipantStmt.run(log.key, id, nickname);
      room -= 1;
    }
  });
  publish(log.key, accepted.map((item) => ({ seq: item.seq, ...item.event })));
  return last;
}

export function listEvents(key, after, limit) {
  return eventsStmt.all(key, after, limit).map((row) => ({ seq: row.seq, ...JSON.parse(row.payload) }));
}

function buildItems(key) {
  const items = [];
  const find = (id) => items.findLastIndex((item) => String(item.rawMsgId) === String(id));
  for (const row of db.prepare('SELECT payload FROM live_events WHERE log_key = ? ORDER BY seq').iterate(key)) {
    const event = JSON.parse(row.payload);
    if (event.op === 'add') {
      items.push(event.item);
    } else {
      const index = find(event.rawMsgId);
      if (index < 0) continue;
      if (event.op === 'edit') items[index] = { ...items[index], message: event.message };
      else items.splice(index, 1);
    }
  }
  items.forEach((item, i) => {
    if (item.id === undefined || item.id === null) item.id = i + 1;
  });
  return items;
}

// 进行中的日志按 last_seq 缓存压缩结果，观众反复刷新时不必每次重压。
const materialized = new Map();

function materialize(log) {
  const cached = materialized.get(log.key);
  if (cached && cached.seq === log.last_seq) return cached;
  const items = buildItems(log.key);
  const entry = {
    seq: log.last_seq,
    items,
    data: zlib.deflateSync(Buffer.from(JSON.stringify({ version: 1, items }))),
  };
  if (materialized.size >= 50) materialized.delete(materialized.keys().next().value);
  materialized.set(log.key, entry);
  return entry;
}

// 完结：把实时消息压成一份普通日志。没有任何消息的日志直接删除。
export function finalizeLive(key) {
  const log = getLog(key);
  if (!log || log.status !== 'live') return { log, deleted: false };
  const entry = materialize(log);
  materialized.delete(key);
  if (entry.items.length === 0) {
    deleteLogs([key]);
    return { log: null, deleted: true };
  }
  writeLocal(key, entry.data);
  transaction(() => {
    db.prepare("UPDATE logs SET status = 'done', size = ?, token_hash = '', updated_at = ? WHERE key = ?")
      .run(entry.data.length, nowIso(), key);
    deleteEventsStmt.run(key);
  });
  indexItems(key, entry.items);
  publishEnd(key, { status: 'done', last_seq: log.last_seq });
  kickMover();
  return { log: getLog(key), deleted: false };
}

export function finalizeIdle() {
  const cutoff = new Date(Date.now() - getSetting('live_idle_hours') * 3600000).toISOString();
  const rows = db.prepare("SELECT key FROM logs WHERE status = 'live' AND updated_at < ?").all(cutoff);
  for (const row of rows) finalizeLive(row.key);
  return rows.length;
}

// 日志本体（压缩字节）。进行中的日志现场压一份，格式与完结后相同。
export async function readData(log) {
  if (log.status === 'live') return materialize(log).data;
  try {
    return await readBlob(log.storage, log.key);
  } catch (err) {
    // 读的时候正好被搬走：按新位置再读一次。
    const fresh = getLog(log.key);
    if (err.code === 'ENOENT' && fresh && fresh.storage !== log.storage) {
      return readBlob(fresh.storage, fresh.key);
    }
    throw err;
  }
}

// load_data 的回应：字段与旧站完全一致，进行中的日志多带 live / last_seq。
export async function storagePayload(log) {
  const payload = {
    client: log.client,
    created_at: log.created_at,
    data: (await readData(log)).toString('base64'),
    name: log.name,
    note: log.note,
    updated_at: log.updated_at,
  };
  if (log.status === 'live') {
    payload.live = true;
    payload.last_seq = log.last_seq;
  }
  return payload;
}
