# 音乐接口与 WebSocket 说明

> 文件名保留历史路径，内容已迁移为 jusic-serve WebSocket 与网易云歌词说明。

## 1. 架构概览

项目不再依赖 Meting-API。音乐能力分为两部分：

| 能力 | 通道 | 说明 |
| --- | --- | --- |
| 歌曲、歌单、用户、电台搜索 | jusic-serve SockJS + STOMP | 小程序端 `utils/jusicWsApi.js` 直连，返回歌曲元数据 |
| 播放地址 | jusic-serve `/music/pick` | 点歌/播放前获取带签名的直链，随歌曲入队 |
| 网易云封面 | 网易云官方歌曲详情接口 | `song/getCovers` 批量补全搜索/收藏/队列中缺失的封面，命中后缓存 24 小时 |
| 网易云歌词 | 网易云官方歌词接口 | `musicApp` 云函数请求 `https://music.163.com/api/song/lyric`，并做 30 分钟缓存 |

搜索接口不返回 `url` 和 `lyric`；播放地址统一由点播帧下发。QQ 音乐与电台歌曲不提供歌词。

服务项目地址：

```text
https://xin.hanxin.vip/
```

## 2. WebSocket 连接

连接地址：

```text
wss://xin.hanxin.vip/server/{serverId}/{sessionId}/websocket
  ?houseId=DEFAULT&housePwd=&connectType=enter
```

- `serverId`：100 到 999 的随机编号。
- `sessionId`：随机会话字符串。
- 连接建立后会收到 SockJS `o` 开放帧，随后发送 STOMP `CONNECT`：

```text
CONNECT\naccept-version:1.1,1.0\nheart-beat:0,0\n\n\u0000
```

- 收到 `CONNECTED` 后才发送业务 `SEND` 帧。
- 业务响应由 SockJS `a["TYPE\\n...\\n\\n{json}"]` 包装，封装层按响应类型串行关联请求。
- 请求超时 15 秒；取消请求会关闭并重建连接，避免迟到响应串到下一次同类型请求。

## 3. 业务 Destination

| 能力 | Destination | 关键参数 | 响应类型 |
| --- | --- | --- | --- |
| 网易云歌曲搜索 | `/music/search` | `name`、`source=wy`、`pageIndex`、`pageSize` | `SEARCH` |
| QQ 歌曲搜索 | `/music/search` | `name`、`source=qq`、`pageIndex`、`pageSize` | `SEARCH` |
| 网易电台搜索 | `/music/search` | `name`、`source=wydt`、`pageIndex`、`pageSize` | `SEARCH` |
| 网易云歌单歌曲 | `/music/search` | `name=*歌单 ID`、`source=wy` | `SEARCH` |
| QQ 歌单歌曲 | `/music/search` | `name=*dissid`、`source=qq` | `SEARCH` |
| 搜索歌单 | `/music/searchsonglist` | `name`、`source=wy/qq`、分页 | `SEARCH_SONGLIST` |
| 搜索用户 | `/music/searchuser` | `nickname`、`source=wy`、分页 | `SEARCH_USER` |
| 用户公开歌单 | `/music/searchsonglist` | `name=用户 ID`、`source=wy_user` | `SEARCH_SONGLIST` |
| QQ 用户歌单 | `/music/searchsonglist` | `name=QQ 号`、`source=qq_user` | `SEARCH_SONGLIST` |
| 点歌 / 获取播放地址 | `/music/pick` | `id`、`name`、`artist`、`duration`、`source=wy/qq/wydt`、`quality=320k` | `PICK` |

分页数据位于响应的 `data.data`，总数位于 `data.totalSize`。

## 4. 搜索结果结构

`SEARCH` 只提供元数据，典型字段：

```json
{
  "id": "186016",
  "name": "晴天",
  "artist": "周杰伦",
  "album": { "name": "叶惠美", "picture_url": "" },
  "duration": 269000,
  "picture_url": ""
}
```

封装层转换为项目统一歌曲结构：

```json
{
  "source": "netease",
  "mid": "186016",
  "name": "晴天",
  "singer": "周杰伦",
  "album": "叶惠美",
  "pic": "https://p1.music.126.net/example.jpg",
  "url": "",
  "lrc": [],
  "duration": 269000
}
```

网易云 `SEARCH` 的 `picture_url` 和 `album.picture_url` 经常为空，QQ 搜索通常返回 `https://y.gtimg.cn/...` 封面。缺少封面时由客户端批量调用云函数 `song/getCovers`。

