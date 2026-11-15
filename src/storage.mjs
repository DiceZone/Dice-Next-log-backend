// 日志本体的存放位置。
// local：数据目录里的本地缓存，上传一律先写到这里，立刻可读。
// 其他位置：.env 的 STORAGES 里列出的目录（例如挂载好的对象存储），由后台搬运程序把日志从缓存搬过去。
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm, stat, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { config } from './config.mjs';
import { db, getRaw, putRaw, nowIso } from './db.mjs';

export const LOCAL = 'local';
// 位置初始化时写入的标记文件。挂载掉了的时候目录还在、标记不在，据此判断位置离线，
// 避免把日志写进挂载点下面的本地磁盘。
const MARKER = '.dnlog-storage';

const roots = new Map([[LOCAL, resolve(config.dataDir, 'blobs')], ...config.storages]);

export function storageNames() {
  return [...roots.keys()];
}

export function hasStorage(name) {
  return roots.has(name);
}

export function storagePath(name) {
  return roots.get(name);
}

// 文件名用 key 的十六进制：Windows / macOS 的文件系统不分大小写，直接用 key 会撞名。
function blobFile(name, key) {
  const hex = Buffer.from(key).toString('hex');
  return resolve(roots.get(name), hex.slice(0, 2), `${hex}.bin`);
}

// ─── 位置的状态 ─────────────────────────────────────────────

