// 初始化emoji列表
let emojiList = []
for (let i = 1; i <= 30; i++) {
  emojiList.push('/res/Emojis/' + i + '.png')
}

export default {
  historyMax: 20,
  placeholderDefault: '说点什么吧...',
  placeholderSearchImage: '关键词搜索表情',
  messageButtonTitleSearch: 'search',
  messageButtonTitleSend: 'send',
  emojiList
}
