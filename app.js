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
  cloudFileUrlCache: {},
  request,
  resolveCloudFileUrls(fileIds) {
    const sources = [...new Set((fileIds || []).filter((fileId) => /^cloud:\/\//i.test(fileId)))]
    const pending = sources.filter((fileId) => !this.cloudFileUrlCache[fileId])
    if (!pending.length) {
      return Promise.resolve(this.cloudFileUrlCache)
    }
    const batches = []
    for (let index = 0; index < pending.length; index += 50) {
      batches.push(pending.slice(index, index + 50))
    }
    return Promise.all(batches.map((fileList) => wx.cloud.getTempFileURL({ fileList }))).then((results) => {
      results.forEach((result) => {
        const files = result.fileList || []
        files.forEach((file) => {
          if (file.status === 0 && file.tempFileURL) {
            this.cloudFileUrlCache[file.fileID] = file.tempFileURL
          }
        })
      })
      return this.cloudFileUrlCache
    })
  },
  resolveCloudFileUrl(fileId) {
    if (!/^cloud:\/\//i.test(fileId || '')) {
      return Promise.resolve(fileId || '')
    }
    return this.resolveCloudFileUrls([fileId]).then((urls) => urls[fileId] || '')
  },
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
