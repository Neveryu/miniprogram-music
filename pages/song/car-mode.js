// pages/song/car-mode.js
const app = getApp()
const { checkPageToken } = require('../../utils/pageGuard.js')
Component({
  /**
   * 组件的属性列表
   */
  properties: {},
  /**
   * 组件的初始数据
   */
  data: {
    bbbug: false,
    top: '80rpx',
    songInfo: null,
    lrcString: '',
    lrcList: [],
    lrcIndex: -1,
    lrcTranslate: 0,
    dragOffset: 0,
    swiping: false,
    passReady: false,
    passTriggered: false,
    carLeaving: false,
    carEntering: false,
    favBurst: false,
    picError: false,
    eventChannel: null,
    dateText: '',
    timeText: '',
    weekText: ''
  },

  /**
   * 组件的方法列表
   */
  methods: {
    onLoad(options) {
      // 驾驶模式依赖首页通过 EventChannel 下发数据，直接打开/恢复旧页面只会白屏
      if (!checkPageToken(options)) {
        return
      }
      this.setData({ bbbug: true })
      // 歌词区域当前的实际滚动位置（不触发渲染）
      this.lrcScrollOffset = 0
      this.data.eventChannel = this.getOpenerEventChannel()
      this.data.eventChannel.on('sendSongInfo', (data) => {
        this.setData({
          songInfo: data,
          picError: false
        })
      })
      this.data.eventChannel.on('sendLrcString', (str) => {
        this.setData({
          lrcString: str
        })
      })
      // 接收完整歌词列表，重置歌词平移状态
      this.data.eventChannel.on('sendLrcList', (list) => {
        this.setData({
          lrcList: list || [],
          lrcIndex: -1,
          lrcTranslate: 0
        })
      })
      // 接收当前歌词行索引，高亮并平移居中
      this.data.eventChannel.on('sendLrcIndex', (index) => {
        if (typeof index !== 'number' || index < 0) {
          return
        }
        this.setData({
          lrcIndex: index
        })
        this.centerCurrentLine()
      })
      let systemInfo = app.systemInfo
      this.setData({
        top: `${systemInfo.statusBarHeight + systemInfo.safeArea.top}px`
      })
      this.updateClock()
      this.clockTimer = setInterval(() => this.updateClock(), 1000)
    },
    // 更新顶部时钟（年月日 + 星期 + 时分秒）
    updateClock() {
      const now = new Date()
      const p = (n) => (n < 10 ? '0' + n : '' + n)
      const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      this.setData({
        dateText: `${now.getFullYear()}年${p(now.getMonth() + 1)}月${p(now.getDate())}日`,
        timeText: `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`,
        weekText: weeks[now.getDay()]
      })
    },
    onUnload() {
      if (this.clockTimer) {
        clearInterval(this.clockTimer)
        this.clockTimer = null
      }
      if (this.carResetTimer) {
        clearTimeout(this.carResetTimer)
        this.carResetTimer = null
      }
      if (this.passToastTimer) {
        clearTimeout(this.passToastTimer)
        this.passToastTimer = null
      }
      if (this.favBurstTimer) {
        clearTimeout(this.favBurstTimer)
        this.favBurstTimer = null
      }
      // 手势返回与顶部返回都会触发卸载，统一在此通知首页清理事件通道
      if (this.data.eventChannel) {
        this.data.eventChannel.emit('destroyed')
      }
    },
    // 上滑切歌手势：页面不动，小车向前顶进（透视缩小）模拟前行
    onTouchStart(e) {
      this.touchStartX = e.touches[0].clientX
      this.touchStartY = e.touches[0].clientY
      this.setData({
        swiping: true
      })
    },
    onTouchMove(e) {
      if (typeof this.touchStartY !== 'number') {
        return
      }
      const dx = e.touches[0].clientX - this.touchStartX
      const dy = e.touches[0].clientY - this.touchStartY
      // 横向滑动或回拖视为取消，必须重置进度，避免松手仍然切歌
      if (Math.abs(dx) > 60 || dy >= -10) {
        if (this.data.passReady || this.data.dragOffset > 0) {
          this.setData({
            dragOffset: 0,
            passReady: false
          })
        }
        return
      }
      // 上滑进度 0 ~ 1，小车据此向远处推进
      const progress = Math.min(1, -dy / 90)
      const ready = progress >= 0.78
      const wasReady = this.data.passReady
      this.setData({
        dragOffset: progress,
        passReady: ready
      })
      // 首次到达阈值，震动提示
      if (ready && !wasReady) {
        wx.vibrateShort({ type: 'light' })
      }
    },
    onTouchEnd(e) {
      if (typeof this.touchStartY !== 'number') {
        return
      }
      const triggered = this.data.passReady
      this.touchStartX = null
      this.touchStartY = null
      this.setData({
        dragOffset: 0,
        swiping: false,
        passReady: false
      })
      // 驶离/驶入动画期间不再触发切歌，避免连续上滑重复请求
      if (triggered && !this.data.carLeaving && !this.data.carEntering) {
        wx.vibrateShort({ type: 'medium' })
        this.showPassToast()
        this.carDriveAway()
        this.data.eventChannel.emit('longPressPassTheSong')
      }
    },
    // 切歌成功：小车沿路面驶向建筑底部，随后从屏幕底部开进一辆新车
    carDriveAway() {
      if (this.carResetTimer) {
        clearTimeout(this.carResetTimer)
      }
      this.setData({
        carLeaving: true,
        carEntering: false
      })
      // 驶离动画 1.15s
      this.carResetTimer = setTimeout(() => {
        this.setData({
          carLeaving: false,
          carEntering: true
        })
        // 驶入动画 1s
        this.carResetTimer = setTimeout(() => {
          this.setData({
            carEntering: false
          })
          this.carResetTimer = null
        }, 1000)
      }, 1150)
    },
    // 切歌确认卡片：显示 1.2 秒后自动消失
    showPassToast() {
      if (this.passToastTimer) {
        clearTimeout(this.passToastTimer)
      }
      this.setData({
        passTriggered: true
      })
      this.passToastTimer = setTimeout(() => {
        this.setData({
          passTriggered: false
        })
        this.passToastTimer = null
      }, 1200)
    },
    // 将当前歌词行平移到视窗中间（列表整体 translateY）
    centerCurrentLine() {
      const lineHeight = app.systemInfo.windowWidth / 750 * 76
      const query = this.createSelectorQuery()
      query.select('.car-lrc-window').boundingClientRect()
      query.exec((res) => {
        const rect = res && res[0]
        if (!rect) {
          return
        }
        const offset = this.data.lrcIndex * lineHeight + lineHeight / 2 - rect.height / 2
        this.setData({
          lrcTranslate: -Math.max(0, offset)
        })
      })
    },
    // 点击封面收藏：触发爱心点亮动画 + 上报收藏
    onTapFav() {
      // 心形动画期间忽略重复点击，避免连续发起收藏请求
      if (this.favBusy) {
        return
      }
      this.favBusy = true
      if (this.favBurstTimer) {
        clearTimeout(this.favBurstTimer)
      }
      this.setData({
        favBurst: false
      })
      // 下一帧重新触发动画（允许连续点击）
      wx.nextTick(() => {
        this.setData({
          favBurst: true
        })
        this.favBurstTimer = setTimeout(() => {
          this.setData({
            favBurst: false
          })
          this.favBurstTimer = null
          this.favBusy = false
        }, 1000)
      })
      wx.vibrateShort({ type: 'light' })
      this.data.eventChannel.emit('tapToAddSong')
    },
    // 封面图加载失败时回退本地占位图
    onPicError() {
      this.setData({
        picError: true
      })
    },
    backCar() {
      wx.navigateBack({
        delta: 1
      })
    }
  }
})
