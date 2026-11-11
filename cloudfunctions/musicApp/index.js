const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const DEFAULT_ROOM_ID = 1
const DEFAULT_ROOM_NAME = 'Music For U'
// 网易云官方歌词与歌曲详情接口；播放地址统一由客户端通过 jusic-serve WebSocket 点播获取
const NETEASE_LYRIC_URL = 'https://music.163.com/api/song/lyric'
const NETEASE_SONG_DETAIL_URL = 'https://music.163.com/api/song/detail'
// 保留历史数据中的来源标识；当前只有 netease 与 tencent 具备可用的在线播放链路
const MUSIC_SOURCES = ['netease', 'tencent', 'kugou', 'wydt']
const DEFAULT_SEARCH_PROMPTS = ['周杰伦', '流行歌曲', '经典歌曲', '精选']
// 允许登录的协议版本；登录必须携带当前版本，缺失或不匹配一律拒绝
const AGREEMENT_VERSIONS = ['V1.2']
// 自动补歌来源权重（收藏 / 缓存 / 提示词），候选按权重随机混入队列
const REFILL_SOURCE_WEIGHTS = { favorite: 5, cache: 3, prompt: 2 }
// 儿歌模式补歌权重：儿歌收藏（用户精选）占主导，云端儿歌词池补充新鲜度
const CHILDREN_REFILL_WEIGHTS = { favorite: 3, children: 2 }
// 播放队列硬上限，与客户端一致
const MAX_QUEUE_SIZE = 100
// 读取上限高于硬上限，保证历史并发溢出产生的队列行仍可见、可清理
const QUEUE_READ_LIMIT = MAX_QUEUE_SIZE * 2
// 只接受已知音乐 CDN 的播放直链，避免客户端伪造任意外部音频地址
const TRUSTED_AUDIO_DOMAINS = ['music.126.net', '126.net', 'music.163.com', '163.com', 'qqmusic.qq.com', 'gtimg.cn', 'qq.com']
// 游客（未登录）可访问的只读接口：房间、提示词、消息、队列、歌词与封面；
// song/ended 为歌曲自然播完后的自动推进，finishSong 不依赖登录用户且有队列一致性校验，故也对游客开放，避免单人游客房间播完不续播
const GUEST_ACTIONS = [
  'room/getRoomInfo',
  'room/getSearchPrompts',
  'message/getMessageList',
  'song/songList',
  'song/ended',
  'song/getLrc',
  'song/getCovers'
]
const AUTO_SONG_USER = {
  user_id: 'system',
  user_name: 'Music For U',
  user_head: '',
  user_sex: 2,
  user_remark: '',
  profile_completed: true,
  myRoom: false
}

const success = (data, msg = '操作成功') => ({ code: 200, msg, data })
const failure = (msg, code = 500, data = null) => ({ code, msg, data })

// 聊天媒体统一存放在 messages/ 下；撤回时也只清理该目录，避免误删头像等其他云文件
const isMessageMediaFile = (value) => /^cloud:\/\/[^/]+\/messages\//i.test(String(value || ''))

const normalizeMusicSource = (source) => MUSIC_SOURCES.includes(source) ? source : 'netease'

const normalizeHttpsUrl = value => String(value || '')
  .replace(/^http:\/\//i, 'https://')
  .replace(/\\u0026/gi, '&')
  .replace(/&amp;/gi, '&')

const isTrustedAudioHost = hostname => {
  const host = String(hostname || '').toLowerCase()
  return TRUSTED_AUDIO_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

const isUsableAudioUrl = value => {
  try {
    const parsed = new URL(normalizeHttpsUrl(value))
    return parsed.protocol === 'https:'
      && isTrustedAudioHost(parsed.hostname)
      && parsed.pathname
      && parsed.pathname !== '/'
      && !/\/404(?:\/|\?|$)/i.test(parsed.pathname + parsed.search)
  } catch (error) {
    return false
  }
}

// 历史歌曲里可能存有已失效的 Meting 接口地址，统一按「没有直链」处理
const isDirectAudioUrl = value => isUsableAudioUrl(value)
  && !/\/meting\/api(?:\?|$)/i.test(normalizeHttpsUrl(value))
  && !/[?&]type=url(?:&|$)/i.test(normalizeHttpsUrl(value))

// 网易云官方歌词接口，短时缓存避免重复请求
const LYRIC_CACHE_TTL = 30 * 60 * 1000
const lyricCache = new Map()
// 云函数实例常驻，缓存需要上限，避免热实例内存持续增长
const trimCache = (cache, maxSize) => {
  while (cache.size > maxSize) {
    cache.delete(cache.keys().next().value)
  }
}
const LYRIC_CACHE_MAX = 200
const COVER_CACHE_MAX = 500

// 网易云官方接口请求：歌词和封面补全都复用同一套请求头
const NETEASE_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://music.163.com/',
  Accept: 'application/json',
  'Accept-Encoding': 'identity'
}

const requestNeteaseJson = (requestUrl, timeout = 2500) => new Promise((resolve, reject) => {
  let finished = false
  let req = null
  const done = (fn, value) => {
    if (finished) return
    finished = true
    clearTimeout(deadlineTimer)
    fn(value)
  }
  // 总时长兜底：socket 空闲超时挡不住慢速响应，避免拖到云函数整体超时
  const deadlineTimer = setTimeout(() => {
    req && req.destroy()
    done(reject, new Error('网易云接口请求超时'))
  }, timeout + 1000)
  req = https.get(requestUrl, { headers: NETEASE_REQUEST_HEADERS }, (response) => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume()
      done(reject, new Error(`网易云接口返回 HTTP ${response.statusCode}`))
      return
    }
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      body += chunk
    })
    response.on('end', () => {
      try {
        done(resolve, JSON.parse(body))
      } catch (error) {
        done(reject, new Error('网易云接口返回格式无效'))
      }
    })
  })
  req.setTimeout(timeout, () => req.destroy(new Error('网易云接口请求超时')))
  req.on('error', (error) => done(reject, error))
})

const requestNeteaseLyric = (mid) => requestNeteaseJson(
  `${NETEASE_LYRIC_URL}?id=${encodeURIComponent(mid)}&lv=1&kv=1&tv=-1`,
  2000
).then(parsed => parsed && parsed.lrc && typeof parsed.lrc.lyric === 'string' ? parsed.lrc.lyric : '')

const getNeteaseLyric = async (mid) => {
  const key = String(mid || '')
  if (!key) {
    return []
  }
  const cached = lyricCache.get(key)
  if (cached && Date.now() - cached.ts < LYRIC_CACHE_TTL) {
    return cached.lines
  }
  const text = await requestNeteaseLyric(key)
  const lines = parseLyrics(text)
  lyricCache.set(key, { lines, ts: Date.now() })
  trimCache(lyricCache, LYRIC_CACHE_MAX)
  return lines
}

// 网易云搜索经常不返回封面，用官方歌曲详情接口补全；命中结果缓存 24 小时
const COVER_CACHE_TTL = 24 * 60 * 60 * 1000
const COVER_MISS_TTL = 10 * 60 * 1000
const coverCache = new Map()

const normalizeCoverMids = (mids) => {
  if (!Array.isArray(mids)) {
    return []
  }
  const list = []
  mids.forEach((value) => {
    const mid = String(value || '').trim()
    if (/^\d+$/.test(mid) && !list.includes(mid)) {
      list.push(mid)
    }
  })
  return list.slice(0, 30)
}

