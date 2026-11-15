// 后台管理接口（/admin/api）。除 state / setup / login 外都需要登录。
import { config } from '../config.mjs';
import { db, nowIso, allSettings, updateSettings, getSetting, SETTING_DEFS } from '../db.mjs';
import { HttpError, send, readJson, RateLimiter } from '../http.mjs';
import {
  hasAdmin, ensureSetupCode, createAdmin, checkLogin, changePassword,
  createSession, findSession, dropSession, verifyPassword,
} from '../auth.mjs';
import {
  getLog, shareUrl, deleteLogs, cleanupExpired, finalizeLive, readData,
  decodeItems, searchLogs, participantsOf,
} from '../store.mjs';
import { liveAuthConfigured } from '../bdc.mjs';
import { site, siteValues, updateSite } from '../site.mjs';
import { importStatus, startImport, stopImport } from '../import-legacy.mjs';
import {
  LOCAL, storageNames, hasStorage, storagePath, initialized, draining, setDraining,
  isOnline, initStorage, getTarget, setTarget, moverStatus, kickMover,
} from '../storage.mjs';

const COOKIE = 'dnlog_session';
const USERNAME = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;
const loginLimiter = new RateLimiter(15 * 60 * 1000);
const LOGIN_FAIL_LIMIT = 10;
const PREVIEW_ITEMS = 300;

function cookieToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return '';
}

function sessionCookie(req, token, maxAge) {
  const secure = config.cookieSecure === 'true'
    || (config.cookieSecure === 'auto' && req.headers['x-forwarded-proto'] === 'https');
  return `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function fail(status, message, extra = {}) {
  return new HttpError(status, { success: false, message, ...extra });
}

function checkPasswordRule(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 128) {
    throw fail(400, `密码长度须为 ${MIN_PASSWORD}–128 个字符。`);
  }
}

function logView(row, retentionDays) {
  let expiresAt = null;
  if (row.status === 'done' && !row.pinned && retentionDays > 0) {
    expiresAt = new Date(new Date(row.created_at).getTime() + retentionDays * 86400000).toISOString();
  }
  return {
    key: row.key,
    name: row.name,
    client: row.client,
    note: row.note,
    status: row.status,
    source: row.source,
    uniform_id: row.uniform_id,
    size: row.size,
    pinned: row.pinned === 1,
    last_seq: row.last_seq,
    uploader_ip: row.uploader_ip,
    storage: row.storage,
    bot_id: row.bot_id,
    group_id: row.group_id,
    item_count: row.item_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: expiresAt,
    url: shareUrl(row),
  };
}

// ─── 未登录可用 ─────────────────────────────────────────────

function state({ req, res }) {
  const session = findSession(cookieToken(req));
  send(res, 200, {
    setup_required: !hasAdmin(),
    logged_in: Boolean(session),
    username: session ? session.username : null,
    version: config.version,
  });
}

async function setup({ req, res, ip }) {
  if (hasAdmin()) throw fail(409, '管理员账号已存在。');
  if (!loginLimiter.hit(`setup:${ip}`, LOGIN_FAIL_LIMIT)) throw fail(429, '尝试次数过多，请稍后再试。');
  const body = await readJson(req, 4096);
  if (String(body.setup_code || '').trim() !== ensureSetupCode()) throw fail(403, '设置码不正确。');
  const username = String(body.username || '').trim();
  if (!USERNAME.test(username)) throw fail(400, '用户名须为 3–32 位的字母、数字、下划线、点或短横线。');
  checkPasswordRule(body.password);
  const admin = createAdmin(username, body.password);
  const session = createSession(admin.id);
  send(res, 200, { success: true, username }, { 'Set-Cookie': sessionCookie(req, session.token, session.maxAge) });
}

async function login({ req, res, ip }) {
  if (loginLimiter.count(`login:${ip}`) >= LOGIN_FAIL_LIMIT) throw fail(429, '登录失败次数过多，请稍后再试。');
  const body = await readJson(req, 4096);
  const admin = checkLogin(String(body.username || '').trim(), String(body.password || ''));
  if (!admin) {
    loginLimiter.hit(`login:${ip}`, 0);
    throw fail(401, '用户名或密码不正确。');
  }
  const session = createSession(admin.id);
  send(res, 200, { success: true, username: admin.username }, {
    'Set-Cookie': sessionCookie(req, session.token, session.maxAge),
  });
}

// ─── 需要登录 ───────────────────────────────────────────────

function logout({ req, res }) {
  dropSession(cookieToken(req));
  send(res, 200, { success: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
}

async function password({ req, res, session }) {
  const body = await readJson(req, 4096);
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(session.admin_id);
  if (!verifyPassword(String(body.old_password || ''), admin.pass_hash)) throw fail(403, '当前密码不正确。');
  checkPasswordRule(body.new_password);
  changePassword(admin.id, body.new_password, session.token_hash);
  send(res, 200, { success: true });
}

function stats({ res }) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(size), 0) AS bytes,
           COALESCE(SUM(status = 'live'), 0) AS live,
           COALESCE(SUM(pinned), 0) AS pinned,
           COALESCE(SUM(created_at >= ?), 0) AS last_day
    FROM logs`).get(new Date(Date.now() - 86400000).toISOString());
  send(res, 200, row);
}

