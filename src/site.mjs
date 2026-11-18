// 可在后台即时修改的站点配置（存在数据库，改完立刻生效，不需要重启）。
// .env 里的同名变量只作为首次启动时的默认值。
import { config, baseUrl, originOf } from './config.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getRaw, putRaw, transaction } from './db.mjs';

function urlOrEmpty(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const normalized = baseUrl(text);
  return originOf(normalized) ? normalized : null;
}

// 每一项：环境变量给的默认值 + 把输入整理成存储格式（不合法时返回 null）。
const DEFS = {
  // 染色器地址：生成分享链接、决定 CORS 放行的来源。
  frontend_url: { def: config.frontendUrl, clean: (v) => urlOrEmpty(v) || null },
  // 除染色器外另外放行的来源，逗号分隔。
  cors_origins: {
    def: config.corsOrigins,
    clean: (v) => {
      const origins = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(originOf);
      return origins.every(Boolean) ? origins.join(',') : null;
    },
  },
  // 旧站地址：本站查不到的日志转去那里读取。
  legacy_upstream_url: { def: config.legacyUpstream, clean: urlOrEmpty },
  // BDC 账号站的骰娘密钥校验接口与凭据。
  bdc_verify_url: {
    def: config.bdcVerifyUrl,
    clean: (v) => {
      const text = String(v ?? '').trim();
      return !text || /^https?:\/\/\S+$/i.test(text) ? text : null;
    },
  },
  bdc_verify_token: { def: config.bdcVerifyToken, clean: (v) => String(v ?? '').trim().slice(0, 256), secret: true },
  // BDC 公寓站提供 QQ 图片 rkey 的接口，凭据与骰娘密钥校验共用；留空则不取 rkey（见 rkey.mjs）。
  bdc_rkey_url: {
    def: config.bdcRkeyUrl,
    clean: (v) => {
      const text = String(v ?? '').trim();
      return !text || /^https?:\/\/\S+$/i.test(text) ? text : null;
    },
  },
  // 回源校验：CDN 回源时带上这个请求头与密钥，没带的请求一律拒绝。
  // 源站的地址被人知道后，可以绕过 CDN 直接访问并伪造访客 IP；开了这项就挡住了。
  // 请求头名留空即关闭。
  origin_auth_header: {
    def: (process.env.ORIGIN_AUTH_HEADER || '').trim().toLowerCase(),
    clean: (v) => {
      const text = String(v ?? '').trim().toLowerCase();
      return /^[a-z0-9-]{0,64}$/.test(text) ? text : null;
    },
  },
  origin_auth_token: {
    def: (process.env.ORIGIN_AUTH_TOKEN || '').trim(),
    clean: (v) => {
      const text = String(v ?? '').trim();
      return text === '' || /^[\x21-\x7e]{16,256}$/.test(text) ? text : null;
    },
    secret: true,
  },
  // 反向代理 / CDN 后面取访客真实 IP 用的请求头；留空则用连接地址。
  trust_proxy_header: {
    def: config.trustProxyHeader,
    clean: (v) => {
      const text = String(v ?? '').trim().toLowerCase();
      return /^[a-z0-9-]{0,64}$/.test(text) ? text : null;
    },
  },
};

let cache = null;

function load() {
  if (cache) return cache;
  const values = {};
  for (const [key, def] of Object.entries(DEFS)) values[key] = getRaw(`site.${key}`) ?? def.def;
  cache = {
    values,
    corsOrigins: new Set([originOf(values.frontend_url), ...values.cors_origins.split(',')].filter(Boolean)),
  };
  return cache;
}

export const site = {
  get frontendUrl() { return load().values.frontend_url; },
  get corsOrigins() { return load().corsOrigins; },
  get legacyUpstream() { return load().values.legacy_upstream_url; },
  get bdcVerifyUrl() { return load().values.bdc_verify_url; },
  get bdcVerifyToken() { return load().values.bdc_verify_token; },
  get bdcRkeyUrl() { return load().values.bdc_rkey_url; },
  get trustProxyHeader() { return load().values.trust_proxy_header; },
  get originAuthHeader() { return load().values.origin_auth_header; },
  get originAuthToken() { return load().values.origin_auth_token; },
};

// 给后台看的值：凭据不回传，只说有没有设置。
export function siteValues() {
  const out = {};
  for (const [key, def] of Object.entries(DEFS)) {
    if (def.secret) out[`${key}_set`] = Boolean(load().values[key]);
    else out[key] = load().values[key];
  }
  return out;
}

// 这个请求是不是从 CDN 回源来的。没开回源校验时一律算是。
export function originAllowed(headers) {
  const name = site.originAuthHeader;
  const token = site.originAuthToken;
  if (!name || !token) return true;
  const given = headers[name];
  return typeof given === 'string' && timingSafeEqual(sha256(given), sha256(token));
}

function sha256(text) {
  return createHash('sha256').update(text).digest();
}

// 指令行用：关闭回源校验（配错把自己挡在外面时用）。
export function disableOriginAuth() {
  putRaw('site.origin_auth_header', '');
  cache = null;
}

// 只改 patch 里出现的项。返回出错的字段名；全部合法则写入并返回 null。
// headers 是发起修改的那个请求的请求头：开启回源校验时，这个请求自己必须已经带着相符的
// 请求头——也就是 CDN 那边已经配好——否则保存之后包括后台在内全部打不开。
export function updateSite(patch, headers) {
  const next = {};
  for (const [key, raw] of Object.entries(patch || {})) {
    const def = DEFS[key];
    if (!def) continue;
    const value = def.clean(raw);
    if (value === null) return key;
    next[key] = value;
  }
  const name = next.origin_auth_header ?? site.originAuthHeader;
  const token = next.origin_auth_token ?? site.originAuthToken;
  const touched = 'origin_auth_header' in next || 'origin_auth_token' in next;
  if (touched && name && !token) return 'origin_auth_token';
  if (touched && name && token && headers && headers[name] !== token) return 'origin_auth_unverified';
  transaction(() => {
    for (const [key, value] of Object.entries(next)) putRaw(`site.${key}`, value);
  });
  cache = null;
  return null;
}
