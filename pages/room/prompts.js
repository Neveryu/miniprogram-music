const app = getApp()
Component({
  data: {
    prompts: [],
    input: ''
  },
  methods: {
    onLoad() {
      wx.setNavigationBarTitle({ title: '搜索提示词' })
      this.loadPrompts()
    },
    loadPrompts() {
      app.request({
        url: 'room/getSearchPrompts',
        success: (res) => this.setData({ prompts: res.data || [] })
      })
    },
    inputChanged(e) {
      this.setData({ input: e.detail.value })
    },
    clearInput() {
      this.setData({ input: '' })
    },
    addPrompt() {
      const prompt = this.data.input.trim()
      if (!prompt) {
        wx.showToast({ title: '请输入提示词', icon: 'none' })
        return
      }
      if (this.data.prompts.indexOf(prompt) > -1) {
        wx.showToast({ title: '提示词已存在', icon: 'none' })
        return
      }
      if (this.data.prompts.length >= 20) {
        wx.showToast({ title: '最多 20 个提示词', icon: 'none' })
        return
      }
      this.savePrompts(this.data.prompts.concat(prompt))
    },
    removePrompt(e) {
      const index = e.mark.index
      wx.showModal({
        title: '删除提示词',
        content: `确定删除「${this.data.prompts[index]}」吗？`,
        confirmText: '删除',
        confirmColor: '#e54d42',
        success: (res) => {
          if (res.confirm) {
            this.savePrompts(this.data.prompts.filter((item, promptIndex) => promptIndex !== index))
          }
        }
      })
    },
    savePrompts(prompts) {
      app.request({
        url: 'room/updateSearchPrompts',
        data: { prompts },
        loading: '保存中',
        success: () => {
          this.setData({ prompts, input: '' })
          wx.showToast({ title: '保存成功' })
        }
      })
    }
  }
})
