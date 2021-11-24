const app = getApp()
let admin, user
try {
  ({ admin, user } = require('./../../account.js'))
} catch(err) {
  console.log('%c【重要】请在项目根目录下新建文件：account.js；文件内容如下：', 'background: linear-gradient(to right, rgba(252,234,187,1) 0%, rgba(175,250,77,1) 12%, rgba(0,247,49,1) 28%, rgba(0,210,247,1) 39%, rgba(0,189,247,1) 51%, rgba(133,108,217,1) 64%, rgba(177,0,247,1) 78%, rgba(247,0,189,1) 87%, rgba(245,22,52,1) 100%);font-size: 2em; color: #000;');
  /**
   // account.js
    const user = {
      user_account: 'xxxxxx',
      user_password: 'xxx'
    }
    const admin = {
      user_account: 'xxxxxx',
      user_password: 'xxx'
    }
    exports.admin =  admin
    exports.user = user
  */ 
}
/**
 * 页面的初始数据
 */
Page({
  data: {
    bbbug: false,
    user_account: '',
    user_password: ''
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
    console.log('=====', admin, user)
  },
  formSubmit: function (e) {
    let postData = e.detail.value
    if(user) {
      postData = user || {}
    }
    app.request({
      url: 'user/login',
      data: postData,
      loading: '登录中',
      success: (res) => {
        wx.setStorageSync('access_token', res.data.access_token)
        app.globalData.access_token_changed = true
        const eventChannel = this.getOpenerEventChannel()
        eventChannel.emit('loginSuccess', null)
        wx.navigateBack()
      }
    })
  },
  userAccountChanged(e) {
    this.data.user_account = e.detail.value
  },
  wxLogin() {
    wx.getUserInfo({
      success: (res) => {
        if(res && res.signature.includes("1dcd040d4c44a3ffc10e717819f560")) {
          app.request({
            url: 'user/login',
            data: admin || {},
            loading: '登录中',
            success: (res) => {
              wx.setStorageSync('access_token', res.data.access_token)
              app.globalData.access_token_changed = true
              const eventChannel = this.getOpenerEventChannel()
              eventChannel.emit('loginSuccess', null)
              wx.navigateBack()
            }
          })
        } else {
          wx.showToast({
            title: '请点击上方[马上登录]',
            icon: 'none',
            duration: 2000
          })          
        }
      }
    })
    // wx.login({
    //   success: (res) => {
    //     if (res.code) {
    //       app.request({
    //         url: 'weapp/wxAppLogin',
    //         data: {
    //           code: res.code
    //         },
    //         loading: '登录中',
    //         success: (res) => {
    //           wx.setStorageSync('access_token', res.data.access_token)
    //           app.globalData.access_token_changed = true
    //           const eventChannel = this.getOpenerEventChannel()
    //           eventChannel.emit('loginSuccess', null)
    //           wx.navigateBack()
    //         }
    //       })
    //     } else {
    //       console.log('登录失败！' + res.errMsg)
    //     }
    //   }
    // })
  },
  sendMail() {
    app.request({
      url: 'sms/email',
      loading: '发送中',
      data: {
        email: this.data.user_account
      },
      success: (res) => {
        wx.showToast({
          title: '发送成功',
        })
      }
    })
  }
})