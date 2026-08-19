// FocusLocker 配置模板 · 首次启动生效后可在「设置页」内修改并保存
// ⚠️ 安全提醒：请勿把真实 deepseekApiKey、个人站点、本机绝对路径直接提交到公开/私有仓库。
//    本文件提供默认占位。本地使用时请在「应用内设置页」或本地副本中填入真实值。
module.exports = {
  imagePath: '',
  autoLaunch: true,

  // DeepSeek 开放平台 API Key。留空时走内嵌 BrowserView 登录 DeepSeek 官网使用 AI 助手。
  // 获取方式：https://platform.deepseek.com/ → API Keys → Create new key
  deepseekApiKey: '',

  // 每日自动锁屏时段（24 小时制，HH:MM-HH:MM，支持多段，左闭右开区间）
  timeRanges: [
    { start: '18:00', end: '21:00' },
    { start: '22:00', end: '23:00' }
  ],

  // 锁屏期间白名单网站（id 必须唯一；zoom 为 BrowserView 默认缩放；aliases 用于 AI 语音指令匹配）
  sites: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      url: 'https://chat.deepseek.com',
      zoom: 1.4,
      aliases: ['deepseek', '深度求索', 'dpsk'],
      pinned: false
    },
    {
      id: 'netease-music',
      name: '网易云音乐',
      url: 'https://music.163.com',
      zoom: 1,
      aliases: ['网易云', '云音乐', '音乐'],
      pinned: false
    },
    {
      id: 'kimi',
      name: 'Kimi',
      url: 'https://www.kimi.com/chat/',
      zoom: 1,
      aliases: ['kimi', '月之暗面'],
      pinned: false
    }
  ],

  // 文件库中默认显示的本地目录（绝对路径，按需要在本地配置中填写；默认为空数组）
  fileViewDirs: [],

  // 即时模式（紧急退出验证码校验关闭）—— 生产建议保持 false
  instantModeEnabled: false,

  // 看门狗守护进程（防止结束进程绕过锁屏）—— 生产建议保持 true
  guardEnabled: true
}