const getNeteaseCovers = async (mids) => {
  const result = {}
  const need = []
  const now = Date.now()
  mids.forEach((mid) => {
    const cached = coverCache.get(mid)
    if (cached) {
      const fresh = now - cached.ts < (cached.pic ? COVER_CACHE_TTL : COVER_MISS_TTL)
      if (fresh) {
        if (cached.pic) {
          result[mid] = cached.pic
        }
        return
      }
    }
    need.push(mid)
  })
  if (!need.length) {
    return result
  }
  const ids = JSON.stringify(need)
  const parsed = await requestNeteaseJson(`${NETEASE_SONG_DETAIL_URL}?ids=${encodeURIComponent(ids)}`)
  const songs = Array.isArray(parsed && parsed.songs) ? parsed.songs : []
  const found = new Set()
  songs.forEach((item) => {
    const mid = String(item && item.id || '')
    if (!need.includes(mid)) {
      return
    }
    found.add(mid)
    const pic = normalizeHttpsUrl(item.album && (item.album.picUrl || item.album.blurPicUrl) || '')
    if (/^https:\/\//i.test(pic)) {
      coverCache.set(mid, { pic, ts: Date.now() })
      result[mid] = pic
    } else {
      coverCache.set(mid, { pic: '', ts: Date.now() })
    }
  })
  need.forEach((mid) => {
    if (!found.has(mid)) {
      coverCache.set(mid, { pic: '', ts: Date.now() })
    }
  })
  trimCache(coverCache, COVER_CACHE_MAX)
  return result
}

const parseLyrics = (source) => String(source || '')
  .split(/\r?\n/)
  .map((line) => {
    const match = line.match(/^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/)
    if (!match) {
      return null
    }
    const fraction = String(match[3] || '').padEnd(3, '0')
    return {
      time: Number(match[1]) * 60 + Number(match[2]) + Number(fraction) / 1000,
      lineLyric: match[4].trim()
    }
  })
  .filter((item) => item && item.lineLyric)

const validateSong = (song) => {
  if (!song || !song.mid || !song.name) {
    throw new Error('歌曲数据不完整')
  }
  const source = normalizeMusicSource(song.source)
  // 播放地址由客户端 WS 点播下发；历史旧接口地址一律视为没有直链
  const url = isDirectAudioUrl(song.url) ? normalizeHttpsUrl(song.url) : ''
  if (source === 'wydt' && !url) {
    throw new Error('电台节目缺少播放地址')
  }
  return {
    source,
    mid: String(song.mid),
    name: String(song.name),
    singer: String(song.singer || ''),
    album: String(song.album || ''),
    pic: source === 'kugou' ? '' : String(song.pic || ''),
    url,
    // 客户端进房/重连时按歌曲时长封顶 seek，缺失会导致偏移越界
    duration: Math.max(0, Number(song.duration) || 0),
    lrc: []
  }
}

const getOpenid = () => cloud.getWXContext().OPENID

// 登录头像由客户端上传到 avatars/ 单层目录
const isLoginAvatarFile = (value) => /^cloud:\/\/[^/]+\/avatars\/[^/]+$/i.test(String(value || ''))

const createSystemUserName = (openid) => {
  const suffix = crypto.createHash('sha256').update(String(openid)).digest('hex').slice(0, 8).toUpperCase()
  return `音乐用户${suffix}`
}

const getUserByOpenid = async (openid) => {
  const result = await db.collection('users').where({ _openid: openid }).limit(1).get()
  const user = result.data[0] || null
  if (!user) {
    return null
  }
  const systemUserName = createSystemUserName(openid)
  if (user.user_name !== systemUserName) {
    await db.collection('users').doc(user._id).update({
      data: {
        user_name: systemUserName,
        updated_at: db.serverDate()
      }
    })
    return { ...user, user_name: systemUserName }
  }
  return user
}

const saveLoginUser = async (openid, payload) => {
  const userHead = String(payload.user_head || '')
  if (!isLoginAvatarFile(userHead)) {
    return failure('请授权选择并上传微信头像', 422)
  }
  const agreementVersion = String(payload.agreement_version || '').trim()
  if (AGREEMENT_VERSIONS.indexOf(agreementVersion) === -1) {
    return failure('请先阅读并同意隐私保护指引', 422)
  }
  const agreementFields = {
    agreement_version: agreementVersion,
    agreed_at: db.serverDate()
  }
  const systemUserName = createSystemUserName(openid)
  const existing = await getUserByOpenid(openid)
  if (existing) {
    const values = {
      user_name: systemUserName,
      user_head: userHead,
      profile_completed: true,
      ...agreementFields,
      updated_at: db.serverDate()
    }
    await db.collection('users').doc(existing._id).update({ data: values })
    return success(toClientUser({ ...existing, ...values }), '登录成功')
  }
  const values = {
    user_name: systemUserName,
    user_head: userHead,
    user_sex: 2,
    user_remark: '',
    profile_completed: true,
    ...agreementFields,
    updated_at: db.serverDate()
  }
  let created
  try {
    created = await db.collection('users').add({
      data: {
        _openid: openid,
        ...values,
        created_at: db.serverDate(),
      }
    })
  } catch (error) {
    // 并发首次登录可能同时写入，唯一索引冲突时复用已存在的用户
    const duplicated = await getUserByOpenid(openid)
    if (!duplicated) {
      throw error
    }
    return success(toClientUser(duplicated), '登录成功')
  }
  return success(toClientUser({
    _id: created._id,
    _openid: openid,
    ...values
  }), '登录成功')
}

const toClientUser = (user) => ({
  user_id: user._id,
  user_name: user.user_name,
  user_head: user.user_head,
  user_sex: user.user_sex,
  user_remark: user.user_remark || '',
  profile_completed: Boolean(user.profile_completed),
  myRoom: false
})

const ensureDefaultRoom = async (user) => {
  const result = await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).limit(1).get()
  if (result.data.length) {
    return result.data[0]
  }
  const room = {
    room_id: DEFAULT_ROOM_ID,
    room_name: DEFAULT_ROOM_NAME,
    room_notice: '欢迎来到 Music For U！',
    room_user: user._id,
    search_prompts: DEFAULT_SEARCH_PROMPTS,
    backup_songs: [],
    recent_played: [],
    current_song: null,
    refill_lock_until: 0,
    refill_lock_token: '',
    created_at: db.serverDate(),
    updated_at: db.serverDate()
  }
  try {
    const created = await db.collection('rooms').add({ data: room })
    return { ...room, _id: created._id }
  } catch (error) {
    const existing = await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).limit(1).get()
    if (existing.data.length) {
      return existing.data[0]
    }
    throw error
  }
}

