// 与旧站（story-painter-eobackend）完全兼容的接口：路径、参数、回应格式均不变。
//   PUT      /api/dice/log            海豹 / Dice!Next 一次性上传（multipart）
//   GET      /api/dice/load_data      染色器读取
//   PUT      /api/dice/backup-upload  其他站点转发过来的上传（JSON）
//   PUT/POST /api/dice/w4123          旧版 Dice! Lua 插件上传（纯文字或 JSON）
import { site } from '../site.mjs';
import { getSetting } from '../db.mjs';
import { HttpError, send, readForm, readJson, cors, bearer, RateLimiter } from '../http.mjs';
import { verifyKey } from '../bdc.mjs';
import { createLog, getLog, shareUrl, storagePayload } from '../store.mjs';
import { textLogToSealData } from '../w4123.mjs';

const UNIFORM_ID = /^[^:]+:[A-Za-z0-9_\-.]+$/;
const uploadLimiter = new RateLimiter(3600 * 1000);
const loadFailLimiter = new RateLimiter(10 * 60 * 1000);
const LOAD_FAIL_LIMIT = 30;

function maxBytes() {
  return getSetting('max_upload_mb') * 1024 * 1024;
}

function checkUploadRate(ip, headers) {
  if (!uploadLimiter.hit(ip, getSetting('upload_rate_per_hour'))) {
    throw new HttpError(429, { success: false, message: 'Too many uploads, please try again later' }, headers);
  }
}

// 上传时带了有效的骰娘金钥：日志记到这把金钥名下，骰娘号以账号站登记的为准。
// 没带或金钥无效都照常接收，旧客户端不受影响。
async function uploader(req) {
  const key = bearer(req);
  if (!key) return {};
  try {
    const identity = await verifyKey(key);
    return { ownerHash: identity.hash, botId: identity.botId };
  } catch {
    return {};
  }
}

function isFile(value) {
  return value !== null && typeof value === 'object' && typeof value.arrayBuffer === 'function';
}

function decodeBase64(text, headers) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(text)) {
    throw new HttpError(400, { success: false, message: 'logdata is not valid base64' }, headers);
  }
  const data = Buffer.from(text, 'base64');
  if (data.length === 0) throw new HttpError(400, { success: false, message: 'logdata is empty' }, headers);
  if (data.length > maxBytes()) throw new HttpError(413, { success: false, data: 'Size is too big!' }, headers);
  return data;
}

async function upload({ req, res, ip }) {
  const headers = cors(req, 'PUT, OPTIONS');
  checkUploadRate(ip, headers);
  const form = await readForm(req, maxBytes() + 64 * 1024);
  const name = form.get('name');
  const file = form.get('file');
  const uniformId = form.get('uniform_id');
  // 上传方声明的客户端类型：SealDice=zlib JSON / Parquet=parquet / DiceNext=zstd JSON。
  const client = form.get('client') || 'SealDice';

  if (typeof uniformId !== 'string' || !UNIFORM_ID.test(uniformId)) {
    return send(res, 400, { data: 'uniform_id field did not pass validation' }, headers);
  }
  if (!isFile(file)) return send(res, 400, { data: 'file field is required' }, headers);
  if (file.size > maxBytes()) return send(res, 413, { data: 'Size is too big!' }, headers);
  if (file.size === 0) return send(res, 400, { data: 'file is empty' }, headers);

  const data = Buffer.from(await file.arrayBuffer());
  const who = await uploader(req);
  const log = createLog({
    name, client, source: 'upload', uniformId, data, ip,
    ownerHash: who.ownerHash,
    // 可选字段：骰娘号与群号。
    botId: who.botId || form.get('bot_id'),
    groupId: form.get('group_id'),
  });
  send(res, 200, { url: shareUrl(log) }, headers);
}

