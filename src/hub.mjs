// 实时日志的观众连接（SSE）。只在本进程内分发，不落盘。
const subscribers = new Map();
const MAX_PER_LOG = 200;
const MAX_TOTAL = 2000;
let total = 0;

function frame(event, data, id) {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function subscribe(key, res) {
  let set = subscribers.get(key);
  if (!set) subscribers.set(key, (set = new Set()));
  if (set.size >= MAX_PER_LOG || total >= MAX_TOTAL) return false;
  set.add(res);
  total += 1;
  res.on('close', () => {
    if (set.delete(res)) total -= 1;
    if (set.size === 0 && subscribers.get(key) === set) subscribers.delete(key);
  });
  return true;
}

export function writeEvents(res, events) {
  for (const ev of events) res.write(frame('message', ev, ev.seq));
}

export function writeEnd(res, data) {
  res.write(frame('end', data));
  res.end();
}

export function publish(key, events) {
  const set = subscribers.get(key);
  if (!set) return;
  for (const res of set) writeEvents(res, events);
}

export function publishEnd(key, data) {
  const set = subscribers.get(key);
  if (!set) return;
  for (const res of [...set]) writeEnd(res, data);
}

setInterval(() => {
  for (const set of subscribers.values()) {
    for (const res of set) res.write(': ping\n\n');
  }
}, 25000).unref();