// 读时自愈：rooms.current_song 是指向播放队列项的存储快照，正常流程必然对应一条真实存在的
// play_queue 记录；若云函数被中断（如 -404012 轮询超时）停在“先删队列、后改指针”的中间态，
// current_song 会悬空指向已删除项，导致该歌既不在待播列表、又一直被点歌去重判为“正在播放中”而无法重播。
// 这里统一校验：悬空时把 current_song 修正为队列首项（重新计时）或清空，让房间状态自洽。
const healCurrentSong = async (room) => {
  if (!room || !room.current_song || !room.current_song._id) {
    return room
  }
  const currentId = String(room.current_song._id)
  const result = await db.collection('play_queue').doc(currentId).get().catch(() => null)
  const row = result && result.data && String(result.data.room_id || DEFAULT_ROOM_ID) === String(DEFAULT_ROOM_ID)
    ? result.data
    : null
  if (row) {
    return room
  }
  // 悬空：取队列首项补位，队列为空则清空 current_song
  const headResult = await db.collection('play_queue')
    .where({ room_id: DEFAULT_ROOM_ID })
    .orderBy('sort_time', 'asc')
    .limit(1)
    .get()
  const head = headResult.data[0]
  const next = head ? { ...head, since: Math.floor(Date.now() / 1000) } : null
  // 仅在指针仍是那条悬空记录时写回，避免覆盖并发刚写入的新指针
  const healed = await db.collection('rooms').where({
    _id: room._id,
    'current_song._id': currentId
  }).update({
    data: {
      current_song: _.set(next),
      updated_at: db.serverDate()
    }
  }).catch(() => null)
  if (healed && healed.stats && healed.stats.updated) {
    room.current_song = next
  } else {
    // CAS 未命中说明指针已被并发修改，重新读取最新值，避免把旧悬空指针返回给调用方
    const latest = await db.collection('rooms').doc(room._id).get().catch(() => null)
    if (latest && latest.data) {
      room.current_song = latest.data.current_song || null
    }
  }
  return room
}

const getDefaultRoom = async (user) => {
  const room = await ensureDefaultRoom(user)
  const roomDefaults = {}
  if (!Array.isArray(room.search_prompts)) {
    roomDefaults.search_prompts = DEFAULT_SEARCH_PROMPTS
    room.search_prompts = DEFAULT_SEARCH_PROMPTS
  }
  if (!Array.isArray(room.backup_songs)) {
    roomDefaults.backup_songs = []
    room.backup_songs = []
  }
  if (!Array.isArray(room.recent_played)) {
    roomDefaults.recent_played = []
    room.recent_played = []
  }
  if (typeof room.children_mode !== 'boolean') {
    roomDefaults.children_mode = false
    room.children_mode = false
  }
  if (typeof room.refill_lock_until !== 'number') {
    roomDefaults.refill_lock_until = 0
    roomDefaults.refill_lock_token = ''
    room.refill_lock_until = 0
    room.refill_lock_token = ''
  }
  if (Object.keys(roomDefaults).length) {
    await db.collection('rooms').doc(room._id).update({
      data: {
        ...roomDefaults,
        updated_at: db.serverDate()
      }
    })
  }
  const legacyDefaults = await db.collection('play_queue')
    .where({ room_id: DEFAULT_ROOM_ID, is_default_song: true })
    .limit(100)
    .get()
  if (legacyDefaults.data.length) {
    await Promise.all(legacyDefaults.data.map((item) => db.collection('play_queue').doc(item._id).remove()))
    if (room.current_song && room.current_song.is_default_song) {
      await db.collection('rooms').doc(room._id).update({
        data: {
          current_song: _.set(null),
          updated_at: db.serverDate()
        }
      })
      room.current_song = null
    }
  }
  // 读时自愈：保证返回的 current_song 一定指向真实存在的队列行
  return await healCurrentSong(room)
}

const normalizeMessage = (doc) => {
  // _openid、原始 payload 与 created_at 只保留在服务端；客户端 history 只需以下三个字段
  return {
    message_id: doc._id,
    message_content: JSON.stringify(doc.payload),
    message_createtime: doc.created_timestamp
  }
}

// 文本内容安全检测：失败或接口不可用时放行，避免因平台接口异常阻断聊天
const checkTextSecurity = async (content, openid) => {
  const security = cloud.openapi && cloud.openapi.security
  if (!security || typeof security.msgSecCheck !== 'function') {
    return true
  }
  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000))
    const result = await Promise.race([
      security.msgSecCheck({
        content,
        version: 2,
        scene: 2,
        openid
      }),
      timeout
    ])
    if (!result || result.errCode !== 0) {
      return true
    }
    const suggest = result.result && result.result.suggest
    return !suggest || suggest === 'pass'
  } catch (error) {
    console.error('[msgSecCheck]', error)
    return true
  }
}

const sendMessage = async (payload, user) => {
  const type = ['text', 'img', 'voice'].includes(payload.type) ? payload.type : 'text'
  const content = String(payload.msg || '').trim()
  if (!content) {
    return failure('消息内容长度应为 1 到 1000 个字符', 422)
  }
  // 文本由客户端 encodeURIComponent 后提交，长度按解码后的原始文本计算
  let plainContent = content
  if (type === 'text') {
    try {
      plainContent = decodeURIComponent(content)
    } catch (error) {
      plainContent = content
    }
  }
  if (plainContent.length > 1000) {
    return failure('消息内容长度应为 1 到 1000 个字符', 422)
  }
  // 文本重发时客户端会复用同一 client_msg_id：传输超时但服务端已入库的情况下避免重复消息
  const clientMsgId = type === 'text' ? String(payload.client_msg_id || '').trim().slice(0, 64) : ''
  if (clientMsgId) {
    const existed = await db.collection('messages')
      .where({ _openid: user._openid, room_id: DEFAULT_ROOM_ID, client_msg_id: clientMsgId })
      .limit(1)
      .get()
    if (existed.data.length) {
      return success({ ...(existed.data[0].payload || {}), message_id: existed.data[0]._id }, '发送成功')
    }
  }
  if (type === 'text' && !(await checkTextSecurity(plainContent, user._openid))) {
    return failure('消息包含敏感内容，请修改后重试', 422)
  }
  const isBundledEmoji = type === 'img' && /^\/res\/Emojis\//.test(content)
  if ((type === 'img' || type === 'voice') && !isMessageMediaFile(content) && !isBundledEmoji) {
    return failure('消息文件必须使用消息目录下的云存储地址', 422)
  }
  const duration = type === 'voice' ? Math.min(Math.max(Number(payload.duration) || 0, 1), 60000) : 0
  let reply = null
  if (payload.reply_to) {
    const replied = await db.collection('messages').doc(String(payload.reply_to)).get().catch(() => null)
    if (replied && replied.data && replied.data.room_id === DEFAULT_ROOM_ID) {
      const repliedPayload = replied.data.payload || {}
      let replyContent = ''
      if (repliedPayload.type === 'text') {
        // 先解码再截断，避免把 %XX 转义序列截成非法内容
        let plain = String(repliedPayload.content || '')
        try {
          plain = decodeURIComponent(plain)
        } catch (error) {
          plain = String(repliedPayload.content || '')
        }
        replyContent = plain.slice(0, 200)
      }
      reply = {
        message_id: replied.data._id,
        type: repliedPayload.type,
        content: replyContent,
        user_name: String(repliedPayload.user && repliedPayload.user.user_name || '')
      }
    }
  }
  const message = {
    type,
    content,
    // 媒体消息的 resource 由服务端以校验过的 content 为准，避免客户端塞入其他文件引用后被撤回清理
    resource: type === 'text' ? String(payload.resource || content) : content,
    duration,
    reply,
    user: toClientUser(user),
    room_id: DEFAULT_ROOM_ID,
    message_time: Math.floor(Date.now() / 1000)
  }
  const messageDoc = {
    _openid: user._openid,
    room_id: DEFAULT_ROOM_ID,
    payload: message,
    created_timestamp: message.message_time,
    created_at: db.serverDate()
  }
  if (clientMsgId) {
    messageDoc.client_msg_id = clientMsgId
  }
  const created = await db.collection('messages').add({ data: messageDoc })
  return success({ ...message, message_id: created._id }, '发送成功')
}

