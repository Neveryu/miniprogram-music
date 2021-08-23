const { request } = require('./utils/request.js')
App({
  globalData: {
    systemVersion: 0,
    access_token_changed: false,
    guestUserInfo: {
      myRoom: false,
      user_admin: false,
      user_head: 'https://bbbug.hamm.cn/new/images/nohead.jpg',
      user_id: -1,
      user_name: 'Ghost',
      access_token: '45af3cfe44942c956e026d5fd58f0feffbd3a237',
    },
    roomInfo: false,
    userInfo: false,
    atUserInfo: false,
  },
  request,
  // 监听token变化
  watchAccessToken(callback) {
    let obj = this.globalData
    Object.defineProperty(obj, 'access_token_changed', {
      set: function (value) {
        if (value && callback) {
          callback()
        }
      }
    })
  },
  showLogin: function () {
    wx.navigateTo({
      // url: '../user/login?bbbug=' + this.globalData.systemVersion,
      url: '../user/login'
    })
  }
})