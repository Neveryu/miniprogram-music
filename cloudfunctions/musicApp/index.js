const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const DEFAULT_ROOM_ID = 1
const DEFAULT_ROOM_NAME = 'Music For U'
const MUSIC_API_URL = 'https://www.hanxin.vip/api/music'

const success = (data, msg = '操作成功') => ({ code: 200, msg, data })
const failure = (msg, code = 500, data = null) => ({ code, msg, data })

const validateUserName = (value) => {
  const name = String(value || '').trim()
  if (!name || name.length > 20) {
    throw new Error('昵称长度应为 1 到 20 个字符')
  }
  return name
}

const validateSong = (song) => {
  if (!song || !song.mid || !song.name) {
    throw new Error('歌曲数据不完整')
  }
  const url = String(song.url || '')
  if (url && !/^https:\/\//i.test(url) && !/^cloud:\/\//i.test(url)) {
    throw new Error('歌曲播放地址必须使用 HTTPS 或云文件地址')
  }
  return {
    mid: String(song.mid),
    name: String(song.name),
    singer: String(song.singer || ''),
    album: String(song.album || ''),
    pic: String(song.pic || ''),
    url,
    lrc: Array.isArray(song.lrc) ? song.lrc : []
  }
}

const getOpenid = () => cloud.getWXContext().OPENID

const getUserByOpenid = async (openid) => {
  const result = await db.collection('users').where({ _openid: openid }).limit(1).get()
  return result.data[0] || null
}

const saveLoginUser = async (openid, payload) => {
  const userName = validateUserName(payload.user_name)
  const userHead = String(payload.user_head || '')
  if (!/^cloud:\/\//i.test(userHead)) {
    return failure('请授权选择并上传微信头像', 422)
  }
  if (![0, 1].includes(Number(payload.user_sex))) {
    return failure('请选择性别', 422)
  }
  const values = {
    user_name: userName,
    user_head: userHead,
    user_sex: Number(payload.user_sex),
    user_remark: String(payload.user_remark || '').trim().slice(0, 100),
    profile_completed: true,
    updated_at: db.serverDate()
  }
  const existing = await getUserByOpenid(openid)
  if (existing) {
    await db.collection('users').doc(existing._id).update({ data: values })
    return success(toClientUser({ ...existing, ...values }), '登录成功')
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
    current_song: null,
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

const getDefaultRoom = async (user) => ensureDefaultRoom(user)

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
    user_name: validateUserName(payload.user_name || user.user_name),
    user_head: payload.user_head || user.user_head,
    user_sex: Number(payload.user_sex) || 0,
    user_remark: String(payload.user_remark || '').trim().slice(0, 100),
    profile_completed: Boolean(payload.user_name && (payload.user_head || user.user_head)),
    updated_at: db.serverDate()
  }
  await db.collection('users').doc(user._id).update({ data: values })
  return success(toClientUser({ ...user, ...values }), '资料已更新')
}

const addFavorite = async (payload, user) => {
  const song = validateSong(payload.song || { mid: payload.mid, name: payload.name })
  const exists = await db.collection('playlists').where({ _openid: user._openid, mid: song.mid }).limit(1).get()
  if (!exists.data.length) {
    await db.collection('playlists').add({
      data: {
        _openid: user._openid,
        mid: song.mid,
        song,
        created_at: db.serverDate()
      }
    })
  }
  return success(null, '收藏成功')
}

const favoriteList = async (user) => {
  const result = await db.collection('playlists').where({ _openid: user._openid }).orderBy('created_at', 'desc').limit(100).get()
  return success(result.data.map((item) => item.song))
}

const deleteFavorite = async (payload, user) => {
  await db.collection('playlists').where({ _openid: user._openid, mid: payload.mid }).remove()
  return success(null, '移除成功')
}

const queueList = async () => {
  const result = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).orderBy('sort_time', 'asc').limit(100).get()
  return success(result.data)
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
  if (playNow) {
    await db.collection('rooms').where({ room_id: DEFAULT_ROOM_ID }).update({
      data: {
        current_song: { ...queueItem, _id: created._id, since: Math.floor(Date.now() / 1000) },
        updated_at: db.serverDate()
      }
    })
  }
  return success(null, playNow ? '播放成功' : '点歌成功')
}

const passSong = async (payload, user) => {
  const room = await getDefaultRoom(user)
  if (!room.current_song || !room.current_song.song) {
    return failure('当前没有正在播放的歌曲', 422)
  }
  if (payload.mid && String(payload.mid) !== String(room.current_song.song.mid)) {
    return failure('当前播放歌曲已发生变化', 409)
  }
  const requesterId = room.current_song.user && room.current_song.user.user_id
  if (room.room_user !== user._id && requesterId !== user._id) {
    return failure('只有房主或点歌人可以切歌', 403)
  }
  const queue = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID }).orderBy('sort_time', 'asc').limit(2).get()
  if (room.current_song && room.current_song._id) {
    await db.collection('play_queue').doc(room.current_song._id).remove().catch(() => null)
  }
  const next = queue.data.find((item) => !room.current_song || item._id !== room.current_song._id) || null
  await db.collection('rooms').doc(room._id).update({
    data: {
      current_song: next ? { ...next, since: Math.floor(Date.now() / 1000) } : null,
      updated_at: db.serverDate()
    }
  })
  return success(null, '切歌成功')
}

const removeQueueSong = async (payload, user) => {
  if (!payload.mid) {
    return failure('缺少歌曲标识', 422)
  }
  const result = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID, 'song.mid': payload.mid }).limit(1).get()
  if (result.data.length) {
    const room = await getDefaultRoom(user)
    const requesterId = result.data[0].user && result.data[0].user.user_id
    if (room.room_user !== user._id && requesterId !== user._id) {
      return failure('无权移除该歌曲', 403)
    }
    await db.collection('play_queue').doc(result.data[0]._id).remove()
  }
  return success(null, '移除成功')
}

const pushQueueSong = async (payload, user) => {
  if (!payload.mid) {
    return failure('缺少歌曲标识', 422)
  }
  const result = await db.collection('play_queue').where({ room_id: DEFAULT_ROOM_ID, 'song.mid': payload.mid }).limit(1).get()
  if (result.data.length) {
    const room = await getDefaultRoom(user)
    if (room.room_user !== user._id) {
      return failure('只有房主可以置顶歌曲', 403)
    }
    await db.collection('play_queue').doc(result.data[0]._id).update({ data: { sort_time: 0 } })
  }
  return success(null, '置顶成功')
}

const searchMusic = async (payload) => {
  if (!payload.keyword) {
    return failure('请输入歌曲名称', 422)
  }
  return failure(`音乐接口 ${MUSIC_API_URL} 当前返回空响应，请根据接口文档完善适配器`, 501, { endpoint: MUSIC_API_URL, keyword: payload.keyword })
}

const handlers = {
  'user/getmyinfo': async (payload, user) => success(toClientUser(user)),
  'user/updateMyInfo': updateProfile,
  'room/getRoomInfo': async (payload, user) => success(await getDefaultRoom(user)),
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
  'song/mySongList': (payload, user) => favoriteList(user),
  'song/deleteMySong': deleteFavorite,
  'song/remove': removeQueueSong,
  'song/push': pushQueueSong,
  'song/pass': passSong,
  'song/getLrc': async (payload) => success(payload.lrc || []),
  'attach/search': async () => success([])
}

exports.main = async (event) => {
  try {
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
