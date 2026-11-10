const cloudConfig = require('../config/cloud.js')

const config = {
  code: {
    success: 200,
    login: 401
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

// 云调用传输层轮询超时（-404012）多为瞬时网络抖动，函数在服务端往往已执行成功，只是回包未送达 SDK。
// 对这类错误静默重试一次，避免动辄弹「云服务连接失败」；重试仅限下面的白名单操作——它们要么只读、
// 要么带服务端幂等/一致性校验，可安全重发；未列入者（如 message/send 发消息、登录）一律不自动重试。
const isTransportTimeout = (error) => {
  const code = error && (error.errCode || error.code)
  const message = String((error && (error.errMsg || error.message)) || '').toLowerCase()
  return code === -404012 || message.indexOf('polling exceed') > -1
}
const SAFE_RETRY_ACTIONS = [
  'user/getmyinfo',
  'room/getRoomInfo',
  'room/getSearchPrompts',
  'room/updateSearchPrompts',
  'message/getMessageList',
  'message/back',
  'song/songList',
  'song/addMySong',
  'song/mySongList',
  'song/deleteMySong',
  'song/toggleMySongChildren',
  // song/pass 不重试：首次可能已切歌成功，重试会返回 409 并让驾驶模式误报“切歌失败”
  'song/autoPass',
  // song/ended 不重试：首页已按 3 秒间隔重试并在失败时回退补歌，避免与传输层重试叠加放大调用量
  'song/refill',
  'song/getLrc',
  'song/getCovers'
]
const invokeCloud = (data) => wx.cloud.callFunction({
  name: cloudConfig.functionName,
  config: {
    env: cloudConfig.env
  },
  data: {
    action: data.url,
    payload: data.data || {}
  }
})

// 并发请求共用全局 loading，用计数避免先完成的请求提前关闭遮罩
let loadingCount = 0
const showLoading = (title) => {
  loadingCount += 1
  wx.showLoading({
    mask: true,
    title
  })
}
const hideLoading = () => {
  loadingCount = Math.max(loadingCount - 1, 0)
  if (!loadingCount) {
    wx.hideLoading()
  }
}

const request = (data = {}) => {
  if (data.loading) {
    showLoading(data.loading)
  }

  const handleSuccess = (result) => {
    data.loading && hideLoading()
    const response = result.result || {}
    switch (response.code) {
      case config.code.success:
        if (data.success) {
          data.success(response)
        }
        break
      case config.code.login:
        // 先让页面复位自身的 loading 状态，再交给登录处理
        if (data.loginRequired) {
          data.loginRequired(response)
        }
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
                  url: '/pages/user/login'
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
  }

  const handleFailure = (error) => {
    data.loading && hideLoading()
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
  }

  invokeCloud(data).then(handleSuccess).catch((error) => {
    // 瞬时传输超时且为白名单内的幂等/可安全重发操作：保留 loading，静默重试一次
    if (isTransportTimeout(error) && SAFE_RETRY_ACTIONS.indexOf(data.url) > -1) {
      invokeCloud(data).then(handleSuccess).catch(handleFailure)
      return
    }
    handleFailure(error)
  })
}

module.exports = { request, showLoading, hideLoading }
