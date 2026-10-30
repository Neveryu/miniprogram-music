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
// 游客（未登录）可访问的只读接口：浏览房间、消息、队列、歌词
const GUEST_ACTIONS = [
  'room/getRoomInfo',
  'app/getRealtimeState',
  'message/getMessageList',
  'song/songList',
  'song/getLrc'
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

const normalizeMusicSource = (source) => MUSIC_SOURCES.includes(source) ? source : 'netease'

const normalizeHttpsUrl = value => String(value || '')
  .replace(/^http:\/\//i, 'https://')
  .replace(/\\u0026/gi, '&')
  .replace(/&amp;/gi, '&')

const isUsableAudioUrl = value => {
  try {
    const parsed = new URL(normalizeHttpsUrl(value))
    return parsed.protocol === 'https:'
      && Boolean(parsed.hostname)
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

// 网易云官方接口请求：歌词和封面补全都复用同一套请求头
const NETEASE_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://music.163.com/',
  Accept: 'application/json',
  'Accept-Encoding': 'identity'
}

const requestNeteaseJson = (requestUrl, timeout = 2500) => new Promise((resolve, reject) => {
  const request = https.get(requestUrl, { headers: NETEASE_REQUEST_HEADERS }, (response) => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume()
      reject(new Error(`网易云接口返回 HTTP ${response.statusCode}`))
      return
    }
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      body += chunk
    })
    response.on('end', () => {
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error('网易云接口返回格式无效'))
      }
    })
  })
  request.setTimeout(timeout, () => request.destroy(new Error('网易云接口请求超时')))
  request.on('error', reject)
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
    room_type: 0,
    room_public: 1,
    room_addsong: 0,
    room_sendmsg: 0,
    room_playone: 0,
    search_prompts: DEFAULT_SEARCH_PROMPTS,
    backup_songs: [],
    recent_played: [],
    current_song: null,
    auto_refill_paused: false,
    refill_status: 'idle',
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
    roomDefaults.refill_status = 'idle'
    roomDefaults.refill_lock_token = ''
    room.refill_lock_until = 0
    room.refill_status = 'idle'
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
  return room
}

const normalizeMessage = (doc) => ({
  ...doc,
  message_id: doc._id,
  message_content: JSON.stringify(doc.payload),
  message_createtime: doc.created_timestamp
})

const sendMessage = async (payload, user) => {
  const type = ['text', 'img', 'voice'].includes(payload.type) ? payload.type : 'text'
  const content = String(payload.msg || '').trim()
  if (!content || content.length > 1000) {
    return failure('消息内容长度应为 1 到 1000 个字符', 422)
  }
  const isBundledEmoji = type === 'img' && /^\/res\/Emojis\//.test(content)
  if ((type === 'img' || type === 'voice') && !/^cloud:\/\//i.test(content) && !isBundledEmoji) {
    return failure('消息文件必须使用云存储地址', 422)
  }
  const duration = type === 'voice' ? Math.min(Math.max(Number(payload.duration) || 0, 1), 60000) : 0
  let reply = null
  if (payload.reply_to) {
    const replied = await db.collection('messages').doc(String(payload.reply_to)).get()
    if (replied.data && replied.data.room_id === DEFAULT_ROOM_ID) {
      const repliedPayload = replied.data.payload || {}
      reply = {
        message_id: replied.data._id,
        type: repliedPayload.type,
        content: repliedPayload.type === 'text' ? String(repliedPayload.content || '').slice(0, 200) : '',
        user_name: String(repliedPayload.user && repliedPayload.user.user_name || '')
      }
    }
  }
  const message = {
    type,
    content,
    resource: String(payload.resource || content),
    duration,
    reply,
    user: toClientUser(user),
    room_id: DEFAULT_ROOM_ID,
    message_time: Math.floor(Date.now() / 1000)
  }
  const created = await db.collection('messages').add({
    data: {
      _openid: user._openid,
      room_id: DEFAULT_ROOM_ID,
      payload: message,
      created_timestamp: message.message_time,
      created_at: db.serverDate()
    }
  })
  return success({ ...message, message_id: created._id }, '发送成功')
}

const getMessageList = async (payload) => {
  const limit = Math.min(Number(payload.per_page) || 20, 100)
  const result = await db.collection('messages')
    .where({ room_id: DEFAULT_ROOM_ID })
    .orderBy('created_timestamp', 'desc')
    .limit(limit)
    .get()
  return success(result.data.map(normalizeMessage))
}

const getRealtimeState = async (payload, user) => {
  const room = await getDefaultRoom(user)
  const messages = await getMessageList(payload)
  return success({
    room,
    messages: messages.data
  })
}

