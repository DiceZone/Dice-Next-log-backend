# Dice!Next Log Service

Dice!Next 的跑团日志存储后端。

- **一次性上传**：与原 `story-painter-eobackend` 的接口路径、参数、回应格式完全一致，旧客户端无需改动。
- **实时串流**：骰娘在跑团进行中逐条上传消息，观众可即时观看；完结后自动成为一份普通日志，分享链接不变。
- **后台管理**：按名称、骰娘号、群号、参与者查询日志，查看、修改、批量删除，设置保留期限与站点配置。
- **零依赖**：只需要 Node.js，数据存在本地 SQLite 与磁盘文件，不需要另装数据库，也没有 `npm install`。

## 运行

需要 Node.js 22.15 或以上。

```bash
cp .env.example .env      # 至少填写 FRONTEND_URL
node server.mjs
```

或使用 Docker：

```bash
cp .env.example .env
mkdir -p data && chown 1000:1000 data    # 容器以 uid 1000 运行
docker compose up -d --build
```

`DATA_DIR`（默认 `./data`）里的 `logs.db` 是中继资料，`blobs/` 是日志本体的本地缓存。没有另设存储位置时，备份这个目录即可。

### 存储位置

日志本体可以放到别的地方（例如挂载到本机的对象存储），数据库与缓存仍留在本地磁盘：

1. 在 `.env` 的 `STORAGES` 里登记位置，格式为 `名称=路径`，多个用逗号分隔。Docker 部署时先在 `docker-compose.yml` 把挂载点映射进容器，`STORAGES` 写容器内的路径。
2. 重启服务，进入后台「设置 → 存储位置」，对新位置执行「初始化」，再「设为写入位置」。

之后的流程：

- 上传的日志先写入本地缓存，立刻可读；后台搬运程序随即把它搬到写入位置，核对大小无误后才删除本地那份。
- 写入位置不可用时（例如挂载掉线），日志留在缓存里照常可读，位置恢复后自动补搬。
- 可以登记多个位置并随时更改写入位置；已存放的日志留在原处照常读取。需要腾空某个位置时，对它执行「迁出日志」，其中的日志会搬往当前写入位置。
- 初始化时会在位置根目录写入标记文件 `.dnlog-storage`，服务靠它判断位置是否在线，请勿删除。

环境变量的说明见 [.env.example](.env.example)。染色器地址、旧站地址、骰娘密钥校验地址等站点配置在 `.env` 里的值只是首次启动时的默认值，之后在后台「设置 → 站点配置」修改，保存后立即生效，不需要重启。

版本号是建置日期（如 `v20261115`）：建置镜像时写入，直接从源码运行时取源码的最新修改日期。

### 首次设置管理员

启动时若还没有管理员账号，控制台会输出一组**设置码**：

```
尚未建立管理员账号。请打开 /admin 完成首次设置，设置码：
    3f9a1c0b7e2d
```

打开 `/admin`，填入设置码、用户名和密码即可。Docker 部署时用 `docker logs dice-next-log-backend` 查看。

### 重置管理员密码

在服务器上执行（服务不必停止）：

```bash
node cli.mjs reset-admin
```

Docker 部署：

```bash
docker exec dice-next-log-backend node cli.mjs reset-admin
```

该指令会清除管理员账号与全部登录状态，并输出新的设置码，之后打开 `/admin` 重新设置。

## 接口

### 兼容接口（与旧站一致）

| 方法 | 路径 | 说明 |
|---|---|---|
| `PUT` | `/api/dice/log` | 一次性上传。`multipart/form-data`：`name`、`uniform_id`、`file`，可选 `client`（`SealDice` / `Parquet` / `DiceNext`，默认 `SealDice`）。回应 `{"url": "<染色器地址>?key=XXXX#123456"}` |
| `GET` | `/api/dice/load_data?key=&password=` | 读取日志。回应 `{client, created_at, data, name, note, updated_at}`，`data` 为 base64 |
| `PUT` | `/api/dice/backup-upload` | 其他站点转发的上传。JSON：`{uniform_id, name, logdata}`，`logdata` 为 base64 |
| `PUT` `POST` | `/api/dice/w4123` | 旧版 Dice! Lua 插件。`multipart/form-data` 上传纯文字日志，或 JSON `{uniform_id, name, logdata}` |

