const cloudConfig = require('../config/cloud.js')

let config = {
  apiUrl: '',
  cdnUrl: '',
  baseData: {},
  code: {
    success: 200,
    login: 401,
    updateForce: 301,
    update: 302,
    hide: 503,
    error: 500
  }
}

const getCloudErrorContent = (error) => {
  const errCode = error.errCode || error.code || 'UNKNOWN'
  const errMsg = error.errMsg || error.message || '未知错误'
  const normalized = `${errCode} ${errMsg}`.toLowerCase()
  let reason = '云服务调用失败，请查看云函数日志。'
  if (normalized.indexOf('function not found') > -1 || normalized.indexOf('-501000') > -1) {
    reason = `${cloudConfig.functionName} 云函数尚未部署到目标环境。`
  } else if (normalized.indexOf('-504003') > -1 || normalized.indexOf('functions_time_limit_exceeded') > -1) {
    reason = `${cloudConfig.functionName} 云函数执行超时，请确认已部署最新代码和超时配置。`
  } else if (normalized.indexOf('env') > -1 && normalized.indexOf('not found') > -1) {
    reason = '云环境不存在或环境 ID 配置错误。'
  } else if (normalized.indexOf('permission') > -1 || normalized.indexOf('unauthorized') > -1) {
    reason = '当前 AppID 没有该云环境或云函数的访问权限。'
  }
  return `${reason}\n环境：${cloudConfig.env}\n函数：${cloudConfig.functionName}\n错误：${errCode}\n${errMsg}`
}

const request = (data = {}) => {
  if (data.loading) {
    wx.showLoading({
      mask: true,
      title: data.loading
    })
  }

  wx.cloud.callFunction({
    name: cloudConfig.functionName,
    config: {
      env: cloudConfig.env
    },
    data: {
      action: data.url,
      payload: data.data || {}
    }
  }).then((result) => {
    data.loading && wx.hideLoading()
    const response = result.result || {}
    switch (response.code) {
      case config.code.success:
        if (data.success) {
          data.success(response)
        }
        break
      case config.code.login:
        if (data.login) {
          data.login(response)
        } else {
          wx.showModal({
            title: '身份验证失败',
            content: response.msg || '请先登录',
            confirmText: '去登录',
            cancelText: '留在当前页',
            showCancel: true,
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.navigateTo({
                  url: '/pages/user/login?bbbug=' + getApp().globalData.systemVersion
                })
              }
            }
          })
        }
        break
      default:
        if (data.error) {
          const dontAlert = data.error(response)
          if (dontAlert) {
            return
          }
        }
        wx.showModal({
          title: '操作失败',
          content: response.msg || '云服务调用失败',
          showCancel: false
        })
    }
  }).catch((error) => {
    data.loading && wx.hideLoading()
    console.error('[CloudRequest]', data.url, error)
    if (data.fail) {
      data.fail(error)
      return
    }
    wx.showModal({
      title: '云服务连接失败',
      content: getCloudErrorContent(error),
      showCancel: false
    })
  })
}

export { config }
exports.request = request
