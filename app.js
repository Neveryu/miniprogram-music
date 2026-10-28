const { request } = require('./utils/request.js')
const cloudConfig = require('./config/cloud.js')
import { checkMiniprogramVersion } from './utils/core.js'
const USER_INFO_KEY = 'music_user_info'
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
  cloudFileUrlCache: {},
  loginListeners: [],
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
    this.globalData.userInfo = this.readStoredUserInfo()
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
  readStoredUserInfo() {
    try {
      const userInfo = wx.getStorageSync(USER_INFO_KEY)
      return userInfo && userInfo.user_id ? userInfo : null
    } catch (error) {
      console.error('[UserInfoCache]', error)
      return null
    }
  },
  saveUserInfo(userInfo) {
    this.globalData.userInfo = userInfo || null
    try {
      if (userInfo) {
        wx.setStorageSync(USER_INFO_KEY, userInfo)
      } else {
        wx.removeStorageSync(USER_INFO_KEY)
      }
    } catch (error) {
      console.error('[UserInfoCache]', error)
    }
  },
  // 注册登录成功回调，返回取消注册函数；登录后需要重拉数据的页面各自订阅
  onLogin(callback) {
    if (typeof callback !== 'function') {
      return () => {}
    }
    this.loginListeners.push(callback)
    return () => {
      const index = this.loginListeners.indexOf(callback)
      if (index > -1) {
        this.loginListeners.splice(index, 1)
      }
    }
  },
  notifyLogin(userInfo) {
    this.saveUserInfo(userInfo)
    this.globalData.user_changed = true
    this.loginListeners.slice().forEach((callback) => {
      try {
        callback(this.globalData.userInfo)
      } catch (error) {
        console.error('[LoginListener]', error)
      }
    })
  },
  showLogin: function () {
    wx.navigateTo({
      url: '../user/login?bbbug=' + this.globalData.systemVersion
    })
  }
})
