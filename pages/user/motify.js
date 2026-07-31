const app = getApp()
Component({
  /**
   * 组件的属性列表
   */
  properties: {},
  /**
   * 组件的初始数据
   */
  data: {
    userInfo: false,
    user_head: '',
    user_sex: 0,
    sexList: [{
      id: 0,
      name: '女生'
    }, {
      id: 1,
      name: '男生'
    }]
  },
  /**
   * 组件的方法列表
   */
  methods: {
    onShow() {
      this.getMyInfo()
    },
    changeSex() {
      wx.showActionSheet({
        itemList: ['女生', '男生'],
        success: (res) => {
          this.setData({
            user_sex: res.tapIndex
          })
        }
      })
    },
    chooseWechatAvatar(e) {
      const avatarUrl = e.detail.avatarUrl
      if (!avatarUrl) {
        return
      }
      wx.showLoading({
        title: '上传中',
        mask: true
      })
      const extension = avatarUrl.match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
      const cloudPath = `avatars/${Date.now()}-${Math.random().toString(16).slice(2)}.${extension ? extension[1] : 'jpg'}`
      wx.cloud.uploadFile({
        cloudPath,
        filePath: avatarUrl
      }).then((uploadResult) => {
        wx.hideLoading()
        this.setData({
          user_head: uploadResult.fileID
        })
      }).catch((error) => {
        wx.hideLoading()
        console.error('[UploadAvatar]', error)
        wx.showToast({
          title: '微信头像上传失败',
          icon: 'none'
        })
      })
    },
    logout() {
      wx.showModal({
        title: '退出登录',
        content: '退出后需要重新填写资料完成微信登录。',
        success: (res) => {
          if (!res.confirm) {
            return
          }
          wx.removeStorageSync('musicAppLoggedIn')
          app.globalData.userInfo = null
          const eventChannel = this.getOpenerEventChannel()
          eventChannel.emit('logoutSuccess')
          wx.reLaunch({ url: '/pages/index/index' })
        }
      })
    },
    doSubmit(e) {
      if (!this.data.user_head) {
        wx.showModal({
          title: '请设置头像',
          content: '请点击头像并授权选择微信头像。',
          showCancel: false
        })
        return
      }
      let userInfo = e.detail.value
      userInfo.user_head = this.data.user_head
      userInfo.user_sex = this.data.user_sex
      app.request({
        url: 'user/updateMyInfo',
        data: userInfo,
        success: (res) => {
          const eventChannel = this.getOpenerEventChannel()
          eventChannel.emit('myInfoChanged')
          wx.navigateBack()
        }
      })
    },
    getMyInfo() {
      app.request({
        url: 'user/getmyinfo',
        success: (res) => {
          res.data.user_name = decodeURIComponent(res.data.user_name)
          this.setData({
            userInfo: res.data,
            user_sex: res.data.user_sex,
            user_head: res.data.user_head
          })
        }
      })
    }
  }
})
