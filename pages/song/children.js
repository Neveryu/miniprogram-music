const app = getApp()

// 内置精选儿歌曲库：点击后按关键词从网易云搜索取第一首点播
const CATEGORIES = [
  {
    key: 'classic',
    name: '经典儿歌',
    color: '#FFB800',
    songs: [
      { name: '小星星', singer: '一闪一闪亮晶晶', emoji: '⭐', keyword: '小星星 儿歌' },
      { name: '两只老虎', singer: '跑得快 跑得快', emoji: '🐯', keyword: '两只老虎 儿歌' },
      { name: '小燕子', singer: '穿花衣 年年春天来这里', emoji: '🐦', keyword: '小燕子 儿歌' },
      { name: '拔萝卜', singer: '嘿哟嘿哟 拔萝卜', emoji: '🥕', keyword: '拔萝卜 儿歌' },
      { name: '找朋友', singer: '敬个礼 握握手', emoji: '🤝', keyword: '找朋友 儿歌' },
      { name: '数鸭子', singer: '门前大桥下 游过一群鸭', emoji: '🦆', keyword: '数鸭子 儿歌' },
      { name: '丢手绢', singer: '轻轻地放在小朋友的后面', emoji: '🧣', keyword: '丢手绢 儿歌' },
      { name: '世上只有妈妈好', singer: '有妈的孩子像块宝', emoji: '❤️', keyword: '世上只有妈妈好 儿歌' },
      { name: '小白船', singer: '蓝蓝的天空银河里', emoji: '🚣', keyword: '小白船 儿歌' },
      { name: '卖报歌', singer: '啦啦啦 我是卖报的小行家', emoji: '📰', keyword: '卖报歌 儿歌' }
    ]
  },
  {
    key: 'lullaby',
    name: '摇篮曲',
    color: '#5AB8F0',
    songs: [
      { name: '摇篮曲', singer: '勃拉姆斯 · 睡吧睡吧我亲爱的宝贝', emoji: '🌙', keyword: '勃拉姆斯 摇篮曲' },
      { name: '摇篮曲', singer: '舒伯特 · 睡吧睡吧我亲爱的宝贝', emoji: '🍼', keyword: '舒伯特 摇篮曲' },
      { name: '月儿明风儿静', singer: '东北摇篮曲 · 娘的宝宝闭上眼睛', emoji: '🌃', keyword: '月儿明 风儿静 摇篮曲' },
      { name: '宝贝宝贝', singer: '贝瓦儿歌 · 我的宝贝', emoji: '👶', keyword: '宝贝宝贝 贝瓦儿歌' },
      { name: '小小少年', singer: '眼望四周阳光照', emoji: '🧒', keyword: '小小少年 儿歌' },
      { name: '虫儿飞', singer: '黑黑的天空低垂', emoji: '✨', keyword: '虫儿飞 儿歌' }
    ]
  },
  {
    key: 'animal',
    name: '动物朋友',
    color: '#7EC74F',
    songs: [
      { name: '小兔子乖乖', singer: '把门儿开开 快点儿开开', emoji: '🐰', keyword: '小兔子乖乖 儿歌' },
      { name: '蜗牛与黄鹂鸟', singer: '阿门阿前一棵葡萄树', emoji: '🐌', keyword: '蜗牛与黄鹂鸟 儿歌' },
      { name: '小毛驴', singer: '我有一只小毛驴 我从来也不骑', emoji: '🫏', keyword: '小毛驴 儿歌' },
      { name: '一只哈巴狗', singer: '坐在大门口 眼睛黑黝黝', emoji: '🐶', keyword: '一只哈巴狗 儿歌' },
      { name: '小螺号', singer: '嘀嘀嘀吹 海鸥听了展翅飞', emoji: '🐚', keyword: '小螺号 儿歌' },
      { name: '大象', singer: '耳朵像蒲扇 身子像小山', emoji: '🐘', keyword: '大象 儿歌' },
      { name: '小青蛙', singer: '呱呱呱呱 呱呱呱呱', emoji: '🐸', keyword: '小青蛙 儿歌' },
      { name: '粉刷匠', singer: '我是一个粉刷匠 粉刷本领强', emoji: '🎨', keyword: '粉刷匠 儿歌' }
    ]
  },
  {
    key: 'poem',
    name: '国学启蒙',
    color: '#C98A5B',
    songs: [
      { name: '三字经', singer: '人之初 性本善', emoji: '📖', keyword: '三字经 儿歌' },
      { name: '咏鹅', singer: '鹅鹅鹅 曲项向天歌', emoji: '🦢', keyword: '咏鹅 谷建芬' },
      { name: '悯农', singer: '锄禾日当午 汗滴禾下土', emoji: '🌾', keyword: '悯农 谷建芬' },
      { name: '静夜思', singer: '床前明月光 疑是地上霜', emoji: '🌕', keyword: '静夜思 谷建芬' },
      { name: '春晓', singer: '春眠不觉晓 处处闻啼鸟', emoji: '🌸', keyword: '春晓 谷建芬' },
      { name: '游子吟', singer: '慈母手中线 游子身上衣', emoji: '🧵', keyword: '游子吟 谷建芬' }
    ]
  },
  {
    key: 'english',
    name: '英文儿歌',
    color: '#FF8FAB',
    songs: [
      { name: 'Twinkle Twinkle', singer: 'Little Star · 小星星英文版', emoji: '🌟', keyword: 'Twinkle Twinkle Little Star 儿歌' },
      { name: 'Old MacDonald', singer: 'Had a Farm · 王老先生有块地', emoji: '🚜', keyword: 'Old MacDonald Had a Farm' },
      { name: 'ABC Song', singer: '字母歌 · A B C D E F G', emoji: '🔤', keyword: 'ABC Song 儿歌' },
      { name: 'Bingo', singer: 'B-I-N-G-O · 宾果歌', emoji: '🐶', keyword: 'Bingo song 儿歌' },
      { name: 'If You Are Happy', singer: '幸福拍手歌 · clap your hands', emoji: '👏', keyword: 'If You Are Happy And You Know It' },
      { name: 'The Wheels', singer: 'On the Bus · 公共汽车轮子转', emoji: '🚌', keyword: 'The Wheels On The Bus 儿歌' }
    ]
  }
]

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
    categories: CATEGORIES,
    activeKey: 'classic',
    activeCategory: CATEGORIES[0],
    requesting: false
  },
  /**
   * 组件的方法列表
   */
  methods: {
    onLoad(options) {
      if (!options.bbbug || options.bbbug != app.globalData.systemVersion) {
        return
      }
      this.setData({
        bbbug: true
      })
      wx.setNavigationBarTitle({
        title: '儿歌乐园'
      })
    },
    switchCategory(e) {
      const key = e.mark.key
      if (key === this.data.activeKey) {
        return
      }
      const category = this.data.categories.find((item) => item.key === key)
      if (!category) {
        return
      }
      this.setData({
        activeKey: key,
        activeCategory: category
      })
    },
    tapSong(e) {
      const song = e.mark.song
      if (song) {
        this.addSongToQueue(song)
      }
    },
    randomSong() {
      const songs = this.data.activeCategory.songs
      const song = songs[Math.floor(Math.random() * songs.length)]
      this.addSongToQueue(song)
    },
    // 按关键词搜索并点播第一首
    addSongToQueue(song) {
      if (this.data.requesting) {
        return
      }
      this.setData({ requesting: true })
      wx.showLoading({
        title: '找歌中',
        mask: true
      })
      app.request({
        url: 'song/search',
        data: {
          keyword: song.keyword,
          source: 'netease'
        },
        success: (res) => {
          const found = (res.data || [])[0]
          if (!found || !found.mid) {
            this.finishRequest()
            wx.showToast({ title: '没有找到这首歌，换一首试试', icon: 'none' })
            return
          }
          app.request({
            url: 'song/addSong',
            data: {
              mid: found.mid,
              source: found.source,
              song: found,
              room_id: app.globalData.roomInfo.room_id
            },
            success: () => {
              this.finishRequest()
              wx.showToast({ title: '已点《' + song.name + '》', icon: 'none' })
            },
            error: (response) => {
              this.finishRequest()
              wx.showToast({ title: response.msg || '点歌失败', icon: 'none' })
              return true
            },
            fail: () => {
              this.finishRequest()
              wx.showToast({ title: '点歌失败，请重试', icon: 'none' })
            }
          })
        },
        error: (response) => {
          this.finishRequest()
          wx.showToast({ title: response.msg || '搜索失败，请重试', icon: 'none' })
          return true
        },
        fail: () => {
          this.finishRequest()
          wx.showToast({ title: '搜索失败，请重试', icon: 'none' })
        }
      })
    },
    finishRequest() {
      wx.hideLoading()
      this.setData({ requesting: false })
    }
  }
})