const recallMessage = async (payload, user) => {
  if (!payload.message_id) {
    return failure('缺少消息标识', 422)
  }
  const result = await db.collection('messages').doc(payload.message_id).get()
  const message = result.data
  const room = await getDefaultRoom(user)
  if (message._openid !== user._openid && room.room_user !== user._id) {
    return failure('无权撤回该消息', 403)
  }
  await db.collection('messages').doc(payload.message_id).remove()
  return success(null, '撤回成功')
}

const addFavorite = async (payload, user) => {
  const song = validateSong(payload.song || { source: payload.source, mid: payload.mid, name: payload.name })
  const exists = await db.collection('playlists').where({ _openid: user._openid, source: song.source, mid: song.mid }).limit(1).get()
  if (!exists.data.length) {
    await db.collection('playlists').add({
      data: {
        _openid: user._openid,
        source: song.source,
        mid: song.mid,
        song,
        created_at: db.serverDate()
      }
    })
  }
  return success(null, '收藏成功')
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
  const result = await db.collection('playlists').where(where).orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get()
  return success(result.data.map((item) => ({
    ...validateSong(item.song),
    // 儿歌分类标记：供收藏页列表右侧按钮显示状态
    children: !!item.children
  })))
}

// 收藏页：将收藏歌曲标记为儿歌或移出儿歌
const toggleFavoriteChildren = async (payload, user) => {
  const source = normalizeMusicSource(payload.source)
  const result = await db.collection('playlists').where({ _openid: user._openid, mid: payload.mid }).get()
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
  const result = await db.collection('playlists').where({ _openid: user._openid, mid: payload.mid }).get()
  const source = normalizeMusicSource(payload.source)
  await Promise.all(result.data.filter((item) => normalizeMusicSource(item.source) === source).map((item) => db.collection('playlists').doc(item._id).remove()))
  return success(null, '移除成功')
}

const queueList = async () => {
  const result = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).orderBy('sort_time', 'asc').limit(100).get()
  return success(result.data)
}

const getQueueItem = async (payload) => {
  if (payload.queue_id) {
    const result = await db.collection('play_queue').doc(String(payload.queue_id)).get()
    return result.data && result.data.room_id === DEFAULT_ROOM_ID ? result.data : null
  }
  const result = await db.collection('play_queue').where({
    room_id: DEFAULT_ROOM_ID,
    'song.source': normalizeMusicSource(payload.source),
    'song.mid': payload.mid
  }).limit(1).get()
  return result.data[0] || null
}

const addSong = async (payload, user, playNow = false) => {
  const room = await getDefaultRoom(user)
  if (playNow && room.room_user !== user._id) {
    return failure('只有房主可以立即播放歌曲', 403)
  }
  const song = validateSong(payload.song || payload)
  // 防重复点歌：已在队列或正在播放的歌曲直接拒绝（立即播放除外）
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
    }).limit(1).get()
    if (existing.data.length) {
      return failure('该歌曲已在播放列表中', 409)
    }
  }
  const queueItem = {
    room_id: DEFAULT_ROOM_ID,
    song,
    user: toClientUser(user),
    sort_time: Date.now(),
    created_at: db.serverDate()
  }
  const created = await db.collection('play_queue').add({ data: queueItem })
  if (playNow || !room.current_song) {
    await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).update({
      data: {
        current_song: _.set({ ...queueItem, _id: created._id, since: Math.floor(Date.now() / 1000) }),
        recent_played: buildRecentPlayed(room, song),
        auto_refill_paused: false,
        updated_at: db.serverDate()
      }
    })
  }
  return success(null, playNow || !room.current_song ? '播放成功' : '点歌成功')
}

// 移除当前播放歌曲并切到队列下一首；autoPass 时先补一次歌再切，避免唯一歌曲失效后队列直接清空
const switchToNextSong = async (room, options = {}) => {
  const currentId = room.current_song && room.current_song._id
  let queue = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).orderBy('sort_time', 'asc').limit(2).get()
  let next = queue.data.find((item) => !currentId || item._id !== currentId) || null
  if (!next && options.refillWhenEmpty && options.user) {
    await refillQueue({ count: 2 }, options.user).catch(() => null)
    queue = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).orderBy('sort_time', 'asc').limit(2).get()
    next = queue.data.find((item) => !currentId || item._id !== currentId) || null
  }
  const condition = currentId
    ? { room_id: DEFAULT_ROOM_ID, 'current_song._id': currentId }
    : { room_id: DEFAULT_ROOM_ID, current_song: null }
  const switchData = {
    current_song: _.set(next ? { ...next, since: Math.floor(Date.now() / 1000) } : null),
    auto_refill_paused: !next,
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
    .limit(100)
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
  }).filter((song) => song && song.source !== 'wydt'))
}