上传时可以多带几项（都可省略，旧客户端不受影响）：

- 表单字段 `group_id`：群号。
- 表单字段 `bot_id`：骰娘号。省略时取 `uniform_id` 冒号后面的部分。
- 请求头 `Authorization: Bearer <骰娘密钥>`：日志记到这把骰娘密钥名下，骰娘号以 BDC 账号站登记的为准。骰娘密钥无效时照常接收，只是不记归属。

参与者不需要上传：服务会从日志内容里取出发过言的账号与昵称（Parquet 格式除外）。

与旧站的差别：

- `/api/dice/cleanup` 已移除，过期日志由服务每天清理一次，也可在后台手动执行。
- 本机存储失败时不再向其他站点转发（`backup-upload` 仍可接收别的站转发过来的日志）。
- 出错时不再回传程序堆栈。
- 新增限频：同一 IP 每小时的上传次数（后台可调），以及 `load_data` 连续读取失败的次数。

### 实时串流接口

需要在 `.env` 配置骰娘密钥校验方式（`BDC_VERIFY_URL` + `BDC_VERIFY_TOKEN`，或 `LIVE_STATIC_KEYS`）。

**1. 开始** `POST /api/v2/live/start`

```
Authorization: Bearer <骰娘密钥>
{"name": "团名", "uniform_id": "QQ:123456"}
```

```json
{"key": "aB3d", "password": "123456", "url": "https://…/?key=aB3d#123456", "token": "<会话令牌>", "last_seq": 0}
```

`url` 从这一刻起即可分享。之后的请求一律使用 `token`，骰娘密钥只在开始时发送一次。

**2. 追加** `POST /api/v2/live/{key}/append`

```
Authorization: Bearer <会话令牌>
{"events": [
  {"seq": 1, "op": "add", "item": {"nickname": "希亞", "IMUserId": "QQ:10001", "time": 1780000000,
                                    "message": ".r 1d100", "isDice": false, "rawMsgId": "abc"}},
  {"seq": 2, "op": "edit", "rawMsgId": "abc", "message": "修改后的内容"},
  {"seq": 3, "op": "delete", "rawMsgId": "abc"}
]}
```

- `item` 即海豹日志格式的一条消息，未列出的字段原样保留。
- `seq` 从 1 开始、逐条加一。**已收过的序号会被略过**，所以超时后原样重送是安全的。
- 序号出现缺口时回应 `409` 并带上 `last_seq`，客户端应从 `last_seq + 1` 重新发送。
- 成功回应 `{"success": true, "last_seq": 3}`。一批最多 500 条。

建议骰娘每 1–2 秒把累积的消息合成一批发送。

**3. 完结** `POST /api/v2/live/{key}/end`（`Authorization: Bearer <会话令牌>`）

回应 `{"success": true, "deleted": false, "url": "…"}`。没有任何消息的日志会被直接删除，此时 `deleted` 为 `true`、`url` 为 `null`。

长时间没有新消息的实时日志会被自动完结（时间在后台设置）。

**续写** `POST /api/v2/live/{key}/fork`

```
Authorization: Bearer <骰娘密钥>
{"password": "123456"}
```

以一份已有的日志为起点，另开一份新的实时日志：复制原有内容，发给新的 Key、密码与链接，之后各写各的，原日志不受影响。跑团中途换了骰娘，或想接着一份已完结的日志往下写时使用。

- `{key}` 与 `password` 是起点日志的；能读到那份日志才能以它为起点。
- 请求体可另带 `name`、`group_id`、`bot_id`、`uniform_id`，省略时名称与群号沿用起点日志。
- 回应与 `start` 相同，另带 `last_seq`（已复制的条数）与 `forked_from`，之后从 `last_seq + 1` 继续追加。
- 进行中与已完结的日志都可以作为起点（Parquet 格式除外）。

