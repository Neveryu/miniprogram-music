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
  avatarPromptVisible: false,
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
    if (this.globalData.userInfo && !this.globalData.userInfo.user_head && !this.avatarPromptVisible) {
      this.avatarPromptVisible = true
      wx.showModal({
        confirmText: '设置头像',
        title: '需要微信头像',
        content: '请授权选择微信头像后继续使用。',
        showCancel: false,
        complete: () => {
          this.avatarPromptVisible = false
          wx.navigateTo({
            url: '/pages/user/motify'
          })
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
