// 把旧站（story-painter-eobackend）的日志按原索引迁到本站，保留原来的 key、密码与创建时间。
// 索引有两种来源：
//   · 直接给索引内容——旧站 KV 里键 0Aindex 的值（在 EdgeOne Pages 控制台里可以看到）；
//   · 旧站部署了导出接口 GET /api/dice/export-index（头 X-Export-Token）时，凭令牌去取。
// 旧站的 load_data 读不到索引本身，所以必须由这两种方式之一提供。
// 增量：本站已有的日志直接跳过、不再向旧站读取，所以可以随时停止、反复执行。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.mjs';
import { getRaw, putRaw, nowIso } from './db.mjs';
import { getLog, importLog } from './store.mjs';
import { kickMover } from './storage.mjs';

const CONCURRENCY = 4;
const RETRIES = 4;
const MAX_PROBLEMS = 100;

// 贴进来的索引存成文件，再次执行（增量）时不用重贴。
const INDEX_FILE = resolve(config.dataDir, 'import-index.json');

function parseIndex(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('索引内容不是有效的 JSON。');
  }
  const logs = Array.isArray(parsed) ? parsed : parsed && parsed.logs;
  if (!Array.isArray(logs) || !logs.every((entry) => entry && typeof entry.key === 'string' && entry.key.includes('#'))) {
    throw new Error('索引内容的格式不对：应为键 0Aindex 的完整值，其中 logs 是日志条目的数组。');
  }
  return logs;
}

