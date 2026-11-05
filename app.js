const { request } = require('./utils/request.js')
const cloudConfig = require('./config/cloud.js')
import { checkMiniprogramVersion } from './utils/core.js'
const USER_INFO_KEY = 'music_user_info'
// 云存储临时地址有效期通常为 2 小时，本地缓存 1 小时后主动刷新
const CLOUD_FILE_URL_TTL = 60 * 60 * 1000
App({
  globalData: {
    // 入口校验令牌：每次冷启动生成一次性随机值，站内导航通过 ?bbbug= 携带、
    // 各子页面 onLoad 校验，防止页面被外部分享/扫码直接打开而无上下文进入。
    systemVersion: String(Date.now()),
    roomInfo: null,
    userInfo: null,
  },
  systemInfo: null,
  cloudFileUrlCache: {},
  cloudFileUrlExpireAt: {},
  loginListeners: [],
  request,
  resolveCloudFileUrls(fileIds) {
    const sources = [...new Set((fileIds || []).filter((fileId) => /^cloud:\/\//i.test(fileId)))]
    const now = Date.now()
    Object.keys(this.cloudFileUrlExpireAt).forEach((fileId) => {
      if (now < this.cloudFileUrlExpireAt[fileId]) {
        return
      }
      delete this.cloudFileUrlCache[fileId]
      delete this.cloudFileUrlExpireAt[fileId]
    })
    const pending = sources.filter((fileId) => !this.cloudFileUrlCache[fileId])
    if (!pending.length) {
      return Promise.resolve(this.cloudFileUrlCache)
    }
    const batches = []
    for (let index = 0; index < pending.length; index += 50) {
      batches.push(pending.slice(index, index + 50))
    }
    return Promise.all(batches.map((fileList) => wx.cloud.getTempFileURL({ fileList }))).then((results) => {
      const updatedAt = Date.now()
      results.forEach((result) => {
        const files = result.fileList || []
        files.forEach((file) => {
          if (file.status === 0 && file.tempFileURL) {
            this.cloudFileUrlCache[file.fileID] = file.tempFileURL
            this.cloudFileUrlExpireAt[file.fileID] = updatedAt + CLOUD_FILE_URL_TTL
          }
        })
      })
      return this.cloudFileUrlCache
    })
  },
  onLaunch() {
    checkMiniprogramVersion()
    this.globalData.userInfo = this.readStoredUserInfo()
    this.systemInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
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
    this.loginListeners.slice().forEach((callback) => {
      try {
        callback(this.globalData.userInfo)
      } catch (error) {
        console.error('[LoginListener]', error)
      }
    })
  }
})
