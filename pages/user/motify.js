const app = getApp()
import { config as reqConfig } from '../../utils/request.js'
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
                  wx.uploadFile({
                    url: app.globalData.request.apiUrl + 'attach/uploadHead',
                    filePath: res.tempFilePaths[0],
                    name: 'file',
                    formData: Object.assign({}, reqConfig.baseData),
                    success: (res) => {
                      wx.hideLoading()
                      res.data = JSON.parse(res.data)
                      if (res.data.code == 200) {
                        this.setData({
                          user_head: app.globalData.request.cdnUrl + '/uploads/' + res.data.data.attach_path
                        })
                      } else {
                        wx.showModal({
                          title: '上传失败(' + res.data.code + ')',
                          content: res.data.msg,
                          showCancel: false
                        })
                      }
                    },
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
      wx.showModal({
        title: '退出登录',
        content: '确认退出当前登录的帐号吗？',
        confirmText: '退出',
        confirmColor: '#f00',
        success: (res) => {
          if (res.confirm) {
            app.globalData.userInfo = app.globalData.guestUserInfo
            reqConfig.access_token = app.globalData.guestUserInfo.access_token
            wx.setStorageSync('access_token', app.globalData.guestUserInfo.access_token)
            wx.reLaunch({
              url: '../index/index'
            })
          }
        }
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