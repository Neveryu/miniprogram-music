# Meting-API 使用说明

## 1. 服务概览

项目按平台路由两个 Meting-API 实例：

| 平台（`server`） | 接口地址 |
| --- | --- |
| `netease` 网易云 | `https://meting.mikus.ink/api` |
| `tencent` QQ 音乐、`kugou` 酷狗、`wydt` 网易电台 | `https://api.i-meto.com/meting/api` |

当前未配置备用回退接口（云函数中 `getFallbackMusicApiUrl` 返回空），主接口失败时直接向客户端返回错误。

普通歌曲搜索、播放地址、封面和歌词由 `musicApp` 云函数访问；网易云歌单、用户及歌单歌曲详情由小程序通过 jusic-serve 的 WebSocket 通道访问。QQ 歌单和 QQ 用户歌单歌曲同样通过 jusic-serve 获取元数据，不拼接 Meting 播放地址；QQ 播放地址由 `musicApp` 云函数按 `songmid` 调用 `meting.mikus.ink` 的 `type=song` 详情接口动态解析（详见第 5 节）。

服务项目地址：

```text
https://github.com/mikus-loli/Meting-API
```

## 2. 请求格式

基础请求格式：

```text
GET /api?server={server}&type={type}&id={id}
```

完整示例：

```text
https://meting.mikus.ink/api?server=netease&type=search&id=晴天
```

公共参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `server` | 是 | 音乐平台，`netease`、`tencent`、`kugou` 或 `wydt` |
| `type` | 是 | 数据类型 |
| `id` | 是 | 歌曲 ID、歌单 ID、歌手 ID 或搜索词 |
| `auth` | 否 | 服务端配置的授权参数，按实例配置使用 |
| `r` | 否 | 部分前端插件使用的附加参数 |

参数必须进行 URL 编码，尤其是中文搜索词和包含特殊字符的 ID。

## 3. 数据类型

| `type` | 作用 | 网易云 | QQ 音乐 | 酷狗 |
| --- | --- | --- | --- | --- |
| `song` | 获取单曲信息 | 支持 | 支持 | 支持 |
| `playlist` | 获取歌单歌曲 | 支持 | 支持 | 支持 |
| `artist` | 获取歌手歌曲 | 支持 | 不支持 | 支持 |
| `search` | 搜索歌曲 | 支持 | 支持 | 支持 |
| `url` | 获取播放地址 | 支持 | 支持 | 支持 |
| `lrc` | 获取歌词 | 支持 | 支持 | 支持 |
| `pic` | 获取封面地址 | 支持 | 支持 | 支持 |

平台值：

```text
netease   网易云音乐
tencent   QQ音乐
kugou     酷狗音乐
wydt      网易云电台节目
```

## 4. 网易云歌单与用户页面接口

搜索点歌页支持以下网易云资源链路：

```text
搜索歌单 → 打开歌单详情 → 查看歌曲并点歌
搜索用户 → 打开用户公开歌单 → 打开歌单详情 → 查看歌曲并点歌
```

这部分使用 `utils/jusicWsApi.js` 连接 jusic-serve 的 SockJS + STOMP 通道。当前线上服务地址为：

```text
wss://xin.hanxin.vip/server/{serverId}/{sessionId}/websocket
```

连接前会请求 `https://xin.hanxin.vip/server/info?t=...` 获取 SockJS 能力信息；当响应提供 `Set-Cookie` 时，封装层会提取 Cookie 并带入 WebSocket 握手。即使微信运行环境不暴露该响应头，封装层仍会尝试建立连接，因为服务端允许无 Cookie 的连接路径。

连接地址中的 `serverId` 为 `100` 到 `999` 的随机编号，`sessionId` 为随机会话字符串。WebSocket 打开后先收到 SockJS `o` 帧，再发送：

```text
CONNECT\naccept-version:1.1,1.0\nheart-beat:0,0\n\n\\0
```

只有收到 STOMP `CONNECTED` 后才发送业务 `SEND` 帧。业务请求按响应类型串行关联；取消已发送的请求会关闭并重建连接，以避免服务端迟到响应关联到下一次同类型请求。

| 页面能力 | STOMP destination | 请求参数重点 | 响应类型 |
| --- | --- | --- | --- |
| 搜索歌单 | `/music/searchsonglist` | `name`、`source=wy`、`pageIndex`、`pageSize` | `SEARCH_SONGLIST` |
| 搜索用户 | `/music/searchuser` | `nickname`、`source=wy`、`pageIndex`、`pageSize` | `SEARCH_USER` |
| 获取用户歌单 | `/music/searchsonglist` | `name=用户 ID`、`source=wy_user` | `SEARCH_SONGLIST` |
| 获取歌单歌曲 | `/music/search` | `name=*歌单 ID`、`source=wy` | `SEARCH` |

