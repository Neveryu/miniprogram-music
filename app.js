const { request } = require('./utils/request.js')
const cloudConfig = require('./config/cloud.js')
import { checkMiniprogramVersion } from './utils/core.js'
App({
  globalData: {
    systemVersion: 0,
    user_changed: false,
    cloudReady: false,
    roomInfo: null,
    userInfo: null,
    atUserInfo: false,
  },
  systemInfo: null,
  request,
  onLaunch() {
    checkMiniprogramVersion()
    this.systemInfo = wx.getSystemInfoSync()
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '当前版本不支持云开发，请升级小程序基础库。',
        showCancel: false
      })
      return
    }
    wx.cloud.init({
      env: cloudConfig.env,
      traceUser: true
    })
    this.globalData.cloudReady = true
  },
  watchUser(callback) {
    let obj = this.globalData
    Object.defineProperty(obj, 'user_changed', {
      set: function (value) {
        if (value && callback) {
          callback()
        }
      }
    })
  },
  alertChangeInfo() {
    let infoChanged = wx.getStorageSync('userInfoChanged') || false
    if (!infoChanged && this.globalData.userInfo && !this.globalData.userInfo.profile_completed) {
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
      url: '../user/login?bbbug=' + this.globalData.systemVersion
    })
  }
})
