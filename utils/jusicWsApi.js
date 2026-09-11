/**
 * 网易云歌单、用户、歌曲，以及 QQ 音乐歌单相关功能 —— 通过 jusic-serve 的 SockJS + STOMP 通道。
 *
 * 连接地址和业务帧均按线上服务实测协议实现：
 *   1. WebSocket 路径：/server/{100~999}/{sessionId}/websocket
 *   2. SockJS 开放帧：o；之后先发送 STOMP CONNECT 帧
 *   3. STOMP 就绪帧：CONNECTED；业务请求从此时开始发送
 *   4. SockJS 业务帧：a["TYPE\\n...\\n\\n{json}"]
 *
 * QQ 歌单歌曲沿用 QQ 搜索歌曲的元数据结构（songmid、歌名、歌手、专辑、封面、时长），
 * 不持久化限时播放地址；播放时由 musicApp 云函数按 songmid 调用 Meting 详情接口获取地址。
 */

const WS_BASE = 'wss://xin.hanxin.vip/server'
const WS_INFO_URL = 'https://xin.hanxin.vip/server/info'
const NETEASE_MUSIC_API_URL = 'https://meting.mikus.ink/api'
const HOUSE_ID = 'DEFAULT'
const HOUSE_PWD = ''
const BASIC_AUTH = ''

const REQUEST_TIMEOUT = 15000
const CONNECT_TIMEOUT = 10000
const SOCKJS_INFO_TIMEOUT = 3000
const CANCELLATION_CODE = 'JUSIC_REQUEST_CANCELLED'

let socketTask = null
let sockjsReady = false
let stompReady = false
let sockjsCookie = ''
let sockjsCookiePromise = null
let connectionGeneration = 0
let connecting = null
let connectResolve = null
let connectReject = null
let connectTimer = null
let currentRequest = null
const requestQueue = []
let requestPump = null
let closing = false
let currentPick = null
const broadcastHandlers = []

function clearConnectTimer() {
  if (connectTimer) {
    clearTimeout(connectTimer)
    connectTimer = null
  }
}

function resetSocket(task) {
  if (socketTask !== task) return
  socketTask = null
  sockjsReady = false
  stompReady = false
}

function closeSocketTask(task, reason) {
  if (!task) return
  try {
    task.close({ reason })
  } catch (error) {
    // 关闭失败时无需覆盖原始连接错误。
  }
}

function createCancellationError() {
  const error = new Error('请求已取消')
  error.code = CANCELLATION_CODE
  error.silent = true
  return error
}

function isCancellationError(error) {
  return Boolean(error && error.code === CANCELLATION_CODE)
}

function attachCancellation(promise, cancel) {
  promise.cancel = cancel
  return promise
}

