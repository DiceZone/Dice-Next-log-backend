// 实时串流接口（/api/v2）。
//   GET  /api/v2/info                     站点信息
//   POST /api/v2/live/start               开始一份实时日志（Bearer 骰娘金钥）
//   POST /api/v2/live/{key}/fork          以这份日志为起点另开一份续写（Bearer 骰娘金钥 + 日志密码）
//   POST /api/v2/live/{key}/append        追加消息（Bearer 会话令牌）
//   POST /api/v2/live/{key}/end           完结（Bearer 会话令牌）
//   GET  /api/v2/live/{key}/events        拉取 after 之后的消息（password）
//   GET  /api/v2/live/{key}/stream        SSE 推送（password）
//   GET  /api/v2/logs                     骰娘查询自己名下的日志（Bearer 骰娘金钥）
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.mjs';
import { getSetting } from '../db.mjs';
import { HttpError, send, readJson, cors, bearer, RateLimiter } from '../http.mjs';
import { verifyKey, liveAuthConfigured } from '../bdc.mjs';
import {
  getLog, shareUrl, sha256, startLive, forkLive, appendLive, finalizeLive, listEvents, searchLogs, participantsOf,
} from '../store.mjs';
import { subscribe, writeEvents, writeEnd } from '../hub.mjs';

const UNIFORM_ID = /^[^:]+:[A-Za-z0-9_\-.]+$/;
const MAX_BATCH = 500;
const MAX_APPEND_BYTES = 2 * 1024 * 1024;
const LIVE_PATH = /^\/api\/v2\/live\/([A-Za-z0-9]{4,12})\/(fork|append|end|events|stream)$/;
const forkFailLimiter = new RateLimiter(10 * 60 * 1000);
const FORK_FAIL_LIMIT = 20;

function liveAvailable() {
  return getSetting('live_enabled') === 1 && liveAuthConfigured();
}

function requireLive(headers) {
  if (!liveAvailable()) {
    throw new HttpError(503, { success: false, message: 'Live upload is not enabled on this site' }, headers);
  }
}

function info({ req, res }) {
  send(res, 200, {
    name: 'Dice!Next Log Service',
    version: config.version,
    retention_days: getSetting('retention_days'),
    max_upload_mb: getSetting('max_upload_mb'),
    live: liveAvailable(),
  }, { ...cors(req, 'GET, OPTIONS'), 'Cache-Control': 'no-store' });
}

async function start({ req, res, ip }) {
  const headers = cors(req, 'POST, OPTIONS');
  requireLive(headers);
  const identity = await verifyKey(bearer(req));
  const body = await readJson(req, 16 * 1024);
  const name = String(body.name ?? '').trim();
  const uniformId = body.uniform_id;
  if (!name) return send(res, 400, { success: false, message: 'name is required' }, headers);
  if (typeof uniformId !== 'string' || !UNIFORM_ID.test(uniformId)) {
    return send(res, 400, { success: false, message: 'uniform_id field did not pass validation' }, headers);
  }
  const { log, token } = startLive({
    name, uniformId, ip,
    ownerHash: identity.hash,
    botId: identity.botId || body.bot_id,
    groupId: body.group_id,
  });
  send(res, 200, {
    key: log.key, password: log.password, url: shareUrl(log), token, last_seq: 0,
  }, headers);
}

// 续写：复制一份已有日志的内容，另开一份新的实时日志接着写。原日志不动。
// 能读到那份日志（知道它的 Key 与密码）的骰娘才能以它为起点。
async function fork({ req, res, ip }, key) {
  const headers = cors(req, 'POST, OPTIONS');
  requireLive(headers);
  try {
    const identity = await verifyKey(bearer(req));
    const body = await readJson(req, 16 * 1024);
    if (forkFailLimiter.count(ip) >= FORK_FAIL_LIMIT) {
      throw new HttpError(429, { success: false, message: 'Too many failed attempts, please try again later' });
    }
    const source = getLog(key);
    if (!source || source.password !== String(body.password ?? '')) {
      forkFailLimiter.hit(ip, 0);
      throw new HttpError(404, { success: false, message: 'Log not found or wrong password' });
    }
    const uniformId = body.uniform_id;
    if (uniformId !== undefined && (typeof uniformId !== 'string' || !UNIFORM_ID.test(uniformId))) {
      throw new HttpError(400, { success: false, message: 'uniform_id field did not pass validation' });
    }
    const { log, token } = await forkLive(source, {
      name: String(body.name ?? '').trim(),
      uniformId,
      botId: identity.botId || body.bot_id,
      groupId: body.group_id,
      ownerHash: identity.hash,
      ip,
    });
    send(res, 200, {
      key: log.key, password: log.password, url: shareUrl(log), token,
      last_seq: log.last_seq, name: log.name, forked_from: source.key,
    }, headers);
  } catch (err) {
    if (err instanceof HttpError) err.headers = { ...headers, ...err.headers };
    throw err;
  }
}