服务使用 SockJS 包装消息，例如 `a["TYPE\\n...\\n\\n{json}"]`。分页数据位于响应的 `data.data`，总数位于 `data.totalSize`。封装层会把原始字段转换为小程序统一的歌单、用户和歌曲结构，小程序不直接请求网易云接口。


`song`、`playlist`、`artist`、`search` 通常返回 JSON 数组。搜索结果示例：

```json
[
  {
    "title": "晴天",
    "author": "周杰伦",
    "pic": "https://p1.music.126.net/example.jpg",
    "url": "https://meting.mikus.ink/api?server=netease&type=url&id=186016",
    "lrc": "https://meting.mikus.ink/api?server=netease&type=lrc&id=186016"
  }
]
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `title` | 歌曲名称 |
| `author` | 歌手名称 |
| `pic` | 封面地址 |
| `url` | 播放地址接口地址 |
| `lrc` | 歌词接口地址 |

`url` 和 `lrc` 结果中的歌曲 ID 是项目使用的媒体 ID。Meting-API 的搜索结果本身没有单独的 `id` 字段，云函数从这两个接口地址的 `id` 参数中提取媒体 ID。

`type=url` 的响应可能是纯文本播放地址，也可能通过 HTTP 302 重定向到音频地址。小程序先把接口地址提交给 `musicApp` 云函数，由云函数解析重定向并返回 HTTPS 音频地址，再交给微信背景音频播放器。

`type=pic` 通常通过 HTTP 302 重定向到图片地址。

`type=lrc` 返回纯文本歌词，包含类似以下格式的时间标签：

```text
[00:28.950]故事的小黄花
```

云函数会把歌词文本转换成小程序现有播放器使用的结构：

```json
[
  {
    "time": 28.95,
    "lineLyric": "故事的小黄花"
  }
]
```

## 5. 项目接口映射

小程序的普通歌曲搜索仍调用 `musicApp` 云函数；网易云歌单、用户、用户歌单和歌单歌曲详情，以及 QQ 歌单、QQ 用户歌单和 QQ 歌单歌曲，使用 `jusicWsApi.js` 的 WebSocket 通道，不直接请求 Meting-API：

| 小程序能力 | 服务 | 用途 |
| --- | --- | --- |
| `song/search` | `musicApp` 云函数 → 对应平台 Meting-API `type=search` | 普通歌曲搜索（含网易云电台节目） |
| `song/getLrc` | `musicApp` 云函数 → Meting-API `type=lrc` | 网易云歌词；QQ 与电台歌曲返回空歌词 |
| `song/getUrl`（网易/酷狗） | `musicApp` 云函数 → Meting-API `type=url` 或详情接口 | 解析实际播放地址 |
| `song/getUrl`（QQ） | `musicApp` 云函数 → `meting.mikus.ink` `type=song` 详情接口 | 按 `songmid` 动态解析带签名播放地址 |
| 网易云歌单、用户及详情 | `jusicWsApi.js` → jusic-serve STOMP destination | 搜索资源和获取歌单歌曲 |
| QQ 歌单、用户歌单及详情 | `jusicWsApi.js` → jusic-serve STOMP destination | 搜索资源和获取 QQ 歌单歌曲 |
| 歌曲封面 | WS 或搜索结果中的封面字段 | 显示封面 |

### QQ 播放地址解析

QQ 歌曲不持久化播放地址（`validateSong` 对 tencent 来源清空 `url` 字段）。播放时云函数执行 `resolveTencentMusicUrl`：

1. 调用 `https://meting.mikus.ink/api?server=tencent&type=song&id={songmid}` 获取详情。
2. 从返回数组中取出带 `url` 的条目，校验其 `url` 参数中的 `id` 与 `songmid` 一致，不一致视为资源不可用。
3. 请求该签名 `url` 并跟随重定向，得到最终 HTTPS 音频地址。

`type=song` 详情接口免鉴权且返回带签名的 `url`/`lrc` 地址，云函数对详情结果做 3 分钟短时缓存（`musicDetailCache`）避免重复请求；歌词解析同样复用该详情地址。

内部歌曲结构：

```json
{
  "source": "netease",
  "mid": "5257138",
  "name": "屋顶",
  "singer": "周杰伦 / 温岚 / 吴宗宪",
  "album": "男女情歌对唱冠军全记录",
  "pic": "https://p1.music.126.net/example.jpg",
  "url": "https://meting.mikus.ink/api?server=netease&type=url&id=5257138",
  "lrc": "https://meting.mikus.ink/api?server=netease&type=lrc&id=5257138"
}
```

歌单详情页拿到的歌曲对象会直接交给现有的点歌、收藏和播放菜单；播放地址仍由 `musicApp` 云函数解析为最终 HTTPS 音频地址。

## 6. 自动补歌

播放队列不足时（目标数量 1~5 首，默认 3 首），云函数 `refillQueue` 并行准备三个来源的可播放候选：

