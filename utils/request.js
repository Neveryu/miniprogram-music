// 网络请求相关参数
let config = {
  apiUrl: 'https://api.bbbug.com/api/',
  cdnUrl: 'https://bbbug.hamm.cn/',
  baseData: {
    access_token: '',
    plat: 'weapp',
    version: 10000
  },
  code: {
    success: 200,
    access_token_missing: 400,
    login: 401,
    updateForce: 301,
    update: 302,
    hide: 503,
    error: 500
  }
}

// 高度封装了一个request方法 参数随便传 报错算我输
const request = (_data = {}) => {
  if (_data.type) {
    switch (_data.type.toLowerCase()) {
      case 'json':
        _data.type = 'application/json'
        break
      case 'form':
        _data.type = 'application/x-www-form-urlencoded'
        break
      default:
    }
  }
  // 默认使用json，除非按上面的switch传入指定的content-type
  _data.type = _data.type || 'application/json'
  // 预处理是绝对地址还是相对地址，后者需拼接请求基础参数的API根地址
  if (_data.url.indexOf('https://') < 0 && _data.url.indexOf('http://') < 0) {
    _data.url = config.apiUrl + (_data.url || '')
  }
  //读取本地缓存的access_token
  let access_token = wx.getStorageSync('access_token')
  //设置access_token到基础请求参数
  config.baseData.access_token = access_token || ''
  //是否显示Loading 默认不显示Loading
  if (_data.loading) {
    wx.showLoading({
      mask: true,
      title: _data.loading
    })
  }
  wx.request({
    url: _data.url,
    // 默认使用POST请求，除非指定method
    method: _data.method || 'POST',
    // 默认使用application/json基础header，除非完全自定义header
    header: _data.header || {
      'content-type': _data.type
    },
    // 将基础请求参数和本次请求参数合并
    data: {
      ...config.baseData,
      ...(_data.data || {})
    },
    // 固定返回数据格式 默认json 除非指定其他
    dataType: _data.dataType || 'json',
    success(res) {
      // 是否有loading需要关闭
      _data.loading && wx.hideLoading()
      try {
        switch (res.data.code) {
          case config.code.success:
            // 操作成功
            if (_data.success) {
              _data.success(res.data)
            } else {
              wx.showModal({
                title: '操作成功',
                content: res.data.msg,
                showCancel: false
              })
            }
            break
          case config.code.access_token_missing:
            break
          case config.code.login:
            // 需要登录
            if (_data.login) {
              _data.login(res.data)
            } else {
              wx.showModal({
                title: '身份验证失败',
                content: res.data.msg,
                showCancel: false,
                success: function () {
                  that.showLogin()
                }
              })
            }
            break
          case config.code.hide:
            wx.reLaunch({
              url: '../index/index',
            })
            break
          default:
            // 解析其他状态码
            if (_data.error) {
              let dontAlert = _data.error(res.data)
              if (!dontAlert) {
                wx.showModal({
                  title: '操作失败(' + res.data.code + ')',
                  content: res.data.msg,
                  showCancel: false
                })
              }
            } else {
              wx.showModal({
                title: '操作失败(' + res.data.code + ')',
                content: res.data.msg,
                showCancel: false
              })
            }
        }
      } catch (e) {
        // 解析可能发生的异常
        if (_data.fail) {
          _data.fail(e)
          wx.showModal({
            title: '数据错误',
            content: '解析服务器数据失败，请稍候再试！',
            showCancel: false
          })
        } else {
          wx.showModal({
            title: '数据错误',
            content: '解析服务器数据失败，请稍候再试！',
            showCancel: false
          })
        }
      }
    },
    fail(res) {
      // 是否有loading需要关闭
      _data.loading && wx.hideLoading()
      // 解析可能发生的异常
      if (_data.fail) {
        _data.fail(res)
      } else {
        wx.showModal({
          title: '连接失败',
          content: '网络连接失败，请稍候再试！',
          showCancel: false
        })
      }
    }
  })
}

exports.request = request
