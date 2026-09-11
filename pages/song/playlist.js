const app = getApp()
const jusicWsApi = require('../../utils/jusicWsApi.js')

const decodeOption = (value, fallback = '') => {
  try {
    return decodeURIComponent(value || '') || fallback
  } catch (error) {
    return value || fallback
  }
}

Component({
  properties: {},

  data: {
    bbbug: false,
    playlistId: '',
    source: 'netease',
    playlist: null,
    songList: [],
    hasLoaded: false,
    page: 1,
    hasMore: false,
    isLoading: false
  },

  methods: {
    onLoad(options) {
      if (!options.bbbug || options.bbbug != app.globalData.systemVersion || !options.id) {
        return
      }
      const source = options.source === 'qq' || options.source === 'tencent' ? 'tencent' : 'netease'
      this.setData({
        bbbug: true,
        source,
        playlistId: String(options.id),
        playlist: {
          id: String(options.id),
          name: decodeOption(options.name, source === 'tencent' ? 'QQ音乐歌单' : '网易云歌单'),
          cover: decodeOption(options.cover),
          creatorName: decodeOption(options.creatorName, source === 'tencent' ? 'QQ音乐用户' : '网易云用户'),
          creatorId: decodeOption(options.creatorId),
          trackCount: Number(decodeOption(options.trackCount, '0')) || 0,
          playCount: decodeOption(options.playCount, '0'),
          description: decodeOption(options.description),
          source
        }
      })
      wx.setNavigationBarTitle({ title: '歌单详情' })
      this.getPlaylistDetail()
    },

    getPlaylistDetail() {
      const requestId = (this._detailRequestId || 0) + 1
      const page = this.data.page
      const pageSize = 50
      this._detailRequestId = requestId
      if (this._detailRequest && typeof this._detailRequest.cancel === 'function') {
        this._detailRequest.cancel()
      }
      this.setData({ isLoading: true })
      wx.showLoading({ title: '加载中', mask: true })
      const detailOptions = {
        page,
        pageSize,
        playlist: this.data.playlist
      }
      const request = this.data.source === 'tencent'
        ? jusicWsApi.getQQPlaylistSongs(this.data.playlistId, detailOptions)
        : jusicWsApi.getPlaylistDetail(this.data.playlistId, detailOptions)
      this._detailRequest = request
      request.then(result => {
        if (requestId !== this._detailRequestId) return
        const songs = result && Array.isArray(result.songs) ? result.songs : []
        const songList = page === 1 ? songs : this.data.songList.concat(songs)
        this.setData({
          playlist: result && result.playlist ? result.playlist : this.data.playlist,
          songList,
          hasLoaded: true,
          hasMore: Boolean(result && result.hasMore)
        })
      }).catch(error => {
        if (requestId !== this._detailRequestId || (error && error.code === 'JUSIC_REQUEST_CANCELLED')) return
        this.setData({ hasLoaded: true })
        wx.showToast({ title: error.message || '歌单加载失败，请重试', icon: 'none' })
      }).then(() => {
        if (requestId === this._detailRequestId) {
          this._detailRequest = null
          this.setData({ isLoading: false })
          wx.hideLoading()
        }
      })
    },

    onReachBottom() {
      if (!this.data.isLoading && this.data.hasMore) {
        this.setData({ page: this.data.page + 1 })
        this.getPlaylistDetail()
      }
    },

    onUnload() {
      if (this._detailRequest && typeof this._detailRequest.cancel === 'function') {
        this._detailRequest.cancel()
      }
      this._detailRequest = null
      this._detailRequestId = (this._detailRequestId || 0) + 1
      wx.hideLoading()
    },

    onPlaylistPicError() {
      this.setData({
        'playlist.cover': '/res/image/nohead.jpg'
      })
    },

    onSongPicError(e) {
      this.setData({
        [`songList[${e.currentTarget.dataset.index}].pic`]: '/res/image/nohead.jpg'
      })
    },

    openCreatorPlaylists() {
      const playlist = this.data.playlist
      if (!playlist || !playlist.creatorId) return
      const source = this.data.source || playlist.source || 'netease'
      wx.navigateTo({
        url: `./user-playlists?id=${encodeURIComponent(playlist.creatorId)}&source=${encodeURIComponent(source)}&name=${encodeURIComponent(playlist.creatorName || '')}&bbbug=${app.globalData.systemVersion}`
      })
    },

    showMenu(e) {
      const song = e.mark.item
      let menu = ['点歌', '收藏']
      if (app.globalData.roomInfo && app.globalData.userInfo && app.globalData.roomInfo.room_type == 4 && app.globalData.roomInfo.room_user == app.globalData.userInfo.user_id) {
        menu = ['播放', '收藏']
      }
      wx.showActionSheet({
        itemList: menu,
        success: (res) => {
          const action = menu[res.tapIndex]
          if (action === '收藏') {
            this.addFavorite(song)
          } else if (action === '播放') {
            this.playSong(song)
          } else if (action === '点歌') {
            this.addSong(song)
          }
        }
      })
    },

    addSong(song) {
      app.request({
        url: 'song/addSong',
        loading: '点歌中',
        data: {
          mid: song.mid,
          source: song.source,
          song,
          room_id: app.globalData.roomInfo.room_id
        },
        success: () => wx.showToast({ title: '点歌成功' })
      })
    },

    addFavorite(song) {
      app.request({
        url: 'song/addMySong',
        loading: '收藏中',
        data: {
          mid: song.mid,
          source: song.source,
          song,
          room_id: app.globalData.roomInfo.room_id
        },
        success: () => wx.showToast({ title: '收藏成功' })
      })
    },

    playSong(song) {
      app.request({
        url: 'song/playSong',
        loading: '播放中',
        data: {
          mid: song.mid,
          source: song.source,
          song,
          room_id: app.globalData.roomInfo.room_id
        },
        success: () => wx.showToast({ title: '播放成功' })
      })
    }
  }
})