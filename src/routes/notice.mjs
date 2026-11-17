// 站点公告的公开接口：染色器读取后显示在页面上。
import { send, cors } from '../http.mjs';
import { publicNotice } from '../notice.mjs';

function notice({ req, res }) {
  send(res, 200, publicNotice(), {
    ...cors(req, 'GET, OPTIONS'),
    // 经过 CDN 时允许缓存一分钟；后台改完，最迟一分钟后所有访客都能看到。
    'Cache-Control': 'public, max-age=60',
  });
}

export function matchNotice({ path, method }) {
  if (path === '/api/v2/notice' && method === 'GET') return notice;
  return null;
}
