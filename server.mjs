// Dice!Next Log Service —— 入口。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, ROOT } from './src/config.mjs';
import { site, originAllowed } from './src/site.mjs';
import { HttpError, send, cors, clientIp } from './src/http.mjs';
import { ensureSetupCode, pruneSessions } from './src/auth.mjs';
import { cleanupExpired, finalizeIdle, backfillIds } from './src/store.mjs';
import { kickMover, getTarget, storageNames } from './src/storage.mjs';
import { findBan, recordResponse } from './src/bans.mjs';
import { matchLegacy } from './src/routes/legacy.mjs';
import { matchLive } from './src/routes/live.mjs';
import { matchAdmin } from './src/routes/admin.mjs';


// ─── 静态页面 ───────────────────────────────────────────────

const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  'Referrer-Policy': 'same-origin',
};

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/site.css': ['site.css', 'text/css; charset=utf-8'],
  '/index.js': ['index.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/favicon.ico': ['logo.svg', 'image/svg+xml'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin/': ['admin.html', 'text/html; charset=utf-8'],
  '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8'],
  '/admin/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
};

function serveStatic(res, path) {
  const entry = STATIC[path];
  if (!entry) return false;
  const [file, type] = entry;
  send(res, 200, readFileSync(resolve(ROOT, 'public', file)), {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    // 只给页面加：加在 SVG 上会让图内的样式被拦下。
    ...(type.startsWith('text/html') ? PAGE_HEADERS : {}),
  });
  return true;
}

// ─── 路由 ───────────────────────────────────────────────────

async function route(ctx) {
  const { req, res, path, method } = ctx;

  if (path.startsWith('/admin/api/')) {
    const handler = matchAdmin(ctx);
    if (!handler) return send(res, 404, { success: false, message: '接口不存在。' });
    return handler(ctx);
  }

  if (method === 'OPTIONS') return send(res, 204, null, cors(req));

  const handler = matchLive(ctx) || matchLegacy(ctx);
  if (handler) return handler(ctx);

  if ((method === 'GET' || method === 'HEAD') && serveStatic(res, path)) return undefined;
  return send(res, 404, '访问的API接口不存在或方式错误，检查API设置是否正确');
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://local');
  } catch {
    return send(res, 400, 'Bad Request');
  }
  // 开了回源校验时，不是从 CDN 回源来的请求直接拒绝；它自带的访客 IP 也不可信，不往下走。
  if (!originAllowed(req.headers)) {
    return send(res, 403, 'Forbidden', { Connection: 'close' });
  }
  const ctx = { req, res, url, path: url.pathname, method: req.method, ip: clientIp(req) };
  // 被封锁的 IP 一律拒绝；其余请求结束后按状态码记一笔，供自动封锁判断。
  if (findBan(ctx.ip)) {
    return send(res, 403, { success: false, error: 'IP_BANNED', message: 'Your IP address has been blocked.' }, { Connection: 'close' });
  }
  res.on('finish', () => recordResponse(ctx.ip, res.statusCode));
  try {
    await route(ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, err.body, err.headers);
    } else {
      console.error(`[error] ${req.method} ${url.pathname}:`, err);
      send(res, 500, { success: false, message: 'Internal Server Error' });
    }
    if (!res.writableEnded) res.end();
  }
});

// ─── 定时维护 ───────────────────────────────────────────────

// 每 5 分钟：补跑搬运（位置恢复后接着搬）。
// 每小时：完结闲置的实时日志、清掉过期的登录状态。
// 每天：删除超过保留期限的日志。
const HOUR = 3600 * 1000;
let lastHourly = 0;
let lastDaily = 0;

function maintain() {
  try {
    const now = Date.now();
    if (now - lastHourly >= HOUR) {
      lastHourly = now;
      const finished = finalizeIdle();
      pruneSessions();
      if (finished) console.log(`[维护] 自动完结 ${finished} 份闲置的实时日志`);
    }
    if (now - lastDaily >= 24 * HOUR) {
      lastDaily = now;
      const deleted = cleanupExpired();
      if (deleted) console.log(`[维护] 删除 ${deleted} 份过期日志`);
    }
    kickMover();
  } catch (err) {
    console.error('[维护] 失败：', err);
  }
}

server.listen(config.port, config.host, () => {
  console.log(`Dice!Next Log Service v${config.version} 已启动：http://${config.host}:${config.port}`);
  console.log(`  染色器地址：${site.frontendUrl || '未配置（请在后台「设置 → 站点配置」填写）'}`);
  console.log(`  数据目录：  ${config.dataDir}`);
  console.log(`  存储位置：  ${storageNames().join('、')}（当前写入 ${getTarget()}）`);
  const code = ensureSetupCode();
  if (code) {
    console.log('  尚未建立管理员账号。请打开 /admin 完成首次设置，设置码：');
    console.log(`      ${code}`);
  }
  maintain();
  setInterval(maintain, 5 * 60 * 1000).unref();
  backfillIds().catch((err) => console.error('[补齐] 失败：', err));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
