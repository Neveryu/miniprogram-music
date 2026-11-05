/**
 * 检查小程序版本
 */
export function checkMiniprogramVersion() {
  // 全局唯一的版本更新管理器
  const updateManager = wx.getUpdateManager()
  updateManager.onUpdateReady(() => {
    wx.showModal({
      title: '更新提示',
      content: '新版本已经准备好，是否重启应用？',
      success: function (res) {
        if (res.confirm) {
          // 新的版本已经下载好，调用 applyUpdate 应用新版本并重启
          updateManager.applyUpdate()
        }
      }
    })
  })
  updateManager.onUpdateFailed(function () {
    // 新版本下载失败：轻提示，避免用户长期停留在旧版本而不自知
    wx.showToast({
      title: '新版本下载失败，请稍后重试',
      icon: 'none',
      duration: 2000
    })
  })
}
