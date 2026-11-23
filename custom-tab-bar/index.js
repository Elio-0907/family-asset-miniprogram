Component({
  data: {
    selected: 0,
    list: [
      { path: '/pages/home/home', text: '总览' },
      { path: '/pages/due/due', text: '到期' },
      { path: '/pages/assets/assets', text: '资产' },
      { path: '/pages/forecast/forecast', text: '退休计划' }
    ]
  },
  methods: {
    onTap(e) {
      const path = e.currentTarget.dataset.path;
      const index = e.currentTarget.dataset.index;
      if (index === this.data.selected) return;
      wx.switchTab({ url: path });
    },
    onAdd() {
      wx.navigateTo({ url: '/pages/edit/edit' });
    }
  }
});
