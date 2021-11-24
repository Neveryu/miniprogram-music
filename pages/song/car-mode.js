// pages/song/car-mode.js
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
    top: '80rpx',
    songInfo: null,
    lrcString: '',
    eventChannel: null
  },

  /**
   * 组件的方法列表
   */
  methods: {
    onLoad() {
      this.data.eventChannel = this.getOpenerEventChannel()
      this.data.eventChannel.on('sendSongInfo', (data) => {
        this.setData({
          songInfo: data
        })
      })
      this.data.eventChannel.on('sendLrcString', (str) => {
        this.setData({
          lrcString: str
        })
      })
      let systemInfo = app.systemInfo
      this.setData({
        top: `${systemInfo.statusBarHeight + systemInfo.safeArea.top}px`
      })
      // wx.showModal({
      //   content: '点击歌曲图片收藏歌曲，长按页面切歌。'
      // })
    },
    longPressPassTheSong() {
      this.data.eventChannel.emit('longPressPassTheSong')
    },
    tapToAddSong() {
      this.data.eventChannel.emit('tapToAddSong')
    },
    backCar() {
      wx.navigateBack({
        delta: 1,
        success: () => {
          this.data.eventChannel.emit('destroyed')
        }
      })
    }
  }
})