function listLogs({ res, url }) {
  const params = url.searchParams;
  const found = searchLogs({
    q: params.get('q'),
    status: params.get('status'),
    source: params.get('source'),
    bot: params.get('bot'),
    group: params.get('group'),
    participant: params.get('participant'),
  }, { page: params.get('page'), pageSize: params.get('page_size'), sort: params.get('sort') });
  const retention = getSetting('retention_days');
  send(res, 200, {
    total: found.total,
    page: found.page,
    page_size: found.pageSize,
    items: found.rows.map((row) => logView(row, retention)),
  });
}

function requireLog(key) {
  const log = getLog(key);
  if (!log) throw fail(404, '该日志不存在。');
  return log;
}

function getOne({ res }, key) {
  send(res, 200, { ...logView(requireLog(key), getSetting('retention_days')), participants: participantsOf(key) });
}

async function patchOne({ req, res }, key) {
  requireLog(key);
  const body = await readJson(req, 16 * 1024);
  const sets = [];
  const args = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 200) throw fail(400, '名称须为 1–200 个字符。');
    sets.push('name = ?');
    args.push(name);
  }
  if (body.note !== undefined) {
    const note = String(body.note);
    if (note.length > 500) throw fail(400, '备注不得超过 500 个字符。');
    sets.push('note = ?');
    args.push(note);
  }
  if (body.pinned !== undefined) {
    sets.push('pinned = ?');
    args.push(body.pinned ? 1 : 0);
  }
  if (sets.length) {
    // 进行中的日志靠 updated_at 判断闲置时间，改资料时不动它。
    db.prepare(`UPDATE logs SET ${sets.join(', ')} WHERE key = ?`).run(...args, key);
  }
  send(res, 200, logView(requireLog(key), getSetting('retention_days')));
}

async function preview({ res }, key) {
  const log = requireLog(key);
  let items = null;
  try {
    items = decodeItems(log.client, await readData(log));
  } catch {
    items = null;
  }
  const participants = participantsOf(key);
  if (!items) return send(res, 200, { supported: false, total: 0, items: [], participants });
  send(res, 200, {
    supported: true,
    participants,
    total: items.length,
    items: items.slice(0, PREVIEW_ITEMS).map((item) => ({
      nickname: String(item.nickname ?? ''),
      user_id: String(item.IMUserId ?? ''),
      time: Number(item.time) || 0,
      message: String(item.message ?? '').slice(0, 2000),
      is_dice: Boolean(item.isDice),
    })),
  });
}

function removeOne({ res }, key) {
  requireLog(key);
  send(res, 200, { success: true, deleted: deleteLogs([key]) });
}

async function batchDelete({ req, res }) {
  const body = await readJson(req, 256 * 1024);
  if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 1000) {
    throw fail(400, '请选择 1–1000 份日志。');
  }
  send(res, 200, { success: true, deleted: deleteLogs(body.keys.map(String)) });
}

function finalizeOne({ res }, key) {
  const log = requireLog(key);
  if (log.status !== 'live') throw fail(409, '该日志已完结。');
  const result = finalizeLive(key);
  send(res, 200, { success: true, deleted: result.deleted });
}

const SITE_ERRORS = {
  frontend_url: '染色器地址须为有效的网址，且不能留空。',
  cors_origins: '额外放行的来源须为网址，多个以逗号分隔。',
  legacy_upstream_url: '旧站地址须为有效的网址。',
  bdc_verify_url: '金钥校验地址须以 http:// 或 https:// 开头。',
  trust_proxy_header: '请求头名称只能包含字母、数字与短横线。',
};

function getSettings({ res }) {
  send(res, 200, {
    values: allSettings(),
    limits: SETTING_DEFS,
    site: siteValues(),
    live_auth: site.bdcVerifyUrl && site.bdcVerifyToken ? 'bdc' : liveAuthConfigured() ? 'static' : 'none',
  });
}

async function putSettings({ req, res }) {
  const body = await readJson(req, 16 * 1024);
  const bad = updateSettings(body);
  if (bad) {
    const def = SETTING_DEFS[bad];
    throw fail(400, `设置项的取值须为 ${def.min}–${def.max} 的整数。`, { field: bad });
  }
  const badSite = updateSite(body.site);
  if (badSite) throw fail(400, SITE_ERRORS[badSite] || '站点配置的格式不正确。', { field: badSite });
  send(res, 200, { success: true, values: allSettings(), site: siteValues() });
}

// ─── 存储位置 ───────────────────────────────────────────────

