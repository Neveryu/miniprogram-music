const app = getApp()
const jusicWsApi = require('../../utils/jusicWsApi.js')
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
    playlistList: [],
    userList: [],
    searchPrompts: [],
    autoFocus: false,
    searchTypes: [
      { value: 'song', label: '歌曲' },
      { value: 'playlist', label: '歌单' },
      { value: 'user', label: '用户' },
      { value: 'radio', label: '网易电台' }
    ],
    searchType: 'song',
    hasSearched: false,
    sources: [
      { value: 'netease', label: '网易云' },
      { value: 'tencent', label: 'QQ音乐' },
      { value: 'kugou', label: '酷狗' }
    ],
    source: 'netease',
    room_id: 0,
  },
  lifetimes: {},
  /**
   * 组件的方法列表
   */
  methods: {
    onLoad(options) {
      if (!options.bbbug || options.bbbug != app.globalData.systemVersion) {
        return
      }
      this.setData({
        bbbug: true,
        autoFocus: true
      })
      wx.setNavigationBarTitle({
        title: '搜索点歌'
      })
      this.getSearchPrompts()
    },
    onUnload() {
      this.cancelPendingSearch()
      this._searchRequestId = (this._searchRequestId || 0) + 1
      wx.hideLoading()
    },
    cancelPendingSearch() {
      if (this._searchRequest && typeof this._searchRequest.cancel === 'function') {
        this._searchRequest.cancel()
      }
      this._searchRequest = null
    },
    getSearchPrompts() {
      app.request({
        url: 'room/getSearchPrompts',
        success: (res) => {
          this.setData({ searchPrompts: res.data || [] })
        }
      })
    },
    tapSearchPrompt(e) {
      const keyword = e.mark.prompt
      this.doSearchSong({ detail: { value: keyword } })
    },
    // 清空结果后内容变短，滚动位置若不归位会残留在页面下方，
    // 导致提示词区被吸顶头部遮住——切换前先回到顶部。
    resetScrollTop() {
      wx.pageScrollTo({
        scrollTop: 0,
        duration: 0
      })
    },
    selectSource(e) {
      this.cancelPendingSearch()
      this._searchRequestId = (this._searchRequestId || 0) + 1
      wx.hideLoading()
      this.resetScrollTop()
      const source = e.currentTarget.dataset.source
      let searchTypes = [{ value: 'song', label: '歌曲' }]
      if (source === 'netease') {
        searchTypes = [
          { value: 'song', label: '歌曲' },
          { value: 'playlist', label: '歌单' },
          { value: 'user', label: '用户' },
          { value: 'radio', label: '网易电台' }
        ]
      } else if (source === 'tencent') {
        searchTypes = [
          { value: 'song', label: '歌曲' },
          { value: 'playlist', label: '歌单' },
          { value: 'userPlaylists', label: 'QQ用户歌单' }
        ]
      }
      this.setData({
        source,
        searchTypes,
        searchType: 'song',
        songList: [],
        playlistList: [],
        userList: [],
        hasSearched: false
      })
    },
    selectSearchType(e) {
      this.cancelPendingSearch()
      this._searchRequestId = (this._searchRequestId || 0) + 1
      wx.hideLoading()
      this.resetScrollTop()
      const searchType = e.currentTarget.dataset.searchType
      this.setData({
        searchType,
        songList: [],
        playlistList: [],
        userList: [],
        hasSearched: false
      })
    },
    // 封面图加载失败时回退本地占位图
    onSongPicError(e) {
      this.setData({
        [`songList[${e.currentTarget.dataset.index}].pic`]: '/res/image/nohead.jpg'
      })
    },
    doSearchSong(e) {
      const value = e.detail.value
      const keyword = String(typeof value === 'object' ? value.keyword || '' : value || '').trim()
      const source = this.data.source
      const searchType = this.data.searchType
      if (!keyword) {
        wx.showToast({ title: '请输入搜索内容', icon: 'none' })
        return
      }
      if (source === 'tencent' && searchType === 'userPlaylists') {
        if (!/^\d+$/.test(keyword)) {
          wx.showToast({ title: '请输入正确的QQ号', icon: 'none' })
          return
        }
        wx.navigateTo({
          url: `./user-playlists?id=${encodeURIComponent(keyword)}&source=tencent&name=${encodeURIComponent('QQ音乐用户 ' + keyword)}&bbbug=${app.globalData.systemVersion}`
        })
        return
      }

      const requestId = (this._searchRequestId || 0) + 1
      this.cancelPendingSearch()
      this._searchRequestId = requestId
      this.setData({
        hasSearched: true,
        songList: [],
        playlistList: [],
        userList: []
      })

      // 歌单和 QQ 歌曲搜索走统一的 SockJS + STOMP WebSocket；网易云普通歌曲搜索继续走云函数。
      const isNeteaseWsSearch = source === 'netease' && (searchType === 'playlist' || searchType === 'user' || searchType === 'radio')
      const isQQWsSearch = source === 'tencent' && (searchType === 'playlist' || searchType === 'song')
      if (isNeteaseWsSearch || isQQWsSearch) {
        wx.showLoading({ title: '搜索中', mask: true })
        let search
        if (source === 'tencent') {
          search = searchType === 'playlist'
            ? jusicWsApi.searchQQPlaylists(keyword)
            : jusicWsApi.searchQQSongs(keyword)
        } else {
          search = searchType === 'playlist'
            ? jusicWsApi.searchPlaylists(keyword)
            : searchType === 'radio'
              ? jusicWsApi.searchRadioPrograms(keyword)
              : jusicWsApi.searchUsers(keyword)
        }
        this._searchRequest = search
        search.then(result => {
          if (requestId !== this._searchRequestId) return
          const list = result && Array.isArray(result.list) ? result.list : []
          if (searchType === 'song' || searchType === 'radio') {
            this.setData({ songList: list })
          } else if (searchType === 'playlist' || searchType === 'userPlaylists') {
            this.setData({ playlistList: list })
          } else {
            this.setData({ userList: list })
          }
        }).catch(error => {
          if (requestId !== this._searchRequestId || (error && error.code === 'JUSIC_REQUEST_CANCELLED')) return
          wx.showToast({ title: error.message || '搜索失败，请重试', icon: 'none' })
        }).then(() => {
          if (requestId === this._searchRequestId) {
            this._searchRequest = null
            wx.hideLoading()
          }
        })
        return
      }

      app.request({
        url: 'song/search',
        loading: '搜索中',
        data: {
            keyword,
            source
          },
        success: res => {
          if (requestId !== this._searchRequestId) return
          this.setData({ songList: res.data || [] })
        }
      })
    },
    openPlaylist(e) {
      const playlist = e.mark.item
      if (!playlist || !playlist.id) {
        return
      }
      const source = playlist.source || this.data.source || 'netease'
      wx.navigateTo({
        url: `./playlist?id=${encodeURIComponent(playlist.id)}&source=${encodeURIComponent(source)}&name=${encodeURIComponent(playlist.name || '')}&cover=${encodeURIComponent(playlist.cover || '')}&creatorName=${encodeURIComponent(playlist.creatorName || playlist.creator || '')}&creatorId=${encodeURIComponent(playlist.creatorId || playlist.creatorUid || '')}&trackCount=${encodeURIComponent(playlist.trackCount || '')}&playCount=${encodeURIComponent(playlist.playCount || '')}&description=${encodeURIComponent(playlist.description || playlist.desc || '')}&bbbug=${app.globalData.systemVersion}`
      })
    },
    openUserPlaylists(e) {
      const user = e.mark.item
      if (!user || !user.id) {
        return
      }
      const source = user.source || this.data.source || 'netease'
      wx.navigateTo({
        url: `./user-playlists?id=${encodeURIComponent(user.id)}&source=${encodeURIComponent(source)}&name=${encodeURIComponent(user.name || '')}&avatar=${encodeURIComponent(user.avatar || '')}&signature=${encodeURIComponent(user.signature || '')}&bbbug=${app.globalData.systemVersion}`
      })
    },
    onPlaylistPicError(e) {
      this.setData({
        [`playlistList[${e.currentTarget.dataset.index}].cover`]: '/res/image/nohead.jpg'
      })
    },
    onUserAvatarError(e) {
      this.setData({
        [`userList[${e.currentTarget.dataset.index}].avatar`]: '/res/image/nohead.jpg'
      })
    },
    addRadioProgram(song, playNow) {
      wx.showLoading({ title: playNow ? '播放中' : '点歌中', mask: true })
      jusicWsApi.pickRadioProgram(song).then(pickedSong => {
        app.request({
          url: playNow ? 'song/playSong' : 'song/addSong',
          data: {
            mid: pickedSong.mid,
            source: pickedSong.source,
            song: pickedSong,
            room_id: app.globalData.roomInfo.room_id
          },
          success: () => {
            wx.hideLoading()
            wx.showToast({ title: playNow ? '播放成功' : '点歌成功' })
          },
          error: response => {
            wx.hideLoading()
            wx.showToast({ title: response.msg || (playNow ? '播放失败' : '点歌失败'), icon: 'none' })
            return true
          },
          fail: error => {
            wx.hideLoading()
            wx.showToast({ title: error.message || (playNow ? '播放失败' : '点歌失败'), icon: 'none' })
          }
        })
      }).catch(error => {
        wx.hideLoading()
        wx.showToast({ title: error.message || (playNow ? '播放失败' : '点歌失败'), icon: 'none' })
      })
    },
    showMenu(e) {
      let song = e.mark.item
      const isRadio = song.source === 'wydt'
      let menu = isRadio ? ['点歌'] : ['点歌', '收藏']
      if (app.globalData.roomInfo && app.globalData.userInfo && app.globalData.roomInfo.room_type == 4 && app.globalData.roomInfo.room_user == app.globalData.userInfo.user_id) {
        menu = isRadio ? ['播放'] : ['播放', '收藏']
      }
      wx.showActionSheet({
        itemList: menu,
        success: (res) => {
          switch (menu[res.tapIndex]) {
            case '点歌':
              if (song.source === 'wydt') {
                this.addRadioProgram(song, false)
                break
              }
              app.request({
                url: 'song/addSong',
                data: {
                  mid: song.mid,
                  source: song.source,
                  song: song,
                  at: false,
                  room_id: app.globalData.roomInfo.room_id
                },
                loading: '点歌中',
                success: (res) => {
                  wx.showToast({
                    title: '点歌成功'
                  })
                }
              })
              break
            case '收藏':
              app.request({
                url: 'song/addMySong',
                data: {
                  room_id: app.globalData.roomInfo.room_id,
                  mid: song.mid,
                  source: song.source,
                  song: song
                },
                loading: '收藏中',
                success: (res) => {
                  wx.showToast({
                    title: '收藏成功'
                  })
                }
              })
              break
            case '播放':
              if (song.source === 'wydt') {
                this.addRadioProgram(song, true)
                break
              }
              app.request({
                url: 'song/playSong',
                data: {
                  mid: song.mid,
                  source: song.source,
                  song: song,
                  room_id: app.globalData.roomInfo.room_id
                },
                loading: '播放中',
                success: (res) => {
                  wx.showToast({
                    title: '播放成功'
                  })
                }
              })
              break
            default:
              break
          }
        }
      })
    }
  }
})
