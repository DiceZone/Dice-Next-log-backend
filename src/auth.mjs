// 后台管理员账号、会话与首次设置码。cli.mjs 也会用到这里的函数。
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db, nowIso, getRaw, putRaw, transaction } from './db.mjs';

const SESSION_DAYS = 7;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// 用户名不存在时也跑一次同样耗时的比对，不让回应时间泄露用户名是否存在。
const DUMMY_HASH = hashPassword(randomBytes(8).toString('hex'));

export function hasAdmin() {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n > 0;
}

// 还没有管理员时需要一组设置码才能建立账号，设置码只出现在服务器上。
export function ensureSetupCode() {
  if (hasAdmin()) return null;
  let code = getRaw('setup_code');
  if (!code) {
    code = randomBytes(6).toString('hex');
    putRaw('setup_code', code);
  }
  return code;
}

export function createAdmin(username, password) {
  transaction(() => {
    db.prepare('INSERT INTO admins(username, pass_hash, created_at) VALUES(?, ?, ?)')
      .run(username, hashPassword(password), nowIso());
    putRaw('setup_code', null);
  });
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
}

// 清掉管理员与全部会话，回到「首次设置」状态，并返回新的设置码。
export function resetAdmin() {
  transaction(() => {
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM admins');
    putRaw('setup_code', null);
  });
  return ensureSetupCode();
}

export function checkLogin(username, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  const ok = verifyPassword(password, admin ? admin.pass_hash : DUMMY_HASH);
  return admin && ok ? admin : null;
}

export function changePassword(adminId, password, keepTokenHash) {
  transaction(() => {
    db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(hashPassword(password), adminId);
    db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash <> ?').run(adminId, keepTokenHash);
  });
}

export function createSession(adminId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash, admin_id, expires_at) VALUES(?, ?, ?)')
    .run(sha256(token), adminId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function findSession(token) {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = db.prepare(`
    SELECT s.token_hash, s.expires_at, a.id AS admin_id, a.username
    FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`).get(tokenHash);
  if (!row || row.expires_at < nowIso()) return null;
  return row;
}

export function dropSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}
