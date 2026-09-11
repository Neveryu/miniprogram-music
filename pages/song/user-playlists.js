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
    userId: '',
    user: null,
    source: 'netease',
    playlistList: [],
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
        userId: String(options.id),
        user: {
          id: String(options.id),
          name: decodeOption(options.name, source === 'tencent' ? 'QQ音乐用户' : '网易云用户'),
          avatar: decodeOption(options.avatar),
          signature: decodeOption(options.signature)
        }
      })
      wx.setNavigationBarTitle({ title: source === 'tencent' ? 'QQ音乐用户歌单' : '网易云用户歌单' })
      this.getUserPlaylists()
    },

    getUserPlaylists() {
      const requestId = (this._playlistRequestId || 0) + 1
      const page = this.data.page
      const pageSize = 30
      this._playlistRequestId = requestId
      if (this._playlistRequest && typeof this._playlistRequest.cancel === 'function') {
        this._playlistRequest.cancel()
      }
      this.setData({ isLoading: true })
      wx.showLoading({ title: '加载中', mask: true })
      const request = this.data.source === 'tencent'
        ? jusicWsApi.getQQUserPlaylists(this.data.userId, { page, pageSize })
        : jusicWsApi.getUserPlaylists(this.data.userId, { page, pageSize })
      this._playlistRequest = request
      request.then(result => {
        if (requestId !== this._playlistRequestId) return
        const list = result && Array.isArray(result.list) ? result.list : []
        const playlistList = page === 1 ? list : this.data.playlistList.concat(list)
        this.setData({
          playlistList,
          'user.playlistCount': result && Number(result.total) || playlistList.length,
          hasLoaded: true,
          hasMore: Boolean(result && result.hasMore)
        })
      }).catch(error => {
        if (requestId !== this._playlistRequestId || (error && error.code === 'JUSIC_REQUEST_CANCELLED')) return
        this.setData({ hasLoaded: true })
        wx.showToast({ title: error.message || '歌单加载失败，请重试', icon: 'none' })
      }).then(() => {
        if (requestId === this._playlistRequestId) {
          this._playlistRequest = null
          this.setData({ isLoading: false })
          wx.hideLoading()
        }
      })
    },

    onReachBottom() {
      if (!this.data.isLoading && this.data.hasMore) {
        this.setData({ page: this.data.page + 1 })
        this.getUserPlaylists()
      }
    },

    onUnload() {
      if (this._playlistRequest && typeof this._playlistRequest.cancel === 'function') {
        this._playlistRequest.cancel()
      }
      this._playlistRequest = null
      this._playlistRequestId = (this._playlistRequestId || 0) + 1
      wx.hideLoading()
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

    onPlaylistPicError(e) {
      this.setData({
        [`playlistList[${e.currentTarget.dataset.index}].cover`]: '/res/image/nohead.jpg'
      })
    },

    onUserAvatarError() {
      this.setData({
        'user.avatar': '/res/image/nohead.jpg'
      })
    }
  }
})