const getMessageList = async (payload) => {
  const limit = Math.min(Math.max(Number(payload.per_page) || 20, 1), 100)
  const result = await db.collection('messages')
    .where({ room_id: DEFAULT_ROOM_ID })
    .orderBy('created_timestamp', 'desc')
    .limit(limit)
    .get()
  return success(result.data.map(normalizeMessage))
}

// 撤回时只有确认没有其他消息引用该文件才删除，防止伪造引用后撤回删除他人媒体
const isMediaReferencedElsewhere = async (fileId, messageId) => {
  try {
    // 按文件引用查询后排除当前消息，避免依赖 _id 的不等操作符
    const [byContent, byResource] = await Promise.all([
      db.collection('messages').where({ 'payload.content': fileId }).limit(2).get(),
      db.collection('messages').where({ 'payload.resource': fileId }).limit(2).get()
    ])
    return byContent.data.some((doc) => String(doc._id) !== String(messageId))
      || byResource.data.some((doc) => String(doc._id) !== String(messageId))
  } catch (error) {
    // 查询失败时保守处理，跳过文件删除
    return true
  }
}

const recallMessage = async (payload, user) => {
  if (!payload.message_id) {
    return failure('缺少消息标识', 422)
  }
  const result = await db.collection('messages').doc(payload.message_id).get().catch(() => null)
  const message = result && result.data
  if (!message) {
    return failure('消息不存在或已撤回', 404)
  }
  const room = await getDefaultRoom(user)
  if (message._openid !== user._openid && room.room_user !== user._id) {
    return failure('无权撤回该消息', 403)
  }
  await db.collection('messages').doc(payload.message_id).remove()
  // 撤回后消息正文不再展示，顺带清理该消息的云存储图片/语音，避免长期占用空间。
  // 只处理 img/voice 且位于 messages/ 下的文件，并确认没有其他消息引用，
  // 防止构造消息引用他人媒体后撤回导致误删（文本消息的 resource 不参与清理）
  const messagePayload = message.payload || {}
  const mediaFile = (messagePayload.type === 'img' || messagePayload.type === 'voice')
    ? [messagePayload.content, messagePayload.resource].find((item) => isMessageMediaFile(item))
    : ''
  if (mediaFile && !(await isMediaReferencedElsewhere(mediaFile, payload.message_id))) {
    await cloud.deleteFile({ fileList: [mediaFile] }).catch(() => null)
  }
  return success(null, '撤回成功')
}

const addFavorite = async (payload, user) => {
  const song = validateSong(payload.song || { source: payload.source, mid: payload.mid, name: payload.name })
  const exists = await db.collection('playlists').where({ _openid: user._openid, source: song.source, mid: song.mid }).limit(1).get()
  if (!exists.data.length) {
    try {
      await db.collection('playlists').add({
        data: {
          _openid: user._openid,
          source: song.source,
          mid: song.mid,
          song,
          created_at: db.serverDate()
        }
      })
    } catch (error) {
      // 并发收藏可能同时通过存在性检查，唯一索引拒绝后只要确认已存在即视为成功
      const recheck = await db.collection('playlists').where({ _openid: user._openid, source: song.source, mid: song.mid }).limit(1).get()
      if (!recheck.data.length) {
        throw error
      }
    }
  }
  return success(null, '收藏成功')
}

// 查询单曲是否已收藏：供驾驶模式收藏按钮渲染真实状态（儿歌标记不影响收藏判定）
const checkFavorite = async (payload, user) => {
  if (!payload.mid) {
    return failure('缺少歌曲标识', 422)
  }
  const source = normalizeMusicSource(payload.source)
  const result = await db.collection('playlists').where({
    _openid: user._openid,
    mid: String(payload.mid)
  }).get()
  // 兼容历史数据的来源别名，按 mid 缩小范围后再按归一化来源过滤
  const favorited = result.data.some((item) => normalizeMusicSource(item.source) === source)
  return success({ favorited })
}

const favoriteList = async (payload, user) => {
  const page = Math.max(parseInt(payload.page, 10) || 1, 1)
  const pageSize = 30
  // 「我的歌曲」与「儿歌」互斥：标记为儿歌的收藏不再出现在「我的歌曲」列表中
  const where = { _openid: user._openid }
  if (payload.filter === 'children') {
    where.children = true
  } else {
    where.children = _.neq(true)
  }
  // 多取一条用于判断是否还有下一页，避免损坏记录被跳过时提前判定列表结束
  const result = await db.collection('playlists').where(where).orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize + 1).get()
  // 单条历史收藏损坏时只跳过该条，避免整个收藏页加载失败
  const songs = result.data.slice(0, pageSize).map((item) => {
    try {
      return {
        ...validateSong(item.song),
        // 儿歌分类标记：供收藏页列表右侧按钮显示状态
        children: !!item.children
      }
    } catch (error) {
      return null
    }
  }).filter(Boolean)
  return { ...success(songs), hasMore: result.data.length > pageSize }
}

// 收藏页：将收藏歌曲标记为儿歌或移出儿歌
const toggleFavoriteChildren = async (payload, user) => {
  if (!payload.mid) {
    return failure('缺少歌曲标识', 422)
  }
  const source = normalizeMusicSource(payload.source)
  const result = await db.collection('playlists').where({
    _openid: user._openid,
    mid: String(payload.mid)
  }).get()
  // 兼容历史数据的来源别名，按 mid 缩小范围后再按归一化来源过滤
  const targets = result.data.filter((item) => normalizeMusicSource(item.source) === source)
  if (!targets.length) {
    return failure('收藏不存在', 404)
  }
  const children = !!payload.children
  await Promise.all(targets.map((item) => db.collection('playlists').doc(item._id).update({
    data: { children }
  })))
  return success({ children }, children ? '已加入儿歌' : '已移出儿歌')
}

const deleteFavorite = async (payload, user) => {
  if (!payload.mid) {
    return failure('缺少歌曲标识', 422)
  }
  const source = normalizeMusicSource(payload.source)
  const result = await db.collection('playlists').where({
    _openid: user._openid,
    mid: String(payload.mid)
  }).get()
  const targets = result.data.filter((item) => normalizeMusicSource(item.source) === source)
  await Promise.all(targets.map((item) => db.collection('playlists').doc(item._id).remove()))
  return success(null, '移除成功')
}

const queueList = async () => {
  const result = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).orderBy('sort_time', 'asc').limit(QUEUE_READ_LIMIT).get()
  return success(result.data.map((item) => ({
    _id: item._id,
    song: item.song,
    user: item.user,
    since: item.since,
    sort_time: item.sort_time
  })))
}

const getQueueItem = async (payload) => {
  if (payload.queue_id) {
    const result = await db.collection('play_queue').doc(String(payload.queue_id)).get().catch(() => null)
    return result && result.data && result.data.room_id === DEFAULT_ROOM_ID ? result.data : null
  }
  const result = await db.collection('play_queue').where({
    room_id: DEFAULT_ROOM_ID,
    'song.source': normalizeMusicSource(payload.source),
    'song.mid': payload.mid
  }).limit(1).get()
  return result.data[0] || null
}

