const app = getApp()
// 与 pages/user/agreement.js 中展示的协议版本保持一致
const AGREEMENT_VERSION = 'V1.2'
Page({
  data: {
    isLoggingIn: false,
    agreementChecked: false,
    serviceRead: false,
    privacyRead: false,
    consentShake: false,
    // 微信平台侧是否已完成隐私授权；基础库不支持时按已授权处理
    privacyReady: true,
    privacyContractName: '《小程序用户隐私保护指引》'
  },
  onLoad: function () {
    wx.hideNavigationBarLoading()
    wx.setNavigationBarTitle({
      title: '登录',
    })
    this.loadPrivacySetting()
  },
  // 查询微信侧隐私授权状态，未授权时登录按钮改为原生同意按钮
  loadPrivacySetting() {
    if (typeof wx.getPrivacySetting !== 'function') {
      return
    }
    wx.getPrivacySetting({
      success: (res) => {
        this.setData({
          privacyReady: !res.needAuthorization,
          privacyContractName: res.privacyContractName || '《小程序用户隐私保护指引》'
        })
      },
      fail: () => {}
    })
  },
  handleAgreePrivacy() {
    this.setData({ privacyReady: true })
  },
  openPrivacyContract() {
    if (typeof wx.openPrivacyContract !== 'function') {
      wx.showToast({ title: '当前微信版本不支持查看', icon: 'none' })
      return
    }
    wx.openPrivacyContract({
      fail: () => {
        wx.showToast({ title: '打开失败，请稍后重试', icon: 'none' })
      }
    })
  },
  shakeConsent() {
    if (this.data.consentShake) {
      return
    }
    this.setData({ consentShake: true })
    setTimeout(() => {
      this.setData({ consentShake: false })
    }, 900)
  },
  onDisabledLoginTap() {
    if (!this.data.agreementChecked) {
      this.shakeConsent()
      wx.vibrateShort({ type: 'light' })
    }
  },
  toggleAgreement() {
    this.setData({
      agreementChecked: !this.data.agreementChecked
    })
  },
  readAgreement(e) {
    const type = e.currentTarget.dataset.type
    wx.navigateTo({
      url: '/pages/user/agreement?type=' + (type === 'service' ? 'service' : 'privacy')
    })
  },
  chooseWechatAvatar(e) {
    if (this.data.isLoggingIn || !this.data.agreementChecked) {
      return
    }
    const avatarUrl = e.detail.avatarUrl
    if (!avatarUrl) {
      wx.showToast({ title: '请选择微信头像后继续', icon: 'none' })
      return
    }
    this.setData({ isLoggingIn: true })
    wx.showLoading({ title: '登录中', mask: true })
    const extension = avatarUrl.match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
    const cloudPath = `avatars/${Date.now()}-${Math.random().toString(16).slice(2)}.${extension ? extension[1] : 'jpg'}`
    wx.cloud.uploadFile({ cloudPath, filePath: avatarUrl }).then((result) => {
      this.loginWithAvatar(result.fileID)
    }).catch((error) => {
      wx.hideLoading()
      this.setData({ isLoggingIn: false })
      console.error('[LoginAvatar]', error)
      wx.showToast({ title: '头像上传失败', icon: 'none' })
    })
  },
  deleteCloudFiles(fileList) {
    const files = (fileList || []).filter((file) => /^cloud:\/\//i.test(file))
    if (!files.length) {
      return
    }
    wx.cloud.deleteFile({ fileList: files }).catch((error) => {
      console.error('[DeleteAvatar]', error)
    })
  },
  loginWithAvatar(userHead) {
    app.request({
      url: 'weapp/wxAppLogin',
      data: {
        user_head: userHead,
        agreement_version: AGREEMENT_VERSION
      },
      success: (loginRes) => {
        wx.hideLoading()
        this.setData({
          isLoggingIn: false
        })
        app.notifyLogin(loginRes.data)
        const eventChannel = this.getOpenerEventChannel()
        if (eventChannel && typeof eventChannel.emit === 'function') {
          eventChannel.emit('loginSuccess', loginRes.data)
        }
        wx.navigateBack()
      },
      error: (res) => {
        wx.hideLoading()
        this.setData({
          isLoggingIn: false
        })
        // 仅在校验失败（未创建用户）时清理刚上传的头像；
        // 网络或服务端异常可能已经建号，保留文件避免头像失效
        if (res.code === 422) {
          this.deleteCloudFiles([userHead])
        }
        wx.showToast({ title: res.msg || '登录失败', icon: 'none' })
        return true
      },
      fail: (error) => {
        wx.hideLoading()
        this.setData({
          isLoggingIn: false
        })
        wx.showToast({ title: error.message || '登录失败', icon: 'none' })
      }
    })
  }
})
