const app = getApp()

// 入口令牌只在本次冷启动内有效；直接打开/恢复旧页面时给出提示并退回首页，避免整页空白
const checkPageToken = (options, requireId) => {
  const passed = options
    && String(options.bbbug || '') === String(app.globalData.systemVersion)
    && (!requireId || Boolean(options.id))
  if (passed) {
    return true
  }
  wx.showToast({ title: '页面已失效，请重新进入', icon: 'none' })
  const pages = getCurrentPages()
  const topPage = pages[pages.length - 1]
  setTimeout(() => {
    // 等待期间用户可能已手动返回；仅当该页仍是栈顶时才回退，避免多退一页
    const currentPages = getCurrentPages()
    if (currentPages[currentPages.length - 1] !== topPage) {
      return
    }
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/index/index' })
    })
  }, 800)
  return false
}

// 子页统一从全局房间信息取房间号；房间尚未加载时提示并返回 null
const getRoomId = () => {
  const room = app.globalData.roomInfo
  if (room && room.room_id) {
    return room.room_id
  }
  wx.showToast({ title: '房间信息加载中，请稍后重试', icon: 'none' })
  return null
}

module.exports = { checkPageToken, getRoomId }