const getQueueCount = async () => {
  const result = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).count()
  return Number(result.total) || 0
}

const addSong = async (payload, user, playNow = false) => {
  const room = await getDefaultRoom(user)
  if (playNow && room.room_user !== user._id) {
    return failure('只有房主可以立即播放歌曲', 403)
  }
  const song = validateSong(payload.song || payload)
  // 防重复点歌：已在队列或正在播放的歌曲直接拒绝（立即播放除外）
  // room 来自 getDefaultRoom，其 current_song 已由 healCurrentSong 校验，必指向真实存在的队列行，
  // 因此这里命中即代表该歌确实是当前播放项，悬空快照不会再误拦点歌
  if (!playNow) {
    if (room.current_song && room.current_song.song
      && normalizeMusicSource(room.current_song.song.source) === normalizeMusicSource(song.source)
      && String(room.current_song.song.mid) === String(song.mid)) {
      return failure('该歌曲正在播放中', 409)
    }
    const existing = await db.collection('play_queue').where({
      room_id: DEFAULT_ROOM_ID,
      'song.source': normalizeMusicSource(song.source),
      'song.mid': song.mid
    }).get()
    if (existing.data.length) {
      // 已在队列中的歌曲不再重复入队，也不向用户报错：
      // 清掉多余副本，把保留的一条重新排到队尾，等同于重新点歌
      const currentId = room.current_song && room.current_song._id
      const keep = existing.data.find((item) => String(item._id) === String(currentId)) || existing.data[0]
      const extras = existing.data.filter((item) => String(item._id) !== String(keep._id))
      if (extras.length) {
        await Promise.all(extras.map((item) => db.collection('play_queue').doc(item._id).remove().catch(() => null)))
      }
      if (!currentId && keep.song) {
        // 没有当前歌曲时，复用这条记录作为当前播放项，避免点歌后仍不播放
        await db.collection('play_queue').doc(keep._id).update({ data: { sort_time: -1 } })
        await db.collection('rooms').where({
          room_id: DEFAULT_ROOM_ID,
          current_song: null
        }).update({
          data: {
            current_song: _.set({ ...keep, since: Math.floor(Date.now() / 1000) }),
            recent_played: buildRecentPlayed(room, keep.song),
            updated_at: db.serverDate()
          }
        })
        return success(null, '播放成功')
      }
      if (!currentId || String(currentId) !== String(keep._id)) {
        await db.collection('play_queue').doc(keep._id).update({ data: { sort_time: Date.now() } })
      }
      return success(null, '点歌成功')
    }
  }
  // 先做容量预检，避免立即播放清空当前歌曲后才发现队列已满
  const queueCount = await getQueueCount()
  if (!playNow && queueCount >= MAX_QUEUE_SIZE) {
    return failure('播放队列已满，请先移除部分歌曲', 409)
  }
  // 立即播放时清理旧当前歌曲与同曲重复项，并把新歌曲放到队首，
  // 保证 rooms.current_song 始终对应播放队列第一项，避免切歌时又切回已播歌曲
  if (playNow) {
    const currentId = room.current_song && room.current_song._id
    const duplicateResult = await db.collection('play_queue').where({
      room_id: DEFAULT_ROOM_ID,
      'song.source': normalizeMusicSource(song.source),
      'song.mid': song.mid
    }).get()
    const removableIds = new Set(duplicateResult.data.map((item) => String(item._id)))
    if (currentId) {
      removableIds.add(String(currentId))
    }
    if (queueCount - removableIds.size + 1 > MAX_QUEUE_SIZE) {
      return failure('播放队列已满，请先移除部分歌曲', 409)
    }
    if (currentId) {
      // 先把 current_song 置空再删除其队列行：即便删除后调用被中断，current_song 也不会悬空指向已删记录
      await db.collection('rooms').where({
        room_id: DEFAULT_ROOM_ID,
        'current_song._id': currentId
      }).update({
        data: {
          current_song: _.set(null),
          updated_at: db.serverDate()
        }
      }).catch(() => null)
      await db.collection('play_queue').doc(currentId).remove().catch(() => null)
    }
    await db.collection('play_queue').where({
      room_id: DEFAULT_ROOM_ID,
      'song.source': normalizeMusicSource(song.source),
      'song.mid': song.mid
    }).remove()
  }
  const queueItem = {
    room_id: DEFAULT_ROOM_ID,
    song,
    user: toClientUser(user),
    // 立即播放或队列没有当前歌曲时插到队首，其余点歌按时间追加到队尾
    sort_time: playNow || !room.current_song ? -1 : Date.now(),
    created_at: db.serverDate()
  }
  const created = await db.collection('play_queue').add({ data: queueItem })
  // 并发点歌可能同时通过预检，入队后复核；超出上限则回滚本次新增
  if (await getQueueCount() > MAX_QUEUE_SIZE) {
    await db.collection('play_queue').doc(created._id).remove().catch(() => null)
    return failure('播放队列已满，请先移除部分歌曲', 409)
  }
  if (playNow || !room.current_song) {
    // 只在指针仍为空时补位，避免与并发切歌/点歌互相覆盖
    await db.collection('rooms').where({
      room_id: DEFAULT_ROOM_ID,
      current_song: null
    }).update({
      data: {
        current_song: _.set({ ...queueItem, _id: created._id, since: Math.floor(Date.now() / 1000) }),
        recent_played: buildRecentPlayed(room, song),
        updated_at: db.serverDate()
      }
    })
  }
  return success(null, playNow || !room.current_song ? '播放成功' : '点歌成功')
}

// 移除当前播放歌曲并切到队列下一首；autoPass 时先补一次歌再切，避免唯一歌曲失效后队列直接清空
const switchToNextSong = async (room, options = {}) => {
  const currentId = room.current_song && room.current_song._id
  const readQueue = () => db.collection('play_queue')
    .where({ room_id: DEFAULT_ROOM_ID })
    .orderBy('sort_time', 'asc')
    .limit(QUEUE_READ_LIMIT)
    .get()
  let queue = await readQueue()
  // 切歌前清理当前歌曲在队列中的其他重复项（历史数据可能残留），避免切走后立刻又播回同一首
  const currentKey = room.current_song && room.current_song.song ? playedSongKey(room.current_song.song) : ''
  if (currentId && currentKey) {
    const duplicates = queue.data.filter((item) => String(item._id) !== String(currentId)
      && item.song && playedSongKey(item.song) === currentKey)
    if (duplicates.length) {
      await Promise.all(duplicates.map((item) => db.collection('play_queue').doc(item._id).remove().catch(() => null)))
      queue = await readQueue()
    }
  }
  // 当前歌曲正常位于队首；严格取当前项之后的一首，
  // 避免当前项不在队首时把已经播过的歌曲又切回来
  const pickNext = () => {
    const items = queue.data
    if (!currentId) {
      return items[0] || null
    }
    const index = items.findIndex((item) => String(item._id) === String(currentId))
    return index >= 0 ? (items[index + 1] || null) : (items[0] || null)
  }
  let next = pickNext()
  if (!next && options.refillWhenEmpty && options.user) {
    await refillQueue({ count: 2 }, options.user).catch(() => null)
    queue = await readQueue()
    next = pickNext()
  }
  const condition = currentId
    ? { room_id: DEFAULT_ROOM_ID, 'current_song._id': currentId }
    : { room_id: DEFAULT_ROOM_ID, current_song: null }
  const switchData = {
    current_song: _.set(next ? { ...next, since: Math.floor(Date.now() / 1000) } : null),
    updated_at: db.serverDate()
  }
  if (next && next.song) {
    switchData.recent_played = buildRecentPlayed(room, next.song)
  }
  const updated = await db.collection('rooms').where(condition).update({
    data: switchData
  })
  if (!updated.stats.updated) {
    return { advanced: false, next: null }
  }
  if (currentId) {
    await db.collection('play_queue').doc(currentId).remove().catch(() => null)
  }
  return { advanced: true, next }
}

