const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const DEFAULT_ROOM_ID = 1
const DEFAULT_ROOM_NAME = 'Music For U'
const MUSIC_API_URL = 'https://api.i-meto.com/meting/api'
const NETEASE_MUSIC_API_URL = 'https://meting.mikus.ink/api'
const MUSIC_SOURCES = ['netease', 'tencent', 'kugou', 'wydt']
const DEFAULT_SEARCH_PROMPTS = ['周杰伦', '流行歌曲', '经典歌曲', '精选']
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
const getMusicApiUrl = (source) => normalizeMusicSource(source) === 'netease' ? NETEASE_MUSIC_API_URL : MUSIC_API_URL
const getFallbackMusicApiUrl = () => ''

const createMusicError = (message, statusCode = 0) => {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

const buildMusicApiUrl = (baseUrl, params) => {
  const query = Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&')
  return query ? `${baseUrl}?${query}` : baseUrl
}

const requestMusicApiAt = (baseUrl, params, parser = JSON.parse, timeout = 5000) => new Promise((resolve, reject) => {
  const requestUrl = buildMusicApiUrl(baseUrl, params)
  const request = https.get(requestUrl, (response) => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      body += chunk
    })
    response.on('end', () => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(createMusicError(`音乐接口返回 HTTP ${response.statusCode}`, response.statusCode))
        return
      }
      try {
        resolve(parser(body))
      } catch (error) {
        reject(createMusicError('音乐接口返回格式无效'))
      }
    })
  })
  request.setTimeout(timeout, () => request.destroy(createMusicError('音乐接口请求超时')))
  request.on('error', reject)
})

const requestMusicApi = async (params, parser = JSON.parse, timeout = 5000) => {
  const source = normalizeMusicSource(params.server)
  try {
    return await requestMusicApiAt(getMusicApiUrl(source), { ...params, server: source }, parser, timeout)
  } catch (error) {
    const fallbackUrl = getFallbackMusicApiUrl(source)
    if (!fallbackUrl) {
      throw error
    }
    return requestMusicApiAt(fallbackUrl, { ...params, server: source }, parser, timeout)
  }
}

const normalizeHttpsUrl = value => String(value || '').replace(/^http:\/\//i, 'https://')

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

const resolveMusicUrlFromApiUrl = (apiUrl, timeout = 5000) => new Promise((resolve, reject) => {
  const request = https.get(apiUrl, (response) => {
    const location = response.headers.location || ''
    if (response.statusCode >= 300 && response.statusCode < 400 && isUsableAudioUrl(location)) {
      response.resume()
      resolve(normalizeHttpsUrl(location))
      return
    }
    if (response.statusCode >= 200 && response.statusCode < 300
      && /^audio\//i.test(response.headers['content-type'] || '')) {
      response.resume()
      resolve(normalizeHttpsUrl(apiUrl))
      return
    }
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      if (body.length < 4096) body += chunk
    })
    response.on('end', () => {
      const statusCode = response.statusCode || 0
      const value = body.trim()
      let parsedValue = value
      try {
        const parsed = JSON.parse(value)
        if (typeof parsed === 'string') {
          parsedValue = parsed.trim()
        }
      } catch (error) {
        parsedValue = value
      }
      if (statusCode >= 200 && statusCode < 300) {
        if (isUsableAudioUrl(parsedValue)) {
          resolve(normalizeHttpsUrl(parsedValue))
          return
        }
        if (/^audio\//i.test(response.headers['content-type'] || '')) {
          resolve(normalizeHttpsUrl(apiUrl))
          return
        }
      }
      const unavailable = statusCode === 401 || statusCode === 403 || statusCode === 404
        || (statusCode >= 300 && statusCode < 400)
        || /\/404(?:\/|\?|$)/i.test(location)
      reject(createMusicError(unavailable ? '歌曲播放资源不可用' : `音乐接口返回 HTTP ${statusCode}`, unavailable ? 404 : statusCode))
    })
  })
  request.setTimeout(timeout, () => request.destroy(createMusicError('音乐播放接口请求超时')))
  request.on('error', reject)
})

