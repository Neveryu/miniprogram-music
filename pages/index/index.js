import config from '../../config/index.js'
import api from '../../config/api.js'
import { config as reqConfig } from '../../utils/request.js'
const app = getApp()
// var WechatSI = requirePlugin("WechatSI")
// let WechatRecord = WechatSI.getRecordRecognitionManager()
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
    showPasswordForm: false,
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
    default_room: 10865,
    room_id: 0,
    room_password: '',
    bbbug_view_id: '',
    bbbug_view_scroll: '',
    websocket: {
      url: '',
      task: null,
      connected: false,
      forceStop: false,
      reconnectTimer: false,
      heartBeatTimer: false
    },
    bgPlayer: null,
    audioPlayer: null,
    userInfo: null,
    roomInfo: null,
    songInfo: null
  },
  onLoad(options) {
    // 初始化emoji列表
    this.data.emojiList = config.emojiList
    // 响应token变化
    app.watchAccessToken(() => {
      this.getMyInfo()
    })
    // 初始化一个背景音频管理器；小程序切入后台，如果音频处于播放状态，可以继续播放。但是后台状态不能通过调用API操纵音频的播放状态。
    this.data.bgPlayer = wx.getBackgroundAudioManager()
    if (options && options.scene) {
      wx.setStorageSync('room_id', options.scene)
    } else if (options && options.room_id) {
      wx.setStorageSync('room_id', options.room_id)
    }
    // this.data.bottomHeight = app.systemInfo.safeArea.bottom - app.systemInfo.safeArea.height + 40
    /**
     * 因为bottomHeight在dom初始化中已经使用了，所以这里要修改它实现响应式变化，必须使用setData
     * 否则，在onload中是可以直接使用this.data.xxx的形式来赋值的。
     */
    this.setData({
      bottomHeight: app.systemInfo.safeArea.bottom - app.systemInfo.safeArea.height + 40
    })
    // 初始化房间号
    this.data.room_id = wx.getStorageSync('room_id') || this.data.default_room

    let plat = app.systemInfo.platform.toLowerCase()
    if (plat == 'windows' || plat == 'mac') {
      wx.redirectTo({
        url: '../pc/index?bbbug=' + app.globalData.systemVersion + '&url=' + encodeURIComponent('https://bbbug.com'),
      });
      wx.hideHomeButton()
      return
    }
    /**
     * 监听背景音频播放进度更新事件，只有小程序在前台时会回调。
     * 这里用户歌词的轮动显示
     */
    this.data.bgPlayer.onTimeUpdate( (e) => {
      if (this.data.songInfo) {
        if (this.data.musicLrcObj) {
          for (let i = 0; i < this.data.musicLrcObj.length; i++) {
            if (i == this.data.musicLrcObj.length - 1) {
              this.setData({
                lrcString: this.data.musicLrcObj[i].lineLyric
              })
              return
            } else {
              if (this.data.bgPlayer.currentTime > this.data.musicLrcObj[i].time && this.data.bgPlayer.currentTime < this.data.musicLrcObj[i + 1].time) {
                this.setData({
                  lrcString: this.data.musicLrcObj[i].lineLyric
                })
                return
              }
            }
          }
        }
      }
    })
    /**
     * 监听用户在系统音乐播放面板点击上一曲事件（仅iOS）
     */
    this.data.bgPlayer.onPrev(() => {
      if (this.data.isCarMode) {
        app.request({
          url: 'song/addMySong',
          data: {
            room_id: app.globalData.roomInfo.room_id,
            mid: this.data.songInfo.song.mid,
          },
          loading: '收藏中',
          success: (res) => {
            this.say(res.msg)
          },
          error(res) {
            this.say(res.msg)
            return true
          }
        })
      }
    })
    /**
     * 监听用户在系统音乐播放面板点击下一曲事件（仅iOS）
     */
    this.data.bgPlayer.onNext(function () {
      if (!this.data.isCarMode) {
        return
      }
      app.request({
        url: 'song/pass',
        data: {
          room_id: app.globalData.roomInfo.room_id,
          mid: this.data.songInfo.song.mid,
        },
        success: (res) => {
          this.say(res.msg)
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
    // 初始化，获取当前登录用户的信息
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
        });
        app.globalData.userInfo = res.data
        app.globalData.access_token_changed = false
        wx.hideNavigationBarLoading()
        if (reloadRoom) {
          this.getRoomInfo()
        }
        app.alertChangeInfo()
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
    this.setData({
      showPasswordForm: false
    })
    app.request({
      url: api.getRoomInfo,
      data: {
        room_id: this.data.room_id,
        room_password: this.data.room_password
      },
      success: (res) => {
        wx.hideNavigationBarLoading()
        wx.hideLoading()
        this.setData({
          roomInfo: res.data
        })
        app.globalData.roomInfo = res.data
        if (this.data.isThisShow) {
          wx.setNavigationBarTitle({
            title: res.data.room_name
          })
        }
        this.getWebsocketUrl()
        this.getMessageList()
      },
      error: (res) => {
        wx.hideNavigationBarLoading()
        if (res.code == 302) {
          this.setData({
            showPasswordForm: true,
            room_password: ''
          })
          return true
        }
      }
    })
  },
  getWebsocketUrl() {
    wx.showNavigationBarLoading()
    app.request({
      url: api.getWebsocketUrl,
      data: {
        channel: this.data.room_id,
      },
      success: (res) => {
        wx.hideNavigationBarLoading()
        // this.data.websocket.url = 'wss://websocket.bbbug.com?account=' + res.data.account + "&channel=" + res.data.channel + "&ticket=" + res.data.ticket
        this.data.websocket.url = `wss://websocket.bbbug.com?account=${res.data.account}&channel=${res.data.channel}&ticket=${res.data.ticket}`
        this.connectWebsocket()
      },
      error(res) {
        wx.hideNavigationBarLoading()
      }
    })
  },
  connectWebsocket() {
    if (this.data.websocket.connected) {
      this.data.websocket.forceStop = true
      this.data.websocket.task.send({
        data: 'bye'
      })
      this.data.websocket.reconnectTimer = setTimeout(() => {
        this.connectWebsocket()
        console.log('waiting')
      }, 100)
    } else {
      this.data.websocket.task = wx.connectSocket({
        url: this.data.websocket.url,
      })
      this.data.websocket.task.onOpen(() => {
        this.data.websocket.forceStop = false
        this.data.websocket.connected = true
        // 原代码心跳实现不健壮，几乎等于没实现，暂时注释掉下面一行
        this.websocketHeartBeat()
      })
      this.data.websocket.task.onMessage((data) =>{
        let msg = false
        try {
          msg = JSON.parse(data.data)
        } catch (err) {
          return
        }
        if (msg) {
          this.messageController(msg)
        }
      })
      this.data.websocket.task.onClose(() => {
        this.data.websocket.connected = false
        this.data.websocket.task = null
        if (!this.data.websocket.forceStop) {
          this.reconnectWebsocket()
        }
      })
    }
  },
  websocketHeartBeat() {
    if (this.data.websocket.connected) {
      this.data.websocket.task.send({
        data: 'heartBeat'
      })
      clearTimeout(this.data.websocket.heartBeatTimer)
      this.data.websocket.heartBeatTimer = setTimeout(() => {
        this.websocketHeartBeat()
      }, 10000)
    }
  },
  reconnectWebsocket() {
    if (!this.data.websocket.connected) {
      this.connectWebsocket()
    }
  },
  messageController(msg) {
    console.log('长链接发送过来的数据：', msg)
    let msgString = ''
    switch (msg.type) {
      case 'touch':
        msgString = decodeURIComponent(msg.user.user_name) + ' 摸了摸 ' + decodeURIComponent(msg.at.user_name) + msg.at.user_touchtip
        this.addSystemMessage(msgString)
        if (msg.at) {
          if (msg.at.user_id == this.data.userInfo.user_id) {
            wx.vibrateLong()
          }
        }
        break
      case 'join':
        msg.content = msg.content
        msg.type = 'system'
        this.addMessageToList(msg)
        this.say(msg.content)
        break
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
      case 'removeban':
        msgString = decodeURIComponent(msg.user.user_name) + ' 将 ' + decodeURIComponent(msg.ban.user_name) + ' 解禁'
        this.addSystemMessage(msgString)
        this.say(msgString)
        break
      case 'shutdown':
        msgString = decodeURIComponent(msg.user.user_name) + ' 禁止了用户 ' + decodeURIComponent(msg.ban.user_name) + ' 发言'
        this.addSystemMessage(msgString)
        this.say(msgString)
        break
      case 'songdown':
        msgString = decodeURIComponent(msg.user.user_name) + ' 禁止了用户 ' + decodeURIComponent(msg.ban.user_name) + ' 点歌'
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
      case 'online':
        if (this.data.isThisShow) {
          wx.setNavigationBarTitle({
            title: this.data.roomInfo.room_name + '(' + msg.data.length + ')'
          })
        }
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
    this.setData({
      musicLrcObj: [],
      lrcString: '歌词读取中...'
    })
    app.request({
      url: 'song/getLrc',
      data: {
        mid: this.data.songInfo.song.mid
      },
      success: (res) => {
        this.setData({
          musicLrcObj: res.data,
          lrcString: '歌词加载中...'
        })
      }
    })
  },
  // 播放音乐
  playMusic(msg) {
    this.setData({
      songInfo: msg
    })
    this.getMusicLrc()
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
    this.data.bgPlayer.src = reqConfig.apiUrl + '/song/playurl?mid=' + msg.song.mid
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
    this.setData({
      bbbug_view_id: view_id,
      bbbug_view_scroll: view_id
    })
  },
  say(str) {
    return
    let that = this;
    if (!that.data.isCarMode) {
      return;
    }
    WechatSI.textToSpeech({
      lang: "zh_CN",
      tts: true,
      content: str,
      success: function (res) {
        that.data.audioPlayer.src = res.filename;
        that.data.audioPlayer.playbackRate = 1.2;
        that.data.audioPlayer.play();
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
              _obj.isAtAll = decodeURIComponent(_obj.content).indexOf('@全体') == 0 && (_obj.user.user_id == this.data.roomInfo.room_user || _obj.user.user_admin) ? true : false
            }
            messageList.unshift(_obj)
          }
        }
        this.setData({
          messageList: messageList
        });
        this.addSystemMessage(this.data.roomInfo.room_notice ? this.data.roomInfo.room_notice : ('欢迎来到' + this.data.roomInfo.room_name + '!'))
        this.autoScroll()
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
        this.setData({
          isCarMode: !this.data.isCarMode
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
      case '歌单':
        wx.navigateTo({
          url: '../song/my?bbbug=' + app.globalData.systemVersion,
        })
        break
      case '在线':
        wx.navigateTo({
          url: '../user/online?bbbug=' + app.globalData.systemVersion,
          events: {
            doAtUser: (userInfo) => {
              this.longTapToAtUser(userInfo)
            },
            doTouchUser: (user_id) => {
              this.doTouchUser(user_id)
            }
          }
        })
        break
      case '换房':
        wx.navigateTo({
          url: '../room/select?bbbug=' + app.globalData.systemVersion,
          events: {
            changeRoomSuccess: (room_id) => {
              this.setData({
                room_id: room_id
              })
              this.setData({
                songInfo: false
              })
              this.data.bgPlayer.stop()
              this.getRoomInfo()
            }
          }
        })
        break
      case '注销':
        app.globalData.userInfo = app.globalData.guestUserInfo
        reqConfig.baseData.access_token = app.globalData.guestUserInfo.access_token
        wx.setStorageSync('access_token', app.globalData.guestUserInfo.access_token)
        this.setData({
          userInfo: app.globalData.userInfo
        })
        this.getMyInfo();
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
      case '管理':
        wx.navigateTo({
          url: '../room/motify?bbbug=' + app.globalData.systemVersion,
          events: {
            reloadMessage: () => {
              this.getMessageList()
            }
          }
        })
        break
      case '分享':
        let imgUrl = 'https://api.bbbug.com/api/weapp/qrcode?room_id=' + this.data.room_id
        wx.previewImage({
          urls: [imgUrl],
          current: imgUrl
        })
        break
      default:
        return
    }
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
    let menu = ['收藏到歌单', '切歌']
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
          case '收藏到歌单':
            app.request({
              url: api.addMySong,
              data: {
                room_id: app.globalData.roomInfo.room_id,
                mid: this.data.songInfo.song.mid
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
            let type = 'pass'
            if (this.data.roomInfo.room_user == this.data.userInfo.user_id || this.data.userInfo.user_admin || this.data.songInfo.user.user_id == this.data.userInfo.user_id) {
              type = 'pass'
            } else {
              type = 'vote'
            }
            app.request({
              url: 'song/pass',
              data: {
                room_id: app.globalData.roomInfo.room_id,
                mid: this.data.songInfo.song.mid,
              },
              loading: type == 'pass' ? '切歌中' : '投票中',
              success: (res) => {
                if (type == 'pass') {
                  wx.showToast({
                    title: '切歌成功'
                  })
                } else {
                  wx.showModal({
                    title: '投票成功',
                    content: res.msg,
                    showCancel: false,
                  })
                }
              }
            })
            break
          default:
        }
      }
    })
  },
  getStaticUrl(str) {
    if (str.indexOf('https://') == 0 || str.indexOf('http://') == 0) {
      return str.replace('http://', 'https://')
    } else {
      return reqConfig.cdnUrl + '/uploads/' + str
    }
  },
  sendEmoji(e) {
    let url = false
    if (e.mark.url.indexOf('/res/Emojis/') > -1) {
      url = reqConfig.cdnUrl + '/images/emoji/' + e.mark.url.replace('/res/Emojis/', '')
    } else {
      url = e.mark.url
    }
    url = this.getStaticUrl(url)
    console.log(url, '----')
    app.request({
      url: 'message/send',
      data: {
        where: 'channel',
        to: this.data.room_id,
        type: 'img',
        msg: url,
        resource: url,
      },
      success: (res) => {
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
  sendMessage(e) {
    let message = e.detail.value
    if (!message) {
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
    if (this.data.atMessageObj) {
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
        where: "channel",
        to: this.data.room_id,
        msg: encodeURIComponent(message_send),
        at: atUserInfo
      },
      success: (res) => {
        this.setData({
          atMessageObj: false,
          isScrollEnabled: true,
        })
        this.autoScroll()
      },
      error: (res) => {
        this.setData({
          message: message
        })
      }
    })
  },
  chooseImage() {
    wx.chooseImage({
      count: 1,
      sizeType: 'compressed',
      success: (res) => {
        this.hideAllDialog()
        wx.showLoading({
          title: '发送中',
        })
        wx.uploadFile({
          url: reqConfig.apiUrl + 'attach/uploadImage',
          filePath: res.tempFilePaths[0],
          name: 'file',
          formData: reqConfig.baseData,
          success: (res) => {
            wx.hideLoading()
            res.data = JSON.parse(res.data)
            if (res.data.code == 200) {
              let url = reqConfig.cdnUrl + '/uploads/' + res.data.data.attach_path
              app.request({
                url: 'message/send',
                data: {
                  where: 'channel',
                  to: this.data.room_id,
                  type: 'img',
                  msg: url,
                  resource: url,
                },
                success: (res) => {
                  this.hideAllDialog()
                }
              })
            } else {
              wx.showModal({
                title: '上传失败(' + res.data.code + ')',
                content: res.data.msg,
                showCancel: false
              })
            }
          }
        })
      }
    })
  },
  login() {
    wx.navigateTo({
      url: '../user/login?bbbug=' + app.globalData.systemVersion
    })
  }
})