const getQueueSongs = async () => {
  const result = await db.collection('play_queue')
    .where({ room_id: DEFAULT_ROOM_ID })
    .orderBy('sort_time', 'asc')
    .limit(QUEUE_READ_LIMIT)
    .get()
  return result.data
}

// 随机打乱候选歌曲顺序，避免每次都补入同一批头部歌曲
const shuffleSongs = (songs) => {
  const list = songs.filter(Boolean)
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

// 生成歌曲去重键，与补歌 existingKeys 的 source:mid 格式保持一致
const playedSongKey = (song) => `${normalizeMusicSource(song && song.source)}:${song && song.mid}`

// 构建最近已播列表：新歌置顶、去重、最多保留 20 首
const buildRecentPlayed = (room, song) => {
  const existing = Array.isArray(room.recent_played) ? room.recent_played : []
  if (!song || !song.mid) {
    return existing
  }
  const key = playedSongKey(song)
  return [key, ...existing.filter((item) => item !== key)].slice(0, 20)
}

// 收藏候选：与收藏页「我的歌曲 / 儿歌」互斥分类保持一致
// childrenOnly 为 true 时只取标记为儿歌的收藏，否则排除儿歌收藏
const getFavoriteSongs = async (user, childrenOnly) => {
  const where = { _openid: user._openid }
  where.children = childrenOnly ? true : _.neq(true)
  const result = await db.collection('playlists').where(where).orderBy('created_at', 'desc').limit(100).get()
  return shuffleSongs(result.data.map((item) => {
    try {
      return validateSong(item.song)
    } catch (error) {
      return null
    }
  }).filter((song) => song && (song.source === 'netease' || song.source === 'tencent')))
}

const addBackupSong = async (song, source, index) => {
  const autoUser = source === 'favorite' ? { ...AUTO_SONG_USER, user_name: '收藏歌曲' }
    : source === 'children' ? { ...AUTO_SONG_USER, user_name: '儿歌电台' }
      : AUTO_SONG_USER
  const queueItem = {
    room_id: DEFAULT_ROOM_ID,
    // 收藏/缓存里存的签名直链会过期：自动入队一律不带直链，由客户端播放前 WS 点播取新地址
    song: { ...song, url: '' },
    user: autoUser,
    sort_time: Date.now() + index,
    auto_added: true,
    backup_source: source,
    created_at: db.serverDate()
  }
  const created = await db.collection('play_queue').add({ data: queueItem })
  return { ...queueItem, _id: created._id }
}

// 客户端通过 WS 搜索后提交的补歌候选；服务端只做结构校验，不再请求音乐接口
const normalizeClientCandidates = (candidates) => {
  if (!Array.isArray(candidates)) {
    return []
  }
  const list = []
  const keys = new Set()
  candidates.slice(0, 30).forEach((entry) => {
    const source = entry && (entry.source === 'prompt' || entry.source === 'children') ? entry.source : ''
    if (!source || !entry.song) {
      return
    }
    try {
      const song = validateSong(entry.song)
      if (song.source !== 'netease') {
        return
      }
      const key = `${song.source}:${song.mid}`
      if (keys.has(key)) {
        return
      }
      keys.add(key)
      list.push({ source, song })
    } catch (error) {
      return
    }
  })
  return list
}

const refillQueue = async (payload, user) => {
  const room = await getDefaultRoom(user)
  const queue = await getQueueSongs()
  const target = Math.min(Math.max(Number(payload.count) || 3, 1), 5)
  if (queue.length >= target) {
    if (!room.current_song && queue[0]) {
      await db.collection('rooms').where({
        room_id: DEFAULT_ROOM_ID,
        current_song: null
      }).update({
        data: {
          current_song: _.set({ ...queue[0], since: Math.floor(Date.now() / 1000) }),
          recent_played: buildRecentPlayed(room, queue[0].song),
          updated_at: db.serverDate()
        }
      })
    }
    return success({ added: 0, remaining: queue.length }, '备用队列充足')
  }
  const now = Date.now()
  const lockToken = crypto.randomBytes(12).toString('hex')
  const claimed = await db.collection('rooms').where({
    room_id: DEFAULT_ROOM_ID,
    refill_lock_until: _.lte(now)
  }).update({
    data: {
      refill_lock_until: now + 15000,
      refill_lock_token: lockToken,
      updated_at: db.serverDate()
    }
  })
  if (!claimed.stats.updated) {
    return success({ added: 0, remaining: queue.length }, '备用队列正在准备')
  }
  try {
    const currentQueue = await getQueueSongs()
    const existingKeys = new Set(currentQueue.map((item) => `${normalizeMusicSource(item.song && item.song.source)}:${item.song && item.song.mid}`))
    // 儿歌模式下已播歌曲不排除（儿歌本就适合重复收听），其余模式排除最近 20 首已播
    if (!room.children_mode) {
      ;(Array.isArray(room.recent_played) ? room.recent_played : []).forEach((key) => existingKeys.add(key))
    }
    const needed = target - currentQueue.length
    const added = []
    // 客户端通过 WS 搜索提供提示词/儿歌词池候选；云端只负责结构校验和入队
    const clientCandidates = normalizeClientCandidates(payload.candidates)
    const clientPoolOf = (source) => shuffleSongs(
      clientCandidates.filter((entry) => entry.source === source).map((entry) => entry.song)
    ).filter((song) => !existingKeys.has(`${song.source}:${song.mid}`)).slice(0, Math.max(needed * 2, needed))
    const [favoriteSongs, cacheSongs] = await Promise.all([
      // 收藏来源与收藏页分类互斥：正常模式取「我的歌曲」，儿歌模式取「儿歌」
      getFavoriteSongs(user, !!room.children_mode),
      Promise.resolve(shuffleSongs((Array.isArray(room.backup_songs) ? room.backup_songs : []).map((song) => {
        try {
          return validateSong(song)
        } catch (error) {
          return null
        }
      })))
    ])
    const favoritePool = favoriteSongs
      .filter((song) => !existingKeys.has(`${song.source}:${song.mid}`))
      .slice(0, Math.max(needed * 2, needed))
    const cachePool = room.children_mode ? [] : cacheSongs
      .filter((song) => song && (song.source === 'netease' || song.source === 'tencent') && !existingKeys.has(`${song.source}:${song.mid}`))
      .slice(0, Math.max(needed * 2, needed))
    const promptPool = room.children_mode ? [] : clientPoolOf('prompt')
    const childrenPool = room.children_mode ? clientPoolOf('children') : []
    // 提示词搜索成功时刷新房间缓存：与已有缓存合并去重，避免一次调用覆盖全房备用歌单
    if (promptPool.length) {
      const merged = []
      const seen = new Set()
      ;[...promptPool, ...(Array.isArray(room.backup_songs) ? room.backup_songs : [])].forEach((song) => {
        try {
          const normalized = validateSong(song)
          if (normalized.source !== 'netease' && normalized.source !== 'tencent') {
            return
          }
          const key = `${normalized.source}:${normalized.mid}`
          if (seen.has(key)) {
            return
          }
          seen.add(key)
          merged.push(normalized)
        } catch (error) {
          // 跳过损坏的历史缓存项
        }
      })
      await db.collection('rooms').doc(room._id).update({
        data: {
          backup_songs: merged.slice(0, 10),
          updated_at: db.serverDate()
        }
      })
    }
    // 按权重随机混入来源：儿歌模式两来源加权，正常模式三来源加权
    const pools = room.children_mode ? [
      { source: 'favorite', weight: CHILDREN_REFILL_WEIGHTS.favorite, songs: favoritePool },
      { source: 'children', weight: CHILDREN_REFILL_WEIGHTS.children, songs: childrenPool }
    ] : [
      { source: 'favorite', weight: REFILL_SOURCE_WEIGHTS.favorite, songs: favoritePool },
      { source: 'cache', weight: REFILL_SOURCE_WEIGHTS.cache, songs: cachePool },
      { source: 'prompt', weight: REFILL_SOURCE_WEIGHTS.prompt, songs: promptPool }
    ]
    while (added.length < needed) {
      const available = pools.filter((pool) => pool.songs.length)
      if (!available.length) {
        break
      }
      let roll = Math.random() * available.reduce((sum, pool) => sum + pool.weight, 0)
      let picked = available[available.length - 1]
      for (const pool of available) {
        roll -= pool.weight
        if (roll < 0) {
          picked = pool
          break
        }
      }
      const song = picked.songs.shift()
      const key = `${song.source}:${song.mid}`
      if (existingKeys.has(key)) {
        continue
      }
      const item = await addBackupSong(song, picked.source, added.length)
      existingKeys.add(key)
      added.push(item)
    }
    const firstSong = currentQueue[0] || added[0]
    if (firstSong) {
      await db.collection('rooms').where({
        room_id: DEFAULT_ROOM_ID,
        current_song: null
      }).update({
        data: {
          current_song: _.set({ ...firstSong, since: Math.floor(Date.now() / 1000) }),
          recent_played: buildRecentPlayed(room, firstSong.song),
          updated_at: db.serverDate()
        }
      })
    }
    return success({ added: added.length, remaining: currentQueue.length + added.length }, added.length ? '备用队列已补充' : '暂无可用备用歌曲')
  } finally {
    await db.collection('rooms').where({
      room_id: DEFAULT_ROOM_ID,
      refill_lock_token: lockToken
    }).update({
      data: {
        refill_lock_until: 0,
        refill_lock_token: '',
        updated_at: db.serverDate()
      }
    }).catch(() => null)
  }
}

const passSong = async (payload, user) => {
  const room = await ensureDefaultRoom(user)
  if (!room.current_song || !room.current_song.song) {
    const result = await switchToNextSong(room)
    return result.next ? success(null, '开始播放') : success(null, '当前播放队列为空')
  }
  if (payload.source && normalizeMusicSource(payload.source) !== normalizeMusicSource(room.current_song.song.source)) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  if (payload.queue_id && String(payload.queue_id) !== String(room.current_song._id)) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  if (payload.mid && String(payload.mid) !== String(room.current_song.song.mid)) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  const result = await switchToNextSong(room)
  if (!result.advanced) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  return success(null, result.next ? '切歌成功，已切换到下一首' : '当前歌曲已结束，播放队列为空')
}

// 播放资源失效时自动切歌：不校验房主身份（系统行为），仅校验仍是同一首歌，防止误切新歌
const autoPassSong = async (payload, user) => {
  const room = await getDefaultRoom(user)
  if (!room.current_song || !room.current_song.song) {
    return failure('当前没有正在播放的歌曲', 422)
  }
  if (payload.queue_id && String(payload.queue_id) !== String(room.current_song._id)) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  if (payload.mid && String(payload.mid) !== String(room.current_song.song.mid)) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  if (payload.source && normalizeMusicSource(payload.source) !== normalizeMusicSource(room.current_song.song.source)) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  const result = await switchToNextSong(room, { refillWhenEmpty: true, user })
  if (!result.advanced) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  return success(result.next, result.next ? '已跳过失效歌曲' : '失效歌曲已移除，播放队列为空')
}

const finishSong = async (payload) => {
  const roomResult = await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).limit(1).get()
  const room = roomResult.data[0]
  if (!room || !room.current_song || !room.current_song.song) {
    return failure('当前没有正在播放的歌曲', 409)
  }
  if (String(payload.queue_id || '') !== String(room.current_song._id) || normalizeMusicSource(payload.source) !== normalizeMusicSource(room.current_song.song.source) || String(payload.mid || '') !== String(room.current_song.song.mid)) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  const result = await switchToNextSong(room)
  if (!result.advanced) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  return success(null, result.next ? '已播放下一首' : '播放结束，队列为空')
}