**4. 观看**

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/dice/load_data?key=&password=` | 进行中的日志也能读，格式与普通日志相同，另带 `live: true` 与 `last_seq` |
| `GET` | `/api/v2/live/{key}/events?password=&after=<seq>` | 拉取 `after` 之后的事件：`{status, last_seq, events}`；`status` 为 `done` 时改用 `load_data` 读取全文 |
| `GET` | `/api/v2/live/{key}/stream?password=&after=<seq>` | SSE 推送。先补发 `after` 之后的事件，之后逐条推送；完结时发送 `event: end`。支持 `Last-Event-ID` 断线续传 |

SSE 经过 CDN 时可能被缓冲，这种情况下请改用 `events` 轮询。

`start` 的请求体可另带 `group_id`（群号）与 `bot_id`（骰娘号；骰娘密钥经 BDC 校验时以账号站登记的为准）。

**其他** `GET /api/v2/info` 返回站点名称、版本、保留期限、大小上限与是否开放实时串流。

### 骰娘查询自己的日志

`GET /api/v2/logs`（`Authorization: Bearer <骰娘密钥>`）

返回这把骰娘密钥名下的日志：用它上传或串流的，以及骰娘号与账号站登记一致的。

| 参数 | 说明 |
|---|---|
| `group_id` | 只看这个群的 |
| `participant` | 只看这个人参与过的（账号，或昵称的一部分） |
| `status` | `done` 或 `live` |
| `q` | 按名称搜索 |
| `page`、`page_size` | 分页，每页默认 20 份，最多 200 份 |

```json
{"total": 37, "page": 1, "page_size": 20, "items": [
  {"key": "aB3d", "password": "123456", "url": "https://…/?key=aB3d#123456", "name": "团名",
   "status": "done", "bot_id": "123456", "group_id": "7777", "item_count": 420, "size": 10240,
   "created_at": "…", "updated_at": "…",
   "participants": [{"user_id": "10001", "nickname": "希亞"}]}
]}
```

### 骰娘密钥从哪里来

实时串流、续写、骰娘查询都要带骰娘密钥。校验方式有三种，可以并存，按下面的顺序依次比对：

1. **本站签发**：在后台「骰娘密钥」页签发，可一次签发多把，可随时停用或删除。签发时填的骰娘号会记到日志上。密钥只在签发时显示一次，库里只存它的 SHA-256。自建站不接 BDC 时用这种。
2. **配置文件列出**：`.env` 的 `LIVE_STATIC_KEYS`，逗号分隔。只知道密钥有效，不知道是哪个骰娘。
3. **BDC 账号站**：在后台「设置 → 站点配置」填校验地址与凭据，协议见下。

三种都没有配置时，实时串流与骰娘查询不可用，一次性上传不受影响。

### BDC 账号站需要提供的校验接口

```
POST <骰娘密钥校验地址>
X-Log-Service-Token: <骰娘密钥校验凭据>
{"key_sha256": "<骰娘密钥的 SHA-256，十六进制>"}
```

回应 `{"valid": true, "platform": "onebot_v11", "bot_id": "123456", "bot_name": "…"}` 或 `{"valid": false}`。有效结果缓存 10 分钟、无效结果缓存 1 分钟；账号站暂时无法访问时，之前验过有效的骰娘密钥继续放行。

## 从旧站迁移

旧站（story-painter-eobackend）的日志可以整批迁入，保留原来的 key、密码与创建时间，旧的分享链接照常可用。

在后台「设置 → 旧站迁移」启动，页面会显示进度与结果。

旧站的读取接口读不到索引本身，所以索引要另外提供，两种方式任选：

- **贴入索引内容**：在 EdgeOne Pages 控制台的 KV 存储中打开键 `0Aindex`，把它的值完整贴进去。贴过一次会保存，再次执行不用重贴。
- **导出令牌**：旧站部署了索引导出接口 `GET /api/dice/export-index`（请求头 `X-Export-Token`）时，填令牌即可。

- 增量迁移：本站已有的日志直接跳过，不再向旧站读取。可以随时停止，再次执行时只补迁缺少的。
- 迁入的文件先落在本地缓存，随后搬到写入位置。
- 也可在服务器执行 `node cli.mjs import-legacy <旧站地址> <导出令牌>`。

导入完成前，可在后台「设置 → 站点配置」填写旧站地址，本站查不到的日志会转去旧站读取。导入完成、旧站域名改指向本站之后，把这一项清空。

## 测试

```bash
node test/e2e.mjs
```

会启动一个使用临时数据目录的服务进程，把全部接口走一遍。
