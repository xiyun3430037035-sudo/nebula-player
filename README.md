# 网易云播放器(个人自用版)

基于 Electron 的网易云音乐第三方桌面播放器。
扫码登录你自己的网易云账号,同步歌单、在线播放(含 VIP 无损音质)、下载、歌词同步。

> ⚠️ 仅供个人自用学习研究,请勿对外分发或用于商业用途。

---

## 安装

1. 双击运行 `网易云播放器-Setup-1.0.0.exe`
2. 按向导选择安装目录(默认 `C:\Users\你的用户名\AppData\Local\Programs\网易云播放器`)
3. 安装完成后**桌面自动出现「网易云播放器」快捷方式**,双击即可打开

## 使用

| 功能 | 操作 |
|---|---|
| 登录(推荐) | **Cookie 登录**:浏览器打开 music.163.com 登录 → F12 → Application → Cookies → 复制全部 Cookie 粘贴到播放器的「Cookie 登录」输入框 |
| 登录(备选) | **扫码登录**:手机网易云 APP 扫码确认。注意:网易云风控严时会被 8821 拦截(提示改用 Cookie 登录) |
| 浏览歌单 | 左侧「我的歌单」点击任意歌单,右侧显示歌曲列表 |
| 播放 | 点击歌曲行;底部播放栏控制播放/暂停/上一首/下一首 |
| 音质 | 播放栏右侧「音质」下拉:标准 / 高品 / 超高 / **无损** / Hi-Res(需账号权限) |
| 拖动进度 | 播放栏进度条直接拖动(支持 seek) |
| 歌词 | 双击封面或点击歌名,进入滚动歌词视图(当前行高亮) |
| 搜索 | 顶部搜索框输入关键词,300ms 防抖自动搜索 |
| 下载 | 播放栏下载按钮 → 选择保存位置 → 下载当前歌曲(按当前音质) |
| 快捷键 | 空格 = 播放/暂停 |
| 退出登录 | 左下角用户卡片 → 退出图标 |

## 界面

- 设计系统:我也不知道咋写的浅色界面
- 配色:背景 `#F4F3F9` / 浅蓝面 `#DBE3FA` / 重点文字 `#545E75`
- 动效:M3 缓动曲线,封面旋转、图标过渡、视图切换;系统开启"减弱动效"时自动禁用

## 开发

```bash
npm install            # 安装依赖(npmmirror 镜像更快)
npm run test:api       # 验证网易云 API 链路(加密/登录/搜索/播放URL/歌词)
npm start              # 本地运行(需要 Node + Electron)
npm run dist           # 打包 setup.exe(electron-builder + NSIS)
```

### 技术说明

- 接口:网易云网页版逆向(weapi 加密),仅实现个人所需的核心接口
- 登录:二维码扫码,登录态 Cookie 存于 `%APPDATA%/网易云播放器/session.json`
- 架构:Electron 主进程内置本地代理服务(随机端口),持有登录态、代理音频流(绕防盗链、支持 Range),渲染进程纯前端
- 改外观:编辑 `renderer/style.css` 顶部的 CSS 变量(token)后重新 `npm run dist`

### 目录结构

```
netease-player/
├── main.js              # Electron 主进程
├── preload.js           # 预加载脚本
├── core/
│   ├── crypto.js        # weapi 加密(双重 AES + RSA 裸模幂)
│   ├── api.js           # 网易云接口封装
│   └── server.js        # 本地代理服务(接口/音频流/下载)
├── renderer/            # 前端(index.html / style.css / app.js)
├── tools/make_icon.py   # 图标生成脚本
├── test/api.test.js     # API 链路测试
└── dist/                # 打包产物
```

### 许可证

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 xiyun3430037035-sudo。

### 已知限制

- 无版权的"灰色歌曲"无法播放(接口不返回播放地址)
- 个别付费歌曲可能需要对应 VIP 权益
- 非官方接口,网易云改版后可能需要跟进调整(见 `core/crypto.js` 与 `core/api.js`)