const addBackupSong = async (song, source, index) => {
  const autoUser = source === 'favorite' ? { ...AUTO_SONG_USER, user_name: '收藏歌曲' }
    : source === 'children' ? { ...AUTO_SONG_USER, user_name: '儿歌电台' }
      : AUTO_SONG_USER
  const queueItem = {
    room_id: DEFAULT_ROOM_ID,
    song,
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
          auto_refill_paused: false,
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
      refill_status: 'running',
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
      .filter((song) => song && !existingKeys.has(`${song.source}:${song.mid}`))
      .slice(0, Math.max(needed * 2, needed))
    const promptPool = room.children_mode ? [] : clientPoolOf('prompt')
    const childrenPool = room.children_mode ? clientPoolOf('children') : []
    // 提示词搜索成功时刷新房间缓存
    if (promptPool.length) {
      await db.collection('rooms').doc(room._id).update({
        data: {
          backup_songs: promptPool.slice(0, 10),
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
          auto_refill_paused: false,
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
        refill_status: 'idle',
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
  if (item) {
    const room = await getDefaultRoom(user)
    const requesterId = item.user && item.user.user_id
    if (room.room_user !== user._id && requesterId !== user._id) {
      return failure('无权移除该歌曲', 403)
    }
    await db.collection('play_queue').doc(item._id).remove()
  }
  return success(null, '移除成功')
}

const pushQueueSong = async (payload, user) => {
  if (!payload.mid) {
    return failure('缺少歌曲标识', 422)
  }
  const item = await getQueueItem(payload)
  if (item) {
    const room = await getDefaultRoom(user)
    if (room.room_user !== user._id) {
      return failure('只有房主可以置顶歌曲', 403)
    }
    await db.collection('play_queue').doc(item._id).update({ data: { sort_time: 0 } })
  }
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
          updated_at: db.serverDate()
        }
      })
      // 退出时清空待播队列（与开启行为对称），当前歌曲播完后由正常模式三来源重新补歌
      await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).remove()
    }
    return success({ children_mode: false }, '儿歌模式已关闭')
  }
  // 先置位再清空队列：后续补歌自动走「儿歌收藏 + 客户端 WS 词池候选」
  await db.collection('rooms').doc(room._id).update({
    data: {
      children_mode: true,
      updated_at: db.serverDate()
    }
  })
  await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).remove()
  // 优先播放用户「儿歌」收藏；没有收藏时交给客户端用 WS 搜索补充首曲
  const song = (await getFavoriteSongs(user, true))[0]
  if (!song) {
    await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).update({
      data: {
        current_song: _.set(null),
        auto_refill_paused: false,
        updated_at: db.serverDate()
      }
    })
    return success({ children_mode: true, has_song: false }, '儿歌模式已开启，正在准备儿歌')
  }
  const queueItem = {
    room_id: DEFAULT_ROOM_ID,
    song,
    user: { ...AUTO_SONG_USER, user_name: '收藏歌曲' },
    sort_time: Date.now(),
    auto_added: true,
    backup_source: 'favorite',
    created_at: db.serverDate()
  }
  const created = await db.collection('play_queue').add({ data: queueItem })
  await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).update({
    data: {
      current_song: _.set({ ...queueItem, _id: created._id, since: Math.floor(Date.now() / 1000) }),
      recent_played: buildRecentPlayed(room, song),
      auto_refill_paused: false,
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

const handlers = {
  'user/getmyinfo': async (payload, user) => success(toClientUser(user)),
  'room/getRoomInfo': async (payload, user) => success(await getDefaultRoom(user)),
  'room/getSearchPrompts': async (payload, user) => success(normalizeSearchPrompts((await getDefaultRoom(user)).search_prompts)),
  'room/updateSearchPrompts': updateSearchPrompts,
  'room/setChildrenMode': setChildrenMode,
  'app/getRealtimeState': getRealtimeState,
  'message/getMessageList': getMessageList,
  'message/send': sendMessage,
  'message/back': recallMessage,
  'message/clear': async (payload, user) => {
    const room = await getDefaultRoom(user)
    if (room.room_user !== user._id) {
      return failure('无权清空消息', 403)
    }
    await db.collection('messages').where({ room_id: DEFAULT_ROOM_ID }).remove()
    return success(null, '消息已清空')
  },
  'song/songList': queueList,
  'song/addSong': addSong,
  'song/playSong': (payload, user) => addSong(payload, user, true),
  'song/addMySong': addFavorite,
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
    // 只有网易云提供官方歌词；QQ 与电台歌曲返回空歌词
    if (normalizeMusicSource(payload.source) !== 'netease') {
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
  },
  'attach/search': async () => success([])
}

exports.main = async (event) => {
  try {
    if (event.Type === 'Timer' && event.TriggerName === 'refillPlaybackQueue') {
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
    const openid = getOpenid()
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
    const handler = handlers[event.action]
    if (!handler) {
      return failure(`暂不支持操作：${event.action}`, 404)
    }
    return await handler(event.payload || {}, user)
  } catch (error) {
    console.error('[musicApp]', event.action, error)
    return failure(error.message || '云函数执行失败')
  }
}
