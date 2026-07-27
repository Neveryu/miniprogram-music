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
    chooseImage() {
      let menu = ['查看大图', '上传头像']
      wx.showActionSheet({
        itemList: menu,
        success: (res) => {
          switch (menu[res.tapIndex]) {
            case '查看大图':
              if (this.data.userInfo) {
                wx.previewImage({
                  current: this.data.userInfo.user_head,
                  urls: [this.data.userInfo.user_head]
                })
              }
              break
            case '上传头像':
              wx.chooseImage({
                count: 1,
                sizeType: 'compressed',
                // sourceType: 'album',
                success: (res) => {
                  wx.showLoading({
                    title: '上传中'
                  })
                  const cloudPath = `avatars/${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`
                  wx.cloud.uploadFile({
                    cloudPath,
                    filePath: res.tempFilePaths[0]
                  }).then((uploadResult) => {
                    wx.hideLoading()
                    this.setData({
                      user_head: uploadResult.fileID
                    })
                  }).catch((error) => {
                    wx.hideLoading()
                    console.error('[UploadAvatar]', error)
                    wx.showToast({
                      title: '头像上传失败',
                      icon: 'none'
                    })
                  })
                },
              })
              break
            default:
          }
        }
      })
    },
    logout() {
      wx.showToast({
        title: '云开发身份由微信管理',
        icon: 'none'
      })
    },
    doSubmit(e) {
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
    syncWechatUserInfo(e) {
      let wechatUserData = JSON.parse(e.detail.rawData)
      let userInfo = this.data.userInfo
      userInfo.user_head = wechatUserData.avatarUrl
      userInfo.user_sex = (wechatUserData.gender == 1 ? 1 : 0)
      userInfo.user_name = (wechatUserData.nickName)
      this.setData({
        userInfo: userInfo,
        user_head: wechatUserData.avatarUrl,
        user_sex: (wechatUserData.gender == 1 ? 1 : 0)
      })
      wx.showToast({
        title: '同步成功',
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