const removeQueueSong = async (payload, user) => {
  if (!payload.mid) {
    return failure('缺少歌曲标识', 422)
  }
  const item = await getQueueItem(payload)
  if (!item) {
    return failure('歌曲不在播放队列中', 404)
  }
  const room = await getDefaultRoom(user)
  const requesterId = item.user && item.user.user_id
  if (room.room_user !== user._id && requesterId !== user._id) {
    return failure('无权移除该歌曲', 403)
  }
  // 移除正在播放的歌曲时同步切歌，避免 current_song 仍指向已删除的队列项，
  // 导致该歌曲一直处于“正在播放”而无法重新点歌
  if (room.current_song && String(room.current_song._id) === String(item._id)) {
    const result = await switchToNextSong(room, { refillWhenEmpty: true, user })
    if (!result.advanced) {
      await db.collection('play_queue').doc(item._id).remove().catch(() => null)
    }
  } else if (item.song && item.song.source && item.song.mid) {
    // 同曲可能存在历史重复项，移除时一并清理；当前播放项必须排除，
    // 否则会把仍在播放的队列行删掉，导致 rooms.current_song 指向已删除项
    const duplicateWhere = {
      room_id: DEFAULT_ROOM_ID,
      'song.source': normalizeMusicSource(item.song.source),
      'song.mid': String(item.song.mid)
    }
    const currentId = room.current_song && room.current_song._id
    if (currentId) {
      duplicateWhere._id = _.neq(currentId)
    }
    await db.collection('play_queue').where(duplicateWhere).remove()
  } else {
    await db.collection('play_queue').doc(item._id).remove()
  }
  return success(null, '移除成功')
}

