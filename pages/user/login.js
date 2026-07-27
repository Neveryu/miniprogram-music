const app = getApp()
Page({
  data: {
    bbbug: false,
    isLoggingIn: false
  },
  onLoad: function (options) {
    if (!options.bbbug || options.bbbug != app.globalData.systemVersion) {
      return
    }
    this.setData({
      bbbug: true
    })
    wx.hideNavigationBarLoading()
    wx.setNavigationBarTitle({
      title: '登录',
    })
  },
  wxLogin() {
    if (this.data.isLoggingIn) {
      return
    }
    this.setData({
      isLoggingIn: true
    })
    app.request({
      url: 'weapp/wxAppLogin',
      loading: '登录中',
      success: (loginRes) => {
        this.setData({
          isLoggingIn: false
        })
        app.globalData.userInfo = loginRes.data
        app.globalData.user_changed = true
        const eventChannel = this.getOpenerEventChannel()
        eventChannel.emit('loginSuccess', loginRes.data)
        wx.navigateBack()
      },
      error: () => {
        this.setData({
          isLoggingIn: false
        })
        return true
      },
      fail: () => {
        this.setData({
          isLoggingIn: false
        })
      }
    })
  }
})