1. 当前用户收藏（`playlists`，最多取 100 条候选）。
2. 房间缓存的备用歌曲（`rooms.backup_songs`，最多缓存 10 首）。
3. 房间 `search_prompts` 随机提示词的网易云搜索结果。

三个来源按权重 `REFILL_SOURCE_WEIGHTS`（favorite:cache:prompt = 5:3:2）随机混入队列，单一来源不再独占补歌；某来源为空时权重自动让渡给其余来源。候选歌曲先经 `filterPlayableSongs` 验证播放地址可解析（1.2 秒超时）才入队；入队项带 `auto_added: true` 和 `backup_source`（favorite/cache/prompt）标记。为避免反复补入同一批歌曲：收藏、缓存和提示词搜索候选均随机打乱后取样，且补歌会排除 `rooms.recent_played` 中记录的最近 20 首已播歌曲（歌曲成为当前播放时写入）。提示词搜索成功时同步刷新 `backup_songs` 缓存。补歌过程通过 `refill_lock_until`（15 秒锁）和 `refill_lock_token` 防止并发重复补充，并可通过定时触发器 `refillPlaybackQueue` 周期性执行。队列排空时房间进入 `auto_refill_paused` 状态，下次补歌或切歌时恢复。

## 7. 管理能力

Meting-API 服务本身还提供管理后台和服务端管理能力，包括：

- 网易云音乐和 QQ 音乐 Cookie 管理。
- VIP 播放能力检测。
- QQ 音乐 Cookie 自动刷新。
- Cookie 定时监测。
- Gotify、企业微信、钉钉和飞书 Webhook 通知。
- 后台用户、角色和操作日志管理。
- 登录失败锁定。
- TOTP 双因素认证。
- 管理后台路径配置。

这些管理功能不由小程序调用。小程序只使用基础音乐数据接口，不保存或传递音乐平台 Cookie、后台账号、后台 Token 或 2FA 秘钥。

## 8. 部署和地区限制

服务支持 Node.js、Docker、Vercel 和 Cloudflare Workers 等部署方式。Vercel 和 Cloudflare Workers 主要提供基础 API，不支持依赖文件系统的管理后台功能。

QQ 音乐接口受服务部署地区和音乐版权限制影响，项目当前默认使用网易云音乐。正式环境应验证目标用户所在地区、歌曲版权状态、音频 URL 有效期和小程序播放器兼容性。

## 9. 安全与合规注意事项

- 不在小程序客户端保存音乐平台 Cookie。
- 不把 Meting-API 管理后台凭据写入仓库或云函数响应。
- 不把管理 API 暴露给小程序用户。
- 云函数对搜索词、歌曲 ID 和返回数据进行长度、类型和协议校验。
- 音乐资源的可用性和版权由第三方服务及其上游平台决定。
- 生产环境应设置 API 访问监控、错误告警和必要的请求频率限制。

## 10. 当前限制

- `song/search` 按页面选择的平台搜索歌曲，支持 `netease`、`tencent`、`kugou` 和 `wydt`；当前没有备用回退接口，主接口失败直接报错。
- QQ 歌单和 QQ 用户歌单歌曲通过 jusic-serve 返回 QQ `songmid`、歌曲名称、歌手、专辑、封面和时长，不在小程序侧拼接 Meting 地址。播放时由云函数按 `songmid` 调用 Meting 详情接口动态解析；如果 QQ 返回的歌曲需要登录、购买或受地区版权限制，云函数会返回“歌曲播放资源不可用”，不会把无效地址交给播放器。
- `wydt` 电台节目必须在搜索结果中自带可播放 `url`，缺少播放地址的歌曲会被 `validateSong` 拒绝；电台节目不参与歌词解析，也不会进入自动补歌候选。
- `song/getUrl` 仅在播放资源明确失效（HTTP 401/403/404/500 或重定向到 404 页）时重新解析地址，网络错误和超时不触发重解析。
- 酷狗歌曲搜索和播放资源仍依赖 Meting 上游接口；酷狗封面可能返回 HTTP 500，云函数不持久化酷狗封面地址。正式发布前需要在目标云函数地区和实际设备上重新验证。
- Meting-API 的 `song`、`playlist` 和 `artist` 是通用数据类型；小程序的网易云歌单和用户资源页面使用 jusic-serve WebSocket，不直接调用这些 Meting-API action。
- 播放地址可能因版权、Cookie、地区或临时 URL 失效。
- `pic` 搜索结果可能返回 HTTP 地址，云函数会将其转换为 HTTPS；若上游不支持 HTTPS，封面仍可能加载失败。
- 服务返回内容可能随上游平台调整，云函数保留适配和错误转换层。

## 11. 参考资料

- 官方站点：https://meting.mikus.ink/
- API 入口：https://meting.mikus.ink/api
- GitHub：https://github.com/mikus-loli/Meting-API
- MetingJS：https://github.com/xizeyoupan/MetingJS
