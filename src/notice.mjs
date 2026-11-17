// 站点公告：在后台编辑，染色器页面上显示。内容是 Markdown，由染色器渲染，本站只存原文。
import { getRaw, putRaw, nowIso } from './db.mjs';

const KEY = 'notice';
export const NOTICE_LIMITS = { title: 100, content: 20000 };

const EMPTY = { enabled: false, title: '', content: '', updated_at: null };

export function getNotice() {
  try {
    const saved = JSON.parse(getRaw(KEY) || 'null');
    return saved && typeof saved === 'object' ? { ...EMPTY, ...saved } : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

// 只改 patch 里出现的项。返回出错的字段名；全部合法则写入并返回 null。
// 标题或内容有变动时才更新 updated_at：染色器据此判断访客有没有看过这一版。
export function updateNotice(patch) {
  const current = getNotice();
  const next = { ...current };
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') return 'enabled';
    next.enabled = patch.enabled;
  }
  if ('title' in patch) {
    const title = String(patch.title ?? '').trim();
    if (title.length > NOTICE_LIMITS.title) return 'title';
    next.title = title;
  }
  if ('content' in patch) {
    const content = String(patch.content ?? '').replace(/\r\n?/g, '\n').trim();
    if (content.length > NOTICE_LIMITS.content) return 'content';
    next.content = content;
  }
  if (next.enabled && !next.content) return 'content';
  if (next.title !== current.title || next.content !== current.content) next.updated_at = nowIso();
  putRaw(KEY, JSON.stringify(next));
  return null;
}

// 给染色器的：没开启或没有内容时只回答「没有」。
export function publicNotice() {
  const notice = getNotice();
  if (!notice.enabled || !notice.content) return { enabled: false };
  return { enabled: true, id: notice.updated_at, title: notice.title, content: notice.content, updated_at: notice.updated_at };
}
