const app = getApp();
const jusicWsApi = require('../../utils/jusicWsApi.js')
const { fillSongCovers } = require('../../utils/cover.js')
const { checkPageToken, getRoomId } = require('../../utils/pageGuard.js')
Component({
  /**
   * 组件的属性列表
   */
  properties: {},
  /**
   * 组件的初始数据
   */
  data: {
    bbbug: false,
    songList: [],
    page: 1,
    isLoading: false,
    hasMore: true,
    // 分类筛选：normal 我的歌曲 / children 儿歌，两者互斥
    filter: 'normal',
    marking: false
  },
  /**
   * 组件的方法列表
   */
  methods: {
    onLoad(options) {
      if (!checkPageToken(options)) {
        return
      }
      this.setData({
        bbbug: true
      })
      wx.setNavigationBarTitle({
        title: '歌曲收藏'
      })
      this.getSongList()
      // 游客点歌收藏触发登录后，返回本页时自动重拉列表
      this.offLogin = app.onLogin(() => {
        this.data.isLoading = false
        this.data.page = 1
        this.data.hasMore = true
        this.setData({ songList: [] })
        this.getSongList()
      })
    },
    onUnload() {
      if (this.offLogin) {
        this.offLogin()
      }
      // 使在途请求与封面回调失效，避免卸载后 setData
      this._listRequestId = (this._listRequestId || 0) + 1
    },
    onPullDownRefresh() {
      this.data.page = 1
      this.data.hasMore = true
      // 下拉刷新必须发起新请求，不能因在途请求而直接返回
      this.getSongList(true)
      wx.stopPullDownRefresh()
    },
    // 封面图加载失败时回退本地占位图
    onSongPicError(e) {
      this.setData({
        [`songList[${e.currentTarget.dataset.index}].pic`]: '/res/image/nohead.jpg'
      })
    },
    onReachBottom() {
      if (!this.data.isLoading && this.data.hasMore) {
        this.data.page++
        this.getSongList()
      }
    },
    // 切换「我的歌曲 / 儿歌」分类
    switchTab(e) {
      const filter = e.currentTarget.dataset.tab
      // 加载中不切换，避免旧请求结果覆盖新分类列表
      if (filter === this.data.filter || this.data.isLoading) {
        return
      }
      this.setData({
        filter: filter,
        songList: []
      })
      this.data.page = 1
      this.data.hasMore = true
      this.getSongList()
    },
    // 在「我的歌曲」与「儿歌」两个互斥分类之间移动收藏歌曲
    toggleChildrenFlag(e) {
      const song = e.mark.item
      if (!song || this.data.marking) {
        return
      }
      const nextChildren = !song.children
      this.data.marking = true
      app.request({
        url: 'song/toggleMySongChildren',
        data: {
          mid: song.mid,
          source: song.source,
          children: nextChildren
        },
        // 401 时 request.js 不会回调 error/fail，需在此解除操作锁
        loginRequired: () => {
          this.data.marking = false
        },
        success: () => {
          this.data.marking = false
          wx.showToast({
            title: nextChildren ? '已加入儿歌' : '已移出儿歌',
            icon: 'none'
          })
          // 两个分类互斥：加入或移出后该首都会离开当前列表
          this.setData({
            songList: this.data.songList.filter((item) => !(item.mid == song.mid && item.source == song.source))
          })
        },
        error: (response) => {
          this.data.marking = false
          wx.showToast({
            title: response.msg || '操作失败，请重试',
            icon: 'none'
          })
          return true
        },
        fail: () => {
          this.data.marking = false
          wx.showToast({
            title: '操作失败，请重试',
            icon: 'none'
          })
        }
      })
    },
    getSongList(force = false) {
      if (this.data.isLoading && !force) {
        return
      }
      // 请求序号保证下拉刷新后，旧请求的结果不会覆盖新列表
      const requestId = (this._listRequestId || 0) + 1
      this._listRequestId = requestId
      this.data.isLoading = true
      app.request({
        url: 'song/mySongList',
        loading: '加载中',
        data: {
          page: this.data.page,
          filter: this.data.filter
        },
        // 游客收到 401 时解除加载锁，取消登录后仍可下拉刷新重试
        loginRequired: () => {
          if (requestId === this._listRequestId) {
            this.data.isLoading = false
          }
        },
        success: (res) => {
          if (requestId !== this._listRequestId) return
          let songList = this.data.songList
          if (this.data.page == 1) {
            songList = []
          }
          songList = songList.concat(res.data || [])
          // 服务端多取一条判断分页，避免损坏记录被跳过时提前结束列表
          this.data.hasMore = res.hasMore === true
          this.setData({
            songList: songList
          })
          this.data.isLoading = false
          fillSongCovers(songList).then((songs) => {
            if (requestId === this._listRequestId) {
              this.setData({ songList: songs.slice() })
            }
          })
        },
        error: () => {
          if (requestId !== this._listRequestId) return
          if (this.data.page > 1) {
            this.data.page--
          }
          this.data.isLoading = false
        },
        fail: () => {
          if (requestId !== this._listRequestId) return
          if (this.data.page > 1) {
            this.data.page--
          }
          this.data.isLoading = false
        }
      })
    },
    // 播放地址可能缺失或过期，点歌/播放前统一通过 WS 点播重新取直链
    resolvePickedSong(song) {
      return jusicWsApi.ensurePlayableSong(song, true)
    },
    showMenu(e) {
      let song = e.mark.item
      let menu = ['点歌', '移除']
      if (app.globalData.roomInfo && app.globalData.userInfo && app.globalData.roomInfo.room_user == app.globalData.userInfo.user_id) {
        menu = ['播放', '点歌', '移除']
      }
      wx.showActionSheet({
        itemList: menu,
        success: (res) => {
          switch (menu[res.tapIndex]) {
            case '点歌': {
              const roomId = getRoomId()
              if (roomId == null) break
              this.resolvePickedSong(song).then((pickedSong) => {
                app.request({
                  url: 'song/addSong',
                  loading: "点歌中",
                  data: {
                    mid: pickedSong.mid,
                    source: pickedSong.source,
                    song: pickedSong,
                    room_id: roomId
                  },
                  success: (res) => {
                    // this.getSongList()
                    wx.showToast({
                      title: '点歌成功'
                    })
                  }
                })
              }).catch((error) => {
                wx.showToast({ title: error.message || '点歌失败', icon: 'none' })
              })
              break
            }
            case '移除': {
              const roomId = getRoomId()
              if (roomId == null) break
              app.request({
                url: 'song/deleteMySong',
                loading: '移除中',
                data: {
                  mid: song.mid,
                  source: song.source,
                  room_id: roomId
                },
                success: (res) => {
                  this.data.page = 1
                  this.getSongList()
                  wx.showToast({
                    title: '移除成功'
                  })
                }
              })
              break
            }
            case '播放': {
              const roomId = getRoomId()
              if (roomId == null) break
              this.resolvePickedSong(song).then((pickedSong) => {
                app.request({
                  url: 'song/playSong',
                  data: {
                    mid: pickedSong.mid,
                    source: pickedSong.source,
                    song: pickedSong,
                    room_id: roomId
                  },
                  loading: '播放中',
                  success: (res) => {
                    this.data.page = 1
                    this.getSongList()
                    wx.showToast({
                      title: '播放成功'
                    })
                  }
                })
              }).catch((error) => {
                wx.showToast({ title: error.message || '播放失败', icon: 'none' })
              })
              break
            }
            default:
              break
          }
        }
      })
    }
  }
})
