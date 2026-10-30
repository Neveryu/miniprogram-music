const app = getApp()
const jusicWsApi = require('../../utils/jusicWsApi.js')

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
      { name: '卖报歌', singer: '啦啦啦 我是卖报的小行家', emoji: '📰', keyword: '卖报歌 儿歌' },
      { name: '一分钱', singer: '我在马路边 捡到一分钱', emoji: '🪙', keyword: '一分钱 儿歌' },
      { name: '上学歌', singer: '太阳当空照 花儿对我笑', emoji: '🎒', keyword: '上学歌 儿歌' },
      { name: '读书郎', singer: '小嘛小儿郎 背着书包上学堂', emoji: '📚', keyword: '读书郎 儿歌' },
      { name: '娃哈哈', singer: '我们的祖国是花园', emoji: '🌺', keyword: '娃哈哈 儿歌' }
    ]
  },
  {
    key: 'lullaby',
    name: '摇篮曲',
    color: '#5AB8F0',
    songs: [
      { name: '摇篮曲', singer: '勃拉姆斯 · 睡吧睡吧我亲爱的宝贝', emoji: '🌙', keyword: '勃拉姆斯 摇篮曲' },
      { name: '摇篮曲', singer: '舒伯特 · 睡吧睡吧我亲爱的宝贝', emoji: '🍼', keyword: '舒伯特 摇篮曲' },
      { name: '摇篮曲', singer: '莫扎特 · 睡吧小宝贝', emoji: '🎼', keyword: '莫扎特 摇篮曲' },
      { name: '月儿明风儿静', singer: '东北摇篮曲 · 娘的宝宝闭上眼睛', emoji: '🌃', keyword: '月儿明 风儿静 摇篮曲' },
      { name: '蒙古摇篮曲', singer: '呼伦贝尔草原 · 快睡吧小宝贝', emoji: '🌾', keyword: '蒙古族 摇篮曲' },
      { name: '摇啊摇', singer: '摇到外婆桥 · 上海童谣', emoji: '🛶', keyword: '摇啊摇 摇到外婆桥' },
      { name: '月光光', singer: '照地堂 · 广东童谣', emoji: '🌕', keyword: '月光光 照地堂' },
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
      { name: '粉刷匠', singer: '我是一个粉刷匠 粉刷本领强', emoji: '🎨', keyword: '粉刷匠 儿歌' },
      { name: '捉泥鳅', singer: '池塘的水满了 雨也停了', emoji: '🐟', keyword: '捉泥鳅 儿歌' },
      { name: '小乌鸦爱妈妈', singer: '路边开放野菊花', emoji: '🐦', keyword: '小乌鸦爱妈妈' },
      { name: '两只小象', singer: '扬起鼻子勾一勾', emoji: '🐘', keyword: '两只小象 儿歌' },
      { name: '我的小鸡', singer: '叽叽叽叽 叽叽叽叽', emoji: '🐥', keyword: '我的小鸡 儿歌' },
      { name: '小蚂蚁', singer: '小小蚂蚁排队伍', emoji: '🐜', keyword: '小蚂蚁 儿歌' }
    ]
  },
  {
    key: 'poem',
    name: '国学启蒙',
    color: '#C98A5B',
    songs: [
      { name: '三字经', singer: '人之初 性本善', emoji: '📖', keyword: '三字经 儿歌' },
      { name: '弟子规', singer: '圣人训 首孝悌 次谨信', emoji: '📜', keyword: '弟子规 儿歌' },
      { name: '咏鹅', singer: '鹅鹅鹅 曲项向天歌', emoji: '🦢', keyword: '咏鹅 谷建芬' },
      { name: '悯农', singer: '锄禾日当午 汗滴禾下土', emoji: '🌾', keyword: '悯农 谷建芬' },
      { name: '静夜思', singer: '床前明月光 疑是地上霜', emoji: '🌕', keyword: '静夜思 谷建芬' },
      { name: '春晓', singer: '春眠不觉晓 处处闻啼鸟', emoji: '🌸', keyword: '春晓 谷建芬' },
      { name: '游子吟', singer: '慈母手中线 游子身上衣', emoji: '🧵', keyword: '游子吟 谷建芬' },
      { name: '登鹳雀楼', singer: '白日依山尽 黄河入海流', emoji: '🏔️', keyword: '登鹳雀楼 谷建芬' },
      { name: '咏柳', singer: '碧玉妆成一树高', emoji: '🌿', keyword: '咏柳 谷建芬' },
      { name: '出塞', singer: '秦时明月汉时关', emoji: '🏹', keyword: '出塞 谷建芬' },
      { name: '一去二三里', singer: '烟村四五家 亭台六七座', emoji: '🏘️', keyword: '一去二三里 儿歌' },
      { name: '读唐诗', singer: '床前的月光 窗外的雪', emoji: '🎵', keyword: '读唐诗 儿歌' }
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
      { name: 'The Wheels', singer: 'On the Bus · 公共汽车轮子转', emoji: '🚌', keyword: 'The Wheels On The Bus 儿歌' },
      { name: 'Jingle Bells', singer: 'Dashing through the snow · 铃儿响叮当', emoji: '🔔', keyword: 'Jingle Bells' },
      { name: 'Row Your Boat', singer: 'Row Row Row · 划船歌', emoji: '🚣', keyword: 'Row Row Row Your Boat' },
      { name: 'Head & Toes', singer: 'Head Shoulders Knees & Toes · 头肩膝脚操', emoji: '🙆', keyword: 'Head Shoulders Knees And Toes' },
      { name: 'Mary Had a Lamb', singer: 'Little Lamb · 玛丽有只小羊羔', emoji: '🐑', keyword: 'Mary Had A Little Lamb' },
      { name: 'London Bridge', singer: 'Is Falling Down · 伦敦桥', emoji: '🌉', keyword: 'London Bridge Is Falling Down' },
      { name: 'Five Little Ducks', singer: '五只小鸭去游泳', emoji: '🦆', keyword: 'Five Little Ducks' },
      { name: 'You Are Sunshine', singer: 'My only sunshine · 你是我的阳光', emoji: '☀️', keyword: 'You Are My Sunshine' },
      { name: 'Baby Shark', singer: 'du du du du du · 鲨鱼宝宝', emoji: '🦈', keyword: 'Baby Shark' },
      { name: 'Finger Family', singer: 'Daddy Finger · 手指家族', emoji: '👨‍👩‍👧', keyword: 'Finger Family' },
      { name: 'Five Monkeys', singer: 'Jumping on the bed · 五只小猴子', emoji: '🐒', keyword: 'Five Little Monkeys' },
      { name: 'Rain Rain Go Away', singer: 'Come again another day · 雨儿雨儿快走开', emoji: '🌧️', keyword: 'Rain Rain Go Away' },
      { name: 'Hokey Pokey', singer: 'You put your right hand in · 身体部位操', emoji: '🕺', keyword: 'Hokey Pokey' },
      { name: 'Humpty Dumpty', singer: 'Sat on a wall · 鹅妈妈童谣', emoji: '🥚', keyword: 'Humpty Dumpty' },
      { name: 'Hickory Dickory', singer: 'Dock · 老鼠爬上钟', emoji: '🕐', keyword: 'Hickory Dickory Dock' },
      { name: 'Baa Baa Black Sheep', singer: 'Have you any wool · 黑绵羊咩咩', emoji: '🐑', keyword: 'Baa Baa Black Sheep' },
      { name: 'One Two Three', singer: 'Four Five · once I caught a fish alive 数字歌', emoji: '🎣', keyword: 'One Two Three Four Five' },
      { name: 'Ten in the Bed', singer: '十个小宝贝滚下床 · 倒数歌', emoji: '🛏️', keyword: 'Ten in the Bed' },
      { name: 'Sing a Rainbow', singer: 'Red and yellow and pink · 颜色歌', emoji: '🌈', keyword: 'I Can Sing a Rainbow' },
      { name: 'Apples Bananas', singer: 'I like to eat · 元音启蒙', emoji: '🍎', keyword: 'Apples and Bananas' },
      { name: 'Days of Week', singer: 'Monday Tuesday · 星期歌', emoji: '📅', keyword: 'Days of the Week Song' },
      { name: 'Do-Re-Mi', singer: 'Doe a deer · 音乐之声 音阶启蒙', emoji: '🎼', keyword: 'Do Re Mi 音乐之声' }
    ]
  },
  {
    key: 'dance',
    name: '律动儿歌',
    color: '#9B8CFF',
    songs: [
      { name: '健康歌', singer: '左三圈 右三圈', emoji: '🏃', keyword: '健康歌 范晓萱' },
      { name: '幸福拍手歌', singer: '如果感到幸福你就拍拍手', emoji: '👏', keyword: '幸福拍手歌 儿歌' },
      { name: '拍手歌', singer: '你拍一 我拍一', emoji: '🤲', keyword: '拍手歌 儿歌' },
      { name: '木头人', singer: '一二三 我们都是木头人', emoji: '🪵', keyword: '木头人 儿歌' },
      { name: '爱我你就抱抱我', singer: '陪陪我 亲亲我 夸夸我', emoji: '🤗', keyword: '爱我你就抱抱我' },
      { name: '小手拍拍', singer: '小手拍拍 手指伸出来', emoji: '👐', keyword: '小手拍拍 儿歌' },
      { name: '头发肩膀膝盖脚', singer: '摸摸你的头发肩膀膝盖脚', emoji: '🦵', keyword: '头发肩膀膝盖脚 儿歌' }
    ]
  },
  {
    key: 'cartoon',
    name: '动画经典',
    color: '#FF7A50',
    songs: [
      { name: '黑猫警长', singer: '森林公民向你致敬', emoji: '🚨', keyword: '黑猫警长 主题曲' },
      { name: '葫芦娃', singer: '一根藤上七朵花', emoji: '🍇', keyword: '葫芦娃 儿歌' },
      { name: '舒克和贝塔', singer: '开飞机的舒克 开坦克的贝塔', emoji: '✈️', keyword: '舒克和贝塔 主题曲' },
      { name: '大风车', singer: '吱呀吱哟哟地转', emoji: '🎡', keyword: '大风车 主题曲' },
      { name: '蓝精灵', singer: '在那山的那边海的那边', emoji: '🧞', keyword: '蓝精灵之歌' },
      { name: '聪明的一休', singer: '格叽格叽格叽格叽', emoji: '🧘', keyword: '聪明的一休 主题曲' },
      { name: '白龙马', singer: '蹄朝西 驮着唐三藏', emoji: '🐎', keyword: '白龙马 儿歌' },
      { name: '大头儿子', singer: '小头爸爸 · 一对好朋友快乐父子俩', emoji: '👨‍👦', keyword: '大头儿子和小头爸爸 主题曲' }
    ]
  },
  {
    key: 'festival',
    name: '节日日常',
    color: '#E85D75',
    songs: [
      { name: '新年好', singer: '新年好呀 祝贺大家新年好', emoji: '🧨', keyword: '新年好 儿歌' },
      { name: '恭喜恭喜', singer: '恭喜恭喜恭喜你呀', emoji: '🧧', keyword: '恭喜恭喜 儿歌' },
      { name: '卖汤圆', singer: '小二哥的汤圆是圆又圆', emoji: '🍡', keyword: '卖汤圆 儿歌' },
      { name: '爷爷为我打月饼', singer: '八月十五月儿明', emoji: '🥮', keyword: '爷爷为我打月饼' },
      { name: '生日快乐', singer: '祝你生日快乐', emoji: '🎂', keyword: '生日快乐 儿歌' },
      { name: '我的好妈妈', singer: '下班回到家 工作了一天', emoji: '👩', keyword: '我的好妈妈 儿歌' },
      { name: '劳动最光荣', singer: '太阳光金亮亮 雄鸡唱三唱', emoji: '🌞', keyword: '劳动最光荣' },
      { name: '刷牙歌', singer: '小牙刷 手中拿', emoji: '🪥', keyword: '刷牙歌 儿歌' },
      { name: '我爱洗澡', singer: '噜啦啦 噜啦啦', emoji: '🛁', keyword: '我爱洗澡' }
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
    requesting: false,
    childrenMode: false,
    toggling: false
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
      this.loadRoomMode()
    },
    // 读取房间儿歌模式状态，初始化按钮显示
    loadRoomMode() {
      if (app.globalData.roomInfo) {
        this.setData({ childrenMode: !!app.globalData.roomInfo.children_mode })
      }
      app.request({
        url: 'room/getRoomInfo',
        data: {},
        success: (res) => {
          this.setData({ childrenMode: !!(res.data && res.data.children_mode) })
        },
        error: () => {
          return true
        }
      })
    },
    // 一键儿歌：开启后清空待播队列立即播放儿歌，自动补歌切换为儿歌关键词池
    toggleChildrenMode() {
      if (!app.globalData.userInfo) {
        wx.showToast({ title: '登录后即可开启儿歌模式', icon: 'none' })
        return
      }
      if (this.data.toggling) {
        return
      }
      this.setData({ toggling: true })
      const next = !this.data.childrenMode
      app.request({
        url: 'room/setChildrenMode',
        loading: next ? '正在开启' : '正在关闭',
        data: { enabled: next },
        success: (res) => {
          // 仅当云函数明确返回 has_song=false 时才需要客户端兜底搜索
          const hasSong = !(res.data && res.data.has_song === false)
          this.setData({
            childrenMode: !!(res.data && res.data.children_mode),
            toggling: false
          })
          wx.showToast({ title: res.msg || '操作成功', icon: 'none' })
          if (next) {
            // 没有儿歌收藏时，云函数无法搜索，由客户端通过 WS 搜一首并播放
            if (!hasSong) {
              this.playFirstChildrenSong()
            }
            setTimeout(() => wx.navigateBack(), 800)
          }
        },
        error: (response) => {
          this.setData({ toggling: false })
          wx.showToast({ title: response.msg || '操作失败，请重试', icon: 'none' })
          return true
        },
        fail: () => {
          this.setData({ toggling: false })
          wx.showToast({ title: '操作失败，请重试', icon: 'none' })
        }
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
    // 按关键词通过 WS 搜索，取第一首并获取播放直链后点歌
    addSongToQueue(song) {
      if (this.data.requesting) {
        return
      }
      this.setData({ requesting: true })
      wx.showLoading({
        title: '找歌中',
        mask: true
      })
      jusicWsApi.searchNeteaseSongs(song.keyword, { pageSize: 10 }).then(result => {
        const found = (result.list || [])[0]
        if (!found || !found.mid) {
          this.finishRequest()
          wx.showToast({ title: '没有找到这首歌，换一首试试', icon: 'none' })
          return null
        }
        return jusicWsApi.ensurePlayableSong(found).then(pickedSong => new Promise((resolve) => {
          app.request({
            url: 'song/addSong',
            data: {
              mid: pickedSong.mid,
              source: pickedSong.source,
              song: pickedSong,
              room_id: app.globalData.roomInfo.room_id
            },
            success: () => {
              this.finishRequest()
              wx.showToast({ title: '已点《' + song.name + '》', icon: 'none' })
              resolve()
            },
            error: (response) => {
              this.finishRequest()
              wx.showToast({ title: response.msg || '点歌失败', icon: 'none' })
              resolve()
              return true
            },
            fail: () => {
              this.finishRequest()
              wx.showToast({ title: '点歌失败，请重试', icon: 'none' })
              resolve()
            }
          })
        }))
      }).catch(error => {
        this.finishRequest()
        wx.showToast({ title: error.message || '搜索失败，请重试', icon: 'none' })
      })
    },
    // 开启儿歌模式后没有儿歌收藏时的首曲兜底：WS 搜索并立即播放
    playFirstChildrenSong() {
      jusicWsApi.searchNeteaseSongs('儿歌', { pageSize: 10 }).then(result => {
        const found = (result.list || [])[0]
        if (!found || !found.mid) {
          return null
        }
        return jusicWsApi.ensurePlayableSong(found).then(pickedSong => new Promise((resolve) => {
          app.request({
            url: 'song/addSong',
            data: {
              mid: pickedSong.mid,
              source: pickedSong.source,
              song: pickedSong,
              room_id: app.globalData.roomInfo.room_id
            },
            success: resolve,
            error: () => {
              resolve()
              return true
            },
            fail: resolve
          })
        }))
      }).catch(() => {})
    },
    finishRequest() {
      wx.hideLoading()
      this.setData({ requesting: false })
    }
  }
})