async function loadData({ req, res, url, ip }) {
  const headers = cors(req, 'GET, OPTIONS');
  const key = url.searchParams.get('key');
  const password = url.searchParams.get('password');
  if (!key || !password) return send(res, 400, { error: 'Missing key or password' }, headers);
  if (loadFailLimiter.count(ip) >= LOAD_FAIL_LIMIT) {
    return send(res, 429, { error: 'Too many failed attempts, please try again later' }, headers);
  }

  const log = getLog(key);
  if (log && log.password === password) {
    let payload;
    try {
      payload = await storagePayload(log);
    } catch (err) {
      console.error(`[load_data] 读取 ${key}（${log.storage}）失败：${err.message}`);
      return send(res, 503, { error: 'Storage is temporarily unavailable, please try again later' }, headers);
    }
    return send(res, 200, payload, headers);
  }

  // 本站没有：转去旧站读取（迁移过渡期用）。
  // 带着转发标记进来的请求不再转发：旧站域名改指向本站之后，不会自己转给自己。
  if (site.legacyUpstream && !req.headers['x-dnlog-forwarded']) {
    try {
      const target = new URL('api/dice/load_data', site.legacyUpstream);
      target.searchParams.set('key', key);
      target.searchParams.set('password', password);
      const upstream = await fetch(target, { headers: { 'X-DNLog-Forwarded': '1' }, signal: AbortSignal.timeout(8000) });
      if (upstream.ok) {
        const body = Buffer.from(await upstream.arrayBuffer());
        return send(res, 200, body, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      }
    } catch (err) {
      console.warn(`[legacy] 旧站读取失败：${err.message}`);
    }
  }
  loadFailLimiter.hit(ip, 0);
  send(res, 404, { error: 'Data not found' }, headers);
}

async function backupUpload({ req, res, ip }) {
  checkUploadRate(ip, {});
  const body = await readJson(req, Math.ceil(maxBytes() * 1.4) + 64 * 1024);
  const { name, logdata, uniform_id: uniformId } = body;
  if (!uniformId || !name || !logdata) {
    return send(res, 400, { success: false, message: 'Missing required fields: uniform_id, name, or logdata' });
  }
  if (typeof uniformId !== 'string' || !UNIFORM_ID.test(uniformId)) {
    return send(res, 400, { data: 'uniform_id field did not pass validation' });
  }
  const data = decodeBase64(logdata, {});
  const log = createLog({ name, client: 'SealDice', note: 'Backup upload', source: 'backup', uniformId, data, ip });
  send(res, 200, { url: shareUrl(log) });
}

async function w4123({ req, res, ip }) {
  const headers = cors(req, 'PUT, POST, OPTIONS');
  checkUploadRate(ip, headers);
  let name;
  let uniformId;
  let data;

  if ((req.headers['content-type'] || '').includes('multipart/form-data')) {
    const form = await readForm(req, maxBytes() + 64 * 1024);
    name = form.get('name');
    uniformId = form.get('uniform_id');
    const file = form.get('file');
    if (!name || !uniformId || !isFile(file)) {
      return send(res, 400, { success: false, message: 'Missing required fields: name, uniform_id, or file' }, headers);
    }
    if (file.size > maxBytes()) {
      return send(res, 413, { success: false, message: `File size exceeds ${getSetting('max_upload_mb')}MB limit` }, headers);
    }
    const text = new TextDecoder('utf-8').decode(await file.arrayBuffer());
    data = textLogToSealData(text);
    if (!data) return send(res, 400, { success: false, message: '日志解析失败：没有找到有效的日志条目' }, headers);
  } else {
    const body = await readJson(req, Math.ceil(maxBytes() * 1.4) + 64 * 1024);
    name = body.name;
    uniformId = body.uniform_id;
    if (!uniformId || !name || !body.logdata) {
      return send(res, 400, { success: false, message: 'Missing required fields: uniform_id, name, or logdata' }, headers);
    }
    data = decodeBase64(body.logdata, headers);
  }

  if (typeof uniformId !== 'string' || !UNIFORM_ID.test(uniformId)) {
    return send(res, 400, { success: false, message: 'uniform_id field did not pass validation' }, headers);
  }
  const log = createLog({
    name, client: 'SealDice', note: 'Uploaded by w4123 plugin', source: 'w4123', uniformId, data, ip,
  });
  send(res, 200, { url: shareUrl(log) }, headers);
}

// 旧站用 endsWith 匹配路径（允许前面带反向代理的前缀），这里保持一致。
export function matchLegacy({ path, method }) {
  if (path.endsWith('/api/dice/log') && method === 'PUT') return upload;
  if (path.endsWith('/api/dice/load_data') && method === 'GET') return loadData;
  if (path.endsWith('/api/dice/backup-upload') && method === 'PUT') return backupUpload;
  if (path.endsWith('/api/dice/w4123') && (method === 'PUT' || method === 'POST')) return w4123;
  return null;
}
