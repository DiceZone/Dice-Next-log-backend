// 端到端测试：起一个真实的服务进程（临时数据目录）和一个假的 BDC / 旧站，把全部接口走一遍。
//   node test/e2e.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 18790;
const FAKE_PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}`;
const GOOD_KEY = 'bdc_diceflats_goodkey000000000000';
const dataDir = mkdtempSync(join(tmpdir(), 'dnlog-test-'));
const cosDir = mkdtempSync(join(tmpdir(), 'dnlog-cos-'));

let passed = 0;
function check(name, condition, detail) {
  if (!condition) {
    console.error(`✗ ${name}`, detail === undefined ? '' : detail);
    throw new Error(`检查未通过：${name}`);
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

// ─── 假的 BDC 账号站与旧站 ─────────────────────────────────
const goodHash = createHash('sha256').update(GOOD_KEY).digest('hex');
let oldSiteHits = 0;
const oldData = deflateSync(Buffer.from(JSON.stringify({
  version: 1,
  items: [
    { nickname: '旧站玩家', IMUserId: 'QQ:30003', GroupID: 'QQ-Group:321321', time: 1780000000, message: '旧站的一条消息', isDice: false },
    { nickname: '旧站骰娘', IMUserId: 'QQ:90009', GroupID: 'QQ-Group:321321', time: 1780000001, message: '掷骰结果', isDice: true },
  ],
})));
const fake = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/verify') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const ok = req.headers['x-log-service-token'] === 'svc-token';
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    const valid = ok && JSON.parse(body).key_sha256 === goodHash;
    return res.end(JSON.stringify(valid ? { valid, platform: 'onebot_v11', bot_id: '20002', bot_name: '骰娘' } : { valid }));
  }
  if (url.pathname === '/old/api/dice/load_data') {
    oldSiteHits += 1;
    if (url.searchParams.get('key') === 'OLD1' && url.searchParams.get('password') === '123456') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        client: 'SealDice', data: oldData.toString('base64'), name: '旧站日志', note: '旧备注',
        created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
      }));
    }
  }
  if (url.pathname === '/old/api/dice/export-index') {
    const ok = req.headers['x-export-token'] === 'export-token';
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ok ? {
      logs: [
        { key: 'OLD1#123456', created_at: '2026-10-02T03:04:05.000Z' },
        { key: 'GONE#654321', created_at: '2026-10-03T00:00:00.000Z' },
      ],
    } : {}));
  }
  res.writeHead(404);
  res.end('{}');
});
await new Promise((done) => fake.listen(FAKE_PORT, '127.0.0.1', done));

// ─── 被测服务 ──────────────────────────────────────────────
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  FRONTEND_URL: 'https://log.example.test',
  BDC_VERIFY_URL: `http://127.0.0.1:${FAKE_PORT}/verify`,
  BDC_VERIFY_TOKEN: 'svc-token',
  LEGACY_UPSTREAM_URL: `http://127.0.0.1:${FAKE_PORT}/old`,
  LOG_RETENTION_DAYS: '60',
  STORAGES: `cos=${cosDir}`,
};
const server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env });
let output = '';
server.stdout.on('data', (chunk) => { output += chunk; });
server.stderr.on('data', (chunk) => { output += chunk; });

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/v2/info`)).ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`服务没有启动：\n${output}`);
}

async function call(method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, json, text, headers: response.headers };
}

function sealData(items) {
  return deflateSync(Buffer.from(JSON.stringify({ version: 1, items })));
}

function parseShare(url) {
  const match = /^https:\/\/log\.example\.test\/\?key=([A-Za-z0-9]+)#(\d{6})$/.exec(url);
  return match ? { key: match[1], password: match[2] } : null;
}

async function loadItems(key, password) {
  const loaded = await call('GET', `/api/dice/load_data?key=${key}&password=${password}`);
  const items = JSON.parse(inflateSync(Buffer.from(loaded.json.data, 'base64')).toString('utf8')).items;
  return { loaded, items };
}

try {
  await waitReady();

  // ── 站点信息与页面 ──
  const info = await call('GET', '/api/v2/info');
  check('info 返回站点名与保留期限', info.json.name === 'Dice!Next Log Service' && info.json.retention_days === 60 && info.json.live === true);
  check('版本号是建置日期', /^20\d{6}$/.test(info.json.version), info.json.version);
  const home = await call('GET', '/');
  check('公开页显示新名称与 logo', home.text.includes('Dice!Next Log Service') && home.text.includes('/logo.svg') && !home.text.includes('SealDice'));
  check('logo 可访问', (await call('GET', '/logo.svg')).headers.get('content-type') === 'image/svg+xml');
  check('旧的 cleanup 接口已移除', (await call('GET', '/api/dice/cleanup')).status === 404);

  // ── 一次性上传（旧接口） ──
  const payload = sealData([{ nickname: '希亞', IMUserId: 'QQ:10001', time: 1780000000, message: '.r 1d100', isDice: false }]);
  const form = new FormData();
  form.set('name', '测试团');
  form.set('uniform_id', 'QQ:10001');
  form.set('client', 'DiceNext');
  form.set('file', new Blob([payload]), 'log.bin');
  const up = await call('PUT', '/api/dice/log', { raw: form });
  const share = parseShare(up.json && up.json.url);
  check('PUT /api/dice/log 返回分享链接', up.status === 200 && share, up.text);

  const loaded = await call('GET', `/api/dice/load_data?key=${share.key}&password=${share.password}`, { headers: { Origin: 'https://log.example.test' } });
  check('load_data 字段与旧站一致', loaded.status === 200
    && Object.keys(loaded.json).sort().join() === 'client,created_at,data,name,note,updated_at'
    && loaded.json.client === 'DiceNext' && loaded.json.name === '测试团');
  check('load_data 的数据与上传的字节一致', Buffer.from(loaded.json.data, 'base64').equals(payload));
  check('load_data 放行染色器来源', loaded.headers.get('access-control-allow-origin') === 'https://log.example.test');

  check('密码错误返回 404', (await call('GET', `/api/dice/load_data?key=${share.key}&password=000000`)).status === 404);
  check('缺参数返回 400', (await call('GET', '/api/dice/load_data?key=abcd')).status === 400);
  const old = await call('GET', '/api/dice/load_data?key=OLD1&password=123456');
  check('本站没有的日志转去旧站读取', old.status === 200 && old.json.name === '旧站日志');

  const badForm = new FormData();
  badForm.set('name', 'x');
  badForm.set('uniform_id', 'bad id');
  badForm.set('file', new Blob([payload]), 'log.bin');
  const bad = await call('PUT', '/api/dice/log', { raw: badForm });
  check('uniform_id 不合法返回 400', bad.status === 400 && bad.json.data === 'uniform_id field did not pass validation');

  const bigForm = new FormData();
  bigForm.set('name', 'big');
  bigForm.set('uniform_id', 'QQ:10001');
  bigForm.set('file', new Blob([Buffer.alloc(6 * 1024 * 1024, 1)]), 'log.bin');
  let bigStatus;
  try {
    bigStatus = (await call('PUT', '/api/dice/log', { raw: bigForm })).status;
  } catch {
    bigStatus = 413; // 服务端提前断开连接
  }
  check('超过大小上限被拒绝', bigStatus === 413);

  // ── backup-upload 与 w4123 ──
  const backup = await call('PUT', '/api/dice/backup-upload', {
    body: { uniform_id: 'QQ:10001', name: '转发日志', logdata: payload.toString('base64'), visitedHosts: ['a.example'] },
  });
  const backupShare = parseShare(backup.json && backup.json.url);
  check('backup-upload 返回分享链接', backup.status === 200 && backupShare, backup.text);
  const backupLoaded = await call('GET', `/api/dice/load_data?key=${backupShare.key}&password=${backupShare.password}`);
  check('backup-upload 的备注与旧站一致', backupLoaded.json.note === 'Backup upload' && backupLoaded.json.client === 'SealDice');

  const textForm = new FormData();
  textForm.set('name', 'Lua 日志');
  textForm.set('uniform_id', 'QQ:10001');
  textForm.set('file', new Blob(['希亞(10001) 2026-11-15 20:00:00\n.r 1d100\n\n骰娘(20002) 2026-11-15 20:00:01\n希亞掷出了 42\n']), 'log.txt');
  const w = await call('POST', '/api/dice/w4123', { raw: textForm });
  const wShare = parseShare(w.json && w.json.url);
  check('w4123 纯文字上传返回分享链接', w.status === 200 && wShare, w.text);
  const wItems = (await loadItems(wShare.key, wShare.password)).items;
  check('w4123 文字被解析为海豹格式', wItems.length === 2 && wItems[0].nickname === '希亞' && wItems[0].isDice === true && wItems[1].message === '希亞掷出了 42');
  const emptyForm = new FormData();
  emptyForm.set('name', 'x');
  emptyForm.set('uniform_id', 'QQ:10001');
  emptyForm.set('file', new Blob(['没有任何条目']), 'log.txt');
  check('w4123 解析不出条目返回 400', (await call('POST', '/api/dice/w4123', { raw: emptyForm })).status === 400);

  // ── 实时串流 ──
  const startBody = { name: '实时团', uniform_id: 'QQ:10001' };
  check('没有骰娘密钥不能开始实时日志', (await call('POST', '/api/v2/live/start', { body: startBody })).status === 401);
  check('无效骰娘密钥被拒绝', (await call('POST', '/api/v2/live/start', { body: startBody, headers: { Authorization: 'Bearer bdc_diceflats_wrong' } })).status === 403);
  const started = await call('POST', '/api/v2/live/start', { body: startBody, headers: { Authorization: `Bearer ${GOOD_KEY}` } });
  check('有效骰娘密钥可开始实时日志', started.status === 200 && started.json.token && parseShare(started.json.url), started.text);
  const live = started.json;
  const auth = { Authorization: `Bearer ${live.token}` };
  const item = (n, extra = {}) => ({
    seq: n, op: 'add',
    item: { nickname: '希亞', IMUserId: 'QQ:10001', time: 1780000000 + n, message: `第 ${n} 条`, isDice: false, rawMsgId: `m${n}`, ...extra },
  });

  const a1 = await call('POST', `/api/v2/live/${live.key}/append`, { body: { events: [item(1), item(2), item(3)] }, headers: auth });
  check('追加三条消息', a1.status === 200 && a1.json.last_seq === 3, a1.text);
  const a2 = await call('POST', `/api/v2/live/${live.key}/append`, { body: { events: [item(2), item(3), item(4)] }, headers: auth });
  check('重送已收过的消息不会重复', a2.status === 200 && a2.json.last_seq === 4);
  const gap = await call('POST', `/api/v2/live/${live.key}/append`, { body: { events: [item(7)] }, headers: auth });
  check('序号有缺口时拒收并回报 last_seq', gap.status === 409 && gap.json.last_seq === 4);
  check('令牌错误不能追加', (await call('POST', `/api/v2/live/${live.key}/append`, { body: { events: [item(5)] }, headers: { Authorization: 'Bearer nope' } })).status === 401);
  check('骰娘密钥本身不能当作会话令牌', (await call('POST', `/api/v2/live/${live.key}/append`, { body: { events: [item(5)] }, headers: { Authorization: `Bearer ${GOOD_KEY}` } })).status === 401);

  const polled = await call('GET', `/api/v2/live/${live.key}/events?password=${live.password}&after=2`);
  check('events 返回 after 之后的消息', polled.json.status === 'live' && polled.json.events.map((e) => e.seq).join() === '3,4');
  check('events 密码错误返回 404', (await call('GET', `/api/v2/live/${live.key}/events?password=000000`)).status === 404);

  const during = await loadItems(live.key, live.password);
  check('进行中的日志可用旧接口读取', during.loaded.json.live === true && during.loaded.json.last_seq === 4 && during.items.length === 4);

  // SSE：先补发已有消息，再收到新消息与完结通知。
  const sse = await fetch(`${BASE}/api/v2/live/${live.key}/stream?password=${live.password}&after=3`);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let sseText = '';
  const readUntil = async (needle) => {
    const deadline = Date.now() + 5000;
    while (!sseText.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`SSE 等不到 ${needle}：${sseText}`);
      const { value, done } = await reader.read();
      if (done) break;
      sseText += decoder.decode(value, { stream: true });
    }
  };
  await readUntil('id: 4');
  check('SSE 补发 after 之后的消息', sseText.includes('id: 4') && !sseText.includes('id: 3\n'));

  const a3 = await call('POST', `/api/v2/live/${live.key}/append`, {
    body: {
      events: [
        item(5, { isDice: true, message: '.ra 侦查' }),
        { seq: 6, op: 'edit', rawMsgId: 'm2', message: '第 2 条（已修改）' },
        { seq: 7, op: 'delete', rawMsgId: 'm3' },
      ],
    },
    headers: auth,
  });
  check('追加新增、修改、撤回事件', a3.status === 200 && a3.json.last_seq === 7, a3.text);
  await readUntil('id: 7');
  check('SSE 推送新事件', sseText.includes('"op":"edit"') && sseText.includes('"op":"delete"'));

  const ended = await call('POST', `/api/v2/live/${live.key}/end`, { headers: auth });
  check('完结后返回同一个分享链接', ended.status === 200 && ended.json.url === live.url, ended.text);
  await readUntil('event: end');
  check('SSE 收到完结通知', sseText.includes('event: end'));

  const after = await loadItems(live.key, live.password);
  check('完结后成为普通日志', after.loaded.json.live === undefined && after.loaded.json.client === 'SealDice');
  check('修改与撤回已套用', after.items.length === 4
    && after.items.map((i) => i.rawMsgId).join() === 'm1,m2,m4,m5'
    && after.items[1].message === '第 2 条（已修改）' && after.items[3].isDice === true, after.items);
  check('完结后不能再追加', (await call('POST', `/api/v2/live/${live.key}/append`, { body: { events: [item(8)] }, headers: auth })).status === 409);

  const emptyLive = (await call('POST', '/api/v2/live/start', { body: startBody, headers: { Authorization: `Bearer ${GOOD_KEY}` } })).json;
  const emptyEnd = await call('POST', `/api/v2/live/${emptyLive.key}/end`, { headers: { Authorization: `Bearer ${emptyLive.token}` } });
  check('没有消息的实时日志完结时被删除', emptyEnd.json.deleted === true && emptyEnd.json.url === null);

  // ── 后台管理 ──
  const xhr = { 'X-Requested-With': 'dnlog-admin' };
  check('首次进入需要设置管理员', (await call('GET', '/admin/api/state')).json.setup_required === true);
  check('后台页面可访问', (await call('GET', '/admin')).text.includes('后台管理'));
  const code = /设置码：\s*([0-9a-f]{12})/.exec(output);
  check('启动输出中有设置码', code, output);
  const account = { username: 'admin', password: 'correct-horse-1' };
  check('设置码错误不能建立账号', (await call('POST', '/admin/api/setup', { body: { ...account, setup_code: 'wrong' }, headers: xhr })).status === 403);
  check('密码过短被拒绝', (await call('POST', '/admin/api/setup', { body: { username: 'admin', password: 'short', setup_code: code[1] }, headers: xhr })).status === 400);
  const setup = await call('POST', '/admin/api/setup', { body: { ...account, setup_code: code[1] }, headers: xhr });
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
  check('设置码正确可建立账号并登录', setup.status === 200 && cookie.startsWith('dnlog_session='), setup.text);
  check('已有管理员后不能再次设置', (await call('POST', '/admin/api/setup', { body: { ...account, setup_code: code[1] }, headers: xhr })).status === 409);

  const authed = { ...xhr, Cookie: cookie };
  check('未登录不能读日志列表', (await call('GET', '/admin/api/logs')).status === 401);
  check('缺少自定义请求头的写请求被拒绝', (await call('POST', '/admin/api/cleanup', { headers: { Cookie: cookie } })).status === 403);

  const list = await call('GET', '/admin/api/logs', { headers: authed });
  check('日志列表包含全部日志', list.status === 200 && list.json.total === 4, list.text);
  const searched = await call('GET', `/admin/api/logs?q=${encodeURIComponent('实时')}`, { headers: authed });
  check('搜索按名称过滤', searched.json.total === 1 && searched.json.items[0].source === 'live');
  const stats = await call('GET', '/admin/api/stats', { headers: authed });
  check('统计数字正确', stats.json.total === 4 && stats.json.live === 0 && stats.json.bytes > 0);

  const preview = await call('GET', `/admin/api/logs/${live.key}/preview`, { headers: authed });
  check('可预览日志内容', preview.json.supported === true && preview.json.total === 4 && preview.json.items[0].nickname === '希亞');

  const patched = await call('PATCH', `/admin/api/logs/${share.key}`, { body: { name: '改名后的团', note: '管理员备注', pinned: true }, headers: authed });
  check('可修改名称、备注与永久保留', patched.json.name === '改名后的团' && patched.json.pinned === true && patched.json.expires_at === null);
  check('修改后旧接口读到新名称', (await call('GET', `/api/dice/load_data?key=${share.key}&password=${share.password}`)).json.name === '改名后的团');

  const settings = await call('PUT', '/admin/api/settings', { body: { retention_days: 30 }, headers: authed });
  check('可设置保留期限', settings.json.values.retention_days === 30);
  check('公开信息同步新的保留期限', (await call('GET', '/api/v2/info')).json.retention_days === 30);
  check('不合法的设置值被拒绝', (await call('PUT', '/admin/api/settings', { body: { retention_days: -1 }, headers: authed })).status === 400);

  // ── 存储位置与后台搬运 ──
  const blobName = (key) => { const hex = Buffer.from(key).toString('hex'); return join(hex.slice(0, 2), `${hex}.bin`); };
  const inLocal = (key) => existsSync(join(dataDir, 'blobs', blobName(key)));
  const inCos = (key) => existsSync(join(cosDir, blobName(key)));
  const storageInfo = async () => (await call('GET', '/admin/api/storage', { headers: authed })).json;
  const waitFor = async (name, condition) => {
    for (let i = 0; i < 50; i++) {
      if (await condition()) return check(name, true);
      await new Promise((done) => setTimeout(done, 100));
    }
    return check(name, false, await storageInfo());
  };
  const uploadOne = async (name) => {
    const f = new FormData();
    f.set('name', name);
    f.set('uniform_id', 'QQ:10001');
    f.set('file', new Blob([payload]), 'log.bin');
    return parseShare((await call('PUT', '/api/dice/log', { raw: f })).json.url);
  };

  let storage = await storageInfo();
  const cosLoc = () => storage.locations.find((loc) => loc.name === 'cos');
  check('默认写入本地缓存，新位置尚未初始化', storage.target === 'local' && cosLoc().state === 'uninitialized' && inLocal(share.key));
  check('未初始化的位置不能设为写入位置', (await call('POST', '/admin/api/storage/target', { body: { name: 'cos' }, headers: authed })).status === 400);
  check('可初始化存储位置', (await call('POST', '/admin/api/storage/init', { body: { name: 'cos' }, headers: authed })).status === 200);
  check('可更改写入位置', (await call('POST', '/admin/api/storage/target', { body: { name: 'cos' }, headers: authed })).status === 200);
  await waitFor('已有的日志从缓存搬到写入位置', async () => (await storageInfo()).mover.pending === 0 && inCos(share.key) && !inLocal(share.key));
  check('搬走后仍可读取且内容一致', Buffer.from((await call('GET', `/api/dice/load_data?key=${share.key}&password=${share.password}`)).json.data, 'base64').equals(payload));

  const moved = await uploadOne('新上传的团');
  check('上传后立刻可读', (await call('GET', `/api/dice/load_data?key=${moved.key}&password=${moved.password}`)).status === 200);
  await waitFor('新上传的日志自动搬到写入位置', async () => inCos(moved.key) && !inLocal(moved.key));

  // 模拟挂载掉线：标记文件不见了。
  rmSync(join(cosDir, '.dnlog-storage'));
  const held = await uploadOne('掉线期间的团');
  await new Promise((done) => setTimeout(done, 500));
  storage = await storageInfo();
  check('位置离线时日志留在缓存并可读', cosLoc().state === 'offline' && inLocal(held.key) && !inCos(held.key) && storage.mover.pending === 1
    && (await call('GET', `/api/dice/load_data?key=${held.key}&password=${held.password}`)).status === 200, storage);
  check('可重新初始化恢复位置', (await call('POST', '/admin/api/storage/init', { body: { name: 'cos' }, headers: authed })).status === 200);
  await call('POST', '/admin/api/storage/run', { headers: authed });
  await waitFor('位置恢复后补搬', async () => inCos(held.key) && !inLocal(held.key));

  check('删除日志', (await call('POST', '/admin/api/logs/batch-delete', { body: { keys: [moved.key, held.key] }, headers: authed })).json.deleted === 2);
  await waitFor('写入位置上的文件随之删除', async () => !inCos(moved.key) && !inCos(held.key) && (await storageInfo()).mover.pending_deletes === 0);

  check('可把写入位置改回本地', (await call('POST', '/admin/api/storage/target', { body: { name: 'local' }, headers: authed })).status === 200);
  check('当前写入位置不能迁出', (await call('POST', '/admin/api/storage/drain', { body: { name: 'local', enabled: true }, headers: authed })).status === 400);
  check('可迁出其他位置的日志', (await call('POST', '/admin/api/storage/drain', { body: { name: 'cos', enabled: true }, headers: authed })).status === 200);
  await waitFor('日志迁回本地', async () => inLocal(share.key) && !inCos(share.key) && !(await storageInfo()).locations.find((loc) => loc.name === 'cos').draining);
  check('迁出后位置上不留日志文件', readdirSync(cosDir, { recursive: true }).filter((name) => String(name).endsWith('.bin')).length === 0);

  // 把两份日志的创建时间改到 40 天前：永久保留的那份应留下，另一份应被清理。
  const db = new DatabaseSync(join(dataDir, 'logs.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const pastDate = new Date(Date.now() - 40 * 86400000).toISOString();
  db.prepare('UPDATE logs SET created_at = ? WHERE key IN (?, ?)').run(pastDate, share.key, backupShare.key);
  db.close();
  const cleaned = await call('POST', '/admin/api/cleanup', { headers: authed });
  check('清理只删除过期且未标记永久保留的日志', cleaned.json.deleted === 1, cleaned.text);
  check('永久保留的日志仍可读取', (await call('GET', `/api/dice/load_data?key=${share.key}&password=${share.password}`)).status === 200);
  check('过期日志已删除', (await call('GET', `/api/dice/load_data?key=${backupShare.key}&password=${backupShare.password}`)).status === 404);

  const batch = await call('POST', '/admin/api/logs/batch-delete', { body: { keys: [wShare.key, live.key, 'zzzz'] }, headers: authed });
  check('批量删除', batch.json.deleted === 2, batch.text);
  check('批量删除后列表只剩一份', (await call('GET', '/admin/api/logs', { headers: authed })).json.total === 1);
  check('单份删除', (await call('DELETE', `/admin/api/logs/${share.key}`, { headers: authed })).json.deleted === 1);

  check('当前密码错误不能改密码', (await call('POST', '/admin/api/password', { body: { old_password: 'x', new_password: 'another-pass-2' }, headers: authed })).status === 403);
  check('可修改密码', (await call('POST', '/admin/api/password', { body: { old_password: account.password, new_password: 'another-pass-2' }, headers: authed })).status === 200);
  check('退出登录', (await call('POST', '/admin/api/logout', { headers: authed })).status === 200);
  check('退出后会话失效', (await call('GET', '/admin/api/logs', { headers: authed })).status === 401);
  check('旧密码不能登录', (await call('POST', '/admin/api/login', { body: account, headers: xhr })).status === 401);
  const relogin = await call('POST', '/admin/api/login', { body: { username: 'admin', password: 'another-pass-2' }, headers: xhr });
  check('新密码可以登录', relogin.status === 200);

  // ── 骰娘号、群号、参与者 ──
  const admin2 = { ...xhr, Cookie: (relogin.headers.get('set-cookie') || '').split(';')[0] };
  const adminList = async (query) => (await call('GET', `/admin/api/logs?${query}`, { headers: admin2 })).json;
  const metaForm = new FormData();
  metaForm.set('name', '带群号的团');
  metaForm.set('uniform_id', 'QQ:40004');
  metaForm.set('group_id', 'QQ-Group:7777');
  metaForm.set('file', new Blob([payload]), 'log.bin');
  const metaShare = parseShare((await call('PUT', '/api/dice/log', { raw: metaForm })).json.url);
  await new Promise((done) => setTimeout(done, 300));
  let found = await adminList('bot=40004');
  check('未带骰娘密钥时骰娘号取自 uniform_id', found.total === 1 && found.items[0].key === metaShare.key && found.items[0].group_id === '7777');
  const groupForm = new FormData();
  groupForm.set('name', 'DiceNext 上传的团');
  groupForm.set('uniform_id', 'QQ-Group:123123');
  groupForm.set('file', new Blob([payload]), 'log.bin');
  await call('PUT', '/api/dice/log', { raw: groupForm });
  found = await adminList('group=123123');
  check('uniform_id 是群时记为群号而非骰娘号', found.total === 1 && found.items[0].bot_id === '' && (await adminList('bot=123123')).total === 0);
  // 上传方没给的，从内容里认：掷骰结果的发送者是骰娘，消息上的 GroupID 是群
  const richData = sealData([
    { nickname: '希亞', IMUserId: 'QQ:10001', GroupID: 'QQ-Group:456456', time: 1780000000, message: '.ra 侦查', isDice: false },
    { nickname: '骰娘', IMUserId: 'QQ:80008', GroupID: 'QQ-Group:456456', time: 1780000001, message: '希亞的侦查检定：成功', isDice: true },
  ]);
  const inferUpload = async (uniformId) => {
    const f = new FormData();
    f.set('name', '从内容认号');
    f.set('uniform_id', uniformId);
    f.set('file', new Blob([richData]), 'log.bin');
    const shared = parseShare((await call('PUT', '/api/dice/log', { raw: f })).json.url);
    await new Promise((done) => setTimeout(done, 300));
    return (await call('GET', `/admin/api/logs/${shared.key}`, { headers: admin2 })).json;
  };
  const fromDn = await inferUpload('QQ-Group:456456');
  check('只给了群号时从内容认出骰娘号', fromDn.group_id === '456456' && fromDn.bot_id === '80008', fromDn);
  const fromSeal = await inferUpload('QQ:80008');
  check('只给了骰娘号时从内容认出群号', fromSeal.bot_id === '80008' && fromSeal.group_id === '456456', fromSeal);
  const explicit = await inferUpload('QQ:70007');
  check('上传方给的骰娘号优先于内容里认出的', explicit.bot_id === '70007' && explicit.group_id === '456456', explicit);
  found = await adminList('bot=40004');
  check('可按群号查询', (await adminList('group=7777')).total === 1 && (await adminList('group=8888')).total === 0);
  check('可按参与者账号查询', (await adminList('participant=10001')).items.some((log) => log.key === metaShare.key));
  check('可按参与者昵称查询', (await adminList(`participant=${encodeURIComponent('希亞')}`)).items.some((log) => log.key === metaShare.key));
  check('查不到的参与者返回空', (await adminList('participant=99999')).total === 0);
  const detail = await call('GET', `/admin/api/logs/${metaShare.key}/preview`, { headers: admin2 });
  check('详情带参与者名单与消息条数', detail.json.participants[0].user_id === '10001' && found.items[0].item_count === 1, detail.json);

  const keyedForm = new FormData();
  keyedForm.set('name', '带骰娘密钥上传的团');
  keyedForm.set('uniform_id', 'QQ:55555');
  keyedForm.set('bot_id', '55555');
  keyedForm.set('group_id', '8888');
  keyedForm.set('file', new Blob([payload]), 'log.bin');
  const keyedShare = parseShare((await call('PUT', '/api/dice/log', { raw: keyedForm, headers: { Authorization: `Bearer ${GOOD_KEY}` } })).json.url);
  found = await adminList('bot=20002');
  check('带骰娘密钥上传时骰娘号以账号站登记的为准', found.total === 1 && found.items[0].key === keyedShare.key);
  const badKeyForm = new FormData();
  badKeyForm.set('name', '骰娘密钥无效的团');
  badKeyForm.set('uniform_id', 'QQ:66666');
  badKeyForm.set('file', new Blob([payload]), 'log.bin');
  check('骰娘密钥无效的上传照常接收', (await call('PUT', '/api/dice/log', { raw: badKeyForm, headers: { Authorization: 'Bearer bdc_wrong_key' } })).status === 200);

  // ── 骰娘查询自己名下的日志 ──
  check('查询日志需要骰娘密钥', (await call('GET', '/api/v2/logs')).status === 401);
  check('无效骰娘密钥不能查询', (await call('GET', '/api/v2/logs', { headers: { Authorization: 'Bearer bdc_wrong_key' } })).status === 403);
  const liveMeta = (await call('POST', '/api/v2/live/start', {
    body: { name: '查询用实时团', uniform_id: 'QQ:20002', group_id: '9999' }, headers: { Authorization: `Bearer ${GOOD_KEY}` },
  })).json;
  await call('POST', `/api/v2/live/${liveMeta.key}/append`, { body: { events: [item(1)] }, headers: { Authorization: `Bearer ${liveMeta.token}` } });
  const mine = await call('GET', '/api/v2/logs?page_size=1', { headers: { Authorization: `Bearer ${GOOD_KEY}` } });
  check('骰娘只查到自己名下的日志并分页', mine.status === 200 && mine.json.total === 2 && mine.json.items.length === 1 && mine.json.page_size === 1, mine.text);
  const mineGroup = await call('GET', '/api/v2/logs?group_id=9999', { headers: { Authorization: `Bearer ${GOOD_KEY}` } });
  check('查询结果带链接、群号与参与者', mineGroup.json.total === 1 && mineGroup.json.items[0].url === liveMeta.url
    && mineGroup.json.items[0].status === 'live' && mineGroup.json.items[0].participants[0].user_id === '10001', mineGroup.text);
  const minePlayer = await call('GET', '/api/v2/logs?participant=10001&page=1', { headers: { Authorization: `Bearer ${GOOD_KEY}` } });
  check('可按参与者查询自己的日志', minePlayer.json.total === 2);

  // ── 续写：另开一份 ──
  const keyAuth = { Authorization: `Bearer ${GOOD_KEY}` };
  const forkPath = `/api/v2/live/${liveMeta.key}/fork`;
  check('续写需要骰娘密钥', (await call('POST', forkPath, { body: { password: liveMeta.password } })).status === 401);
  check('续写需要原日志的密码', (await call('POST', forkPath, { body: { password: '000000' }, headers: keyAuth })).status === 404);
  const forked = await call('POST', forkPath, { body: { password: liveMeta.password, group_id: '9999' }, headers: keyAuth });
  check('续写得到一份新的日志与当前序号', forked.status === 200 && forked.json.key !== liveMeta.key && forked.json.url !== liveMeta.url
    && forked.json.last_seq === 1 && forked.json.forked_from === liveMeta.key && parseShare(forked.json.url), forked.text);
  const forkAuth = { Authorization: `Bearer ${forked.json.token}` };
  check('新日志可接着写', (await call('POST', `/api/v2/live/${forked.json.key}/append`, { body: { events: [item(2)] }, headers: forkAuth })).json.last_seq === 2);
  check('原日志的令牌仍然有效', (await call('POST', `/api/v2/live/${liveMeta.key}/append`, { body: { events: [item(2, { message: '原日志的第 2 条' })] }, headers: { Authorization: `Bearer ${liveMeta.token}` } })).json.last_seq === 2);
  await call('POST', `/api/v2/live/${forked.json.key}/end`, { headers: forkAuth });
  await call('POST', `/api/v2/live/${liveMeta.key}/end`, { headers: { Authorization: `Bearer ${liveMeta.token}` } });
  const forkItems = (await loadItems(forked.json.key, forked.json.password)).items;
  const originItems = (await loadItems(liveMeta.key, liveMeta.password)).items;
  check('两份日志各写各的', forkItems.map((i) => i.message).join('|') === '第 1 条|第 2 条'
    && originItems.map((i) => i.message).join('|') === '第 1 条|原日志的第 2 条', [forkItems, originItems]);
  const fromDone = await call('POST', `/api/v2/live/${metaShare.key}/fork`, { body: { password: metaShare.password, name: '接着写' }, headers: keyAuth });
  check('已完结的日志也能作为起点', fromDone.status === 200 && fromDone.json.last_seq === 1 && fromDone.json.name === '接着写', fromDone.text);
  await call('POST', `/api/v2/live/${fromDone.json.key}/end`, { headers: { Authorization: `Bearer ${fromDone.json.token}` } });
  check('起点日志不受影响', (await loadItems(metaShare.key, metaShare.password)).items.length === 1);

  // ── 本站签发的骰娘密钥 ──
  check('签发数量超出范围被拒绝', (await call('POST', '/admin/api/keys', { body: { count: 51 }, headers: admin2 })).status === 400);
  const issued = await call('POST', '/admin/api/keys', { body: { name: '自建骰娘', bot_id: 'QQ:61616', count: 3 }, headers: admin2 });
  check('可一次签发多把骰娘密钥', issued.status === 200 && issued.json.items.length === 3
    && issued.json.items.every((k) => k.key.startsWith('dnlog_') && k.bot_id === '61616')
    && new Set(issued.json.items.map((k) => k.key)).size === 3 && issued.json.items[1].name === '自建骰娘 #2', issued.text);
  const listed = await call('GET', '/admin/api/keys', { headers: admin2 });
  check('列表不含密钥明文与哈希', listed.json.items.length === 3 && !listed.text.includes(issued.json.items[0].key)
    && listed.json.items.every((k) => k.key === undefined && k.key_hash === undefined && k.key_prefix.length === 12), listed.text);
  const localAuth = { Authorization: `Bearer ${issued.json.items[0].key}` };
  const localLive = await call('POST', '/api/v2/live/start', { body: { name: '自建站的团', uniform_id: 'QQ-Group:5151' }, headers: localAuth });
  check('本站签发的密钥可开始实时日志', localLive.status === 200, localLive.text);
  await call('POST', `/api/v2/live/${localLive.json.key}/append`, { body: { events: [item(1)] }, headers: { Authorization: `Bearer ${localLive.json.token}` } });
  await call('POST', `/api/v2/live/${localLive.json.key}/end`, { headers: { Authorization: `Bearer ${localLive.json.token}` } });
  const localLogs = await call('GET', '/api/v2/logs', { headers: localAuth });
  check('日志记到签发时填的骰娘号名下', localLogs.json.total === 1 && localLogs.json.items[0].bot_id === '61616' && localLogs.json.items[0].group_id === '5151', localLogs.text);
  check('同一骰娘号的另一把密钥也能查到', (await call('GET', '/api/v2/logs', { headers: { Authorization: `Bearer ${issued.json.items[1].key}` } })).json.total === 1);
  check('使用过的密钥记下最后使用时间', (await call('GET', '/admin/api/keys', { headers: admin2 })).json.items.find((k) => k.id === issued.json.items[0].id).last_used_at !== '');
  const keyId = issued.json.items[0].id;
  check('可停用骰娘密钥', (await call('PATCH', `/admin/api/keys/${keyId}`, { body: { enabled: false }, headers: admin2 })).json.enabled === false);
  check('停用后不能再使用', (await call('GET', '/api/v2/logs', { headers: localAuth })).status === 403);
  check('可重新启用', (await call('PATCH', `/admin/api/keys/${keyId}`, { body: { enabled: true }, headers: admin2 })).json.enabled === true
    && (await call('GET', '/api/v2/logs', { headers: localAuth })).status === 200);
  check('可删除骰娘密钥', (await call('DELETE', `/admin/api/keys/${keyId}`, { headers: admin2 })).status === 200
    && (await call('GET', '/api/v2/logs', { headers: localAuth })).status === 403);
  check('删除不存在的密钥返回 404', (await call('DELETE', `/admin/api/keys/${keyId}`, { headers: admin2 })).status === 404);
  check('设置页列出可用的校验方式', (await call('GET', '/admin/api/settings', { headers: admin2 })).json.live_auth_modes.join() === 'local,bdc');

  // ── 站点配置即时生效 ──
  const siteNow = (await call('GET', '/admin/api/settings', { headers: admin2 })).json.site;
  check('站点配置的默认值来自环境变量', siteNow.frontend_url === 'https://log.example.test/' && siteNow.bdc_verify_token_set === true && siteNow.bdc_verify_token === undefined);
  check('不合法的染色器地址被拒绝', (await call('PUT', '/admin/api/settings', { body: { site: { frontend_url: '' } }, headers: admin2 })).status === 400);
  check('可修改染色器地址', (await call('PUT', '/admin/api/settings', { body: { site: { frontend_url: 'new.example.test' } }, headers: admin2 })).status === 200);
  const reForm = new FormData();
  reForm.set('name', '改地址后的团');
  reForm.set('uniform_id', 'QQ:10001');
  reForm.set('file', new Blob([payload]), 'log.bin');
  const reUp = await call('PUT', '/api/dice/log', { raw: reForm, headers: { Origin: 'https://new.example.test' } });
  check('修改后无需重启即生效', reUp.json.url.startsWith('https://new.example.test/?key=') && reUp.headers.get('access-control-allow-origin') === 'https://new.example.test');
  await call('PUT', '/admin/api/settings', { body: { site: { frontend_url: 'https://log.example.test' } }, headers: admin2 });

  // ── 回源不成环 ──
  const hitsBefore = oldSiteHits;
  check('带转发标记的请求不再回源', (await call('GET', '/api/dice/load_data?key=NOPE&password=111111', { headers: { 'X-DNLog-Forwarded': '1' } })).status === 404 && oldSiteHits === hitsBefore);

  // ── 从旧站导入 ──
  // 假旧站与测试在同一个进程里，子进程必须异步等，否则旧站答不了它的请求。
  const runImport = (token) => new Promise((done) => {
    const child = spawn(process.execPath, ['cli.mjs', 'import-legacy', `http://127.0.0.1:${FAKE_PORT}/old`, token], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
  check('导出令牌不对时不导入', (await runImport('wrong')).status === 1);
  const imported = await runImport('export-token');
  check('按旧站索引导入', imported.status === 0 && imported.stdout.includes('新导入 1 份') && imported.stdout.includes('旧站已不存在 1 份'), imported.stdout + imported.stderr);
  const hitsAfterImport = oldSiteHits;
  check('重复执行会跳过已导入的', (await runImport('export-token')).stdout.includes('此前已导入 1 份'));
  check('已导入的不再向旧站读取', oldSiteHits === hitsAfterImport + 1, oldSiteHits - hitsAfterImport);

  // 后台启动迁移并查看进度
  check('后台启动迁移需填令牌或沿用已保存的', (await call('POST', '/admin/api/import/start', { body: { base_url: 'not-a-url' }, headers: admin2 })).status === 400);
  await call('POST', '/admin/api/logs/batch-delete', { body: { keys: ['OLD1'] }, headers: admin2 });
  const startedImport = await call('POST', '/admin/api/import/start', { body: { base_url: `http://127.0.0.1:${FAKE_PORT}/old` }, headers: admin2 });
  check('可在后台启动迁移', startedImport.status === 200 && startedImport.json.running === true && startedImport.json.token_set === true, startedImport.text);
  let progress;
  for (let i = 0; i < 50; i++) {
    progress = (await call('GET', '/admin/api/import', { headers: admin2 })).json;
    if (!progress.running) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  check('后台可看到迁移进度与结果', progress.running === false && progress.total === 2 && progress.done === 2
    && progress.created === 1 && progress.missing === 1 && progress.failed === 0 && progress.finished_at, progress);

  // 不靠旧站的导出接口：直接贴入索引内容
  await call('POST', '/admin/api/logs/batch-delete', { body: { keys: ['OLD1'] }, headers: admin2 });
  const oldBase = `http://127.0.0.1:${FAKE_PORT}/old`;
  check('索引内容格式不对时拒绝', (await call('POST', '/admin/api/import/start', { body: { base_url: oldBase, index: '{"logs":[{"key":"nohash"}]}' }, headers: admin2 })).status === 400);
  const pasted = JSON.stringify({ version: 1, logs: [{ key: 'OLD1#123456', created_at: '2026-10-02T03:04:05.000Z' }] });
  check('可贴入索引内容启动迁移', (await call('POST', '/admin/api/import/start', { body: { base_url: oldBase, index: pasted }, headers: admin2 })).status === 200);
  for (let i = 0; i < 50; i++) {
    progress = (await call('GET', '/admin/api/import', { headers: admin2 })).json;
    if (!progress.running) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  check('按贴入的索引迁移', progress.total === 1 && progress.created === 1 && progress.saved_index === 1, progress);
  await call('PUT', '/admin/api/settings', { body: { site: { legacy_upstream_url: '' } }, headers: admin2 });
  const importedLog = await call('GET', '/api/dice/load_data?key=OLD1&password=123456');
  check('导入的日志保留原 key、密码、内容与创建时间', importedLog.status === 200 && importedLog.json.name === '旧站日志'
    && importedLog.json.note === '旧备注' && importedLog.json.created_at === '2026-10-02T03:04:05.000Z'
    && Buffer.from(importedLog.json.data, 'base64').equals(oldData), importedLog.text);
  found = await adminList('participant=30003');
  check('导入的日志同样可按参与者查询', found.total === 1 && found.items[0].source === 'import');
  check('导入的日志从内容认出骰娘号与群号', found.items[0].bot_id === '90009' && found.items[0].group_id === '321321', found.items[0]);

  // ── 服务器指令重置管理员 ──
  const reset = spawnSync(process.execPath, ['cli.mjs', 'reset-admin'], { cwd: ROOT, env, encoding: 'utf8' });
  const newCode = /([0-9a-f]{12})/.exec(reset.stdout);
  check('reset-admin 输出新的设置码', reset.status === 0 && newCode, reset.stdout + reset.stderr);
  check('重置后回到首次设置', (await call('GET', '/admin/api/state')).json.setup_required === true);
  const relogCookie = (relogin.headers.get('set-cookie') || '').split(';')[0];
  check('重置后原登录状态失效', (await call('GET', '/admin/api/logs', { headers: { Cookie: relogCookie } })).status === 401);
  const resetup = await call('POST', '/admin/api/setup', { body: { username: 'admin2', password: 'brand-new-pass-3', setup_code: newCode[1] }, headers: xhr });
  check('用新设置码可重新建立账号', resetup.status === 200, resetup.text);

  console.log(`\n全部通过：${passed} 项`);
} catch (err) {
  console.error(`\n${err.message}`);
  console.error('── 服务输出 ──\n' + output);
  process.exitCode = 1;
} finally {
  server.kill();
  fake.close();
  fake.closeAllConnections();
  await new Promise((done) => setTimeout(done, 300));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(cosDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
