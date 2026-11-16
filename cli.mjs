// 服务器上的维护指令。
//   node cli.mjs reset-admin          清除管理员账号与全部登录状态，回到首次设置
//   node cli.mjs setup-code           显示当前的首次设置码
//   node cli.mjs storage-init <名称>  初始化 STORAGES 中登记的存储位置
//   node cli.mjs import-legacy <旧站地址> <导出令牌>  把旧站的全部日志按原索引导入
//   node cli.mjs unban <IP|all>       解除对某个 IP 的封锁，或清空封锁名单
//   node cli.mjs origin-auth off      关闭回源校验（配错把自己挡在外面时用，需重启服务）
import { resetAdmin, ensureSetupCode, hasAdmin } from './src/auth.mjs';
import { LOCAL, hasStorage, storagePath, initStorage, getTarget } from './src/storage.mjs';
import { importLegacy } from './src/import-legacy.mjs';
import { unban } from './src/bans.mjs';
import { disableOriginAuth } from './src/site.mjs';

const [command, argument, extra] = process.argv.slice(2);

function usage(code) {
  console.log('用法：');
  console.log('  node cli.mjs reset-admin          清除管理员账号与全部登录状态，回到首次设置');
  console.log('  node cli.mjs setup-code           显示当前的首次设置码');
  console.log('  node cli.mjs storage-init <名称>  初始化 STORAGES 中登记的存储位置');
  console.log('  node cli.mjs import-legacy <旧站地址> <导出令牌>  把旧站的全部日志按原索引导入');
  console.log('  node cli.mjs unban <IP|all>       解除对某个 IP 的封锁，或清空封锁名单');
  console.log('  node cli.mjs origin-auth off      关闭回源校验（需重启服务）');
  process.exit(code);
}

if (command === 'reset-admin') {
  const code = resetAdmin();
  console.log('管理员账号与全部登录状态已清除。');
  console.log('请打开 /admin 重新设置用户名和密码，设置码：');
  console.log(`    ${code}`);
} else if (command === 'setup-code') {
  if (hasAdmin()) {
    console.log('管理员账号已存在，无需设置码。如需重置密码，请执行：node cli.mjs reset-admin');
  } else {
    console.log(`设置码：${ensureSetupCode()}`);
  }
} else if (command === 'storage-init') {
  if (!argument || argument === LOCAL || !hasStorage(argument)) {
    console.log(`存储位置「${argument || ''}」不在 STORAGES 配置中。`);
    process.exit(1);
  }
  await initStorage(argument);
  console.log(`存储位置「${argument}」已初始化：${storagePath(argument)}`);
  console.log(`当前写入位置：${getTarget()}`);
} else if (command === 'origin-auth') {
  if (argument !== 'off') usage(1);
  disableOriginAuth();
  console.log('回源校验已关闭，请重启服务使其生效。');
} else if (command === 'unban') {
  if (!argument) usage(1);
  console.log(`已解除 ${unban(argument)} 条封锁，运行中的服务最多一分钟后生效。`);
} else if (command === 'import-legacy') {
  if (!argument || !extra) usage(1);
  const ok = await importLegacy(argument, extra);
  process.exit(ok ? 0 : 1);
} else {
  usage(command ? 1 : 0);
}