function extractSetCookieHeader(header) {
  if (!header) return ''
  const values = Array.isArray(header) ? header : [header]
  return values.map(value => String(value || '').split(/,(?=[^;,\s]+=)/)[0].split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

function requestSockjsCookie() {
  if (sockjsCookie) return Promise.resolve(sockjsCookie)
  if (sockjsCookiePromise) return sockjsCookiePromise
  if (typeof wx === 'undefined' || typeof wx.request !== 'function') return Promise.resolve('')

  sockjsCookiePromise = new Promise(resolve => {
    let finished = false
    const finish = value => {
      if (finished) return
      finished = true
      const cookie = extractSetCookieHeader(value)
      if (cookie) sockjsCookie = cookie
      resolve(cookie)
    }
    const timer = setTimeout(() => finish(''), SOCKJS_INFO_TIMEOUT)
    try {
      wx.request({
        url: WS_INFO_URL + '?t=' + Date.now(),
        method: 'GET',
        success: response => {
          clearTimeout(timer)
          const header = response && (response.header || response.headers || {})
          finish(header['Set-Cookie'] || header['set-cookie'] || response && response.cookies)
        },
        fail: () => {
          clearTimeout(timer)
          finish('')
        }
      })
    } catch (error) {
      clearTimeout(timer)
      finish('')
    }
  }).then(cookie => {
    sockjsCookiePromise = null
    return cookie
  })
  return sockjsCookiePromise
}

function resolveConnection() {
  if (!connectResolve) return
  const resolve = connectResolve
  connectResolve = null
  connectReject = null
  connecting = null
  resolve()
}

function rejectConnection(error) {
  const reject = connectReject
  connectResolve = null
  connectReject = null
  connecting = null
  if (reject) reject(error)
}

function connectionError(message, detail) {
  const suffix = detail && detail.errMsg ? `：${detail.errMsg}` : ''
  return new Error(message + suffix + '。请确认 socket 合法域名已加入 https://xin.hanxin.vip')
}

function handleConnectionFailure(task, error) {
  if (socketTask !== task) return
  clearConnectTimer()
  resetSocket(task)
  rejectConnection(error)
  failCurrent(error, true)
  closeSocketTask(task, 'connection failure')
  pumpRequests()
}

function failTransport(task, error, retryCurrentRequest = false) {
  // 旧连接的异步回调不能影响重连后正在处理的请求。
  if (!task || socketTask !== task) return
  clearConnectTimer()
  closing = true
  resetSocket(task)
  rejectConnection(error)
  failCurrent(error, retryCurrentRequest)
  closeSocketTask(task, 'transport failure')
  pumpRequests()
}

/**
 * 建立并复用 SockJS WebSocket 连接。
 * 收到 SockJS 的 o 只代表传输层已打开，必须再收到 STOMP CONNECTED 才能发业务请求。
 */
function ensureConnected() {
  if (socketTask && sockjsReady && stompReady) return Promise.resolve()
  if (connecting) return connecting

  const generation = connectionGeneration
  connecting = new Promise((resolve, reject) => {
    connectResolve = resolve
    connectReject = reject

    const openSocket = (cookie) => {
      if (generation !== connectionGeneration || socketTask) return

      const serverId = Math.floor(Math.random() * 900) + 100
      const sessionId = randomWord(8)
      const url = `${WS_BASE}/${serverId}/${sessionId}/websocket`
        + `?houseId=${encodeURIComponent(HOUSE_ID)}`
        + `&housePwd=${encodeURIComponent(HOUSE_PWD)}&connectType=enter`

      const header = {}
      if (cookie) header.Cookie = cookie
      if (BASIC_AUTH) {
        header.Authorization = 'Basic ' + base64Encode(BASIC_AUTH)
      }

      let task
      try {
        task = wx.connectSocket({ url, header })
      } catch (error) {
        rejectConnection(error)
        return
      }

      socketTask = task
      sockjsReady = false
      stompReady = false
      closing = false

      connectTimer = setTimeout(() => {
        if (socketTask !== task || stompReady) return
        const error = connectionError('WebSocket STOMP 握手超时')
        resetSocket(task)
        rejectConnection(error)
        failCurrent(error)
        closeSocketTask(task, 'connect timeout')
        pumpRequests()
      }, CONNECT_TIMEOUT)

      task.onOpen(() => {
        // SockJS 的 o 开放帧才是业务层可以继续握手的起点。
      })

      task.onError((err) => {
        handleConnectionFailure(task, connectionError('WebSocket 连接失败', err))
      })

      task.onClose(() => {
        if (socketTask !== task) return
        const error = closing
          ? new Error('WebSocket 连接已关闭')
          : new Error('WebSocket 连接已断开，请重试')
        handleConnectionFailure(task, error)
      })

      task.onMessage((res) => {
        if (socketTask !== task) return
        const data = typeof res.data === 'string' ? res.data : ''
        if (data === 'o') {
          sockjsReady = true
          const frame = 'CONNECT\naccept-version:1.1,1.0\nheart-beat:0,0\n\n\u0000'
          try {
            task.send({
              data: JSON.stringify([frame]),
              fail: (err) => failTransport(task, connectionError('STOMP CONNECT 发送失败', err))
            })
          } catch (error) {
            failTransport(task, connectionError('STOMP CONNECT 发送失败', error))
          }
          return
        }
        if (data === 'h' || data === '' || data.startsWith('c[')) {
          if (data.startsWith('c[')) {
            failTransport(task, new Error('WebSocket 服务主动关闭连接'))
          }
          return
        }
        if (data.startsWith('a[')) handleFrames(data, task)
      })
    }

    // cookie_needed=true 是 SockJS 的能力提示。微信请求接口可拿到 Set-Cookie
    // 时带入 WebSocket；拿不到时仍尝试原生 WebSocket，因为服务端实测允许该路径。
    requestSockjsCookie().then(openSocket, () => openSocket(''))
  })

  return connecting
}

/** 解析 SockJS 的 a["..."] 包装，并分发 STOMP 业务帧。 */
function handleFrames(raw, task) {
  if (!task || socketTask !== task) return
  let frames
  try {
    frames = JSON.parse(raw.slice(1))
  } catch (error) {
    return
  }
  if (!Array.isArray(frames)) return

  for (const sourceFrame of frames) {
    if (typeof sourceFrame !== 'string') continue
    // STOMP 允许 CRLF；统一为 LF 后再解析头部和消息体。
    const frame = sourceFrame.replace(/\r\n/g, '\n')
    const firstLineEnd = frame.indexOf('\n')
    const type = firstLineEnd < 0 ? frame : frame.slice(0, firstLineEnd)
    const bodyStart = frame.indexOf('\n\n')
    const headerText = firstLineEnd < 0
      ? ''
      : frame.slice(firstLineEnd + 1, bodyStart < 0 ? frame.length : bodyStart)
    const headers = parseHeaders(headerText)
    let body = null
    if (bodyStart >= 0) {
      const rawBody = frame.slice(bodyStart + 2).replace(/\u0000+$/, '')
      if (rawBody) {
        try { body = JSON.parse(rawBody) } catch (error) { /* 忽略非 JSON 体 */ }
      }
    }

    if (type === 'CONNECTED') {
      clearConnectTimer()
      stompReady = true
      resolveConnection()
      continue
    }

    if (type === 'ERROR') {
      const message = body && (body.message || body.error)
        || headers.message
        || 'WebSocket 服务返回错误'
      const error = new Error(String(message))
      if (task) {
        failTransport(task, error)
      } else {
        rejectConnection(error)
        failCurrent(error)
      }
      continue
    }

    if (currentRequest && type === currentRequest.expectType) {
      if (body && isSuccessCode(body.code)) {
        settleCurrent(body.data == null ? {} : body.data)
      } else {
        settleAsError(new Error(body && body.message || '服务请求失败'), true)
      }
      continue
    }

    // 参数错误和服务端校验错误通过 NOTICE 回推；只有明确的失败码或失败标记
    // 才能结束当前请求。连接成功通知同样是 NOTICE，但不能误判为请求失败。
    if (currentRequest && type === 'NOTICE' && isFailureNotice(body)) {
      settleAsError(new Error(body.message || body.error || '服务请求失败'), true)
      continue
    }
    if (currentPick && type === 'NOTICE' && isFailureNotice(body)) {
      settlePick(null, new Error(body.message || body.error || '点播失败'))
      continue
    }
    if (currentPick && type === 'NOTICE' && body && body.message === '点歌成功') {
      continue
    }
    if (currentPick && type === 'PICK') {
      const pickedSong = findPickedRadioProgram(body, currentPick.program)
      if (pickedSong) settlePick(pickedSong)
    }
    for (const handler of broadcastHandlers) {
      try { handler(type, body) } catch (error) {}
    }
  }
}

function parseHeaders(headerText) {
  return headerText.split('\n').reduce((headers, line) => {
    const separator = line.indexOf(':')
    if (separator > 0) {
      const key = line.slice(0, separator).trim()
      headers[key] = line.slice(separator + 1).trim()
    }
    return headers
  }, {})
}

/**
 * 请求串行化：线上服务广播消息很多，串行发送可以避免同类型响应被错误关联；
 * 不同页面的请求进入同一个队列，不再因为并发打开页面而直接失败。
 */
function request(destination, payload, expectType) {
  let entry
  const promise = new Promise((resolve, reject) => {
    entry = {
      destination,
      payload,
      expectType,
      resolve,
      reject,
      settled: false,
      cancelled: false
    }
    requestQueue.push(entry)
    pumpRequests()
  })
  return attachCancellation(promise, () => cancelRequest(entry))
}

function abortConnectingIfIdle() {
  if (!connecting || currentRequest || requestQueue.length) return
  connectionGeneration += 1
  clearConnectTimer()
  const task = socketTask
  const error = createCancellationError()
  rejectConnection(error)
  if (task) {
    closing = true
    resetSocket(task)
    closeSocketTask(task, 'request cancelled')
  }
  requestPump = null
}

function cancelRequest(entry) {
  if (!entry || entry.settled || entry.cancelled) return
  entry.cancelled = true
  const error = createCancellationError()

  if (currentRequest === entry) {
    clearTimeout(entry.timer)
    currentRequest = null
    entry.settled = true
    entry.reject(error)

    // 服务端不会回传客户端请求 ID。取消正在发送的请求时必须重建连接，
    // 否则迟到的同类型响应可能被错误地关联到下一个请求。
    const task = socketTask
    if (task) {
      clearConnectTimer()
      closing = true
      resetSocket(task)
      closeSocketTask(task, 'request cancelled')
    }
    requestPump = null
    pumpRequests()
    return
  }

  const index = requestQueue.indexOf(entry)
  if (index >= 0) requestQueue.splice(index, 1)
  entry.settled = true
  entry.reject(error)
  abortConnectingIfIdle()
  pumpRequests()
}

function nextQueuedRequest() {
  while (requestQueue.length) {
    const entry = requestQueue.shift()
    if (!entry.cancelled && !entry.settled) return entry
    if (!entry.settled) {
      entry.settled = true
      entry.reject(createCancellationError())
    }
  }
  return null
}

function resetTransportForRequest(task, reason) {
  if (!task || socketTask !== task) return
  clearConnectTimer()
  closing = true
  resetSocket(task)
  closeSocketTask(task, reason)
}

function pumpRequests() {
  if (requestPump || currentRequest) return

  const first = nextQueuedRequest()
  if (!first) return
  requestQueue.unshift(first)

  let pump
  pump = ensureConnected().then(() => {
    // 取消连接中的请求后，旧连接的 Promise 可能稍后才结束；
    // 旧流程不能清理或消费新流程的队列。
    if (requestPump !== pump) return
    requestPump = null
    if (currentRequest) return

    const pending = nextQueuedRequest()
    if (!pending) return

    const timer = setTimeout(() => {
      settleAsError(new Error(`请求超时（${REQUEST_TIMEOUT / 1000}s），请重试`), true)
    }, REQUEST_TIMEOUT)
    currentRequest = pending
    currentRequest.timer = timer

    const frame = 'SEND\ndestination:' + pending.destination
      + '\ncontent-type:application/json\n\n'
      + JSON.stringify(pending.payload) + '\u0000'
    const task = socketTask
    if (!task) {
      settleAsError(new Error('发送失败：WebSocket 连接不可用'), true)
      return
    }
    try {
      task.send({
        data: JSON.stringify([frame]),
        fail: (err) => failTransport(task, new Error('发送失败：' + (err.errMsg || '')), true)
      })
    } catch (error) {
      failTransport(task, new Error('发送失败：' + (error.message || '未知错误')), true)
    }
  }).catch((error) => {
    if (requestPump !== pump) return
    requestPump = null
    const pending = nextQueuedRequest()
    if (pending) {
      pending.settled = true
      pending.reject(error)
    }
    pumpRequests()
  })
  requestPump = pump
}

function settleCurrent(data) {
  if (!currentRequest) return
  clearTimeout(currentRequest.timer)
  const req = currentRequest
  currentRequest = null
  req.settled = true
  req.resolve(data)
  pumpRequests()
}

function settleAsError(error, resetTransport = false) {
  if (!currentRequest) return
  const req = currentRequest
  clearTimeout(req.timer)
  currentRequest = null
  req.settled = true
  if (resetTransport) resetTransportForRequest(socketTask, 'request failure')
  req.reject(error)
  pumpRequests()
}

function failCurrent(error, retry = false) {
  if (!currentRequest) return
  if (retry && !currentRequest.retried) {
    const req = currentRequest
    clearTimeout(req.timer)
    currentRequest = null
    req.timer = null
    req.retried = true
    requestQueue.unshift(req)
    return
  }
  settleAsError(error)
}

/* ---------- 数据映射 ---------- */

function randomWord(length) {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  let result = ''
  for (let index = 0; index < length; index += 1) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

function isSuccessCode(code) {
  return String(code) === '20000'
}

function isFailureNotice(body) {
  if (!body || typeof body !== 'object') return false
  if (body.code != null && !isSuccessCode(body.code)) return true
  return body.success === false || body.ok === false || body.status === 'error'
}

function normalizePageNumber(value, fallback = 1) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback
}

function normalizePageSize(value, fallback = 20, maximum = 50) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(Math.floor(number), maximum)
}

function normalizePageData(data) {
  if (Array.isArray(data)) {
    return { currentPage: 1, pageSize: data.length, totalSize: data.length, data }
  }
  if (data && typeof data === 'object') {
    const items = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.list)
        ? data.list
        : Array.isArray(data.items)
          ? data.items
          : []
    return { ...data, data: items }
  }
  return { currentPage: 1, pageSize: 0, totalSize: 0, data: [] }
}

