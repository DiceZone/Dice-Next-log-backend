// HTTP 小工具：回应、读请求体（带上限）、CORS、来源 IP、限频。
import { site } from './site.mjs';

export class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(typeof body === 'string' ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  let buf;
  let type;
  if (body === null || body === undefined) {
    buf = Buffer.alloc(0);
  } else if (Buffer.isBuffer(body)) {
    buf = body;
  } else if (typeof body === 'string') {
    buf = Buffer.from(body);
    type = 'text/plain; charset=utf-8';
  } else {
    buf = Buffer.from(JSON.stringify(body));
    type = 'application/json; charset=utf-8';
  }
  res.writeHead(status, {
    ...(type ? { 'Content-Type': type } : {}),
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

function tooLarge(limit) {
  const mb = Math.floor(limit / 1024 / 1024);
  return new HttpError(
    413,
    { success: false, message: `File size exceeds ${mb}MB limit`, data: 'Size is too big!' },
    { Connection: 'close' },
  );
}

export async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw tooLarge(limit);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw tooLarge(limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  try {
    const value = JSON.parse(buf.toString('utf8') || '{}');
    if (value === null || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, { success: false, message: 'Invalid JSON body' });
  }
}

export async function readForm(req, limit) {
  const buf = await readBody(req, limit);
  try {
    return await new Request('http://local/', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] || '' },
      body: buf,
    }).formData();
  } catch {
    throw new HttpError(400, { success: false, message: 'Invalid multipart body' });
  }
}

// 只放行染色器等已登记的来源；其他来源一律回主染色器地址（浏览器会自行拦下）。
export function cors(req, methods = 'GET, PUT, POST, OPTIONS') {
  const requested = req.headers.origin;
  const allow = requested && site.corsOrigins.has(requested)
    ? requested
    : site.frontendUrl.replace(/\/$/, '');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Accept-Version, Authorization, Last-Event-ID',
    Vary: 'Origin',
  };
}

export function clientIp(req) {
  if (site.trustProxyHeader) {
    const value = req.headers[site.trustProxyHeader];
    if (typeof value === 'string' && value) return value.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

export function bearer(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  return match ? match[1] : '';
}

// 滑动窗口限频（进程内存）。hit() 返回 false 表示已超限。
export class RateLimiter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.hits = new Map();
    setInterval(() => this.prune(), 5 * 60 * 1000).unref();
  }

  recent(key) {
    const cutoff = Date.now() - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    this.hits.set(key, list);
    return list;
  }

  count(key) {
    return this.recent(key).length;
  }

  hit(key, limit) {
    const list = this.recent(key);
    if (limit > 0 && list.length >= limit) return false;
    list.push(Date.now());
    return true;
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, list] of this.hits) {
      if (!list.some((t) => t > cutoff)) this.hits.delete(key);
    }
  }
}
