// 旧版 Dice!（w4123）Lua 插件上传的纯文字日志 → 海豹 V1 格式。
// 文字格式：「昵称(ID) 时间」一行，后面跟消息内容。
import { deflateSync } from 'node:zlib';

const DICE_COMMANDS = ['.r', '.rh', '.ra', '.raa', '.rs', '.rc', '.d', '.log', '.nn', '.n'];

function isDiceCommand(message) {
  const lower = message.trim().toLowerCase();
  return DICE_COMMANDS.some((cmd) => lower.startsWith(cmd));
}

export function parseTextLog(text) {
  const items = [];
  let current = null;
  let id = 0;

  const flush = () => {
    if (current && current.message) {
      current.id = ++id;
      current.isDice = isDiceCommand(current.message);
      current.commandId = current.isDice ? 1 : 0;
      items.push(current);
    }
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const header = line.match(/^(.+)\((.+?)\)\s+(.+)$/);
    if (header) {
      flush();
      current = { nickname: header[1], IMUserId: header[2], timeText: header[3], message: '' };
      const time = header[3].match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
      if (time) {
        const parsed = new Date(time[1]);
        if (!Number.isNaN(parsed.getTime())) current.time = Math.floor(parsed.getTime() / 1000);
      }
    } else if (current && line !== '') {
      current.message = current.message ? `${current.message}\n${line}` : line;
    }
  }
  flush();
  return items;
}

// 返回 zlib 压缩后的字节；解析不出任何条目时返回 null。
export function textLogToSealData(text) {
  const items = parseTextLog(text);
  if (items.length === 0) return null;
  return deflateSync(Buffer.from(JSON.stringify({ version: 1, items })));
}