function getPageItems(data) {
  return normalizePageData(data).data
}

function getPageTotal(data, fallback) {
  const page = normalizePageData(data)
  const total = Number(page.totalSize ?? page.total ?? page.count)
  return Number.isFinite(total) && total >= 0 ? total : fallback
}

function formatCount(value) {
  if (value == null || value === '') return '0'
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  if (number >= 100000000) return (number / 100000000).toFixed(1) + '亿'
  if (number >= 10000) return (number / 10000).toFixed(1) + '万'
  return String(number)
}

function httpsUrl(value) {
  return String(value || '').replace(/^http:\/\//i, 'https://')
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (match, code) => {
      try { return String.fromCodePoint(Number(code)) } catch (error) { return match }
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => {
      try { return String.fromCodePoint(parseInt(code, 16)) } catch (error) { return match }
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function creatorNameOf(value) {
  if (value && typeof value === 'object') {
    return String(value.nickname || value.name || '')
  }
  return String(value || '')
}

function mapPlaylist(item, source = 'netease') {
  const raw = item || {}
  const platform = source === 'qq' || source === 'tencent' ? 'tencent' : 'netease'
  const creator = raw.creator
  const creatorUid = raw.creatorUid || raw.creatorId || (creator && (creator.userId || creator.id)) || ''
  const defaultCreatorName = platform === 'tencent' ? 'QQ音乐用户' : '网易云用户'
  const creatorName = creatorNameOf(creator) || String(raw.creatorName || defaultCreatorName)
  const description = decodeHtmlEntities(raw.desc || raw.description)
  return {
    id: raw.id == null ? '' : String(raw.id),
    name: String(raw.name || '未命名歌单'),
    cover: httpsUrl(raw.pictureUrl || raw.coverImgUrl || raw.cover || raw.picUrl),
    creator: creatorName,
    creatorName,
    creatorUid: String(creatorUid),
    creatorId: String(creatorUid),
    playCount: typeof raw.playCount === 'string' ? raw.playCount : formatCount(raw.playCount),
    bookCount: typeof raw.bookCount === 'string' ? raw.bookCount : formatCount(raw.bookCount),
    trackCount: Number(raw.songCount || raw.trackCount || raw.trackNumber || 0),
    description,
    desc: description,
    source: platform
  }
}

function albumNameOf(album) {
  if (album && typeof album === 'object') return String(album.name || '')
  return String(album || '')
}

function mapSong(item, source = 'netease') {
  const raw = item || {}
  const isQQ = source === 'qq' || source === 'tencent'
  const musicSource = source === 'wydt' ? 'wydt' : (isQQ ? 'tencent' : 'netease')
  const mid = isQQ
    ? String(raw.songmid || raw.songMid || raw.mid || raw.id || '')
    : (raw.id == null ? '' : String(raw.id))
  if (!mid || !raw.name) return null
  const album = raw.album || raw.al || ''
  const picture = raw.pictureUrl || raw.picture_url || raw.pic || raw.picUrl
    || (album && (album.pictureUrl || album.picture_url || album.picUrl)) || ''
  const musicApiUrl = `${NETEASE_MUSIC_API_URL}?server=netease`
  const singerValue = raw.artist || raw.artists || raw.author || raw.singer || ''
  const singer = Array.isArray(singerValue)
    ? singerValue.map(item => typeof item === 'object' ? item.name || item.nickname || '' : item).filter(Boolean).join('/')
    : typeof singerValue === 'object'
      ? String(singerValue.name || singerValue.nickname || '')
      : String(singerValue)
  const cover = httpsUrl(picture)
  const duration = Number(raw.duration || 0)
  return {
    // 页面和云函数使用 mid；同时保留 QQ 原始 songmid/id 别名，避免在点歌、收藏和播放菜单间丢失标识。
    id: mid,
    ...(isQQ ? { songmid: mid } : {}),
    source: musicSource,
    mid,
    name: String(raw.name),
    singer,
    artists: singer,
    album: albumNameOf(album),
    pic: cover,
    cover,
    // QQ WS 搜索结果不携带播放地址；显式返回空字符串，阻止后续误把其他平台地址当成 QQ 地址。
    url: isQQ || source === 'wydt' ? '' : (httpsUrl(raw.url) || `${musicApiUrl}&type=url&id=${encodeURIComponent(mid)}`),
    lrc: isQQ || source === 'wydt'
      ? []
      : (typeof raw.lrc === 'string' && /^https?:\/\//i.test(raw.lrc)
        ? httpsUrl(raw.lrc)
        : `${musicApiUrl}&type=lrc&id=${encodeURIComponent(mid)}`),
    duration
  }
}

function findPickedRadioProgram(body, program) {
  const data = body && body.data != null ? body.data : body
  const items = Array.isArray(data)
    ? data
    : data && Array.isArray(data.list)
      ? data.list
      : data && Array.isArray(data.songs)
        ? data.songs
        : [data]
  const expectedId = String(program.id || program.mid || '')
  for (const item of items) {
    const raw = item && (item.song || item.music || item)
    if (!raw) continue
    const id = String(raw.id || raw.mid || '')
    const url = httpsUrl(raw.url || raw.musicUrl || raw.playUrl || '')
    if (!id || id !== expectedId || !url) continue
    const mapped = mapSong({ ...program, ...raw, id }, 'wydt')
    if (!mapped) continue
    return {
      ...mapped,
      pic: mapped.pic || program.pic || program.cover || '',
      cover: mapped.cover || program.cover || program.pic || '',
      url,
      lrc: []
    }
  }
  return null
}

function settlePick(body, error) {
  if (!currentPick) return
  const pending = currentPick
  currentPick = null
  clearTimeout(pending.timer)
  if (error) pending.reject(error)
  else pending.resolve(body)
}

function onBroadcast(handler) {
  if (typeof handler !== 'function') return () => {}
  broadcastHandlers.push(handler)
  return () => {
    const index = broadcastHandlers.indexOf(handler)
    if (index >= 0) broadcastHandlers.splice(index, 1)
  }
}

function pickRadioProgram(program) {
  return ensureConnected().then(() => new Promise((resolve, reject) => {
    if (currentPick) {
      reject(new Error('上一次点播尚未完成，请稍候'))
      return
    }
    const timer = setTimeout(() => settlePick(null, new Error('点播超时，请重试')), REQUEST_TIMEOUT)
    currentPick = { resolve, reject, timer, program }
    const payload = {
      id: program.id,
      name: program.name,
      artist: program.artists || program.artist || '',
      duration: program.duration || 0,
      source: 'wydt',
      sendTime: Date.now()
    }
    const frame = 'SEND\ndestination:/music/pick\n\n' + JSON.stringify(payload) + '\u0000'
    socketTask.send({
      data: JSON.stringify([frame]),
      fail: error => settlePick(null, new Error('发送失败：' + (error.errMsg || '')))
    })
  }))
}

function mapRequest(requestPromise, mapper) {
  const mapped = requestPromise.then(mapper)
  return attachCancellation(mapped, () => {
    if (typeof requestPromise.cancel === 'function') requestPromise.cancel()
  })
}

function pageResult(data, mapper, page, pageSize) {
  const pageData = normalizePageData(data)
  const list = pageData.data.map(mapper).filter(item => item && item.id)
  const total = getPageTotal(pageData, list.length)
  return { total, list, hasMore: page * pageSize < total }
}

/* ========== 对外接口 ========== */

function searchPlaylists(keywords, options = {}) {
  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 20)
  return mapRequest(request('/music/searchsonglist', {
    name: String(keywords || ''),
    sendTime: Date.now(),
    source: 'wy',
    pageIndex: page,
    pageSize
  }, 'SEARCH_SONGLIST'), (data) => pageResult(data, mapPlaylist, page, pageSize))
}

function mapUser(user) {
  const raw = user || {}
  const id = raw.userId || raw.id || ''
  return {
    id: String(id),
    userId: String(id),
    name: String(raw.nickname || raw.name || '网易云用户'),
    nickname: String(raw.nickname || raw.name || '网易云用户'),
    avatar: httpsUrl(raw.avatarUrl || raw.avatar || ''),
    signature: String(raw.signature || raw.description || raw.detailDescription || ''),
    playlistCount: raw.playlistCount == null && raw.playlistNumber == null && raw.playlistNum == null
      ? null
      : Number(raw.playlistCount || raw.playlistNumber || raw.playlistNum || 0),
    followerCount: raw.followeds == null && raw.followerCount == null && raw.followers == null
      ? null
      : Number(raw.followeds || raw.followerCount || raw.followers || 0),
    gender: raw.gender,
    source: 'netease'
  }
}

function searchUsers(keywords, options = {}) {
  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 20)
  return mapRequest(request('/music/searchuser', {
    nickname: String(keywords || ''),
    sendTime: Date.now(),
    source: 'wy',
    pageIndex: page,
    pageSize
  }, 'SEARCH_USER'), (data) => pageResult(data, mapUser, page, pageSize))
}

function getUserPlaylists(uid, options = {}) {
  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 30)
  return mapRequest(request('/music/searchsonglist', {
    name: String(uid || ''),
    sendTime: Date.now(),
    source: 'wy_user',
    pageIndex: page,
    pageSize
  }, 'SEARCH_SONGLIST'), (data) => pageResult(data, mapPlaylist, page, pageSize))
}

/** 搜索 QQ 音乐歌单。 */
function searchQQPlaylists(keywords, options = {}) {
  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 20)
  return mapRequest(request('/music/searchsonglist', {
    name: String(keywords || ''),
    sendTime: Date.now(),
    source: 'qq',
    pageIndex: page,
    pageSize
  }, 'SEARCH_SONGLIST'), (data) => pageResult(
    data,
    item => mapPlaylist(item, 'tencent'),
    page,
    pageSize
  ))
}

