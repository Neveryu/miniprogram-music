import config from '../../config/index.js'
const app = getApp()
const jusicWsApi = require('../../utils/jusicWsApi.js')
const { pickChildrenKeywords } = require('../../utils/childrenKeywords.js')
const { fillSongCovers } = require('../../utils/cover.js')

// 自动补歌目标数量，与云函数 song/refill 的 count 保持一致
const REFILL_TARGET = 3
// 切歌后短暂忽略旧播放器错误；真正的新直链错误由播放 watchdog 兜底
const PLAYER_SWITCH_GRACE = 1000
const PLAYER_GUARD_TIMEOUT = 6000

// 安全解码消息文本：云函数按 encodeURIComponent 存储，展示前统一转成纯文本
const decodeMessageText = (value) => {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return decodeURIComponent(value)
  } catch (error) {
    return value
  }
}

Page({
  data: {
    // 值应为某子元素id（id不能以数字开头）。设置哪个方向可滚动，则在哪个方向滚动到该元素
    bbbug_view_scroll: '',
    isEmojiBoxShow: false,
    isMusicPlaying: true,
    message: '',
    simplePlayer: true,
    musicLrcObj: [],
    lrcString: '',
    lrcIndex: -1,
    isScrollEnabled: true,
    emojiList: [],
    imageList: [],
    isSystemEmoji: false,
    isPanelShow: false,
    messagePlaceHolder: config.placeholderDefault,
    messageFocus: false,
    messageSendButton: 'send',
    messageConfirmHold: true,
    replyTarget: false,
    messageList: [],
    historyMax: config.historyMax,
    bottomHeight: 0,
    default_room: 1,
    room_id: 1,
    bbbug_view_id: '',
    resumePosition: 0,
    resumeSongId: '',
    messageWatcher: null,
    roomWatcher: null,
    bgPlayer: null,
    voicePlayer: null,
    recorderManager: null,
    voiceMode: false,
    isRecording: false,
    discardVoiceResult: false,
    autoPassSongId: '',
    failedSongPassId: '',
    playerSwitchingUntil: 0,
    isRefillingQueue: false,
    refillRequestId: 0,
    voicePlayingId: '',
    voiceSource: '',
    voicePlayRequestId: 0,
    voiceFileCache: {},
    userInfo: app.globalData.userInfo || null,
    authReady: !!app.globalData.userInfo,
    roomInfo: null,
    songInfo: null,
    playerPicError: false,
    carEventChannel: null
  },
  messageListScrolling(e) {
    const windowHeight = app.systemInfo ? app.systemInfo.windowHeight : 0
    if (windowHeight + 50 < e.detail.scrollHeight - e.detail.scrollTop) {
      this.setData({
        isScrollEnabled: false
      })
    } else {
      this.setData({
        isScrollEnabled: true
      })
    }
  },
  onLoad(options) {
    // 初始化emoji列表
    this.data.emojiList = config.emojiList
    this.offLogin = app.onLogin(() => {
      this.getMyInfo()
    })
    // 响应歌词变化
    Object.defineProperty(this.data, 'lrcString', {
      enumerable: true,
      set: (value) => {
        if(value !== this.data._lrcString) {
          this.data._lrcString = value
          this.data.carEventChannel && this.data.carEventChannel.emit('sendLrcString', value)
        }
      }
    })
    // 响应歌词列表变化，同步给驾驶模式页面
    Object.defineProperty(this.data, 'musicLrcObj', {
      enumerable: true,
      get: () => this.data._musicLrcObj,
      set: (value) => {
        this.data._musicLrcObj = value
        this.data.carEventChannel && this.data.carEventChannel.emit('sendLrcList', value || [])
      }
    })
    // 响应当前歌词行变化，同步给驾驶模式页面
    Object.defineProperty(this.data, 'lrcIndex', {
      enumerable: true,
      set: (value) => {
        if(value !== this.data._lrcIndex) {
          this.data._lrcIndex = value
          this.data.carEventChannel && this.data.carEventChannel.emit('sendLrcIndex', value)
        }
      }
    })
    // 初始化一个背景音频管理器；小程序切入后台，如果音频处于播放状态，可以继续播放。但是后台状态不能通过调用API操纵音频的播放状态。
    this.data.bgPlayer = wx.getBackgroundAudioManager()
    // this.data.bottomHeight = app.systemInfo.safeArea.bottom - app.systemInfo.safeArea.height + 40
    /**
     * 因为bottomHeight在dom初始化中已经使用了，所以这里要修改它实现响应式变化，必须使用setData
     * 否则，在onload中是可以直接使用this.data.xxx的形式来赋值的。
     */
    this.setData({
      bottomHeight: app.systemInfo.safeArea.bottom - app.systemInfo.safeArea.height + 40
    })
    this.data.room_id = this.data.default_room
    /**
     * 监听背景音频播放进度更新事件，只有小程序在前台时会回调。
     * 这里用户歌词的轮动显示
     */
    this.data.bgPlayer.onPlay(() => {
      this.playbackConfirmed = true
      this.clearPlaybackGuard()
    })
    this.data.bgPlayer.onTimeUpdate(() => {
      // 先确认播放已真正开始，再处理歌词；无歌词来源也必须清除 watchdog
      this.playbackConfirmed = true
      this.clearPlaybackGuard()
      if (!this.data.songInfo || !this.data.musicLrcObj || !this.data.musicLrcObj.length) {
        return
      }
      const currentTime = Number(this.data.bgPlayer.currentTime) || 0
      let index = -1
      for (let i = 0; i < this.data.musicLrcObj.length; i++) {
        if (currentTime < Number(this.data.musicLrcObj[i].time)) {
          break
        }
        index = i
      }
      // 前奏阶段没有匹配行时保持空白，不提前显示最后一行
      if (index < 0 || index === this.data._lrcIndex) {
        return
      }
      this.setData({
        lrcString: this.data.musicLrcObj[index].lineLyric,
        lrcIndex: index
      })
    })
    this.data.bgPlayer.onEnded(() => {
      const songInfo = this.data.songInfo
      if (!songInfo || !songInfo.song || this.data.autoPassSongId === songInfo._id) {
        return
      }
      this.clearPlaybackGuard()
      // 游客不能推进公共队列，等登录用户触发切歌，避免弹出登录框
      if (!this.data.userInfo) {
        return
      }
      this.setData({ autoPassSongId: songInfo._id })
      app.request({
        url: 'song/ended',
        data: {
          queue_id: songInfo._id,
          mid: songInfo.song.mid,
          source: songInfo.song.source
        },
        success: () => {
          this.setData({ autoPassSongId: '' })
          this.refillPlaybackQueue()
        },
        error: () => {
          this.setData({ autoPassSongId: '' })
          this.refillPlaybackQueue()
          return true
        },
        fail: () => {
          this.setData({ autoPassSongId: '' })
          this.refillPlaybackQueue()
        }
      })
    })
    this.data.bgPlayer.onError(() => {
      if (Date.now() < this.data.playerSwitchingUntil) {
        return
      }
      const songInfo = this.data.songInfo
      if (!songInfo || !songInfo.song) {
        return
      }
      // 直链可能过期：先重新点播一次，仍失败再自动切歌
      if (this.retryPickSongId !== songInfo._id) {
        this.retryPickSongId = songInfo._id
        this.repickAndPlay(songInfo)
        return
      }
      this.retryPickSongId = ''
      this.autoPassUnavailableSong(songInfo)
    })
    if (wx.setInnerAudioOption) {
      wx.setInnerAudioOption({
        mixWithOther: true,
        obeyMuteSwitch: false
      })
    }
    this.data.voicePlayer = wx.createInnerAudioContext()
    this.data.voicePlayer.onEnded(() => this.setData({ voicePlayingId: '', voiceSource: '' }))
    this.data.voicePlayer.onError((error) => {
      console.error('[VoicePlayer]', error, this.data.voiceSource)
      this.setData({ voicePlayingId: '', voiceSource: '' })
      wx.showToast({ title: '语音播放失败，请稍后重试', icon: 'none' })
    })
    this.data.recorderManager = wx.getRecorderManager()
    this.data.recorderManager.onStop((result) => this.uploadVoice(result))
    this.data.recorderManager.onError(() => {
      this.setData({ isRecording: false })
      wx.showToast({ title: '录音失败，请检查麦克风权限', icon: 'none' })
    })
    this.getMyInfo()
  },
  // 退出儿歌模式返回首页后，按正常模式重新补歌并恢复播放
  onShow() {
    const needExitRefill = !!app.globalData.needRefillAfterChildrenExit
    if (needExitRefill) {
      app.globalData.needRefillAfterChildrenExit = false
      if (this.data.roomInfo && this.data.roomInfo.children_mode) {
        const roomInfo = { ...this.data.roomInfo, children_mode: false }
        this.setData({ roomInfo })
        app.globalData.roomInfo = roomInfo
      }
      this.refillPlaybackQueue()
      return
    }
    const room = this.data.roomInfo || app.globalData.roomInfo
    // 儿歌模式下没有当前歌曲时（例如无儿歌收藏且首曲搜索失败），回到首页后自动补歌
    if (room && room.children_mode && !this.data.songInfo) {
      this.refillPlaybackQueue()
    }
  },
  setSimplePlayer() {
    wx.vibrateShort()
    this.setData({
      simplePlayer: !this.data.simplePlayer
    })
  },
  /**
   * @param {*} reloadRoom 
   */
  getMyInfo(reloadRoom = true) {
    wx.showNavigationBarLoading()
    app.request({
      url: 'user/getmyinfo',
      success: (res) => {
        app.saveUserInfo(res.data)
        this.setData({
          userInfo: res.data,
          authReady: true
        })
        wx.hideNavigationBarLoading()
        if (reloadRoom) {
          this.getRoomInfo()
        }
      },
      login: () => {
        wx.hideNavigationBarLoading()
        app.saveUserInfo(null)
        this.setData({ userInfo: null, authReady: true })
        // 游客也加载房间信息，可浏览消息与正在播放的歌曲
        this.getRoomInfo()
      },
      error(res) {
        wx.hideNavigationBarLoading()
        this.setData({ authReady: true })
      }
    })
  },
  /**
   * 获取房间信息，包括message列表
   */
  getRoomInfo() {
    wx.showNavigationBarLoading()
    app.request({
      url: 'room/getRoomInfo',
      data: {
        room_id: this.data.room_id
      },
      success: (res) => {
        wx.hideNavigationBarLoading()
        wx.hideLoading()
        this.setData({
          roomInfo: res.data
        })
        app.globalData.roomInfo = res.data
        if (res.data.current_song && (!this.data.songInfo || res.data.current_song._id !== this.data.songInfo._id)) {
          this.playMusic(res.data.current_song)
        }
        this.getMessageList()
        this.watchCloudData()
        this.refillPlaybackQueue()
      },
      error: (res) => {
        wx.hideNavigationBarLoading()
      },
      login: () => {
        wx.hideNavigationBarLoading()
      }
    })
  },
  resolveMessageCloudUrls(messageList) {
    const fileIds = []
    messageList.forEach((message) => {
      if (message.user && message.user.user_head) {
        fileIds.push(message.user.user_head)
      }
      if (message.type === 'img' && message.content) {
        fileIds.push(message.content)
      }
    })
    return app.resolveCloudFileUrls(fileIds).then((urls) => messageList.map((message) => {
      const userHead = message.user && message.user.user_head
      const content = message.type === 'img' && urls[message.content]
        ? urls[message.content]
        : message.content
      if ((!userHead || !urls[userHead]) && content === message.content) {
        return message
      }
      return {
        ...message,
        content,
        user: userHead && urls[userHead]
          ? { ...message.user, user_head: urls[userHead] }
          : message.user
      }
    }))
  },
  watchCloudData() {
    this.closeCloudWatchers()
    const db = wx.cloud.database()
    this.data.messageWatcher = db.collection('messages').where({ room_id: 1 }).watch({
      onChange: (snapshot) => {
        if (!snapshot.docs) {
          return
        }
        const messageList = snapshot.docs
          .sort((a, b) => a.created_timestamp - b.created_timestamp)
          .slice(-this.data.historyMax)
          .map((item) => {
            const payload = item.payload || {}
            const reply = payload.reply && payload.reply.type === 'text'
              ? { ...payload.reply, content: decodeMessageText(payload.reply.content) }
              : payload.reply
            return {
              ...payload,
              content: payload.type === 'text' ? decodeMessageText(payload.content) : payload.content,
              reply,
              message_id: item._id,
              message_time: item.created_timestamp
            }
          })
        const welcome = this.data.roomInfo && this.data.roomInfo.room_notice
        if (welcome) {
          messageList.unshift({
            type: 'system',
            message_id: 'welcome',
            content: welcome
          })
        }
        this.resolveMessageCloudUrls(messageList).then((resolvedMessages) => {
          this.setData({ messageList: resolvedMessages })
          this.autoScroll()
        }).catch((error) => {
          console.error('[MessageAvatar]', error)
          this.setData({ messageList })
          this.autoScroll()
        })
      },
      onError: (error) => console.error('[MessageWatcher]', error)
    })
    this.data.roomWatcher = db.collection('rooms').where({ room_id: 1 }).watch({
      onChange: (snapshot) => {
        const room = snapshot.docs && snapshot.docs[0]
        if (!room) {
          return
        }
        this.setData({ roomInfo: room })
        app.globalData.roomInfo = room
        if (room.current_song && (!this.data.songInfo || room.current_song._id !== this.data.songInfo._id)) {
          this.playMusic(room.current_song)
        } else if (!room.current_song && this.data.songInfo) {
          this.clearPlaybackGuard()
          this.data.bgPlayer.stop()
          this.data.resumeSongId = ''
          this.data.resumePosition = 0
          this.setData({
            songInfo: null,
            musicLrcObj: [],
            lrcString: '',
            lrcIndex: -1
          })
        }
      },
      onError: (error) => console.error('[RoomWatcher]', error)
    })
  },
  closeCloudWatchers() {
    this.data.messageWatcher && this.data.messageWatcher.close()
    this.data.roomWatcher && this.data.roomWatcher.close()
    this.data.messageWatcher = null
    this.data.roomWatcher = null
  },
  // 歌词
  getMusicLrc() {
    const song = this.data.songInfo && this.data.songInfo.song
    if (!song) {
      this.setData({
        musicLrcObj: [],
        lrcString: '',
        lrcIndex: -1
      })
      return
    }
    // 只有网易云提供官方歌词，其他来源直接清空
    if (song.source !== 'netease') {
      this.setData({
        musicLrcObj: [],
        lrcString: '',
        lrcIndex: -1
      })
      return
    }
    this.setData({
      musicLrcObj: [],
      lrcString: '歌词读取中...',
      lrcIndex: -1
    })
    app.request({
      url: 'song/getLrc',
      data: {
        mid: song.mid,
        source: song.source
      },
      success: (res) => {
        const lines = Array.isArray(res.data) ? res.data : []
        this.setData({
          musicLrcObj: lines,
          // 前奏阶段保持空白，由 onTimeUpdate 在命中第一行后再填入
          lrcString: '',
          lrcIndex: -1
        })
      },
      error: () => {
        this.setData({
          musicLrcObj: [],
          lrcString: '',
          lrcIndex: -1
        })
        return true
      }
    })
  },
  // 播放音乐；resumePosition 为同曲恢复的秒数，null 表示按歌曲开始时间定位
  playMusic(msg, resumePosition = null) {
    if (!msg || !msg.song) {
      this.clearPlaybackGuard()
      return
    }
    this.refillRetryCount = 0
    clearTimeout(this.refillRetryTimer)
    this.refillRetryTimer = null
    this.clearPlaybackGuard()
    this.playbackConfirmed = false
    this.pendingResumePosition = typeof resumePosition === 'number' ? resumePosition : null
    this.data.resumeSongId = ''
    this.data.resumePosition = 0
    this.data.playerSwitchingUntil = Date.now() + PLAYER_SWITCH_GRACE
    this.setData({
      songInfo: msg,
      playerPicError: false,
      failedSongPassId: ''
    })
    this.getMusicLrc()
    this.data.carEventChannel && this.data.carEventChannel.emit('sendSongInfo', this.data.songInfo)
    this.retryPickSongId = ''
    const directUrl = this.getDirectPlaybackUrl(msg.song.url)
    if (directUrl) {
      this.startPlayback(msg, directUrl)
      return
    }
    this.resolveAndPlay(msg)
  },
  clearPlaybackGuard() {
    if (this.playbackGuardTimer) {
      clearTimeout(this.playbackGuardTimer)
      this.playbackGuardTimer = null
    }
  },
  // 新直链长时间没有真正开始播放时，主动重试一次并最终自动切歌
  schedulePlaybackGuard(msg) {
    this.clearPlaybackGuard()
    if (!this.data.isMusicPlaying || !msg || !msg._id) {
      return
    }
    this.playbackGuardTimer = setTimeout(() => {
      this.playbackGuardTimer = null
      if (!this.data.songInfo || this.data.songInfo._id !== msg._id || !this.data.isMusicPlaying || this.playbackConfirmed) {
        return
      }
      if (this.retryPickSongId === msg._id) {
        this.retryPickSongId = ''
        this.autoPassUnavailableSong(msg)
        return
      }
      this.retryPickSongId = msg._id
      this.repickAndPlay(msg)
    }, PLAYER_GUARD_TIMEOUT)
  },
  // 是否为可直接交给播放器的音频直链（排除历史旧接口地址）
  getDirectPlaybackUrl(url) {
    const value = String(url || '').replace(/^http:\/\//i, 'https://')
      .replace(/\\u0026/gi, '&')
      .replace(/&amp;/gi, '&')
    if (!/^https:\/\//i.test(value)) return ''
    if (/\/meting\/api(?:\?|$)/i.test(value)) return ''
    if (/[?&]type=url(?:&|$)/i.test(value)) return ''
    return value
  },
  // 统一设置播放器并开始播放
  startPlayback(msg, url, announce = true) {
    const userName = (msg.user && msg.user.user_name) || '听众'
    const roomName = (this.data.roomInfo && this.data.roomInfo.room_name) || ''
    const nowSeconds = Math.floor(Date.now() / 1000)
    const since = Number(msg.since) || 0
    const resumePosition = this.pendingResumePosition
    this.pendingResumePosition = null
    this.data.bgPlayer.src = url
    this.data.bgPlayer.title = msg.song.name + ' - ' + msg.song.singer
    this.data.bgPlayer.singer = '点歌人: ' + userName + ' ' + roomName + ' '
    this.data.bgPlayer.coverImgUrl = msg.song.pic
    this.data.bgPlayer.webUrl = msg.song.pic
    // since 缺失或异常时按从头播放，避免 seek 到超大位置
    const knownSince = since > 0 && since <= nowSeconds ? since : nowSeconds
    let seekPosition = resumePosition === null
      ? Math.max(0, nowSeconds - knownSince)
      : Math.max(0, resumePosition)
    const duration = Number(msg.song.duration) || 0
    if (duration > 0) {
      seekPosition = Math.min(seekPosition, Math.max(0, Math.floor(duration / 1000) - 1))
    }
    this.data.bgPlayer.seek(seekPosition)
    if (this.data.isMusicPlaying) {
      if (announce) {
        this.addSystemMessage('正在播放 ' + userName + ' 点的 ' + msg.song.name + '(' + msg.song.singer + ')')
      }
      this.data.bgPlayer.play()
      this.schedulePlaybackGuard(msg)
    } else {
      this.data.bgPlayer.stop()
      this.clearPlaybackGuard()
    }
  },
  // 点播返回的歌曲可能带封面；同步到当前歌曲并补全缺失封面
  applyPickedSong(msg, pickedSong, url) {
    const pic = pickedSong.pic || msg.song.pic || ''
    msg.song.url = url
    msg.song.pic = pic
    this.setData({
      'songInfo.song.url': url,
      'songInfo.song.pic': pic
    })
    if (!pic) {
      fillSongCovers([msg.song]).then((songs) => {
        const cover = songs[0] && songs[0].pic
        if (!cover || !this.data.songInfo || this.data.songInfo._id !== msg._id) {
          return
        }
        this.setData({ 'songInfo.song.pic': cover })
        this.data.bgPlayer.coverImgUrl = cover
        this.data.bgPlayer.webUrl = cover
      })
    }
  },
  // 播放失败后重新点播一次，拿到新直链再播放
  repickAndPlay(msg) {
    jusicWsApi.pickSong(msg.song).then((pickedSong) => {
      if (!this.data.songInfo || this.data.songInfo._id !== msg._id) {
        return
      }
      const url = this.getDirectPlaybackUrl(pickedSong.url)
      if (!url) {
        this.autoPassUnavailableSong(msg)
        return
      }
      this.data.playerSwitchingUntil = Date.now() + PLAYER_SWITCH_GRACE
      this.playbackConfirmed = false
      this.applyPickedSong(msg, pickedSong, url)
      this.startPlayback(msg, url, false)
    }).catch(() => {
      if (!this.data.songInfo || this.data.songInfo._id !== msg._id) {
        return
      }
      this.autoPassUnavailableSong(msg)
    })
  },
  // 没有直链时通过 WS /music/pick 获取播放地址
  resolveAndPlay(msg) {
    jusicWsApi.ensurePlayableSong(msg.song).then((pickedSong) => {
      if (!this.data.songInfo || this.data.songInfo._id !== msg._id) {
        return
      }
      this.applyPickedSong(msg, pickedSong, pickedSong.url)
      this.startPlayback(msg, pickedSong.url)
    }).catch(() => {
      if (!this.data.songInfo || this.data.songInfo._id !== msg._id) {
        return
      }
      this.autoPassUnavailableSong(msg)
    })
  },
  // 先确认队列确实不足再发起 WS 搜索，避免每次进房/每首歌结束都浪费一次搜索
  getQueueLengthForRefill() {
    return new Promise((resolve) => {
      app.request({
        url: 'song/songList',
        data: { room_id: this.data.room_id },
        success: (res) => resolve(Array.isArray(res.data) ? res.data.length : 0),
        login: () => resolve(0),
        error: () => {
          resolve(0)
          return true
        },
        fail: () => resolve(0)
      })
    })
  },
  refillPlaybackQueue() {
    if (this.data.isRefillingQueue || !app.globalData.userInfo) {
      return
    }
    clearTimeout(this.refillRetryTimer)
    this.refillRetryTimer = null
    const requestId = this.data.refillRequestId + 1
    this.data.refillRequestId = requestId
    this.setData({ isRefillingQueue: true })
    const finish = () => {
      if (this.data.refillRequestId === requestId) {
        this.setData({ isRefillingQueue: false })
      }
    }
    setTimeout(finish, 18000)
    this.getQueueLengthForRefill().then((queueLength) => {
      if (this.data.refillRequestId !== requestId) {
        return
      }
      // 队列已充足且有当前歌曲时无需补歌；没有当前歌曲时仍需调用云函数
      // 让 refillQueue 把队列首项提升为 current_song
      if (queueLength >= REFILL_TARGET && this.data.songInfo) {
        this.refillRetryCount = 0
        finish()
        return
      }
      // 队列不足时再用 WS 搜索候选，交给云函数与收藏/缓存按权重混入
      return this.buildRefillCandidates().then((candidates) => {
        if (this.data.refillRequestId !== requestId) {
          finish()
          return
        }
        app.request({
          url: 'song/refill',
          data: { count: REFILL_TARGET, candidates },
          success: (res) => {
            const data = res.data || {}
            if (data.added > 0) {
              this.refillRetryCount = 0
            }
            finish()
            // 补歌被并发锁挡住或没有可用候选时，延迟重试，避免空队列一直停留
            if (/正在准备/.test(res.msg || '') || (!data.added && !data.remaining)) {
              this.scheduleRefillRetry()
            }
          },
          error: () => {
            finish()
            return true
          },
          login: finish,
          fail: finish
        })
      })
    }).catch(() => {
      finish()
    })
  },
  // 通过 WS 搜索自动补歌候选：正常模式抽一个提示词，儿歌模式抽 1 聚合 + 2 歌名
  buildRefillCandidates() {
    const room = this.data.roomInfo || app.globalData.roomInfo || {}
    const pendingRequests = []
    let search
    if (room.children_mode) {
      const keywords = pickChildrenKeywords()
      const searches = keywords.map((keyword) => {
        const pending = jusicWsApi.searchNeteaseSongs(keyword, { pageSize: 10 })
        pendingRequests.push(pending)
        return pending.then((result) => result.list || []).catch(() => [])
      })
      search = Promise.all(searches).then((groups) => {
        const songs = groups.flat().filter((song) => song && song.mid)
        const result = []
        while (songs.length && result.length < 20) {
          result.push(songs.splice(Math.floor(Math.random() * songs.length), 1)[0])
        }
        return result.map((song) => ({ source: 'children', song }))
      })
    } else {
      const prompts = Array.isArray(room.search_prompts) && room.search_prompts.length
        ? room.search_prompts
        : ['周杰伦', '流行歌曲', '经典歌曲', '精选']
      const keyword = prompts[Math.floor(Math.random() * prompts.length)]
      const pending = jusicWsApi.searchNeteaseSongs(keyword, { pageSize: 20 })
      pendingRequests.push(pending)
      search = pending.then((result) => (result.list || []).filter((song) => song && song.mid).slice(0, 15)
        .map((song) => ({ source: 'prompt', song })))
        .catch(() => [])
    }
    // 慢网超时后主动取消 WS 请求，避免已放弃的搜索继续占用串行队列
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = (value) => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
        }
        resolve(value)
      }
      timer = setTimeout(() => {
        pendingRequests.forEach((request) => {
          if (request && typeof request.cancel === 'function') {
            request.cancel()
          }
        })
        finish([])
      }, 10000)
      search.then(finish, () => finish([]))
    })
  },
  scheduleRefillRetry() {
    const retries = this.refillRetryCount || 0
    if (retries >= 2) {
      return
    }
    this.refillRetryCount = retries + 1
    clearTimeout(this.refillRetryTimer)
    this.refillRetryTimer = setTimeout(() => {
      this.refillRetryTimer = null
      this.refillPlaybackQueue()
    }, 4000)
  },
  autoPassUnavailableSong(msg) {
    if (!msg || !msg.song || this.data.failedSongPassId === msg._id) {
      return
    }
    this.clearPlaybackGuard()
    this.data.bgPlayer.stop()
    this.setData({
      failedSongPassId: msg._id,
      musicLrcObj: [],
      lrcString: ''
    })
    // 游客不能推进公共队列，不发起会触发登录弹窗的系统请求
    if (!this.data.userInfo) {
      wx.showToast({
        title: '播放失败，登录后可自动切歌',
        icon: 'none'
      })
      return
    }
    wx.showToast({
      title: '歌曲无法播放，自动切歌',
      icon: 'none'
    })
    app.request({
      url: 'song/autoPass',
      data: {
        queue_id: msg._id,
        mid: msg.song.mid,
        source: msg.song.source
      },
      success: () => {
        this.setData({ failedSongPassId: '' })
        this.refillPlaybackQueue()
      },
      error: () => {
        this.setData({ failedSongPassId: '' })
        this.refillPlaybackQueue()
        return true
      },
      fail: () => {
        this.setData({ failedSongPassId: '' })
        this.refillPlaybackQueue()
      }
    })
  },
  // 封面图加载失败时回退本地占位图，不影响播放
  onPlayerPicError() {
    this.setData({
      playerPicError: true
    })
  },
  // 添加系统消息
  addSystemMessage(msg) {
    this.addMessageToList({
      type: 'system',
      message_id: 'system-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      content: msg,
    });
  },
  addMessageToList(msg) {
    if (this.data.messageList.length > this.data.historyMax) {
      this.data.messageList.shift()
    }
    this.data.messageList.push(msg)
    this.setData({
      messageList: this.data.messageList
    })
    this.autoScroll()
  },
  autoScroll() {
    if (!this.data.isScrollEnabled) {
      return
    }
    let view_id = 'view_id_' + parseInt(Math.random() * 10000000)
    // this.setData({
    //   bbbug_view_scroll: ''
    // })
    this.setData({
      bbbug_view_id: view_id
    })
    this.setData({
      bbbug_view_scroll: view_id
    })
  },
  // 获取当前房间的消息
  getMessageList() {
    app.request({
      url: 'message/getMessageList',
      data: {
        room_id: this.data.room_id,
        per_page: this.data.historyMax
      },
      success: (res) => {
        let messageList = []
        for (let i = 0; i < res.data.length; i++) {
          let _obj = false
          try {
            _obj = JSON.parse(res.data[i].message_content)
          } catch (error) {
            continue
          }
          if (_obj) {
            _obj.message_id = res.data[i].message_id
            _obj.message_time = res.data[i].message_createtime
            if (_obj.type === 'text') {
              _obj.content = decodeMessageText(_obj.content)
            }
            if (_obj.reply && _obj.reply.type === 'text') {
              _obj.reply = { ..._obj.reply, content: decodeMessageText(_obj.reply.content) }
            }
            messageList.unshift(_obj)
          }
        }
        messageList.unshift({
          type: 'system',
          message_id: 'welcome',
          content: this.data.roomInfo.room_notice ? this.data.roomInfo.room_notice : ('欢迎来到' + this.data.roomInfo.room_name + '!')
        })
        this.resolveMessageCloudUrls(messageList).then((resolvedMessages) => {
          this.setData({ messageList: resolvedMessages })
          this.autoScroll()
        }).catch((error) => {
          console.error('[MessageAvatar]', error)
          this.setData({ messageList })
          this.autoScroll()
        })
      }
    })
  },
  hideAllDialog() {
    this.setData({
      isEmojiBoxShow: false,
      isPanelShow: false,
      messagePlaceHolder: config.placeholderDefault,
      messageSendButton: config.messageButtonTitleSend
    })
    wx.hideKeyboard()
  },
  footerTapedToFocus() {
    if (!this.data.voiceMode) {
      this.setData({ messageFocus: true })
    }
  },
  messageFocused() {
    this.setData({ messageFocus: true })
  },
  clearReply() {
    this.setData({ replyTarget: false })
  },
  showOrHideEmojiBox() {
    if (this.data.isEmojiBoxShow) {
      this.setData({
        message: ''
      })
    } else {
      this.setData({
        imageList: this.data.emojiList,
        isSystemEmoji: true,
      })
    }
    this.setData({
      isPanelShow: false,
      isEmojiBoxShow: !this.data.isEmojiBoxShow,
    })
    wx.vibrateShort();
    this.setData({
      messageFocus: !this.data.isEmojiBoxShow,
      replyTarget: false
    })
  },
  mainMenuClicked(e) {
    switch (e.mark.title) {
      case '驾驶':
        wx.navigateTo({
          url: '../song/car-mode?bbbug=' + app.globalData.systemVersion,
          events: {
            destroyed: () => {
              this.setData({
                carEventChannel: null
              })
            },
            longPressPassTheSong: () => {
              this.longPressPassTheSong()
            },
            tapToAddSong: () => {
              this.tapToAddSong()
            }
          },
          success: (res) => {
            this.setData({
              carEventChannel: res.eventChannel
            })
            res.eventChannel.emit('sendSongInfo', this.data.songInfo)
            res.eventChannel.emit('sendLrcList', this.data.musicLrcObj || [])
            if (typeof this.data._lrcIndex === 'number') {
              res.eventChannel.emit('sendLrcIndex', this.data._lrcIndex)
            }
          }
        })
        break
      case '儿歌':
        wx.navigateTo({
          url: '../song/children?bbbug=' + app.globalData.systemVersion
        })
        break
      case '点歌':
        wx.navigateTo({
          url: '../song/select?bbbug=' + app.globalData.systemVersion,
        })
        break
      case '已点':
        wx.navigateTo({
          url: '../song/playing?bbbug=' + app.globalData.systemVersion,
        })
        break
      case '收藏':
        wx.navigateTo({
          url: '../song/my?bbbug=' + app.globalData.systemVersion
        })
        break
      case '提示词':
        wx.navigateTo({
          url: '../room/prompts'
        })
        break
      default:
        return
    }
  },
  longTapToMessage(e) {
    if (!this.data.userInfo) {
      return
    }
    let msg = e.mark.msg
    let menuList = ['引用消息']
    if (msg.user.user_id == this.data.userInfo.user_id || this.data.userInfo.user_id == this.data.roomInfo.room_user) {
      menuList.push('撤回消息')
    }
    switch (msg.type) {
      case 'img':
        // menuList.push('保存大图');
        break
      case 'text':
        menuList.push('复制文字')
        break
      case 'jump':
        menuList.push('进入房间')
        break
      case 'link':
        menuList.push('复制链接')
        break
      default:
        break
    }
    wx.vibrateShort()
    wx.showActionSheet({
      itemList: menuList,
      success: (res) => {
        switch (menuList[res.tapIndex]) {
          case '复制文字':
            let copyData = msg.content
            // 调用成功后，会弹出 toast 提示"内容已复制"，持续 1.5s
            wx.setClipboardData({
              data: copyData,
            })
            // wx.showToast({
            //   title: '复制成功',
            // });
            break
          case '引用消息':
            this.setData({
              messageFocus: true,
              replyTarget: { message: msg }
            })
            break
          case '复制链接':
            wx.setClipboardData({
              data: decodeURIComponent(msg.link)
            })
            break
          case '撤回消息':
            app.request({
              url: 'message/back',
              loading: '撤回中',
              data: {
                message_id: msg.message_id,
                room_id: this.data.room_id
              },
              success: (res) => {
                // not todo
              }
            })
            break
          case '进入房间':
            this.setData({
              room_id: msg.jump.room_id
            })
            this.getRoomInfo()
            break
          default:
            wx.showToast({
              title: '功能即将上线'
            })
            break
        }
      }
    })
  },
  showMainMenu() {
    wx.vibrateShort()
    this.setData({
      isPanelShow: !this.data.isPanelShow,
      isEmojiBoxShow: false
    })
  },
  // 点击圆形播放器
  showSongMenu() {
    let menu = ['收藏歌曲', '切歌']
    if (this.data.isMusicPlaying) {
      menu.push('关闭音乐')
    } else {
      menu.push('打开音乐')
    }
    wx.showActionSheet({
      itemList: menu,
      success: (res) => {
        switch (menu[res.tapIndex]) {
          case '关闭音乐':
          case '打开音乐':
            if (this.data.isMusicPlaying) {
              // 记录暂停位置，重新打开时从同一首歌的当前位置继续
              if (this.data.songInfo) {
                this.data.resumeSongId = this.data.songInfo._id
                this.data.resumePosition = Number(this.data.bgPlayer.currentTime) || 0
              }
              this.clearPlaybackGuard()
              this.data.bgPlayer.stop()
              this.setData({
                isMusicPlaying: false
              })
            } else {
              if (!this.data.songInfo || !this.data.songInfo.song) {
                wx.showToast({
                  title: '当前没有正在播放的歌曲',
                  icon: 'none'
                })
                break
              }
              const resumePosition = this.data.resumeSongId === this.data.songInfo._id
                ? this.data.resumePosition
                : 0
              this.setData({
                isMusicPlaying: true
              })
              this.playMusic(this.data.songInfo, resumePosition)
            }
            break
          case '收藏歌曲':
            if (!this.data.songInfo || !this.data.songInfo.song) {
              wx.showToast({
                title: '当前没有正在播放的歌曲',
                icon: 'none'
              })
              break
            }
            app.request({
              url: 'song/addMySong',
              data: {
                room_id: app.globalData.roomInfo.room_id,
                mid: this.data.songInfo.song.mid,
                source: this.data.songInfo.song.source,
                song: this.data.songInfo.song
              },
              loading: '收藏中',
              success: (res) => {
                wx.showToast({
                  title: '收藏成功'
                })
              }
            })
            break
          case '切歌':
            if (!this.data.songInfo || !this.data.songInfo.song || !this.data.songInfo.user) {
              app.request({
                url: 'song/pass',
                data: {
                  room_id: app.globalData.roomInfo.room_id
                },
                loading: '加载歌曲中',
                success: (res) => {
                  wx.showToast({
                    title: res.msg
                  })
                }
              })
              break
            }
            app.request({
              url: 'song/pass',
              data: {
                room_id: app.globalData.roomInfo.room_id,
                mid: this.data.songInfo.song.mid,
                source: this.data.songInfo.song.source,
                queue_id: this.data.songInfo._id,
              },
              loading: '切歌中',
              success: (res) => {
                wx.showToast({
                  title: res.msg || '切歌完成'
                })
                this.refillPlaybackQueue()
              }
            })
            break
          default:
        }
      }
    })
  },
  getStaticUrl(str) {
    if (!str) {
      return ''
    }
    if (str.indexOf('https://') == 0 || str.indexOf('http://') == 0) {
      return str.replace('http://', 'https://')
    }
    return str
  },
  sendEmoji(e) {
    const url = this.getStaticUrl(e.mark.url)
    const reply = this.data.replyTarget && this.data.replyTarget.message ? this.data.replyTarget.message : null
    app.request({
      url: 'message/send',
      data: {
        where: 'channel',
        to: this.data.room_id,
        type: 'img',
        msg: url,
        resource: url,
        reply_to: reply ? reply.message_id : ''
      },
      success: () => {
        this.setData({ replyTarget: false })
        this.hideAllDialog()
      }
    })
  },
  enableScroll() {
    this.setData({
      isScrollEnabled: true
    })
    this.autoScroll()
  },
  tapToAddSong() {
    if (!this.data.songInfo || !this.data.songInfo.song) {
      wx.showToast({ title: '当前没有正在播放的歌曲', icon: 'none' })
      return
    }
    app.request({
      url: 'song/addMySong',
      data: {
        room_id: app.globalData.roomInfo.room_id,
        mid: this.data.songInfo.song.mid,
        source: this.data.songInfo.song.source,
        song: this.data.songInfo.song
      },
      loading: '收藏中',
      success: (res) => {
        
      },
      error: (res) => {
        
        return true
      }
    })
  },
  longPressPassTheSong() {
    if (!this.data.songInfo || !this.data.songInfo.song || !this.data.songInfo.user) {
      app.request({
        url: 'song/pass',
        data: {
          room_id: app.globalData.roomInfo.room_id
        },
        success: (res) => {
          
        },
        error: (res) => {
          
          return true
        }
      })
      return
    }
    app.request({
      url: 'song/pass',
      data: {
        room_id: app.globalData.roomInfo.room_id,
        mid: this.data.songInfo.song.mid,
        source: this.data.songInfo.song.source,
        queue_id: this.data.songInfo._id
      },
      success: (res) => {
        
        this.refillPlaybackQueue()
      },
      error: () => {
        return true
      }
    })
  },
  sendMessage(e) {
    let message = e.detail.value
    if (!message) {
      return
    }
    if (message.trim().length > 1000) {
      wx.showToast({
        title: '消息不能超过1000字',
        icon: 'none'
      })
      return
    }
    this.setData({
      message: ''
    })
    let msgObj = {
      type: 'text',
      content: message,
      where: 'channel',
      message_id: 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      message_time: 0,
      loading: true,
      resource: message,
      user: this.data.userInfo
    }
    this.addMessageToList(msgObj)
    const replyTarget = this.data.replyTarget
    this.setData({
      replyTarget: false
    })
    app.request({
      url: 'message/send',
      data: {
        type: 'text',
        where: 'channel',
        to: this.data.room_id,
        msg: encodeURIComponent(message),
        reply_to: replyTarget && replyTarget.message ? replyTarget.message.message_id : ''
      },
      success: (res) => {
        this.setData({
          replyTarget: false,
          isScrollEnabled: true,
        })
        this.autoScroll()
      },
      error: (res) => {
        for (let i = this.data.messageList.length - 1; i >= 0; i--) {
          if (this.data.messageList[i].loading) {
            this.data.messageList.splice(i, 1)
            break
          }
        }
        this.setData({
          message: message,
          replyTarget,
          messageList: this.data.messageList
        })
      }
    })
  },
  chooseImage() {
    const reply = this.data.replyTarget && this.data.replyTarget.message ? this.data.replyTarget.message : null
    wx.chooseImage({
      count: 1,
      sizeType: 'compressed',
      success: (res) => {
        this.hideAllDialog()
        wx.showLoading({
          title: '发送中',
        })
        const cloudPath = `messages/${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`
        wx.cloud.uploadFile({
          cloudPath,
          filePath: res.tempFilePaths[0]
        }).then((uploadResult) => {
          wx.hideLoading()
          app.request({
            url: 'message/send',
            data: {
              where: 'channel',
              to: this.data.room_id,
              type: 'img',
              msg: uploadResult.fileID,
              resource: uploadResult.fileID,
              reply_to: reply ? reply.message_id : ''
            },
            success: () => {
              this.setData({ replyTarget: false })
              this.hideAllDialog()
            }
          })
        }).catch((error) => {
          wx.hideLoading()
          console.error('[UploadMessageImage]', error)
          wx.showToast({
            title: '图片上传失败',
            icon: 'none'
          })
        })
      }
    })
  },
  toggleVoiceMode() {
    this.setData({
      voiceMode: !this.data.voiceMode,
      messageFocus: false,
      isEmojiBoxShow: false,
      isPanelShow: false
    })
  },
  startVoiceRecord() {
    if (this.data.isRecording) {
      return
    }
    this.setData({ isRecording: true, discardVoiceResult: false })
    this.data.recorderManager.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    })
  },
  stopVoiceRecord() {
    if (!this.data.isRecording) {
      return
    }
    this.setData({ isRecording: false })
    this.data.recorderManager.stop()
  },
  uploadVoice(result) {
    if (this.data.discardVoiceResult) {
      return
    }
    if (!result.tempFilePath || result.duration < 1000) {
      wx.showToast({ title: '说话时间太短', icon: 'none' })
      return
    }
    wx.showLoading({ title: '发送中' })
    const cloudPath = `messages/voice/${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`
    wx.cloud.uploadFile({ cloudPath, filePath: result.tempFilePath }).then((uploadResult) => {
      wx.hideLoading()
      const reply = this.data.replyTarget && this.data.replyTarget.message ? this.data.replyTarget.message : null
      app.request({
        url: 'message/send',
        data: {
          type: 'voice',
          msg: uploadResult.fileID,
          resource: uploadResult.fileID,
          duration: result.duration,
          reply_to: reply ? reply.message_id : ''
        },
        success: () => this.setData({ replyTarget: false })
      })
    }).catch((error) => {
      wx.hideLoading()
      console.error('[UploadVoice]', error)
      wx.showToast({ title: '语音上传失败', icon: 'none' })
    })
  },
  resolveVoiceSource(source) {
    if (!source) {
      return Promise.reject(new Error('语音资源地址为空'))
    }
    if (!/^cloud:\/\//i.test(source)) {
      return Promise.resolve(this.getStaticUrl(source))
    }
    if (this.data.voiceFileCache[source]) {
      return Promise.resolve(this.data.voiceFileCache[source])
    }
    return wx.cloud.downloadFile({ fileID: source }).then((result) => {
      if (!result.tempFilePath) {
        throw new Error('语音文件下载失败')
      }
      this.data.voiceFileCache[source] = result.tempFilePath
      return result.tempFilePath
    })
  },
  playVoice(e) {
    const msg = e.mark.msg
    const source = msg.resource || msg.content
    if (this.data.voicePlayingId === msg.message_id) {
      this.data.voicePlayRequestId += 1
      this.data.voicePlayer.stop()
      this.setData({ voicePlayingId: '', voiceSource: '' })
      return
    }
    const requestId = this.data.voicePlayRequestId + 1
    this.data.voicePlayRequestId = requestId
    this.data.voicePlayer.stop()
    this.setData({ voicePlayingId: msg.message_id, voiceSource: source })
    this.resolveVoiceSource(source).then((playableSource) => {
      if (requestId !== this.data.voicePlayRequestId) {
        return
      }
      this.data.voicePlayer.src = playableSource
      this.data.voicePlayer.play()
    }).catch((error) => {
      if (requestId !== this.data.voicePlayRequestId) {
        return
      }
      console.error('[ResolveVoiceSource]', error, source)
      this.setData({ voicePlayingId: '', voiceSource: '' })
      wx.showToast({ title: '语音加载失败，请稍后重试', icon: 'none' })
    })
  },
  login() {
    wx.navigateTo({
      url: '../user/login'
    })
  },
  // 空队列时从播放器直接进入点歌页
  goSelectSong() {
    wx.navigateTo({
      url: '../song/select?bbbug=' + app.globalData.systemVersion
    })
  },
  onUnload() {
    if (this.offLogin) {
      this.offLogin()
    }
    clearTimeout(this.refillRetryTimer)
    this.refillRetryTimer = null
    this.clearPlaybackGuard()
    this.closeCloudWatchers()
    if (this.data.isRecording && this.data.recorderManager) {
      this.data.discardVoiceResult = true
      this.data.recorderManager.stop()
    }
    this.data.voicePlayer && this.data.voicePlayer.destroy()
  }
})
