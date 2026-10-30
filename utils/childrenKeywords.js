// 儿歌模式自动补歌关键词池：客户端通过 WS 搜索候选后提交给云函数
const CHILDREN_SONG_KEYWORDS = [
  // 经典儿歌
  '小星星 儿歌', '两只老虎 儿歌', '小燕子 儿歌', '拔萝卜 儿歌', '找朋友 儿歌', '数鸭子 儿歌',
  '丢手绢 儿歌', '世上只有妈妈好 儿歌', '小白船 儿歌', '卖报歌 儿歌', '一分钱 儿歌',
  '上学歌 儿歌', '读书郎 儿歌', '娃哈哈 儿歌', '我的好妈妈 儿歌', '劳动最光荣',
  // 摇篮曲
  '勃拉姆斯 摇篮曲', '舒伯特 摇篮曲', '月儿明 风儿静 摇篮曲', '宝贝宝贝 贝瓦儿歌',
  '虫儿飞 儿歌', '摇啊摇 摇到外婆桥',
  // 动物朋友
  '小兔子乖乖 儿歌', '蜗牛与黄鹂鸟 儿歌', '小毛驴 儿歌', '小螺号 儿歌', '捉泥鳅 儿歌',
  '小乌鸦爱妈妈', '一只哈巴狗 儿歌', '大象 儿歌',
  // 国学启蒙
  '三字经 儿歌', '弟子规 儿歌', '咏鹅 谷建芬', '静夜思 谷建芬', '春晓 谷建芬',
  '悯农 谷建芬', '游子吟 谷建芬',
  // 英文儿歌
  'Twinkle Twinkle Little Star 儿歌', 'Old MacDonald Had a Farm', 'ABC Song 儿歌',
  'Bingo song 儿歌', 'The Wheels On The Bus 儿歌', 'Jingle Bells 儿歌', 'Five Little Ducks',
  'Baby Shark', 'Finger Family', 'Five Little Monkeys', 'Rain Rain Go Away', 'Baa Baa Black Sheep',
  // 律动儿歌
  '健康歌 范晓萱', '幸福拍手歌 儿歌', '爱我你就抱抱我', '小手拍拍 儿歌',
  // 动画经典
  '黑猫警长 主题曲', '葫芦娃 儿歌', '舒克和贝塔 主题曲', '大风车 主题曲', '蓝精灵之歌',
  '白龙马 儿歌', '大头儿子和小头爸爸 主题曲', '聪明的一休 主题曲',
  // 节日日常
  '新年好 儿歌', '恭喜恭喜 儿歌', '刷牙歌 儿歌', '爷爷为我打月饼'
]

// 聚合类关键词：一次搜索能返回整批儿歌合集，是儿歌多样性的主力来源
const CHILDREN_AGGREGATE_KEYWORDS = [
  '儿歌', '儿歌多多', '贝乐虎儿歌', '宝宝巴士儿歌', '贝瓦儿歌', '亲宝儿歌', '火火兔儿歌',
  '经典儿歌大全', '睡前儿歌', '早教儿歌', '英文儿歌', '中文儿歌', '热门儿歌', '新儿歌'
]

// 随机抽 1 个聚合词 + 2 个具体歌名词
function pickChildrenKeywords() {
  const shuffle = (list) => {
    const copy = list.slice()
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }
  return [
    shuffle(CHILDREN_AGGREGATE_KEYWORDS)[0],
    ...shuffle(CHILDREN_SONG_KEYWORDS).slice(0, 2)
  ]
}

module.exports = {
  CHILDREN_SONG_KEYWORDS,
  CHILDREN_AGGREGATE_KEYWORDS,
  pickChildrenKeywords
}
