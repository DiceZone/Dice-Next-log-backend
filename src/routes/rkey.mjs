// QQ 图片 rkey 的公开接口：染色器拿去补到日志里的 QQ 图片链接上（见 src/rkey.mjs）。
import { send, cors } from '../http.mjs';
import { currentRkey } from '../rkey.mjs';

function rkey({ req, res }) {
  const headers = cors(req, 'GET, OPTIONS');
  const current = currentRkey();
  if (!current) {
    return send(res, 503, { success: false, message: 'rkey unavailable' }, { ...headers, 'Cache-Control': 'no-store' });
  }
  // rkey 约一小时过期，本站每 30 分钟换一次；CDN 缓存 5 分钟足够新
  return send(res, 200, current, { ...headers, 'Cache-Control': 'public, max-age=300' });
}

export function matchRkey({ path, method }) {
  if (path === '/api/v2/rkey' && method === 'GET') return rkey;
  return null;
}
