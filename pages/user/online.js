const app = getApp();
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
    roomInfo: {},
    userList: []
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
        bbbug: true,
        roomInfo: app.globalData.roomInfo
      });
      this.getList()
    },
    onPullDownRefresh() {
      this.getList()
      wx.stopPullDownRefresh()
    },
    getList() {
      app.request({
        url: 'user/online',
        loading: '加载中',
        data: {
          room_id: app.globalData.roomInfo.room_id
        },
        success: (res) => {
          this.setData({
            userList: res.data
          })
        }
      })
    },
    doubleTapToTouchUser() {
      const eventChannel = this.getOpenerEventChannel()
      eventChannel.emit('doAtUser', user)
      wx.navigateBack()
    },
    showMenuMaster() {
      if (!(app.globalData.roomInfo && app.globalData.userInfo && (app.globalData.roomInfo.room_user == app.globalData.userInfo.user_id || app.globalData.userInfo.user_admin))) {
        return
      }
      wx.showToast({
        title: '单房间版本暂不提供用户管控',
        icon: 'none'
      })
    },
    showMenu(e) {
      let user = e.mark.item
      let menu = ['@Ta一下', '摸一摸Ta']
      let eventChannel = this.getOpenerEventChannel()
      wx.showActionSheet({
        itemList: menu,
        success: (res) => {
          switch (menu[res.tapIndex]) {
            case '@Ta一下':
              eventChannel.emit('doAtUser', user)
              wx.navigateBack()
              break
            case '摸一摸Ta':
              eventChannel.emit('doTouchUser', user.user_id)
              break
            default:
              wx.showToast({
                title: '即将上线'
              })
          }
        }
      })
    }
  }
})