/** 获取指定 QQ 号创建的歌单。服务返回的 QZone 背景音乐不是普通歌单，需要过滤。 */
function getQQUserPlaylists(qqNumber, options = {}) {
  const id = String(qqNumber || '').trim()
  if (!/^\d+$/.test(id)) {
    return attachCancellation(Promise.reject(new Error('QQ号无效')), () => {})
  }

  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 30)
  const requestPromise = request('/music/searchsonglist', {
    name: id,
    sendTime: Date.now(),
    source: 'qq_user',
    pageIndex: page,
    pageSize
  }, 'SEARCH_SONGLIST')
  return mapRequest(requestPromise, (data) => {
    const result = pageResult(data, item => mapPlaylist(item, 'tencent'), page, pageSize)
    const list = result.list
      .filter(item => item.id !== '0')
      .map(item => item.creatorId
        ? item
        : { ...item, creatorId: id, creatorUid: id })
    const skipped = result.list.length - list.length
    return {
      ...result,
      list,
      total: Math.max(list.length, result.total - skipped),
      hasMore: page * pageSize < Math.max(0, result.total - skipped)
    }
  })
}

/** 获取 QQ 音乐歌单内的歌曲。 */
function getQQPlaylistSongs(playlistId, options = {}) {
  const id = String(playlistId || '').trim()
  if (!/^\d+$/.test(id) || id === '0') {
    return attachCancellation(Promise.reject(new Error('歌单标识无效')), () => {})
  }

  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 50)
  const requestPromise = request('/music/search', {
    name: `*${id}`,
    source: 'qq',
    pageIndex: page,
    pageSize,
    sendTime: Date.now()
  }, 'SEARCH')
  return mapRequest(requestPromise, (data) => {
    const pageData = normalizePageData(data)
    const songs = pageData.data.map(item => mapSong(item, 'tencent')).filter(Boolean)
    const total = getPageTotal(pageData, songs.length)
    const playlist = options.playlist
      ? mapPlaylist({ ...options.playlist, id }, 'tencent')
      : mapPlaylist({ id, name: 'QQ音乐歌单', songCount: total }, 'tencent')
    return { playlist, songs, total, hasMore: page * pageSize < total }
  })
}

