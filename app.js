const { request } = require('./utils/request.js')
import api from './config/api.js'
import { checkMiniprogramVersion } from './utils/core.js'
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
    roomInfo: null,
    userInfo: null,
    atUserInfo: false,
  },
  systemInfo: null,
  request,
  // 生命周期回调——监听小程序初始化。
  onLaunch() {
    // 小程序版本检查
    checkMiniprogramVersion()
    this.systemInfo = wx.getSystemInfoSync()
    // 响应token变化
    // this.watchAccessToken(this.getMyInfo)
    // 初始化token
    let access_token = wx.getStorageSync('access_token') || false
    if (!access_token) {
      access_token = this.globalData.guestUserInfo.access_token
    }
    wx.setStorageSync('access_token', access_token)
  },
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
  // 如果你是登陆用户(user_id>0)，且没有完善资料，那么就引导完善一下资料
  alertChangeInfo() {
    let infoChanged = wx.getStorageSync('userInfoChanged') || false
    if (!infoChanged && this.globalData.userInfo.user_id > 0) {
      console.log('app: 如果你是登陆用户(user_id>0)，且没有完善资料，那么就引导完善一下资料')
      wx.showModal({
        confirmText: '完善资料',
        cancelText: '不再提示',
        title: '修改资料',
        content: '快去完善资料展示自己的个性主页吧',
        success: function (res) {
          wx.setStorageSync('userInfoChanged', new Date().valueOf())
          if (res.confirm) {
            wx.navigateTo({
              url: '../user/motify'
            })
          }
        }
      })
    }
  },
  showLogin: function () {
    wx.navigateTo({
      // url: '../user/login?bbbug=' + this.globalData.systemVersion,
      url: '../user/login'
    })
  }
})