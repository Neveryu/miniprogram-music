const app = getApp()
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
    room_id: 0
  },

  /**
   * 组件的方法列表
   */
  methods: {
    onLoad(options) {
      if (!options.bbbug || options.bbbug != app.globalData.systemVersion) {
        return
      }
      this.setData({
        bbbug: true
      });
      wx.setNavigationBarTitle({
        title: '待播放列表'
      })
      this.getSongList()
    },
    onPullDownRefresh() {
      this.getSongList()
      wx.stopPullDownRefresh()
    },
    getSongList() {
      app.request({
        url: 'song/songList',
        loading: '加载中',
        data: {
          room_id: app.globalData.roomInfo.room_id
        },
        success: (res) => {
          this.setData({
            songList: res.data
          })
        }
      })
    },
    showMenu(e) {
      let song = e.mark.item
      let menu = ['顶歌', '收藏']
      if (app.globalData.roomInfo && app.globalData.userInfo && (app.globalData.roomInfo.room_user == app.globalData.userInfo.user_id || app.globalData.userInfo.user_admin || app.globalData.userInfo.user_id == song.user.user_id)) {
        menu = ['顶歌', '收藏', '移除']
      }
      wx.showActionSheet({
        itemList: menu,
        success: (res) => {
          switch (menu[res.tapIndex]) {
            case '顶歌':
              app.request({
                url: 'song/push',
                loading: '置顶中',
                data: {
                  mid: song.song.mid,
                  room_id: app.globalData.roomInfo.room_id
                },
                success: (res) => {
                  this.getSongList()
                  if (app.globalData.roomInfo && app.globalData.userInfo && (app.globalData.roomInfo.room_user == app.globalData.userInfo.user_id || app.globalData.userInfo.user_admin)) {
                    wx.showToast({
                      title: '置顶成功'
                    })
                  } else {
                    wx.showModal({
                      title: '置顶成功',
                      content: res.msg,
                      showCancel: false,
                    })
                  }
                }
              })
              break
            case '移除':
              app.request({
                url: 'song/remove',
                loading: '移除中',
                data: {
                  mid: song.song.mid,
                  room_id: app.globalData.roomInfo.room_id
                },
                success: (res) => {
                  this.getSongList()
                  wx.showToast({
                    title: '移除成功'
                  })
                }
              })
              break
            case '收藏':
              app.request({
                url: 'song/addMySong',
                data: {
                  room_id: app.globalData.roomInfo.room_id,
                  mid: song.song.mid,
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
              app.request({
                url: 'song/playSong',
                data: {
                  room_id: app.globalData.roomInfo.room_id,
                  mid: song.song.mid,
                },
                loading: '播放中',
                success: (res) => {
                  this.getSongList()
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