function searchRadioPrograms(keywords, options = {}) {
  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 20)
  return mapRequest(request('/music/search', {
    name: String(keywords || ''),
    sendTime: Date.now(),
    source: 'wydt',
    pageIndex: page,
    pageSize
  }, 'SEARCH'), data => pageResult(data, item => mapSong(item, 'wydt'), page, pageSize))
}

function searchQQSongs(keywords, options = {}) {
  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 20)
  return mapRequest(request('/music/search', {
    name: String(keywords || ''),
    sendTime: Date.now(),
    source: 'qq',
    pageIndex: page,
    pageSize
  }, 'SEARCH'), data => pageResult(data, item => mapSong(item, 'tencent'), page, pageSize))
}

/**
 * 路线 B 通过“歌单 ID 搜索”返回歌单歌曲。线上服务对 name=*{playlistId}
 * 的搜索会返回该歌单的歌曲分页，响应类型为 SEARCH。
 */
function getPlaylistDetail(playlistId, options = {}) {
  const id = String(playlistId || '').trim()
  if (!/^\d+$/.test(id)) {
    return attachCancellation(Promise.reject(new Error('歌单标识无效')), () => {})
  }

  const page = normalizePageNumber(options.page)
  const pageSize = normalizePageSize(options.pageSize, 50)
  const requestPromise = request('/music/search', {
    name: `*${id}`,
    source: 'wy',
    pageIndex: page,
    pageSize,
    sendTime: Date.now()
  }, 'SEARCH')
  return mapRequest(requestPromise, (data) => {
    const pageData = normalizePageData(data)
    const songs = pageData.data.map(mapSong).filter(Boolean)
    const total = getPageTotal(pageData, songs.length)
    const playlist = options.playlist
      ? mapPlaylist({ ...options.playlist, id })
      : mapPlaylist({ id, name: '网易云歌单', songCount: total })
    return { playlist, songs, total, hasMore: page * pageSize < total }
  })
}