function jsonSetting(key) {
  try {
    const value = JSON.parse(getRaw(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function initialized() {
  return new Set([LOCAL, ...jsonSetting('storage_inited').filter(hasStorage)]);
}

export function draining() {
  return new Set(jsonSetting('storage_draining').filter(hasStorage));
}

export function setDraining(name, enabled) {
  const set = draining();
  if (enabled) set.add(name); else set.delete(name);
  putRaw('storage_draining', JSON.stringify([...set]));
}

export async function isOnline(name) {
  if (name === LOCAL) return true;
  if (!roots.has(name)) return false;
  try {
    await access(resolve(roots.get(name), MARKER));
    return true;
  } catch {
    return false;
  }
}

export async function initStorage(name) {
  const root = roots.get(name);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, MARKER), `Dice!Next Log Service storage "${name}", initialized ${nowIso()}\n`);
  putRaw('storage_inited', JSON.stringify([...new Set([...jsonSetting('storage_inited'), name])]));
}

// 当前写入位置：搬运程序把缓存里的日志搬到这里。
export function getTarget() {
  const name = getRaw('storage_target') ?? config.storageTarget;
  return roots.has(name) && initialized().has(name) ? name : LOCAL;
}

export function setTarget(name) {
  putRaw('storage_target', name);
  setDraining(name, false);
}

// ─── 读写 ───────────────────────────────────────────────────

// 上传时同步写入本地缓存（先写临时文件再改名，不会留下半份文件）。
export function writeLocal(key, data) {
  const path = blobFile(LOCAL, key);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function removeLocal(key) {
  rmSync(blobFile(LOCAL, key), { force: true });
}

export function readBlob(name, key) {
  if (!roots.has(name)) throw new Error(`存储位置「${name}」不在 STORAGES 配置中`);
  return readFile(blobFile(name, key));
}

// 搬运用。对象存储上改名等于整份重传，所以直接写到最终文件名，写完核对大小；
// 数据库在核对通过后才改指向，半份文件不会被读到。
async function writeBlob(name, key, data) {
  if (name === LOCAL) return writeLocal(key, data);
  const path = blobFile(name, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  const info = await stat(path);
  if (info.size !== data.length) throw new Error(`写入后大小不符（${info.size} / ${data.length}）`);
  return undefined;
}

async function removeBlob(name, key) {
  await rm(blobFile(name, key), { force: true });
}

// ─── 搬运程序 ───────────────────────────────────────────────

const moveState = { running: false, again: false, lastError: '', lastErrorAt: '', lastRunAt: '' };

export function moverStatus() {
  const target = getTarget();
  const sources = [LOCAL, ...draining()].filter((name) => name !== target);
  const marks = sources.map(() => '?').join(',');
  const pending = sources.length
    ? db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE status = 'done' AND storage IN (${marks})`).get(...sources).n
    : 0;
  return {
    pending,
    pending_deletes: db.prepare('SELECT COUNT(*) AS n FROM blob_deletes').get().n,
    running: moveState.running,
    last_error: moveState.lastError,
    last_error_at: moveState.lastErrorAt,
    last_run_at: moveState.lastRunAt,
  };
}

function fail(message) {
  moveState.lastError = message;
  moveState.lastErrorAt = nowIso();
  console.warn(`[搬运] ${message}`);
}

// 删除日志时，不在本地的文件登记到 blob_deletes，由这里实际删除；位置离线时留待下次。
export function queueDelete(name, key) {
  db.prepare('INSERT OR IGNORE INTO blob_deletes(storage, key) VALUES(?, ?)').run(name, key);
}

async function flushDeletes() {
  const online = new Map();
  for (const row of db.prepare('SELECT storage, key FROM blob_deletes LIMIT 1000').all()) {
    if (!roots.has(row.storage)) continue;
    if (!online.has(row.storage)) online.set(row.storage, await isOnline(row.storage));
    if (!online.get(row.storage)) continue;
    try {
      await removeBlob(row.storage, row.key);
      db.prepare('DELETE FROM blob_deletes WHERE storage = ? AND key = ?').run(row.storage, row.key);
    } catch (err) {
      fail(`删除 ${row.storage} 上的 ${row.key} 失败：${err.message}`);
      online.set(row.storage, false);
    }
  }
}

async function moveOne(log, target) {
  const data = await readBlob(log.storage, log.key);
  await writeBlob(target, log.key, data);
  // 搬的过程中日志可能已被删除或被别处改动：只有仍在原位置时才改指向。
  const changed = db
    .prepare('UPDATE logs SET storage = ? WHERE key = ? AND storage = ? AND status = ?')
    .run(target, log.key, log.storage, 'done').changes;
  if (changed === 0) {
    // 没改成：日志已被删除，或已经在目标位置（那份不能删）。只有前一种才清掉刚写的文件。
    const row = db.prepare('SELECT storage FROM logs WHERE key = ?').get(log.key);
    if (!row) {
      if (target === LOCAL) removeLocal(log.key); else queueDelete(target, log.key);
    }
    return;
  }
  if (log.storage === LOCAL) removeLocal(log.key); else queueDelete(log.storage, log.key);
}

async function pass() {
  moveState.lastRunAt = nowIso();
  await flushDeletes();

  const target = getTarget();
  if (!(await isOnline(target))) return fail(`写入位置「${target}」当前不可用，日志暂留在原处。`);

  for (const source of [LOCAL, ...draining()]) {
    if (source === target) continue;
    if (!(await isOnline(source))) {
      fail(`存储位置「${source}」当前不可用，暂不迁出。`);
      continue;
    }
    for (;;) {
      const batch = db
        .prepare("SELECT key, storage FROM logs WHERE status = 'done' AND storage = ? ORDER BY created_at LIMIT 100")
        .all(source);
      if (batch.length === 0) {
        if (source !== LOCAL) setDraining(source, false);
        break;
      }
      for (const log of batch) {
        try {
          await moveOne(log, target);
        } catch (err) {
          // 多半是位置掉线：这一轮到此为止，等下次再试。
          return fail(`搬运 ${log.key}（${source} → ${target}）失败：${err.message}`);
        }
      }
    }
  }
  await flushDeletes();
  moveState.lastError = '';
  return undefined;
}

// 触发一轮搬运。正在进行时只记一笔，结束后再跑一轮。
export function kickMover() {
  if (moveState.running) {
    moveState.again = true;
    return;
  }
  moveState.running = true;
  (async () => {
    try {
      do {
        moveState.again = false;
        await pass();
      } while (moveState.again);
    } catch (err) {
      fail(`搬运程序出错：${err.message}`);
    } finally {
      moveState.running = false;
    }
  })();
}