### 封面补全

```text
POST musicApp { action: "song/getCovers", payload: { mids: ["186016", ...] } }
→ 云函数请求 https://music.163.com/api/song/detail?ids=[...]
→ 读取 songs[].album.picUrl，返回 { "186016": "https://p1.music.126.net/..." }
```

- 单次最多 30 个 `mid`，由客户端自动分批。
- 搜索结果、歌单详情、收藏列表和播放队列都会在渲染后补全缺失封面。
- 网易云官方详情结果缓存 24 小时；查不到封面的歌曲短时缓存 10 分钟，避免重复请求。
- 接口失败时返回空对象，页面继续使用本地占位图。

## 5. 播放地址与点歌

搜索结果不带播放地址。点歌、收藏后播放或切换当前歌曲时，客户端先调用 `ensurePlayableSong`：

1. 若歌曲已有合法 HTTPS 直链（非 Meting 接口地址），直接复用。
2. 否则发送 `/music/pick`，服务端在 `PICK` 帧中返回队列快照。
3. 在 `PICK` 的 `data[]` 中按歌曲 `id` 匹配，取 `url` 字段。
4. 直链中的字面量 `\u0026` 还原为 `&`，`http://` 自动升级为 `https://`。
5. 获取成功的歌曲连同直链一起入队；歌单/搜索结果本身不写入直链。

直链带签名，可能过期。播放器触发 `onError` 时：

- 先重新 `/music/pick` 一次并重试播放；
- 仍失败则调用 `song/autoPass` 自动切歌。

`validateSong` 会丢弃历史数据中的 Meting 接口地址，只保留可用的音频直链，避免把失效地址交给播放器。

## 6. 歌词

网易云歌词由 `musicApp` 云函数请求：

```text
https://music.163.com/api/song/lyric?id={mid}&lv=1&kv=1&tv=-1
```

- 请求带浏览器 User-Agent 和 `Referer: https://music.163.com/`。
- 解析 `lrc.lyric` 文本，转换为 `{ time, lineLyric }` 数组。
- 结果缓存 30 分钟，超时 2 秒；失败时返回空数组。
- `song/getLrc` 对 QQ、电台和酷狗来源直接返回空歌词。

客户端只在播放网易云歌曲时请求歌词；QQ、电台歌曲不发起歌词请求。

## 7. 自动补歌

播放队列不足时：

1. 客户端通过 WS 搜索候选：
   - 正常模式：从房间 `search_prompts` 随机抽 1 个词搜索网易云，候选标记 `prompt`。
   - 儿歌模式：随机抽 1 个聚合词 + 2 个具体歌名词并行搜索，候选标记 `children`。
2. 客户端调用 `song/refill`，携带 `candidates` 数组。
3. 云函数同时准备：
   - 用户「我的歌曲」收藏（正常模式）或「儿歌」收藏（儿歌模式）。
   - 房间 `backup_songs` 缓存（仅正常模式）。
4. 正常模式按 `favorite:cache:prompt = 5:3:2`、儿歌模式按 `favorite:children = 3:2` 加权混入队列。
5. 入队项带 `auto_added: true` 和 `backup_source`，播放时再通过 WS 点播获取直链。

定时触发器 `refillPlaybackQueue` 没有客户端参与，只使用收藏与缓存来源。

## 8. 部署与域名

微信公众平台需要配置：

- request 合法域名：`https://xin.hanxin.vip`
- socket 合法域名：`wss://xin.hanxin.vip`

网易云歌词接口由云函数请求，不需要加入小程序域名白名单。

云函数 `musicApp` 的歌词请求超时为 2 秒；默认 3 秒的云函数超时设置可直接运行。

## 9. 当前限制

- 酷狗入口已隐藏，历史收藏和队列中的酷狗歌曲无法重新获取播放地址。
- QQ 音乐播放依赖 `/music/pick`；需要登录、购买或受地区版权限制的歌曲可能无法获取直链。
- 电台歌曲支持搜索、点歌和播放，但不提供歌词，也不进入自动补歌候选。
- 歌词仅覆盖网易云；歌词接口不可用时页面显示暂无歌词。
- 播放直链带时效，失效后依赖播放器错误回调重新点播或自动切歌。
- 服务端搜索能力依赖 jusic-serve 可用性；接口异常时搜索和点歌会提示失败。

## 10. 参考资料

- 服务站点：https://xin.hanxin.vip/
- SockJS 协议：https://github.com/sockjs/sockjs-protocol
- STOMP 协议：https://stomp.github.io/