/** 主动断开连接。通常保持长连接，以便多个搜索页面复用。 */
function close() {
  closing = true
  connectionGeneration += 1
  clearConnectTimer()

  const error = new Error('WebSocket 连接已关闭')
  rejectConnection(error)
  settlePick(null, error)
  if (currentRequest) {
    clearTimeout(currentRequest.timer)
    const pending = currentRequest
    currentRequest = null
    pending.settled = true
    pending.reject(error)
  }
  while (requestQueue.length) {
    const entry = requestQueue.shift()
    entry.cancelled = true
    entry.settled = true
    entry.reject(error)
  }

  const task = socketTask
  resetSocket(task)
  closeSocketTask(task, 'client close')
  requestPump = null
}

function base64Encode(value) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let output = ''
  for (let index = 0; index < value.length; index += 3) {
    const first = value.charCodeAt(index)
    const second = value.charCodeAt(index + 1)
    const third = value.charCodeAt(index + 2)
    output += chars[first >> 2]
    output += chars[((first & 3) << 4) | (Number.isNaN(second) ? 0 : second >> 4)]
    output += Number.isNaN(second) ? '=' : chars[((second & 15) << 2) | (Number.isNaN(third) ? 0 : third >> 6)]
    output += Number.isNaN(third) ? '=' : chars[third & 63]
  }
  return output
}

module.exports = {
  searchPlaylists,
  searchUsers,
  getUserPlaylists,
  getPlaylistDetail,
  searchQQPlaylists,
  searchQQSongs,
  searchRadioPrograms,
  pickRadioProgram,
  onBroadcast,
  getQQUserPlaylists,
  getQQPlaylistSongs,
  close
}
