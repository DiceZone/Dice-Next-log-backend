// 运行环境配置：只放「部署时决定、运行中不变」的项目。
// 运行中可调的项目（保留期限、大小上限等）在数据库 settings 表，由后台管理修改。
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

export function baseUrl(value) {
  const raw = (value || '').trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, '') + '/';
}

export function originOf(value) {
  try {
    return new URL(baseUrl(value)).origin;
  } catch {
    return '';
  }
}

function list(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// STORAGES=名称=路径,名称=路径 —— 日志本体的最终存放位置（挂载好的目录，例如对象存储）。
// 名称会记在每份日志上，定下后不要改；local 是保留名，指数据目录里的本地缓存。
function storages(value) {
  const out = new Map();
  for (const entry of list(value)) {
    const at = entry.indexOf('=');
    const name = entry.slice(0, at).trim();
    const path = entry.slice(at + 1).trim();
    if (at < 1 || !/^[a-z0-9_-]{1,32}$/.test(name) || name === 'local' || !path) {
      console.error(`STORAGES 中的「${entry}」格式不正确，应为 名称=路径（名称限小写字母、数字、下划线、短横线）。`);
      process.exit(1);
    }
    out.set(name, resolve(path));
  }
  return out;
}

// 版本号是建置日期（如 20261115）。建置镜像时写进 VERSION 文件；
// 直接从源码运行时没有这个文件，取源码里最新的修改日期。
function buildVersion() {
  const file = resolve(ROOT, 'VERSION');
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim();
    if (text) return text;
  }
  let newest = 0;
  for (const dir of ['.', 'src', 'src/routes', 'public']) {
    for (const name of readdirSync(resolve(ROOT, dir))) {
      if (!/\.(mjs|js|css|html)$/.test(name)) continue;
      newest = Math.max(newest, statSync(resolve(ROOT, dir, name)).mtimeMs);
    }
  }
  // 按北京时间取日期。
  return new Date(newest + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

const frontendUrl = baseUrl(env.FRONTEND_URL);
const dataDir = resolve(ROOT, env.DATA_DIR || './data');

export const config = {
  version: buildVersion(),
  port: parseInt(env.PORT || '8787', 10),
  host: env.HOST || '0.0.0.0',
  dataDir,
  // 以下六项是首次启动时的默认值，之后以后台「设置 → 站点配置」为准（见 site.mjs）。
  frontendUrl,
  corsOrigins: list(env.CORS_ORIGINS).map(originOf).filter(Boolean).join(','),
  legacyUpstream: baseUrl(env.LEGACY_UPSTREAM_URL),
  bdcVerifyUrl: (env.BDC_VERIFY_URL || '').trim(),
  bdcVerifyToken: (env.BDC_VERIFY_TOKEN || '').trim(),
  // 自建站不接 BDC 时，可在此直接列出允许串流的金钥。
  liveStaticKeys: list(env.LIVE_STATIC_KEYS),
  trustProxyHeader: (env.TRUST_PROXY_HEADER || '').trim().toLowerCase(),
  // 后台 Cookie 是否强制 Secure：auto 表示按 x-forwarded-proto 判断。
  cookieSecure: (env.COOKIE_SECURE || 'auto').trim().toLowerCase(),
  defaultRetentionDays: parseInt(env.LOG_RETENTION_DAYS || '365', 10) || 365,
  storages: storages(env.STORAGES),
  // 首次启动时的默认写入位置（之后以后台设置为准）。
  storageTarget: (env.STORAGE_TARGET || 'local').trim(),
};

export function ensureDataDir() {
  mkdirSync(resolve(dataDir, 'blobs'), { recursive: true });
}