async function getStorage({ res }) {
  const usage = new Map(db
    .prepare("SELECT storage, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM logs WHERE status = 'done' GROUP BY storage")
    .all().map((row) => [row.storage, row]));
  const inited = initialized();
  const drain = draining();
  const target = getTarget();
  const locations = await Promise.all(storageNames().map(async (name) => {
    let state = 'online';
    if (!inited.has(name)) state = 'uninitialized';
    else if (!(await isOnline(name))) state = 'offline';
    const used = usage.get(name) || { n: 0, bytes: 0 };
    usage.delete(name);
    return {
      name, path: storagePath(name), state, count: used.n, bytes: used.bytes,
      draining: drain.has(name), target: name === target, builtin: name === LOCAL,
    };
  }));
  // 日志记着、但 STORAGES 里已经没有的位置：这些日志目前读不到。
  for (const [name, used] of usage) {
    locations.push({ name, path: '', state: 'missing', count: used.n, bytes: used.bytes, draining: false, target: false, builtin: false });
  }
  send(res, 200, { target, locations, mover: moverStatus() });
}

async function storageName(req) {
  const body = await readJson(req, 4096);
  const name = String(body.name || '');
  if (!hasStorage(name)) throw fail(404, '该存储位置不存在。');
  return { name, body };
}

async function storageInit({ req, res }) {
  const { name } = await storageName(req);
  if (name === LOCAL) throw fail(400, '本地缓存无需初始化。');
  try {
    await initStorage(name);
  } catch (err) {
    throw fail(400, `无法写入该位置：${err.message}`);
  }
  send(res, 200, { success: true });
}

async function storageTarget({ req, res }) {
  const { name } = await storageName(req);
  if (!initialized().has(name)) throw fail(400, '该存储位置尚未初始化。');
  if (!(await isOnline(name))) throw fail(400, '该存储位置当前不可用。');
  setTarget(name);
  kickMover();
  send(res, 200, { success: true });
}

async function storageDrain({ req, res }) {
  const { name, body } = await storageName(req);
  if (name === LOCAL) throw fail(400, '本地缓存中的日志会自动搬往写入位置。');
  if (body.enabled && name === getTarget()) throw fail(400, '当前写入位置不能迁出。');
  setDraining(name, Boolean(body.enabled));
  kickMover();
  send(res, 200, { success: true });
}

function storageRun({ res }) {
  kickMover();
  send(res, 200, { success: true });
}

// ─── 旧站迁移 ───────────────────────────────────────────────

function getImport({ res }) {
  send(res, 200, importStatus());
}

async function postImportStart({ req, res }) {
  const body = await readJson(req, 32 * 1024 * 1024);
  try {
    startImport(body.base_url, body.token, body.index);
  } catch (err) {
    throw fail(400, err.message);
  }
  send(res, 200, importStatus());
}

function postImportStop({ res }) {
  stopImport();
  send(res, 200, importStatus());
}

function runCleanup({ res }) {
  send(res, 200, { success: true, deleted: cleanupExpired(), at: nowIso() });
}

const PUBLIC = {
  'GET state': state,
  'POST setup': setup,
  'POST login': login,
};

const PRIVATE = {
  'POST logout': logout,
  'POST password': password,
  'GET stats': stats,
  'GET logs': listLogs,
  'POST logs/batch-delete': batchDelete,
  'GET settings': getSettings,
  'PUT settings': putSettings,
  'POST cleanup': runCleanup,
  'GET import': getImport,
  'POST import/start': postImportStart,
  'POST import/stop': postImportStop,
  'GET storage': getStorage,
  'POST storage/init': storageInit,
  'POST storage/target': storageTarget,
  'POST storage/drain': storageDrain,
  'POST storage/run': storageRun,
};

const LOG_ROUTE = /^logs\/([A-Za-z0-9]{4,12})(?:\/(preview|finalize))?$/;

function findPrivate(method, sub) {
  const direct = PRIVATE[`${method} ${sub}`];
  if (direct) return direct;
  const match = LOG_ROUTE.exec(sub);
  if (!match) return null;
  const [, key, action] = match;
  if (!action && method === 'GET') return (ctx) => getOne(ctx, key);
  if (!action && method === 'PATCH') return (ctx) => patchOne(ctx, key);
  if (!action && method === 'DELETE') return (ctx) => removeOne(ctx, key);
  if (action === 'preview' && method === 'GET') return (ctx) => preview(ctx, key);
  if (action === 'finalize' && method === 'POST') return (ctx) => finalizeOne(ctx, key);
  return null;
}

export function matchAdmin({ path, method, req }) {
  if (!path.startsWith('/admin/api/')) return null;
  const sub = path.slice('/admin/api/'.length);
  const open = PUBLIC[`${method} ${sub}`];
  const handler = open || findPrivate(method, sub);
  if (!handler) return null;

  return async (ctx) => {
    // 会改动资料的请求必须带自定义请求头：跨站表单带不了，等同于防 CSRF。
    if (method !== 'GET' && req.headers['x-requested-with'] !== 'dnlog-admin') {
      throw fail(403, '请求来源不合法。');
    }
    if (!open) {
      const session = findSession(cookieToken(req));
      if (!session) throw fail(401, '尚未登录或登录已过期。');
      ctx.session = session;
    }
    return handler(ctx);
  };
}