function savedIndex() {
  if (!existsSync(INDEX_FILE)) return null;
  try {
    return parseIndex(readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function emptyState() {
  return {
    running: false, stopping: false, base_url: '', started_at: '', finished_at: '', error: '',
    total: 0, done: 0, created: 0, exists: 0, missing: 0, conflict: 0, failed: 0, problems: [],
  };
}

// 上一次的结果存进数据库，重启后后台仍能看到。
function loadLast() {
  try {
    return { ...emptyState(), ...JSON.parse(getRaw('import.last') || '{}'), running: false, stopping: false };
  } catch {
    return emptyState();
  }
}

let state = null;

function current() {
  if (!state) state = loadLast();
  return state;
}

export function importStatus() {
  const s = current();
  return {
    ...s,
    problems: s.problems.slice(0, MAX_PROBLEMS),
    base_url: s.base_url || getRaw('import.base') || '',
    token_set: Boolean(getRaw('import.token')),
    saved_index: (savedIndex() || []).length,
  };
}

async function fetchJson(url, headers = {}) {
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (response.status === 404) return { status: 404 };
      if (response.status === 401 || response.status === 403) return { status: response.status };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { status: 200, body: await response.json() };
    } catch (err) {
      lastError = err;
      await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function problem(s, text) {
  if (s.problems.length < MAX_PROBLEMS) s.problems.push(text);
}

async function importOne(s, base, entry) {
  const [key, password] = String(entry.key || '').split('#');
  if (!key || !password) throw new Error('索引条目格式不对');
  const existing = getLog(key);
  if (existing) {
    if (existing.password === password) {
      s.exists += 1;
    } else {
      s.conflict += 1;
      problem(s, `${key}：本站已有同名但密码不同的日志，未迁移`);
    }
    return;
  }
  const url = `${base}/api/dice/load_data?key=${encodeURIComponent(key)}&password=${encodeURIComponent(password)}`;
  // 带上转发标记：万一旧站地址其实指向本站，不会再转一圈。
  const loaded = await fetchJson(url, { 'X-DNLog-Forwarded': '1' });
  if (loaded.status !== 200) {
    s.missing += 1;
    return;
  }
  const record = loaded.body;
  const data = Buffer.from(String(record.data || ''), 'base64');
  if (data.length === 0) throw new Error('日志内容为空');
  const result = importLog({
    key,
    password,
    name: record.name,
    client: record.client || 'SealDice',
    note: record.note,
    // 创建时间以索引为准（旧站按它计算到期），内容里的作为后备。
    createdAt: new Date(entry.created_at || record.created_at).toISOString(),
    updatedAt: record.updated_at ? new Date(record.updated_at).toISOString() : '',
    data,
  });
  s[result] += 1;
}

// 执行一轮迁移，结束后返回状态。move 为 true 时边迁边触发搬运（只应在服务进程里开）。
async function run(base, { token, entries: given }, { move, onProgress }) {
  const s = current();
  try {
    let entries = given;
    if (!entries) {
      const index = await fetchJson(`${base}/api/dice/export-index`, { 'X-Export-Token': token });
      if (index.status !== 200 || !Array.isArray(index.body.logs)) {
        throw new Error(index.status === 404
          ? '旧站没有索引导出接口。请改为贴入索引内容，或先在旧站部署该接口。'
          : index.status === 200 ? '旧站返回的索引格式不对。' : '导出令牌不正确。');
      }
      entries = index.body.logs;
    }
    s.total = entries.length;
    let next = 0;

    const worker = async () => {
      while (next < entries.length && !s.stopping) {
        const entry = entries[next++];
        try {
          await importOne(s, base, entry);
        } catch (err) {
          s.failed += 1;
          problem(s, `${entry.key}：${err.message}`);
        }
        s.done += 1;
        if (move && s.created > 0 && s.done % 20 === 0) kickMover();
        if (onProgress && (s.done % 50 === 0 || s.done === entries.length)) onProgress(s);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (err) {
    s.error = err.message;
  }
  s.running = false;
  s.stopping = false;
  s.finished_at = nowIso();
  putRaw('import.last', JSON.stringify(s));
  if (move) kickMover();
  return s;
}

// 索引来源的优先顺序：这次贴入的 → 上次贴入并保存的 → 凭令牌向旧站取。
function begin(baseUrl, token, indexText) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(base)) throw new Error('旧站地址须以 http:// 或 https:// 开头。');
  let entries = null;
  if (String(indexText || '').trim()) {
    entries = parseIndex(indexText);
    writeFileSync(INDEX_FILE, JSON.stringify({ logs: entries }));
  }
  const newToken = String(token || '').trim();
  if (newToken) putRaw('import.token', newToken);
  if (!entries && !newToken) entries = savedIndex();
  const useToken = newToken || getRaw('import.token') || '';
  if (!entries && !useToken) throw new Error('请贴入索引内容，或填写导出令牌。');
  putRaw('import.base', base);
  state = { ...emptyState(), running: true, base_url: base, started_at: nowIso() };
  return { base, source: { token: useToken, entries } };
}

// 后台启动：立刻返回，在服务进程里继续跑。
export function startImport(baseUrl, token, indexText) {
  if (current().running) throw new Error('迁移正在进行中。');
  const job = begin(baseUrl, token, indexText);
  run(job.base, job.source, { move: true }).catch((err) => console.error('[迁移] 出错：', err));
}

export function stopImport() {
  if (current().running) current().stopping = true;
}

// 指令行执行：等它跑完。
export async function importLegacy(baseUrl, token) {
  const job = begin(baseUrl, token, '');
  console.log(`读取旧站索引：${job.base}`);
  const s = await run(job.base, job.source, {
    move: false,
    onProgress: (now) => console.log(`  ${now.done} / ${now.total}`),
  });
  if (s.error) {
    console.error(s.error);
    return false;
  }
  console.log('');
  console.log(`新导入 ${s.created} 份；此前已导入 ${s.exists} 份；旧站已不存在 ${s.missing} 份；`
    + `冲突 ${s.conflict} 份；失败 ${s.failed} 份。`);
  for (const line of s.problems) console.log(`  ${line}`);
  if (s.failed) console.log('有失败的条目，重新执行本指令即可只补导这些。');
  return s.failed === 0;
}
