const app = getApp()
Page({
  data: {
    isLoggingIn: false,
    agreementChecked: false,
    serviceRead: false,
    privacyRead: false,
    consentShake: false
  },
  onLoad: function () {
    wx.hideNavigationBarLoading()
    wx.setNavigationBarTitle({
      title: '登录',
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
  loginWithAvatar(userHead) {
    app.request({
      url: 'weapp/wxAppLogin',
      data: {
        user_head: userHead
      },
      success: (loginRes) => {
        wx.hideLoading()
        this.setData({
          isLoggingIn: false
        })
        app.globalData.userInfo = loginRes.data
        app.globalData.user_changed = true
        const eventChannel = this.getOpenerEventChannel()
        eventChannel.emit('loginSuccess', loginRes.data)
        wx.navigateBack()
      },
      error: (res) => {
        wx.hideLoading()
        this.setData({
          isLoggingIn: false
        })
        wx.showToast({ title: res.msg || '登录失败', icon: 'none' })
        return true
      },
      fail: () => {
        wx.hideLoading()
        this.setData({
          isLoggingIn: false
        })
      }
    })
  }
})