const resolveTencentMusicUrl = async (mid) => {
  const item = await getMusicDetailItemFrom(NETEASE_MUSIC_API_URL, 'tencent', mid)
  const url = item && typeof item.url === 'string' ? item.url : ''
  if (!url || extractMusicId(url) !== String(mid)) {
    throw createMusicError('QQ音乐播放资源不可用', 404)
  }
  return resolveMusicUrlFromApiUrl(url)
}

// 详情接口（type=song）免鉴权且返回带签名的 url/lrc 地址，做短时缓存避免重复请求
const MUSIC_DETAIL_CACHE_TTL = 3 * 60 * 1000
const musicDetailCache = new Map()

const getMusicDetailItemFrom = async (baseUrl, source, mid, timeout = 5000) => {
  const detail = await requestMusicApiAt(baseUrl, {
    server: normalizeMusicSource(source),
    type: 'song',
    id: mid
  }, JSON.parse, timeout)
  return Array.isArray(detail) ? detail.find((entry) => entry && (entry.url || entry.lrc)) : null
}

const getMusicDetailItem = async (source, mid, timeout = 5000) => {
  const key = `${normalizeMusicSource(source)}:${mid}`
  const cached = musicDetailCache.get(key)
  if (cached && Date.now() - cached.ts < MUSIC_DETAIL_CACHE_TTL) {
    return cached.item
  }
  let item
  let usedFallback = false
  try {
    item = await getMusicDetailItemFrom(getMusicApiUrl(source), source, mid, timeout)
  } catch (error) {
    const fallbackUrl = getFallbackMusicApiUrl(source)
    if (!fallbackUrl) throw error
    usedFallback = true
    item = await getMusicDetailItemFrom(fallbackUrl, source, mid, timeout)
  }
  if (!item) {
    const fallbackUrl = getFallbackMusicApiUrl(source)
    if (fallbackUrl && !usedFallback) item = await getMusicDetailItemFrom(fallbackUrl, source, mid, timeout)
  }
  if (item) {
    musicDetailCache.set(key, { item, ts: Date.now() })
  }
  return item
}

const firstSuccess = (tasks) => new Promise((resolve, reject) => {
  let pending = tasks.length
  let lastError = null
  tasks.forEach((task) => {
    Promise.resolve(task).then(resolve, (error) => {
      lastError = error
      pending -= 1
      if (pending === 0) {
        reject(lastError || new Error('所有请求均失败'))
      }
    })
  })
})

const resolveMusicUrl = async (source, mid, apiUrl) => {
  const server = normalizeMusicSource(source)
  if (server === 'tencent') {
    return resolveTencentMusicUrl(mid)
  }
  const fallbackBaseUrl = getFallbackMusicApiUrl(server)
  const fallbackUrl = fallbackBaseUrl
    ? buildMusicApiUrl(fallbackBaseUrl, { server, type: 'url', id: mid })
    : ''
  const isMetingUrl = value => value && typeof value === 'string'
    && /^https:\/\/meting\.mikus\.ink\/api\?/.test(value)

  if (isMetingUrl(apiUrl)) {
    try {
      return await resolveMusicUrlFromApiUrl(apiUrl)
    } catch (error) {
      if (![401, 403, 404, 500].includes(error.statusCode)) throw error
      if (fallbackUrl) {
        try { return await resolveMusicUrlFromApiUrl(fallbackUrl) } catch (fallbackError) { /* 继续使用详情地址 */ }
      }
    }
  }

  const item = await getMusicDetailItem(server, mid)
  const detailUrl = item && typeof item.url === 'string' ? item.url : ''
  if (!detailUrl || extractMusicId(detailUrl) !== String(mid)) {
    throw createMusicError('歌曲播放资源不可用', 404)
  }

  try {
    return await resolveMusicUrlFromApiUrl(detailUrl)
  } catch (error) {
    if (![401, 403, 404, 500].includes(error.statusCode) || !fallbackUrl) throw error
    return resolveMusicUrlFromApiUrl(fallbackUrl)
  }
}

const extractMusicId = (value) => {
  const match = String(value || '').match(/[?&]id=([^&]+)/i)
  return match ? decodeURIComponent(match[1]) : ''
}