const pushQueueSong = async (payload, user) => {
  if (!payload.mid) {
    return failure('缺少歌曲标识', 422)
  }
  const item = await getQueueItem(payload)
  if (!item) {
    return failure('歌曲不在播放队列中', 404)
  }
  const room = await getDefaultRoom(user)
  if (room.room_user !== user._id) {
    return failure('只有房主可以置顶歌曲', 403)
  }
  // 置顶只调整待播顺序：取当前播放项之后的最小 sort_time 再减一，
  // 既保证当前播放项仍在队首，也避免多次置顶都写 0 造成顺序不稳定
  const currentId = room.current_song && room.current_song._id
  const headWhere = { room_id: DEFAULT_ROOM_ID }
  if (currentId) {
    headWhere._id = _.neq(currentId)
  }
  const head = await db.collection('play_queue').where(headWhere).orderBy('sort_time', 'asc').limit(1).get()
  const headSort = head.data.length ? Number(head.data[0].sort_time) : 0
  const nextSort = Number.isFinite(headSort) ? headSort - 1 : 0
  await db.collection('play_queue').doc(item._id).update({ data: { sort_time: nextSort } })
  return success(null, '置顶成功')
}

const normalizeSearchPrompts = (prompts) => {
  if (!Array.isArray(prompts)) {
    return DEFAULT_SEARCH_PROMPTS
  }
  return [...new Set(prompts.map((item) => String(item || '').trim()).filter((item) => item.length > 0 && item.length <= 30))].slice(0, 20)
}

// 一键儿歌：开启时清空待播队列并优先播放一首「儿歌」收藏；没有收藏时由客户端通过 WS 搜索补充
const setChildrenMode = async (payload, user) => {
  const room = await getDefaultRoom(user)
  if (!payload.enabled) {
    if (room.children_mode) {
      await db.collection('rooms').doc(room._id).update({
        data: {
          children_mode: false,
          // 退出时停止当前儿歌，交给正常模式重新补歌并恢复播放
          current_song: _.set(null),
          updated_at: db.serverDate()
        }
      })
      // 退出时清空待播队列（与开启行为对称），回到首页后由正常模式三来源重新补歌
      await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).remove()
    }
    return success({ children_mode: false }, '儿歌模式已关闭')
  }
  // 先置位并把 current_song 清空，再清空队列：保证删除队列行时不会有 current_song 悬空指向已删记录；
  // 后续补歌自动走「儿歌收藏 + 客户端 WS 词池候选」
  await db.collection('rooms').doc(room._id).update({
    data: {
      children_mode: true,
      current_song: _.set(null),
      updated_at: db.serverDate()
    }
  })
  await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).remove()
  // 优先播放用户「儿歌」收藏；没有收藏时交给客户端用 WS 搜索补充首曲
  const song = (await getFavoriteSongs(user, true))[0]
  if (!song) {
    return success({ children_mode: true, has_song: false }, '儿歌模式已开启，正在准备儿歌')
  }
  const queueItem = await addBackupSong(song, 'favorite', 0)
  await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).update({
    data: {
      current_song: _.set({ ...queueItem, since: Math.floor(Date.now() / 1000) }),
      recent_played: buildRecentPlayed(room, song),
      updated_at: db.serverDate()
    }
  })
  return success({ children_mode: true, has_song: true }, '儿歌模式已开启')
}

const updateSearchPrompts = async (payload, user) => {
  const room = await ensureDefaultRoom(user)
  if (room.room_user !== user._id) {
    return failure('只有房主可以管理搜索提示词', 403)
  }
  const prompts = normalizeSearchPrompts(payload.prompts)
  if (!prompts.length) {
    return failure('至少保留一个搜索提示词', 422)
  }
  await db.collection('rooms').doc(room._id).update({
    data: {
      search_prompts: prompts,
      updated_at: db.serverDate()
    }
  })
  return success(prompts, '搜索提示词已更新')
}

// 客户端只需要房间业务字段，补歌锁与备用缓存等内部状态不下发
const toClientRoom = (room) => {
  const { _id, backup_songs, refill_lock_until, refill_lock_token, ...clientRoom } = room
  return clientRoom
}

const handlers = {
  'user/getmyinfo': async (payload, user) => success(toClientUser(user)),
  // 附带服务端当前时间戳 serverTime，供客户端进房时校准本机与服务器的时钟差（切歌 seek 不受本机钟差影响）
  'room/getRoomInfo': async (payload, user) => {
    const room = await getDefaultRoom(user)
    return { code: 200, msg: '操作成功', data: toClientRoom(room), serverTime: Date.now() }
  },
  'room/getSearchPrompts': async (payload, user) => success(normalizeSearchPrompts((await getDefaultRoom(user)).search_prompts)),
  'room/updateSearchPrompts': updateSearchPrompts,
  'room/setChildrenMode': setChildrenMode,
  'message/getMessageList': getMessageList,
  'message/send': sendMessage,
  'message/back': recallMessage,
  'song/songList': queueList,
  'song/addSong': addSong,
  'song/playSong': (payload, user) => addSong(payload, user, true),
  'song/addMySong': addFavorite,
  'song/checkMySong': checkFavorite,
  'song/mySongList': (payload, user) => favoriteList(payload, user),
  'song/deleteMySong': deleteFavorite,
  'song/toggleMySongChildren': toggleFavoriteChildren,
  'song/remove': removeQueueSong,
  'song/push': pushQueueSong,
  'song/pass': passSong,
  'song/autoPass': autoPassSong,
  'song/ended': finishSong,
  'song/refill': refillQueue,
  'song/getLrc': async (payload) => {
    if (!payload.mid) {
      return success([])
    }
    // 只有网易云提供官方歌词；QQ、电台、酷狗及缺失来源的历史数据统一返回空歌词
    if (String(payload.source || '').toLowerCase() !== 'netease') {
      return success([])
    }
    try {
      return success(await getNeteaseLyric(payload.mid))
    } catch (error) {
      return success([])
    }
  },
  'song/getCovers': async (payload) => {
    const mids = normalizeCoverMids(payload.mids)
    if (!mids.length) {
      return success({})
    }
    try {
      return success(await getNeteaseCovers(mids))
    } catch (error) {
      return success({})
    }
  }
}

exports.main = async (event) => {
  try {
    const openid = getOpenid()
    // 定时触发器没有 OPENID；客户端伪造 Type/TriggerName 时仍会携带 OPENID，不能进入该分支
    if (!openid && event.Type === 'Timer' && event.TriggerName === 'refillPlaybackQueue') {
      const roomResult = await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).limit(1).get()
      const room = roomResult.data[0]
      if (!room || !room.room_user) {
        return success(null, '房间尚未初始化')
      }
      const ownerResult = await db.collection('users').doc(room.room_user).get()
      if (!ownerResult.data) {
        return success(null, '房主用户不存在')
      }
      return refillQueue({ count: 3 }, ownerResult.data)
    }
    if (!openid) {
      return failure('请先完成微信登录', 401)
    }
    if (event.action === 'weapp/wxAppLogin') {
      return await saveLoginUser(openid, event.payload || {})
    }
    const user = await getUserByOpenid(openid)
    if (!user) {
      // 游客可浏览的只读接口直接放行（房间初始化后才生效，避免游客触发建房）
      if (GUEST_ACTIONS.indexOf(event.action) > -1) {
        const roomResult = await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).limit(1).get()
        if (roomResult.data.length) {
          return await handlers[event.action](event.payload || {}, null)
        }
      }
      return failure('请先完成微信登录', 401)
    }
    const handler = Object.prototype.hasOwnProperty.call(handlers, event.action) ? handlers[event.action] : null
    if (!handler) {
      return failure(`暂不支持操作：${event.action}`, 404)
    }
    return await handler(event.payload || {}, user)
  } catch (error) {
    console.error('[musicApp]', event.action, error)
    return failure('云函数执行失败，请稍后重试')
  }
}
