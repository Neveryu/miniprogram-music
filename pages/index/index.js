import config from '../../config/index.js'
import api from '../../config/api.js'
const app = getApp()
var WechatSI = requirePlugin('WechatSI')
Page({
  data: {
    // 值应为某子元素id（id不能以数字开头）。设置哪个方向可滚动，则在哪个方向滚动到该元素
    bbbug_view_scroll: '',
    isThisShow: false,
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
    atMessageObj: false,
    messageList: [],
    historyMax: 20,
    bottomHeight: 0,
    default_room: 1,
    room_id: 1,
    bbbug_view_id: '',
    bbbug_view_scroll: '',
    messageWatcher: null,
    roomWatcher: null,
    bgPlayer: null,
    audioPlayer: null,
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
    userInfo: null,
    roomInfo: null,
    songInfo: null,
    playerPicError: false,
    carEventChannel: null
  },
  messageListScrolling(e) {
    let res = wx.getSystemInfoSync()
    if (res.windowHeight + 50 < e.detail.scrollHeight - e.detail.scrollTop) {
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
    app.watchUser(() => {
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
    this.data.bgPlayer.onTimeUpdate((e) => {
      if (this.data.songInfo) {
        if (this.data.musicLrcObj) {
          for (let i = 0; i < this.data.musicLrcObj.length; i++) {
            if (i == this.data.musicLrcObj.length - 1) {
              this.setData({
                lrcString: this.data.musicLrcObj[i].lineLyric,
                lrcIndex: i
              })
              return
            } else {
              if (this.data.bgPlayer.currentTime > this.data.musicLrcObj[i].time && this.data.bgPlayer.currentTime < this.data.musicLrcObj[i + 1].time) {
                this.setData({
                  lrcString: this.data.musicLrcObj[i].lineLyric,
                  lrcIndex: i
                })
                return
              }
            }
          }
        }
      }
    })
    this.data.bgPlayer.onEnded(() => {
      const songInfo = this.data.songInfo
      if (!songInfo || !songInfo.song || this.data.autoPassSongId === songInfo._id) {
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
    this.data.bgPlayer.onError((error) => {
      if (Date.now() < this.data.playerSwitchingUntil) {
        return
      }
      const songInfo = this.data.songInfo
      if (!songInfo || !songInfo.song) {
        return
      }
      this.autoPassUnavailableSong(songInfo, error)
    })
    /**
     * 监听用户在系统音乐播放面板点击上一曲事件（仅iOS）
     * 收藏？
     */
    this.data.bgPlayer.onPrev(() => {
      if (this.data.isCarMode && this.data.songInfo && this.data.songInfo.song) {
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
            this.say(res.msg)
            this.refillPlaybackQueue()
          },
          error: (res) => {
            this.say(res.msg)
            return true
          }
        })
      }
    })
    /**
     * 监听用户在系统音乐播放面板点击下一曲事件（仅iOS）
     */
    this.data.bgPlayer.onNext(() => {
      if (!this.data.isCarMode) {
        return
      }
      if (!this.data.songInfo || !this.data.songInfo.song) {
        app.request({
          url: 'song/pass',
          data: {
            room_id: app.globalData.roomInfo.room_id
          },
          success: (res) => {
            this.say(res.msg)
            this.refillPlaybackQueue()
          },
          error: (res) => {
            this.say(res.msg)
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
          this.say(res.msg)
          this.refillPlaybackQueue()
        },
        error() {
          return true
        }
      })
    })
    
    // 创建内部 audio 上下文 InnerAudioContext 对象
    this.data.audioPlayer = wx.createInnerAudioContext({
      useWebAudioImplement: true
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
      url: api.getMyInfo,
      success: (res) => {
        this.setData({
          userInfo: res.data
        })
        app.globalData.userInfo = res.data
        app.globalData.user_changed = false
        wx.hideNavigationBarLoading()
        if (reloadRoom) {
          this.getRoomInfo()
        }
        app.alertChangeInfo()
      },
      login: () => {
        wx.hideNavigationBarLoading()
        app.globalData.userInfo = null
        this.setData({ userInfo: null })
      },
      error(res) {
        wx.hideNavigationBarLoading()
      }
    })
  },
  /**
   * 获取房间信息，包括message列表
   */
  getRoomInfo() {
    wx.showNavigationBarLoading()
    app.request({
      url: api.getRoomInfo,
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
        if (this.data.isThisShow) {
          wx.setNavigationBarTitle({
            title: res.data.room_name
          })
        }
        this.getMessageList()
        this.watchCloudData()
        this.refillPlaybackQueue()
      },
      error: (res) => {
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
          .map((item) => ({
            ...item.payload,
            message_id: item._id,
            message_time: item.created_timestamp
          }))
        const welcome = this.data.roomInfo && this.data.roomInfo.room_notice
        if (welcome) {
          messageList.unshift({
            type: 'system',
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
          this.data.bgPlayer.stop()
          this.setData({
            songInfo: null,
            musicLrcObj: [],
            lrcString: ''
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
  messageController(msg) {
    console.log('长链接发送过来的数据：', msg)
    let msgString = ''
    switch (msg.type) {
      case 'text':
      case 'img':
      case 'link':
      case 'jump':
      case 'system':
        if (msg.type == 'text') {
          try {
            msg.content = (decodeURIComponent(msg.content))
          } catch (e) {
            msg.content = (msg.content)
          }
          if (msg.at) {
            msgString = decodeURIComponent(msg.user.user_name) + '对' + decodeURIComponent(msg.at.user_name) + '说：' + decodeURIComponent(msg.content)
            msg.content = '@' + decodeURIComponent(msg.at.user_name) + ' ' + msg.content
          } else {
            msgString = decodeURIComponent(msg.user.user_name) + '说：' + decodeURIComponent(msg.content)
          }
          this.say(msgString)
          for (let i = 0; i < this.data.messageList.length; i++) {
            if (this.data.messageList[i].loading) {
              this.data.messageList.splice(i, 1)
            }
          }
        }
        this.addMessageToList(msg)
        break
      case 'addSong':
        if (msg.at) {
          msgString = decodeURIComponent(msg.user.user_name) + ' 送了一首《' + msg.song.name + '》给 ' +
            decodeURIComponent(msg.at.user_name)
          this.addSystemMessage(msgString)
          this.say(msgString)
        } else {
          msgString = decodeURIComponent(msg.user.user_name) + ' 点了一首《' + msg.song.name + '》'
          this.addSystemMessage(msgString)
          this.say(msgString)
        }
        break
      case 'pass':
        msgString = decodeURIComponent(msg.user.user_name) + ' 切掉了《' + msg.song.name + '》'
        this.addSystemMessage(msgString, '#ff4500')
        this.say(msgString)
        break
      case 'push':
        msgString = decodeURIComponent(msg.user.user_name) + ' 将歌曲 《' + msg.song.name + '》 设为置顶候播放'
        this.addSystemMessage(msgString)
        this.say(msgString)
        break
      case 'removeSong':
        msgString = decodeURIComponent(msg.user.user_name) + ' 将歌曲 《' + msg.song.name + '》 从队列移除'
        this.addSystemMessage(msgString)
        this.say(msgString)
        break
      case 'back':
        for (let i = 0; i < this.data.messageList.length; i++) {
          if (this.data.messageList[i].message_id == msg.message_id) {
            this.data.messageList.splice(i, 1)
            break
          }
        }
        this.setData({
          messageList: this.data.messageList
        });
        msgString = decodeURIComponent(msg.user.user_name) + ' 撤回了一条消息'
        this.addSystemMessage(msgString)
        this.say(msgString)
        break
      case 'playSong':
        if (msg && msg.song && msg.user) {
          this.playMusic(msg)
        }
        break
      case 'all':
        this.addSystemMessage(msg.content)
        break
      case 'roomUpdate':
        this.getRoomInfo()
        break
      default:
        console.log('消息未解析')
    }
    this.autoScroll()
  },
  // 歌词
  getMusicLrc() {
    const song = this.data.songInfo && this.data.songInfo.song
    if (!song) {
      this.setData({
        musicLrcObj: [],
        lrcString: ''
      })
      return
    }
    if (song.source === 'wydt') {
      this.setData({
        musicLrcObj: [],
        lrcString: ''
      })
      return
    }
    if (song && Array.isArray(song.lrc) && song.lrc.length) {
      this.setData({
        musicLrcObj: song.lrc,
        lrcString: '歌词加载中...'
      })
      return
    }
    this.setData({
      musicLrcObj: [],
      lrcString: '歌词读取中...'
    })
    app.request({
      url: 'song/getLrc',
      data: {
        mid: song.mid,
        source: song.source,
        lrc: song.lrc || []
      },
      success: (res) => {
        this.setData({
          musicLrcObj: res.data,
          lrcString: '歌词加载中...'
        })
      },
      error: () => {
        this.setData({
          musicLrcObj: [],
          lrcString: ''
        })
        return true
      }
    })
  },
  // 播放音乐
  playMusic(msg) {
    this.data.playerSwitchingUntil = Date.now() + 1800
    this.setData({
      songInfo: msg,
      playerPicError: false
    })
    this.getMusicLrc()
    this.data.carEventChannel && this.data.carEventChannel.emit('sendSongInfo', this.data.songInfo)
    for (let i = 0; i < this.data.messageList.length; i++) {
      if (this.data.messageList[i].type == 'play') {
        this.data.messageList.splice(i, 1);
        break
      }
    }
    this.data.messageList.push({
      type: 'play',
      data: msg
    })
    this.setData({
      messageList: this.data.messageList
    })
    if (msg.song.source === 'wydt') {
      this.data.bgPlayer.src = msg.song.url
      this.data.bgPlayer.title = msg.song.name + ' - ' + msg.song.singer
      this.data.bgPlayer.singer = '点歌人: ' + decodeURIComponent(msg.user.user_name) + ' ' + this.data.roomInfo.room_name + ' '
      this.data.bgPlayer.coverImgUrl = msg.song.pic
      this.data.bgPlayer.webUrl = msg.song.pic
      this.data.bgPlayer.seek(parseInt(new Date().valueOf() / 1000) - msg.since)
      if (this.data.isMusicPlaying) {
        this.addSystemMessage('正在播放 ' + decodeURIComponent(msg.user.user_name) + ' 点的 ' + msg.song.name + '(' + msg.song.singer + ')')
        this.data.bgPlayer.play()
      } else {
        this.data.bgPlayer.stop()
      }
      return
    }
    if (!msg.song.url && msg.song.source !== 'tencent') {
      this.autoPassUnavailableSong(msg)
      return
    }
    app.request({
      url: 'song/getUrl',
      data: { source: msg.song.source, mid: msg.song.mid, url: msg.song.url },
      success: (res) => {
        if (!this.data.songInfo || this.data.songInfo._id !== msg._id) {
          return
        }
        if (!res.data || !/^https:\/\//i.test(String(res.data))) {
          this.autoPassUnavailableSong(msg)
          return
        }
        this.data.bgPlayer.src = res.data
        this.data.bgPlayer.title = msg.song.name + ' - ' + msg.song.singer
        this.data.bgPlayer.singer = '点歌人: ' + decodeURIComponent(msg.user.user_name) + ' ' + this.data.roomInfo.room_name + ' '
        this.data.bgPlayer.coverImgUrl = msg.song.pic
        this.data.bgPlayer.webUrl = msg.song.pic
        this.data.bgPlayer.seek(parseInt(new Date().valueOf() / 1000) - msg.since)
        if (this.data.isMusicPlaying) {
          this.addSystemMessage('正在播放 ' + decodeURIComponent(msg.user.user_name) + ' 点的 ' + msg.song.name + '(' + msg.song.singer + ')')
          this.data.bgPlayer.play()
        } else {
          this.data.bgPlayer.stop()
        }
      },
      error: (response) => {
        const errmsg = response.msg || ''
        if (/资源不可用|HTTP/.test(errmsg)) {
          this.autoPassUnavailableSong(msg)
          return true
        }
        if (this.data.songInfo && this.data.songInfo._id === msg._id) {
          this.data.bgPlayer.stop()
          this.setData({
            songInfo: null,
            musicLrcObj: [],
            lrcString: ''
          })
        }
        wx.showToast({
          title: errmsg || '当前歌曲暂时无法播放',
          icon: 'none'
        })
        return true
      },
      fail: (error) => {
        const message = `${error.errCode || error.code || ''} ${error.errMsg || error.message || ''}`
        if (/-504003|timed out after (?:3|5) seconds|functions_time_limit_exceeded/i.test(message)) {
          this.autoPassUnavailableSong(msg)
          return
        }
        wx.showToast({
          title: '云服务暂时不可用',
          icon: 'none'
        })
      }
    })
  },
  refillPlaybackQueue() {
    if (this.data.isRefillingQueue || !app.globalData.userInfo) {
      return
    }
    const requestId = this.data.refillRequestId + 1
    this.data.refillRequestId = requestId
    this.setData({ isRefillingQueue: true })
    const finish = () => {
      if (this.data.refillRequestId === requestId) {
        this.setData({ isRefillingQueue: false })
      }
    }
    setTimeout(finish, 12000)
    app.request({
      url: 'song/refill',
      data: { count: 3 },
      success: finish,
      error: () => {
        finish()
        return true
      },
      fail: finish
    })
  },
  autoPassUnavailableSong(msg) {
    if (!msg || !msg.song || this.data.failedSongPassId === msg._id) {
      return
    }
    this.setData({ failedSongPassId: msg._id })
    this.data.bgPlayer.stop()
    this.setData({
      musicLrcObj: [],
      lrcString: ''
    })
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
  say(str) {
    if (!this.data.isCarMode) {
      return
    }
    WechatSI.textToSpeech({
      lang: 'zh_CN',
      tts: true,
      content: str,
      success: (res) => {
        this.data.audioPlayer.src = res.filename
        this.data.audioPlayer.playbackRate = 1.2
        this.data.audioPlayer.play()
      }
    })
  },
  // 获取当前房间的消息
  getMessageList() {
    app.request({
      url: api.getMessageList,
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
            if (_obj.at) {
              _obj.content = '@' + _obj.at.user_name + ' ' + _obj.content
            }
            _obj.message_time = res.data[i].message_createtime
            _obj.isAtAll = false
            if (_obj.type == 'text') {
              try {
                _obj.content = (decodeURIComponent(_obj.content))
              } catch (e) {
                _obj.content = (_obj.content)
              }
              _obj.isAtAll = decodeURIComponent(_obj.content).indexOf('@全体') == 0 && _obj.user.user_id == this.data.roomInfo.room_user ? true : false
            }
            messageList.unshift(_obj)
          }
        }
        messageList.unshift({
          type: 'system',
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
  clearAtInfo() {
    this.setData({ atMessageObj: false })
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
      messagePlaceHolder: this.data.isEmojiBoxShow ? config.placeholderSearchImage : config.placeholderDefault,
      messageSendButton: this.data.isEmojiBoxShow ? config.messageButtonTitleSearch : config.messageButtonTitleSend,
      atMessageObj: false
    })
  },
  mainMenuClicked(e) {
    switch (e.mark.title) {
      case '驾驶':
        // this.setData({
        //   isCarMode: !this.data.isCarMode
        // })
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
      case '资料':
        wx.navigateTo({
          url: '../user/motify',
          events: {
            myInfoChanged: () => {
              this.getMyInfo(false)
            }
          }
        })
        break
      case '提示词':
        wx.navigateTo({
          url: '../room/prompts'
        })
        break
      case '分享':
        wx.showShareMenu({
          withShareTicket: true
        })
        break
      default:
        return
    }
  },
  // 点击图片，预览。【这个功能我觉得不好，暂时不放开】
  previewImage(e) {
    return
    try {
      e.mark.url = decodeURIComponent(e.mark.url)
    } catch (e) {
      // not todo
    }
    if (e.mark.url) {
      if (e.mark.url.indexOf('images/emoji/') == -1 && e.mark.url.indexOf('/res/Emojis/') == -1) {
        wx.previewImage({
          current: this.getStaticUrl(e.mark.url),
          urls: [
            this.getStaticUrl(e.mark.url)
          ]
        })
      }
    }
  },
  longTapToMessage(e) {
    if (!this.data.userInfo || this.data.userInfo.user_id < 0) {
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
            let copyData = decodeURIComponent(msg.content)
            if (msg.at) {
              copyData = '@' + decodeURIComponent(msg.at.user_name) + ' ' + copyData
            }
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
              atMessageObj: {
                user_id: msg.user.user_id,
                user_name: decodeURIComponent(msg.user.user_name),
                message: msg
              }
            })
            if (!this.data.messageFocus) {
              this.setData({
                messageFocus: true
              })
            }
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
              this.data.bgPlayer.stop()
              this.setData({
                isMusicPlaying: false
              })
            } else {
              this.setData({
                isMusicPlaying: true
              })
              this.playMusic(this.data.songInfo)
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
              url: api.addMySong,
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
  longTapToAtUser(user) {
    this.setData({
      isPanelShow: false,
      atMessageObj: {
        user_id: user.user_id,
        user_name: decodeURIComponent(user.user_name)
      }
    })
    if (!this.data.messageFocus) {
      this.setData({
        messageFocus: true
      })
    }
    this.autoScroll()
    wx.vibrateShort()
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
    const reply = this.data.atMessageObj && this.data.atMessageObj.message ? this.data.atMessageObj.message : null
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
        this.setData({ atMessageObj: false })
        this.hideAllDialog()
      }
    })
  },
  searchImages(message) {
    app.request({
      url: 'attach/search',
      data: {
        keyword: message
      },
      loading: '搜索中',
      success: (res) => {
        this.setData({
          imageList: res.data,
          isSystemEmoji: false
        })
      },
      error: () => {
        this.setData({
          imageList: this.data.emojiList
        })
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
      this.say('当前没有正在播放的歌曲')
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
        this.say(res.msg)
      },
      error: (res) => {
        this.say(res.msg)
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
          this.say(res.msg)
        },
        error: (res) => {
          this.say(res.msg)
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
        this.say(res.msg)
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
    if (this.data.isEmojiBoxShow) {
      this.searchImages(message)
      return
    }
    this.setData({
      message: ''
    })
    let message_send = message
    if (this.data.atMessageObj && !this.data.atMessageObj.message) {
      message = '@' + decodeURIComponent(this.data.atMessageObj.user_name + ' ' + message,
        '')
    }
    let msgObj = {
      type: 'text',
      content: encodeURIComponent(message),
      where: 'channel',
      at: this.data.atMessageObj,
      message_id: 0,
      message_time: 0,
      loading: true,
      resource: message,
      user: this.data.userInfo
    }
    this.addMessageToList(msgObj)
    let atUserInfo = this.data.atMessageObj
    this.setData({
      atMessageObj: false
    })
    app.request({
      url: 'message/send',
      data: {
        type: 'text',
        where: 'channel',
        to: this.data.room_id,
        msg: encodeURIComponent(message_send),
        at: atUserInfo && !atUserInfo.message ? atUserInfo : false,
        reply_to: atUserInfo && atUserInfo.message ? atUserInfo.message.message_id : ''
      },
      success: (res) => {
        this.setData({
          atMessageObj: false,
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
          messageList: this.data.messageList
        })
      }
    })
  },
  chooseImage() {
    const reply = this.data.atMessageObj && this.data.atMessageObj.message ? this.data.atMessageObj.message : null
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
              this.setData({ atMessageObj: false })
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
      const reply = this.data.atMessageObj && this.data.atMessageObj.message ? this.data.atMessageObj.message : null
      app.request({
        url: 'message/send',
        data: {
          type: 'voice',
          msg: uploadResult.fileID,
          resource: uploadResult.fileID,
          duration: result.duration,
          reply_to: reply ? reply.message_id : ''
        },
        success: () => this.setData({ atMessageObj: false })
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
  backCar() {
    this.setData({
      isCarMode: false
    })
  },
  login() {
    wx.navigateTo({
      url: '../user/login?bbbug=' + app.globalData.systemVersion
    })
  },
  onUnload() {
    this.closeCloudWatchers()
    if (this.data.isRecording && this.data.recorderManager) {
      this.data.discardVoiceResult = true
      this.data.recorderManager.stop()
    }
    this.data.voicePlayer && this.data.voicePlayer.destroy()
  }
})
