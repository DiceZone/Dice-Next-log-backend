// 检查界面上的中文字串在英文字典里都有对应。
//   node test/i18n-check.mjs
// 从页面脚本与后台接口里取出全部含中文的字串，逐条过一遍 t()；
// 翻译后仍含中文的就是漏翻。拼接句子的片段无法单独翻译，在 SAMPLES 里给出完整例句来检查。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const CJK = /[一-鿿]/;

// 在英文环境下载入字典。
const sandbox = { window: { localStorage: { getItem: () => 'en', setItem() {} }, location: { reload() {} } }, navigator: { language: 'en' } };
vm.runInNewContext(read('public/i18n.js'), sandbox);
const { t } = sandbox.window.DNLOG_I18N;

// 拼接句子里的片段：它们只作为下面例句的一部分出现。
const FRAGMENTS = new Set([
  '请求失败（HTTP ', '）。', '将删除骰娘密钥「', '」，使用它的骰娘将无法再上传实时日志或查询日志。', '已选择 ', ' 份日志', '将删除所选的 ', ' 份日志，删除后无法恢复。', '已删除 ', ' 份日志。',
  '选择 ', '共 ', ' 份，第 ', ' 页', '每页 ', ' 份', '将删除日志「', '」，删除后无法恢复。', '将完结日志「',
  '」，完结后骰娘无法继续向它追加消息。', '（', '）', '） ', '、', ' 条消息，以下为前 ', ' 条：', ' 条消息：',
  '将在「', '」写入标记文件，之后该位置可用于存放日志。请先确认该目录已正确挂载。', '之后上传的日志将存放到「',
  '」，已存放在其他位置的日志保持原处。', '将把「', '」中的 ', ' 份日志搬往当前写入位置。', '等待搬运的日志：',
  ' 份；等待删除的文件：', ' 份。', '　', '已保存 ', ' 条索引，留空则沿用', '上次迁移结束于 ', '。', '已处理 ',
  ' 份：新迁入 ', '，本站已有 ', '，旧站已不存在 ', '，冲突 ', '，失败 ', ' 份过期日志。', '日志留存 ', ' 天', '中文',
]);

const SAMPLES = [
  '请求失败（HTTP 502）。', '已选择 3 份日志', '将删除所选的 3 份日志，删除后无法恢复。', '已删除 3 份日志。',
  '已删除 3 份过期日志。', '选择 aB3d', '共 37 份，第 1 / 2 页', '每页 50 份', '将删除日志「Session A」，删除后无法恢复。',
  '将完结日志「Session A」，完结后骰娘无法继续向它追加消息。', '共 420 条消息，以下为前 300 条：', '共 12 条消息：',
  '将在「/storage/cos」写入标记文件，之后该位置可用于存放日志。请先确认该目录已正确挂载。',
  '之后上传的日志将存放到「本地缓存」，已存放在其他位置的日志保持原处。', '将把「cos」中的 5 份日志搬往当前写入位置。',
  '等待搬运的日志：2 份；等待删除的文件：0 份。', '已保存 1135 条索引，留空则沿用', '上次迁移结束于 2026-11-15 12:00。',
  '已处理 10 / 20 份：新迁入 5，本站已有 3，旧站已不存在 1，冲突 0，失败 1。', '日志留存 365 天',
  'aB3d#123456：本站已有同名但密码不同的日志，未迁移', 'aB3d#123456：日志内容为空', 'aB3d#123456：索引条目格式不对',
  '设置项的取值须为 0–36500 的整数。', '无法写入该位置：EACCES', '密码长度须为 8–128 个字符。',
  '将删除骰娘密钥「dnlog_abc123…」，使用它的骰娘将无法再上传实时日志或查询日志。',
  '自动封锁：10 分钟内出现 40 次可疑请求',
  '写入位置「cos」当前不可用，日志暂留在原处。', '存储位置「cos」当前不可用，暂不迁出。',
  '公告标题最多 100 个字符。', '启用公告时须填写内容，内容最多 20000 个字符。',
];

const found = new Set(SAMPLES);
const literal = /'((?:[^'\\\n]|\\.)*)'/g;
for (const file of ['public/admin.js', 'public/index.js']) {
  for (const match of read(file).matchAll(literal)) {
    if (CJK.test(match[1]) && !FRAGMENTS.has(match[1])) found.add(match[1]);
  }
}
for (const file of ['public/index.html', 'public/admin.html']) {
  for (const match of read(file).matchAll(/data-i18n>([^<]+)</g)) found.add(match[1].trim());
}
// 后台接口返回的提示（fail('…')、SITE_ERRORS、迁移的 Error）。
for (const file of ['src/routes/admin.mjs', 'src/import-legacy.mjs']) {
  for (const match of read(file).matchAll(/(?:fail\(\d+, |throw new Error\(|: |\? )'((?:[^'\\\n]|\\.)*)'/g)) {
    if (CJK.test(match[1])) found.add(match[1]);
  }
}

const missing = [...found].filter((text) => CJK.test(t(text)));
if (missing.length) {
  console.error(`有 ${missing.length} 条界面文字没有英文对应：`);
  for (const text of missing) console.error(`  ${text}  →  ${t(text)}`);
  process.exit(1);
}
console.log(`界面文字 ${found.size} 条，英文对应齐全。`);
