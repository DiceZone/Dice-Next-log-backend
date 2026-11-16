// 界面语言：简体中文（原文）与英文。
// 界面文字在代码里直接写中文，显示前经 t() 查表；英文模式下查不到的原样显示。
// 带数字或名称的句子用 PATTERNS 里的正则匹配，$1、$2 是原样带入的部分，$t1 表示带入前先翻译。
window.DNLOG_I18N = (function () {
  'use strict';

  var EN = {
    // ── 首页 ──
    'Dice!Next 的跑团日志存储后端服务。': 'Log storage backend for Dice!Next tabletop sessions.',
    'API 端点': 'API Endpoints',
    '上传日志文件': 'Upload a log file',
    '适配 w4123/Dice 的接口，支持txt直接上传': 'Endpoint for w4123/Dice, accepts plain-text uploads',
    '根据 Key 和 Password 读取日志数据': 'Read a log by key and password',
    '备用上传接口，用于主存储失败时的级联转发': 'Fallback upload endpoint for forwarding between sites',
    '实时串流上传接口，需要骰娘密钥': 'Live streaming upload, requires a bot key',
    '源码': 'Source',
    '复制': 'Copy',
    'API链接已复制！': 'API URL copied.',
    '日志长期留存': 'Logs kept indefinitely',

    // ── 通用 ──
    '后台管理': 'Admin',
    '退出登录': 'Sign out',
    '取消': 'Cancel',
    '保存': 'Save',
    '关闭': 'Close',
    '删除': 'Delete',
    '刷新': 'Refresh',
    '搜索': 'Search',
    '已保存。': 'Saved.',

    // ── 首次设置 / 登录 ──
    '设置管理员账号': 'Set up the administrator account',
    '设置码': 'Setup code',
    '设置码显示在服务器的启动输出中，也可在服务器执行 node cli.mjs setup-code 查看。':
      'The setup code is printed when the server starts. You can also run "node cli.mjs setup-code" on the server.',
    '用户名': 'Username',
    '3–32 位的字母、数字、下划线、点或短横线。': '3–32 letters, digits, underscores, dots or hyphens.',
    '密码': 'Password',
    '8–128 个字符。': '8–128 characters.',
    '确认密码': 'Confirm password',
    '完成设置': 'Finish setup',
    '两次输入的密码不一致。': 'The two passwords do not match.',
    '登录后台管理': 'Sign in to Admin',
    '登录': 'Sign in',

    // ── 页签 ──
    '日志': 'Logs',
    '设置': 'Settings',
    '账号': 'Account',

    // ── 日志列表 ──
    '搜索名称、Key、uniform_id 或备注': 'Search name, key, uniform_id or note',
    '骰娘号': 'Bot ID',
    '群号': 'Group ID',
    '参与者账号或昵称': 'Participant ID or nickname',
    '全部状态': 'All statuses',
    '已完结': 'Finished',
    '进行中': 'Live',
    '永久保留': 'Pinned',
    '全部来源': 'All sources',
    '一次性上传': 'One-off upload',
    '实时串流': 'Live stream',
    'Dice! 插件': 'Dice! plugin',
    '站点转发': 'Forwarded',
    '旧站导入': 'Migrated',
    '最新在前': 'Newest first',
    '最早在前': 'Oldest first',
    '体积最大在前': 'Largest first',
    '日志总数': 'Total logs',
    '占用空间': 'Storage used',
    '进行中的实时日志': 'Live logs in progress',
    '近 24 小时新增': 'Added in the last 24 hours',
    '删除所选': 'Delete selected',
    '取消选择': 'Clear selection',
    '删除日志': 'Delete logs',
    '没有符合条件的日志。': 'No logs match.',
    '全选本页': 'Select all on this page',
    '完结后计算': 'Set when finished',
    '不自动删除': 'Never',
    '（未命名）': '(untitled)',
    '查看': 'Open',
    '详情': 'Details',
    '编辑': 'Edit',
    '完结': 'Finish',
    '名称': 'Name',
    '来源': 'Source',
    '格式': 'Format',
    '大小': 'Size',
    '状态': 'Status',
    '创建时间': 'Created',
    '到期时间': 'Expires',
    '每页条数': 'Logs per page',
    '上一页': 'Previous',
    '下一页': 'Next',
    '日志已删除。': 'Log deleted.',
    '完结实时日志': 'Finish live log',
    '该日志没有任何消息，已删除。': 'The log had no messages and was deleted.',
    '日志已完结。': 'Log finished.',
    '编辑日志': 'Edit log',
    '备注': 'Note',
    '永久保留，不随保留期限删除': 'Pin: never delete when the retention period passes',
    '分享链接': 'Share link',
    '上传 IP': 'Uploader IP',
    '存储位置': 'Storage location',
    '最后更新': 'Last updated',
    '参与者': 'Participants',
    '正在读取内容……': 'Loading content…',
    '日志详情': 'Log details',
    '该格式无法在后台预览内容，请使用「查看」在染色器中打开。':
      'This format cannot be previewed here. Use "Open" to view it in the renderer.',
    '本地缓存': 'Local cache',

    // ── 设置：日志与上传 ──
    '日志与上传': 'Logs and uploads',
    '日志保留期限（天）': 'Log retention (days)',
    '超过期限的日志会被自动删除；填 0 表示不自动删除。标记为永久保留的日志不受影响。':
      'Logs older than this are deleted automatically; 0 keeps them forever. Pinned logs are not affected.',
    '单份日志大小上限（MB）': 'Maximum log size (MB)',
    '一次性上传的文件超过此大小时会被拒绝。': 'One-off uploads larger than this are rejected.',
    '同一 IP 每小时上传次数上限': 'Uploads per hour per IP',
    '只计一次性上传，实时日志的追加不受影响。填 0 表示不限制。':
      'Counts one-off uploads only; appending to a live log is not limited. 0 means unlimited.',
    '实时日志闲置自动完结（小时）': 'Finish idle live logs after (hours)',
    '实时日志在此时间内没有新消息时会被自动完结。':
      'A live log with no new messages for this long is finished automatically.',
    '单份实时日志大小上限（MB）': 'Maximum live log size (MB)',
    '实时日志累计的消息超过此大小后不再接收新消息。':
      'A live log stops accepting messages once it grows past this size.',
    '同一骰娘密钥可同时进行的实时日志数': 'Live logs in progress per bot key',
    '开放实时串流上传': 'Enable live streaming uploads',
    '立即清理过期日志': 'Delete expired logs now',
    '保存设置': 'Save settings',
    '设置已保存。': 'Settings saved.',

    // ── 设置：站点配置 ──
    '站点配置': 'Site configuration',
    '染色器地址': 'Renderer URL',
    '用于生成日志的分享链接，并放行该来源的跨域请求。':
      'Used to build share links; cross-origin requests from it are allowed.',
    '额外放行的来源': 'Additional allowed origins',
    '除染色器外允许跨域访问的网址，多个以逗号分隔。':
      'Other origins allowed to make cross-origin requests, separated by commas.',
    '旧站地址': 'Legacy site URL',
    '本站查不到的日志会转去该地址读取；留空则不转。':
      'Logs not found here are read from this site; leave empty to disable.',
    '访客 IP 请求头': 'Visitor IP header',
    '反向代理或 CDN 传递访客真实 IP 的请求头；留空则使用连接地址。':
      'Header in which the reverse proxy or CDN passes the visitor IP; leave empty to use the connection address.',
    '骰娘密钥校验地址': 'Bot key verification URL',
    'BDC 账号站校验骰娘密钥的接口地址。': 'Endpoint of the BDC account site that verifies bot keys.',
    '骰娘密钥校验凭据': 'Bot key verification token',
    '与 BDC 账号站约定的凭据。': 'Token agreed with the BDC account site.',
    '可用的骰娘密钥校验方式': 'Bot key verification in use',
    '本站签发的骰娘密钥': 'bot keys issued by this site',
    '配置文件中列出的骰娘密钥': 'bot keys listed in the configuration file',
    'BDC 账号站': 'BDC account site',
    '未配置，实时串流与骰娘查询不可用': 'Not configured; live streaming and bot queries are unavailable',
    '已设置，留空则不修改': 'Set; leave empty to keep it',
    '尚未设置': 'Not set',
    '保存站点配置': 'Save site configuration',
    '站点配置已保存，立即生效。': 'Site configuration saved and in effect.',

    // ── 设置：存储位置 ──
    '位置': 'Location',
    '路径': 'Path',
    '日志数': 'Logs',
    '在线': 'Online',
    '未初始化': 'Not initialized',
    '离线': 'Offline',
    '配置中已移除': 'Removed from configuration',
    '写入位置': 'Write target',
    '迁出中': 'Moving out',
    '初始化': 'Initialize',
    '重新初始化': 'Initialize again',
    '初始化存储位置': 'Initialize storage location',
    '存储位置已初始化。': 'Storage location initialized.',
    '设为写入位置': 'Set as write target',
    '更改写入位置': 'Change write target',
    '更改': 'Change',
    '写入位置已更改。': 'Write target changed.',
    '停止迁出': 'Stop moving out',
    '已停止迁出。': 'Stopped moving out.',
    '迁出日志': 'Move logs out',
    '迁出': 'Move out',
    '已开始迁出。': 'Moving out started.',
    '日志上传后先写入本地缓存，随后搬往写入位置。存储位置在服务器的 .env 文件 STORAGES 中增减，修改后需重启服务。':
      'Uploads are written to the local cache first, then moved to the write target. Locations are added or removed in STORAGES in the server .env file; restart the service afterwards.',
    '立即搬运': 'Move now',

    // ── 设置：旧站迁移 ──
    '旧站迁移': 'Legacy site migration',
    '开始迁移': 'Start migration',
    '停止': 'Stop',
    '已保存，留空则沿用': 'Saved; leave empty to reuse it',
    '正在停止……': 'Stopping…',
    '正在迁移……': 'Migrating…',
    '按旧站的索引把全部日志迁到本站，保留原来的 Key、密码与创建时间。':
      'Copies every log listed in the legacy site index to this site, keeping its key, password and creation time.',
    '索引内容': 'Index content',
    '在 EdgeOne Pages 控制台的 KV 存储中打开键 0Aindex，把它的值完整贴到这里。':
      'In the EdgeOne Pages console, open the key 0Aindex in KV storage and paste its whole value here.',
    '导出令牌': 'Export token',
    '旧站部署了索引导出接口时填写，可代替上面的索引内容。':
      'Fill this in if the legacy site has the index export endpoint; it replaces the index content above.',
    '本站已有的日志会跳过，可随时停止并再次执行。':
      'Logs already on this site are skipped. You can stop at any time and run it again.',

    // ── 骰娘密钥 ──
    '骰娘密钥': 'Bot keys',
    '签发骰娘密钥': 'Issue bot keys',
    '用这把密钥上传的日志会记到该骰娘号名下；可留空。': 'Logs uploaded with the key are recorded under this bot ID; may be left empty.',
    '用于辨认这把密钥，例如骰娘的名字。': 'Helps you recognise the key, for example the bot name.',
    '数量': 'Quantity',
    '一次可签发 1–50 把；多把时备注后会加上序号。': 'Issue 1–50 keys at once; with several, a number is added to the note.',
    '持有骰娘密钥的骰娘可以上传实时日志，并查询自己名下的日志。':
      'A bot holding a key can upload live logs and query the logs recorded under it.',
    '签发': 'Issue',
    '已签发的骰娘密钥': 'Issued bot keys',
    '尚未签发骰娘密钥。': 'No bot keys have been issued.',
    '（无备注）': '(no note)',
    '密钥开头': 'Key starts with',
    '最后使用': 'Last used',
    '从未使用': 'Never',
    '启用': 'Enabled',
    '已停用': 'Disabled',
    '停用': 'Disable',
    '骰娘密钥已签发': 'Bot keys issued',
    '密钥只显示这一次，关闭后无法再次查看，请立即保存。':
      'The keys are shown only this once and cannot be viewed again after closing. Save them now.',
    '已复制。': 'Copied.',
    '删除骰娘密钥': 'Delete bot key',
    '骰娘密钥已删除。': 'Bot key deleted.',
    '备注不得超过 100 个字符。': 'The note must not exceed 100 characters.',
    '签发数量须为 1–50 的整数。': 'The quantity must be an integer from 1 to 50.',
    '骰娘密钥的数量已达上限。': 'The maximum number of bot keys has been reached.',
    '该骰娘密钥不存在。': 'That bot key does not exist.',

    // ── IP 封锁 ──
    'IP 封锁': 'IP blocking',
    '手动封锁': 'Block manually',
    'IP 或网段': 'IP or range',
    '单个 IP，或 IPv4 网段（如 1.2.3.0/24）。': 'A single IP, or an IPv4 range such as 1.2.3.0/24.',
    '封锁时长（小时）': 'Block duration (hours)',
    '填 0 表示永久封锁。': '0 blocks permanently.',
    '理由': 'Reason',
    '被封锁的 IP 访问本站的任何地址都会被拒绝。内网与本机地址不会被封锁。':
      'A blocked IP is refused on every address of this site. Private and loopback addresses are never blocked.',
    '封锁': 'Block',
    '已加入封锁名单。': 'Added to the block list.',
    '封锁名单': 'Block list',
    '封锁名单是空的。': 'The block list is empty.',
    '自动': 'Automatic',
    '手动': 'Manual',
    '封锁时间': 'Blocked at',
    '永久': 'Permanent',
    '解除': 'Unblock',
    '已解除封锁。': 'Unblocked.',
    '自动封锁': 'Automatic blocking',
    '启用自动封锁': 'Enable automatic blocking',
    '可疑请求次数': 'Suspicious requests',
    '达到此次数即封锁。可疑请求指被拒绝、地址或日志不存在、触发限频的请求。':
      'An IP is blocked when it reaches this count. Suspicious means refused, not found, or rate-limited.',
    '统计时间（分钟）': 'Counting window (minutes)',
    '在这段时间内累计上面的次数。': 'The count above is accumulated over this period.',
    '请填写有效的 IP 地址或 IPv4 网段（如 1.2.3.4 或 1.2.3.0/24）。':
      'Enter a valid IP address or IPv4 range, such as 1.2.3.4 or 1.2.3.0/24.',
    '内网与本机地址不会被封锁。': 'Private and loopback addresses are never blocked.',
    '不能封锁您当前使用的 IP。': 'You cannot block the IP you are using now.',
    '封锁时长须为 0–87600 的整数小时。': 'The duration must be a whole number of hours from 0 to 87600.',
    '该封锁记录不存在。': 'That block entry does not exist.',

    // ── 账号 ──
    '修改密码': 'Change password',
    '当前密码': 'Current password',
    '新密码': 'New password',
    '确认新密码': 'Confirm new password',
    '两次输入的新密码不一致。': 'The two new passwords do not match.',
    '密码已修改，其他设备上的登录状态已失效。': 'Password changed. Sessions on other devices have been signed out.',
    '忘记密码时，请在服务器执行 node cli.mjs reset-admin 后重新设置账号。':
      'If you forget the password, run "node cli.mjs reset-admin" on the server and set up the account again.',

    // ── 服务器返回的提示 ──
    '名称须为 1–200 个字符。': 'The name must be 1–200 characters.',
    '备注不得超过 500 个字符。': 'The note must not exceed 500 characters.',
    '尚未登录或登录已过期。': 'Not signed in, or the session has expired.',
    '尝试次数过多，请稍后再试。': 'Too many attempts. Please try again later.',
    '当前写入位置不能迁出。': 'The current write target cannot be moved out.',
    '当前密码不正确。': 'The current password is incorrect.',
    '旧站地址须以 http:// 或 https:// 开头。': 'The legacy site URL must start with http:// or https://.',
    '本地缓存中的日志会自动搬往写入位置。': 'Logs in the local cache are moved to the write target automatically.',
    '本地缓存无需初始化。': 'The local cache does not need initializing.',
    '用户名或密码不正确。': 'Incorrect username or password.',
    '用户名须为 3–32 位的字母、数字、下划线、点或短横线。':
      'The username must be 3–32 letters, digits, underscores, dots or hyphens.',
    '登录失败次数过多，请稍后再试。': 'Too many failed sign-ins. Please try again later.',
    '站点配置的格式不正确。': 'The site configuration is not valid.',
    '管理员账号已存在。': 'The administrator account already exists.',
    '索引内容不是有效的 JSON。': 'The index content is not valid JSON.',
    '索引内容的格式不对：应为键 0Aindex 的完整值，其中 logs 是日志条目的数组。':
      'The index content has the wrong shape: it should be the whole value of the key 0Aindex, with logs as an array of entries.',
    '设置码不正确。': 'The setup code is incorrect.',
    '该存储位置不存在。': 'That storage location does not exist.',
    '该存储位置尚未初始化。': 'That storage location has not been initialized.',
    '该存储位置当前不可用。': 'That storage location is currently unavailable.',
    '该日志不存在。': 'That log does not exist.',
    '该日志已完结。': 'That log is already finished.',
    '请求来源不合法。': 'The request origin is not allowed.',
    '请贴入索引内容，或填写导出令牌。': 'Paste the index content or enter the export token.',
    '请选择 1–1000 份日志。': 'Select 1–1000 logs.',
    '迁移正在进行中。': 'A migration is already running.',
    '密码长度须为 8–128 个字符。': 'The password must be 8–128 characters.',
    '染色器地址须为有效的网址，且不能留空。': 'The renderer URL must be a valid URL and cannot be empty.',
    '额外放行的来源须为网址，多个以逗号分隔。': 'Additional origins must be URLs, separated by commas.',
    '旧站地址须为有效的网址。': 'The legacy site URL must be a valid URL.',
    '骰娘密钥校验地址须以 http:// 或 https:// 开头。': 'The bot key verification URL must start with http:// or https://.',
    '请求头名称只能包含字母、数字与短横线。': 'A header name may contain only letters, digits and hyphens.',
    '旧站没有索引导出接口。请改为贴入索引内容，或先在旧站部署该接口。':
      'The legacy site has no index export endpoint. Paste the index content instead, or deploy the endpoint there first.',
    '旧站返回的索引格式不对。': 'The legacy site returned an index in the wrong format.',
    '导出令牌不正确。': 'The export token is incorrect.',
    '接口不存在。': 'No such endpoint.',
    '索引条目格式不对': 'malformed index entry',
    '日志内容为空': 'the log is empty',
  };

  var PATTERNS = [
    [/^日志留存 (\d+) 天$/, 'Logs kept for $1 days'],
    [/^请求失败（HTTP (\d+)）。$/, 'Request failed (HTTP $1).'],
    [/^已选择 (\d+) 份日志$/, '$1 logs selected'],
    [/^将删除所选的 (\d+) 份日志，删除后无法恢复。$/, 'This deletes the $1 selected logs. It cannot be undone.'],
    [/^已删除 (\d+) 份日志。$/, '$1 logs deleted.'],
    [/^已删除 (\d+) 份过期日志。$/, '$1 expired logs deleted.'],
    [/^选择 (.+)$/, 'Select $1'],
    [/^共 (\d+) 份，第 (\d+) \/ (\d+) 页$/, '$1 logs, page $2 of $3'],
    [/^每页 (\d+) 份$/, '$1 per page'],
    [/^将删除日志「([\s\S]*)」，删除后无法恢复。$/, 'This deletes the log "$1". It cannot be undone.'],
    [/^将完结日志「([\s\S]*)」，完结后骰娘无法继续向它追加消息。$/, 'This finishes the log "$1". The bot can no longer append to it.'],
    [/^共 (\d+) 条消息，以下为前 (\d+) 条：$/, '$1 messages; the first $2 are shown:'],
    [/^共 (\d+) 条消息：$/, '$1 messages:'],
    [/^自动封锁：(\d+) 分钟内出现 (\d+) 次可疑请求$/, 'Automatic: $2 suspicious requests within $1 minutes'],
    [/^将删除骰娘密钥「([\s\S]*)」，使用它的骰娘将无法再上传实时日志或查询日志。$/,
      'This deletes the bot key "$1". Bots using it can no longer upload live logs or query logs.'],
    [/^将在「([\s\S]*)」写入标记文件，之后该位置可用于存放日志。请先确认该目录已正确挂载。$/,
      'This writes a marker file in "$1", after which the location can hold logs. Make sure the directory is mounted correctly first.'],
    [/^之后上传的日志将存放到「([\s\S]*)」，已存放在其他位置的日志保持原处。$/,
      'New uploads will be stored in "$t1". Logs already stored elsewhere stay where they are.'],
    [/^将把「([\s\S]*)」中的 (\d+) 份日志搬往当前写入位置。$/, 'This moves the $2 logs in "$1" to the current write target.'],
    [/^等待搬运的日志：(\d+) 份；等待删除的文件：(\d+) 份。$/, 'Logs waiting to be moved: $1. Files waiting to be deleted: $2.'],
    [/^已保存 (\d+) 条索引，留空则沿用$/, '$1 index entries saved; leave empty to reuse them'],
    [/^上次迁移结束于 (.+)。$/, 'The last migration finished at $1.'],
    [/^已处理 (\d+) \/ (\d+) 份：新迁入 (\d+)，本站已有 (\d+)，旧站已不存在 (\d+)，冲突 (\d+)，失败 (\d+)。$/,
      'Processed $1 of $2: $3 migrated, $4 already here, $5 no longer on the legacy site, $6 conflicts, $7 failed.'],
    [/^(.+)：本站已有同名但密码不同的日志，未迁移$/, '$1: a log with the same key but a different password already exists here; not migrated'],
    [/^(.+)：日志内容为空$/, '$1: the log is empty'],
    [/^(.+)：索引条目格式不对$/, '$1: malformed index entry'],
    [/^设置项的取值须为 (-?\d+)–(\d+) 的整数。$/, 'The value must be an integer from $1 to $2.'],
    [/^无法写入该位置：([\s\S]*)$/, 'Cannot write to that location: $1'],
    [/^写入位置「(.+)」当前不可用，日志暂留在原处。$/, 'The write target "$1" is unavailable; logs stay where they are for now.'],
    [/^存储位置「(.+)」当前不可用，暂不迁出。$/, 'The storage location "$1" is unavailable; not moving out for now.'],
  ];

  var lang = 'zh';
  try {
    var saved = window.localStorage.getItem('dnlog-lang');
    if (saved === 'zh' || saved === 'en') lang = saved;
    else if (!/^zh\b/i.test(navigator.language || '')) lang = 'en';
  } catch (err) {
    if (!/^zh\b/i.test(navigator.language || '')) lang = 'en';
  }

  function t(text) {
    if (lang === 'zh' || typeof text !== 'string' || !text) return text;
    if (Object.prototype.hasOwnProperty.call(EN, text)) return EN[text];
    for (var i = 0; i < PATTERNS.length; i++) {
      var match = PATTERNS[i][0].exec(text);
      if (match) {
        return PATTERNS[i][1].replace(/\$(t?)(\d)/g, function (whole, translate, index) {
          var value = match[Number(index)];
          return translate ? t(value) : value;
        });
      }
    }
    return text;
  }

  function setLang(next) {
    try {
      window.localStorage.setItem('dnlog-lang', next);
    } catch (err) { /* 存不了就只在本次生效不了，刷新后按浏览器语言 */ }
    window.location.reload();
  }

  return { lang: lang, t: t, setLang: setLang, EN: EN, PATTERNS: PATTERNS };
})();