// 会话令牌只对它开启的那份日志有效。
function ownedLog(req, key, headers) {
  const log = getLog(key);
  if (!log) throw new HttpError(404, { success: false, message: 'Log not found' }, headers);
  if (log.status !== 'live') {
    throw new HttpError(409, { success: false, message: 'Log is already finished', url: shareUrl(log) }, headers);
  }
  const given = Buffer.from(sha256(bearer(req) || '-'));
  const expected = Buffer.from(log.token_hash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(401, { success: false, message: 'Invalid session token' }, headers);
  }
  return log;
}

async function append({ req, res }, key) {
  const headers = cors(req, 'POST, OPTIONS');
  requireLive(headers);
  const body = await readJson(req, MAX_APPEND_BYTES);
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH) {
    return send(res, 400, { success: false, message: `events must be an array of 1-${MAX_BATCH} items` }, headers);
  }
  try {
    const lastSeq = appendLive(ownedLog(req, key, headers), events);
    send(res, 200, { success: true, last_seq: lastSeq }, headers);
  } catch (err) {
    if (err instanceof HttpError) err.headers = { ...headers, ...err.headers };
    throw err;
  }
}

async function end({ req, res }, key) {
  const headers = cors(req, 'POST, OPTIONS');
  ownedLog(req, key, headers);
  const { log, deleted } = finalizeLive(key);
  if (deleted) return send(res, 200, { success: true, deleted: true, url: null }, headers);
  send(res, 200, { success: true, deleted: false, url: shareUrl(log) }, headers);
}

function readableLog(req, url, key, headers) {
  const log = getLog(key);
  if (!log || log.password !== url.searchParams.get('password')) {
    throw new HttpError(404, { error: 'Data not found' }, headers);
  }
  return log;
}

function afterSeq(req, url) {
  const raw = url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '0';
  const value = parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function events({ req, res, url }, key) {
  const headers = { ...cors(req, 'GET, OPTIONS'), 'Cache-Control': 'no-store' };
  const log = readableLog(req, url, key, headers);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 1), 1000);
  const list = log.status === 'live' ? listEvents(key, afterSeq(req, url), limit) : [];
  send(res, 200, { status: log.status, last_seq: log.last_seq, events: list }, headers);
}

function stream({ req, res, url }, key) {
  const headers = cors(req, 'GET, OPTIONS');
  const log = readableLog(req, url, key, headers);
  res.writeHead(200, {
    ...headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  if (log.status !== 'live') return writeEnd(res, { status: log.status, last_seq: log.last_seq });
  if (!subscribe(key, res)) return writeEnd(res, { status: 'busy' });
  // 订阅与补发在同一个同步段里完成，中间不会漏掉新消息。
  let after = afterSeq(req, url);
  for (;;) {
    const batch = listEvents(key, after, 1000);
    if (batch.length === 0) break;
    writeEvents(res, batch);
    after = batch[batch.length - 1].seq;
  }
}

// 骰娘查询自己名下的日志：用这把金钥上传的，以及骰娘号与账号站登记一致的。
async function logs({ req, res, url }) {
  const headers = { ...cors(req, 'GET, OPTIONS'), 'Cache-Control': 'no-store' };
  if (!liveAuthConfigured()) {
    throw new HttpError(503, { success: false, message: 'Key verification is not configured on this site' }, headers);
  }
  let identity;
  try {
    identity = await verifyKey(bearer(req));
  } catch (err) {
    if (err instanceof HttpError) err.headers = { ...headers, ...err.headers };
    throw err;
  }
  const params = url.searchParams;
  const found = searchLogs({
    owner: { hash: identity.hash, botId: identity.botId },
    group: params.get('group_id'),
    participant: params.get('participant'),
    status: params.get('status'),
    q: params.get('q'),
  }, { page: params.get('page'), pageSize: params.get('page_size') || 20, sort: params.get('sort') });
  send(res, 200, {
    total: found.total,
    page: found.page,
    page_size: found.pageSize,
    items: found.rows.map((log) => ({
      key: log.key,
      password: log.password,
      url: shareUrl(log),
      name: log.name,
      status: log.status,
      bot_id: log.bot_id,
      group_id: log.group_id,
      item_count: log.item_count,
      size: log.size,
      created_at: log.created_at,
      updated_at: log.updated_at,
      participants: participantsOf(log.key),
    })),
  }, headers);
}

export function matchLive({ path, method }) {
  if (path === '/api/v2/info' && method === 'GET') return info;
  if (path === '/api/v2/logs' && method === 'GET') return logs;
  if (path === '/api/v2/live/start' && method === 'POST') return start;
  const match = LIVE_PATH.exec(path);
  if (!match) return null;
  const [, key, action] = match;
  if (action === 'fork' && method === 'POST') return (ctx) => fork(ctx, key);
  if (action === 'append' && method === 'POST') return (ctx) => append(ctx, key);
  if (action === 'end' && method === 'POST') return (ctx) => end(ctx, key);
  if (action === 'events' && method === 'GET') return (ctx) => events(ctx, key);
  if (action === 'stream' && method === 'GET') return (ctx) => stream(ctx, key);
  return null;
}