const normalizeMusicItem = (item, source = 'netease') => {
  const mid = extractMusicId(item.url)
    || extractMusicId(item.lrc)
    || String(item.songmid || item.songMid || item.mid || item.id || '')
  if (!mid || !item.title) {
    return null
  }
  const server = normalizeMusicSource(source)
  const isTencent = server === 'tencent'
  const musicApiUrl = getMusicApiUrl(server)
  const fallbackUrl = `${musicApiUrl}?server=${server}&type=url&id=${encodeURIComponent(mid)}`
  const fallbackLrc = `${musicApiUrl}?server=${server}&type=lrc&id=${encodeURIComponent(mid)}`
  return {
    ...(isTencent ? { songmid: mid } : {}),
    source: server,
    mid,
    name: String(item.title),
    singer: String(item.author || ''),
    album: '',
    pic: String(item.pic || '').replace(/^http:\/\//i, 'https://'),
    // QQ 播放地址由 song/getUrl 按 songmid 调用 Meting 详情接口动态获取，不持久化限时地址。
    url: isTencent ? '' : String(item.url || fallbackUrl).replace(/^http:\/\//i, 'https://'),
    lrc: isTencent ? '' : String(item.lrc || fallbackLrc).replace(/^http:\/\//i, 'https://')
  }
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
  const url = source === 'tencent' ? '' : String(song.url || '')
  if (source === 'wydt' && !url) {
    throw new Error('电台节目缺少播放地址')
  }
  if (url && !/^https:\/\//i.test(url) && !/^cloud:\/\//i.test(url)) {
    throw new Error('歌曲播放地址必须使用 HTTPS 或云文件地址')
  }
  return {
    source,
    mid: String(song.mid),
    name: String(song.name),
    singer: String(song.singer || ''),
    album: String(song.album || ''),
    pic: source === 'kugou' ? '' : String(song.pic || ''),
    url,
    lrc: source === 'tencent' || source === 'wydt'
      ? []
      : (typeof song.lrc === 'string' ? song.lrc : (Array.isArray(song.lrc) ? song.lrc : []))
  }
}

const withTimeout = (promise, timeout) => Promise.race([
  promise,
  new Promise((resolve) => setTimeout(() => resolve([]), timeout))
])

const getOpenid = () => cloud.getWXContext().OPENID

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
  if (!/^cloud:\/\//i.test(userHead)) {
    return failure('请授权选择并上传微信头像', 422)
  }
  const systemUserName = createSystemUserName(openid)
  const existing = await getUserByOpenid(openid)
  if (existing) {
    const values = {
      user_name: systemUserName,
      user_head: userHead,
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
    profile_completed: false,
    updated_at: db.serverDate()
  }
  const created = await db.collection('users').add({
    data: {
      _openid: openid,
      ...values,
      created_at: db.serverDate(),
    }
  })
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

const updateProfile = async (payload, user) => {
  if (!payload.user_head && !user.user_head) {
    return failure('请先授权选择微信头像', 422)
  }
  const values = {
    user_head: payload.user_head || user.user_head,
    user_sex: Number(payload.user_sex) || 0,
    user_remark: String(payload.user_remark || '').trim().slice(0, 100),
    profile_completed: Boolean(payload.user_head || user.user_head),
    updated_at: db.serverDate()
  }
  await db.collection('users').doc(user._id).update({ data: values })
  return success(toClientUser({ ...user, ...values }), '资料已更新')
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
  const result = await db.collection('playlists').where({ _openid: user._openid }).orderBy('created_at', 'desc').skip((page - 1) * pageSize).limit(pageSize).get()
  return success(result.data.map((item) => validateSong(item.song)))
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
        auto_refill_paused: false,
        updated_at: db.serverDate()
      }
    })
  }
  return success(null, playNow || !room.current_song ? '播放成功' : '点歌成功')
}

