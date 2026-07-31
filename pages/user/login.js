const app = getApp()
Page({
  data: {
    bbbug: false,
    isLoggingIn: false,
    userHead: '',
    userSex: -1,
    sexList: ['女生', '男生']
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
  chooseWechatAvatar(e) {
    const avatarUrl = e.detail.avatarUrl
    if (!avatarUrl) {
      return
    }
    wx.showLoading({ title: '上传头像', mask: true })
    const extension = avatarUrl.match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
    const cloudPath = `avatars/${Date.now()}-${Math.random().toString(16).slice(2)}.${extension ? extension[1] : 'jpg'}`
    wx.cloud.uploadFile({ cloudPath, filePath: avatarUrl }).then((result) => {
      wx.hideLoading()
      this.setData({ userHead: result.fileID })
    }).catch((error) => {
      wx.hideLoading()
      console.error('[LoginAvatar]', error)
      wx.showToast({ title: '头像上传失败', icon: 'none' })
    })
  },
  changeSex() {
    wx.showActionSheet({
      itemList: this.data.sexList,
      success: (res) => this.setData({ userSex: res.tapIndex })
    })
  },
  wxLogin(e) {
    if (this.data.isLoggingIn) {
      return
    }
    if (!this.data.userHead) {
      wx.showToast({ title: '请先选择微信头像', icon: 'none' })
      return
    }
    const form = e.detail.value
    if (!String(form.user_name || '').trim()) {
      wx.showToast({ title: '请选择或输入昵称', icon: 'none' })
      return
    }
    if (this.data.userSex < 0) {
      wx.showToast({ title: '请选择性别', icon: 'none' })
      return
    }
    this.setData({
      isLoggingIn: true
    })
    app.request({
      url: 'weapp/wxAppLogin',
      data: {
        user_head: this.data.userHead,
        user_name: form.user_name,
        user_sex: this.data.userSex,
        user_remark: form.user_remark
      },
      loading: '登录中',
      success: (loginRes) => {
        this.setData({
          isLoggingIn: false
        })
        wx.setStorageSync('musicAppLoggedIn', true)
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