// 移除当前播放歌曲并切到队列下一首
const switchToNextSong = async (room) => {
  const currentId = room.current_song && room.current_song._id
  const queue = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).orderBy('sort_time', 'asc').limit(2).get()
  const next = queue.data.find((item) => !currentId || item._id !== currentId) || null
  const condition = currentId
    ? { room_id: DEFAULT_ROOM_ID, 'current_song._id': currentId }
    : { room_id: DEFAULT_ROOM_ID, current_song: null }
  const updated = await db.collection('rooms').where(condition).update({
    data: {
      current_song: _.set(next ? { ...next, since: Math.floor(Date.now() / 1000) } : null),
      auto_refill_paused: !next,
      updated_at: db.serverDate()
    }
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

const getFavoriteSongs = async (user) => {
  const result = await db.collection('playlists').where({ _openid: user._openid }).orderBy('created_at', 'desc').limit(100).get()
  return result.data.map((item) => {
    try {
      return validateSong(item.song)
    } catch (error) {
      return null
    }
  }).filter((song) => song && song.source !== 'wydt')
}

const filterPlayableSongs = async (songs, existingKeys, limit) => {
  const candidates = songs
    .filter((song) => song && !existingKeys.has(`${song.source}:${song.mid}`))
    .slice(0, Math.max(limit * 3, limit))
  const checked = await Promise.all(candidates.map(async (song) => {
    try {
      await withTimeout(resolveMusicUrl(song.source, song.mid, song.url), 1200)
      return song
    } catch (error) {
      return null
    }
  }))
  return checked.filter(Boolean).slice(0, limit)
}

const addBackupSong = async (song, source, index) => {
  const queueItem = {
    room_id: DEFAULT_ROOM_ID,
    song,
    user: source === 'favorite' ? {
      ...AUTO_SONG_USER,
      user_name: '收藏歌曲'
    } : AUTO_SONG_USER,
    sort_time: Date.now() + index,
    auto_added: true,
    backup_source: source,
    created_at: db.serverDate()
  }
  const created = await db.collection('play_queue').add({ data: queueItem })
  return { ...queueItem, _id: created._id }
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
    const needed = target - currentQueue.length
    const added = []
    const favorites = await getFavoriteSongs(user)
    const favoriteCandidates = await filterPlayableSongs(favorites, existingKeys, needed)
    for (const song of favoriteCandidates) {
      const key = `${song.source}:${song.mid}`
      if (added.length >= needed || existingKeys.has(key)) {
        continue
      }
      const item = await addBackupSong(song, 'favorite', added.length)
      existingKeys.add(key)
      added.push(item)
    }
    if (added.length < needed) {
      const cachedSongs = await filterPlayableSongs(room.backup_songs.map((song) => {
        try {
          return validateSong(song)
        } catch (error) {
          return null
        }
      }), existingKeys, needed - added.length)
      for (const song of cachedSongs) {
        const key = `${song.source}:${song.mid}`
        if (existingKeys.has(key)) {
          continue
        }
        const item = await addBackupSong(song, 'cache', added.length)
        existingKeys.add(key)
        added.push(item)
      }
    }
    if (added.length < needed) {
      const songs = await findPromptSongs(room, existingKeys, needed - added.length)
      const playableSongs = await filterPlayableSongs(songs, existingKeys, needed - added.length)
      for (const song of playableSongs) {
        const key = `${song.source}:${song.mid}`
        if (existingKeys.has(key)) {
          continue
        }
        const item = await addBackupSong(song, 'prompt', added.length)
        existingKeys.add(key)
        added.push(item)
      }
      if (playableSongs.length) {
        await db.collection('rooms').doc(room._id).update({
          data: {
            backup_songs: playableSongs.slice(0, 10),
            updated_at: db.serverDate()
          }
        })
      }
    }
    const firstSong = currentQueue[0] || added[0]
    if (firstSong) {
      await db.collection('rooms').where({
        room_id: DEFAULT_ROOM_ID,
        current_song: null
      }).update({
        data: {
          current_song: _.set({ ...firstSong, since: Math.floor(Date.now() / 1000) }),
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
  const result = await switchToNextSong(room)
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

const searchMusic = async (payload) => {
  const keyword = String(payload.keyword || '').trim()
  if (!keyword || keyword.length > 50) {
    return failure('请输入歌曲名称', 422)
  }
  try {
    const source = normalizeMusicSource(payload.source)
    const result = await requestMusicApi({
      server: source,
      type: 'search',
      id: keyword
    })
    const songs = Array.isArray(result)
      ? result.map((item) => normalizeMusicItem(item, source)).filter(Boolean)
      : []
    return success(songs, '搜索成功')
  } catch (error) {
    return failure(error.message || '音乐搜索失败', 502)
  }
}

const normalizeSearchPrompts = (prompts) => {
  if (!Array.isArray(prompts)) {
    return DEFAULT_SEARCH_PROMPTS
  }
  return [...new Set(prompts.map((item) => String(item || '').trim()).filter((item) => item.length > 0 && item.length <= 30))].slice(0, 20)
}

const findPromptSongs = async (room, existingKeys, limit) => {
  const prompts = normalizeSearchPrompts(room.search_prompts)
  if (!prompts.length || limit <= 0) {
    return []
  }
  try {
    const keyword = prompts[Math.floor(Math.random() * prompts.length)]
    const source = 'netease'
    const result = await requestMusicApi({
      server: source,
      type: 'search',
      id: keyword
    }, JSON.parse, 1500)
    const songs = Array.isArray(result) ? result.map((item) => normalizeMusicItem(item, source)).filter(Boolean) : []
    return songs.filter((song) => !existingKeys.has(`${song.source}:${song.mid}`)).slice(0, Math.max(limit * 3, limit))
  } catch (error) {
    return []
  }
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
  'user/updateMyInfo': updateProfile,
  'room/getRoomInfo': async (payload, user) => success(await getDefaultRoom(user)),
  'room/getSearchPrompts': async (payload, user) => success(normalizeSearchPrompts((await getDefaultRoom(user)).search_prompts)),
  'room/updateSearchPrompts': updateSearchPrompts,
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
  'song/search': searchMusic,
  'song/songList': queueList,
  'song/addSong': addSong,
  'song/playSong': (payload, user) => addSong(payload, user, true),
  'song/addMySong': addFavorite,
  'song/mySongList': (payload, user) => favoriteList(payload, user),
  'song/deleteMySong': deleteFavorite,
  'song/remove': removeQueueSong,
  'song/push': pushQueueSong,
  'song/pass': passSong,
  'song/autoPass': autoPassSong,
  'song/ended': finishSong,
  'song/refill': refillQueue,
  'song/getUrl': async (payload) => {
    if (!payload.mid) {
      return failure('缺少歌曲标识', 422)
    }
    try {
      return success(await resolveMusicUrl(payload.source, payload.mid, payload.url))
    } catch (error) {
      return failure(error.message || '歌曲播放资源不可用', 502)
    }
  },
  'song/getLrc': async (payload) => {
    if (!payload.mid) {
      return success([])
    }
    // QQ WS 歌曲结果只提供 metadata 和 songmid；不再通过 Meting 拼接或补取 QQ 歌词地址。
    if (normalizeMusicSource(payload.source) === 'tencent') {
      return success([])
    }
    const server = normalizeMusicSource(payload.source)
    const parseLyricsBody = (body) => parseLyrics(body)
    // 并行发起：已存歌词地址 + 详情签名地址 + 网易云备用接口
    const tasks = []
    if (payload.lrc && typeof payload.lrc === 'string' && /^https:\/\/(?:api\.i-meto\.com\/meting|meting\.mikus\.ink)\/api\?/.test(payload.lrc)) {
      tasks.push(requestMusicApiAt(payload.lrc, {}, parseLyricsBody))
    }
    tasks.push((async () => {
      const item = await getMusicDetailItem(server, payload.mid)
      if (!item || !item.lrc) {
        throw new Error('歌词资源不可用')
      }
      try {
        return await requestMusicApiAt(item.lrc, {}, parseLyricsBody)
      } catch (error) {
        const fallbackUrl = getFallbackMusicApiUrl(server)
        if (!fallbackUrl) throw error
        return requestMusicApiAt(buildMusicApiUrl(fallbackUrl, {
          server,
          type: 'lrc',
          id: payload.mid
        }), {}, parseLyricsBody)
      }
    })())
    const fallbackUrl = getFallbackMusicApiUrl(server)
    if (fallbackUrl) {
      tasks.push(requestMusicApiAt(buildMusicApiUrl(fallbackUrl, {
        server,
        type: 'lrc',
        id: payload.mid
      }), {}, parseLyricsBody))
    }
    try {
      return success(await withTimeout(firstSuccess(tasks), 2200))
    } catch (error) {
      return success([])
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
    if (event.action === 'weapp/wxAppLogin') {
      return await saveLoginUser(openid, event.payload || {})
    }
    const user = await getUserByOpenid(openid)
    if (!user) {
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
