'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { PlayerServer } = require('./core/server');
const logger = require('./core/log');

// 固定用户数据目录:不受应用名/productName 变化影响,覆盖安装不再丢失登录态
const FIXED_USER_DATA = path.join(app.getPath('appData'), 'Nebula');
app.setPath('userData', FIXED_USER_DATA);

// 迁移旧版登录态(netease-player / 网易云播放器 目录)
function migrateLegacySession() {
  const dst = path.join(FIXED_USER_DATA, 'session.json');
  if (fs.existsSync(dst)) return;
  const legacyDirs = [
    path.join(app.getPath('appData'), 'netease-player'),
    path.join(app.getPath('appData'), '网易云播放器')
  ];
  for (const dir of legacyDirs) {
    const src = path.join(dir, 'session.json');
    if (fs.existsSync(src)) {
      try {
        fs.mkdirSync(FIXED_USER_DATA, { recursive: true });
        fs.copyFileSync(src, dst);
        logger.log('info', `已迁移旧版登录态: ${src}`);
        return;
      } catch (e) {
        logger.log('warn', '登录态迁移失败: ' + String(e && e.message));
      }
    }
  }
}

let win = null;
let server = null;
let tray = null;
let isQuitting = false;

// ---------- 系统托盘(关闭主窗口后驻留托盘,继续播放) ----------
function showMainWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function createTray() {
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
    if (img.isEmpty()) {
      img = nativeImage.createFromPath(path.join(process.resourcesPath, 'icon.ico'));
    }
    tray = new Tray(img);
    tray.setToolTip('Nebula 播放器');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出 Nebula', click: () => { isQuitting = true; app.quit(); } }
    ]));
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch (e) {
    logger.log('warn', 'tray init failed: ' + String(e && e.message));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    loadLyricConfig();
    // 启动前迁移旧登录态
    migrateLegacySession();
    // 启动本地代理服务(持有登录态,随机端口)
    server = new PlayerServer({
      storePath: path.join(FIXED_USER_DATA, 'session.json'),
      logPath: path.join(FIXED_USER_DATA, 'player.log'),
      onDownload: async (song) => {
        const levelLabel = {
          standard: '标准', higher: '高品', exhigh: '超高',
          lossless: '无损', hires: 'Hi-Res'
        }[song.level] || '标准';
        const result = await dialog.showSaveDialog(win, {
          title: '保存音乐',
          defaultPath: `${song.baseName || `song_${song.id}_${levelLabel}`}.${song.ext || 'mp3'}`,
          filters: [
            { name: '音频文件', extensions: ['mp3', 'flac', 'm4a', 'aac'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        });
        if (result.canceled || !result.filePath) return null;
        return result.filePath;
      }
    });
    // 启动时校验登录态(await,确保前端首查时已就绪)
    await server.initLogin();
    const port = await server.start();
    console.log('[player] local server on 127.0.0.1:' + port);

    createWindow(port);
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    });
  });

  app.on('window-all-closed', () => {
    // 主窗口关闭已被拦截为隐藏;仅真正退出(托盘"退出")时允许退出
    if (isQuitting) app.quit();
  });

  app.on('before-quit', () => { isQuitting = true; });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    destroyLyricWindow();
    if (server) server.stop();
  });

  app.whenReady().then(() => {
    registerMediaKeys();
  });
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    title: 'Nebula v' + app.getVersion(),
    backgroundColor: '#F4F3F9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { port: String(port), version: app.getVersion() }
  });

  // 点 × = 最小化到托盘(继续播放),真正退出走托盘菜单
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

// ---------- 多媒体键(播放/暂停、上一首、下一首,含 Fn+F5/F6/F7) ----------
function registerMediaKeys() {
  const send = (action) => () => {
    if (win) win.webContents.send('media-key', action);
  };
  const keys = [
    ['MediaPlayPause', 'playpause'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'prev'],
    ['MediaStop', 'stop']
  ];
  keys.forEach(([acc, action]) => {
    try {
      const ok = globalShortcut.register(acc, send(action));
      logger.log('info', `media key ${acc} => ${ok ? 'registered' : 'FAILED(可能被系统/其他应用占用)'}`);
    } catch (e) {
      logger.log('warn', `media key ${acc} register error: ${e.message}`);
    }
  });
}

// ---------- 网页登录:应用内打开网易云官方页面,登录成功后自动抓取 Cookie ----------
let loginWin = null;

function openWebLogin() {
  return new Promise((resolve) => {
    if (loginWin) { loginWin.focus(); return; }
    // 独立会话,避免污染主窗口
    const ses = session.fromPartition('web-login');
    let done = false;

    loginWin = new BrowserWindow({
      width: 1080,
      height: 760,
      title: '网易云登录',
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    loginWin.loadURL('https://music.163.com');

    // 轮询 Cookie,检测到 MUSIC_U 即登录成功
    const timer = setInterval(async () => {
      try {
        const cookies = await ses.cookies.get({});
        const musicU = cookies.find((c) => c.name === 'MUSIC_U' && c.domain.includes('music.163.com'));
        if (musicU && !done) {
          done = true;
          clearInterval(timer);
          const cookieText = cookies
            .filter((c) => c.domain.includes('music.163.com') || c.domain.includes('163.com'))
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
          try {
            const r = await server.applyCookie(cookieText);
            if (r.ok) {
              if (win) {
                win.webContents.send('web-login-result', { ok: true, profile: r.profile });
              }
              resolve({ ok: true, profile: r.profile });
            } else {
              resolve({ ok: false, error: r.error });
              if (win) win.webContents.send('web-login-result', { ok: false, error: r.error });
            }
          } catch (e) {
            resolve({ ok: false, error: String(e && e.message) });
          }
          closeLoginWin();
        }
      } catch (e) { /* 忽略 */ }
    }, 1200);

    loginWin.on('closed', () => {
      clearInterval(timer);
      loginWin = null;
      if (!done) {
        resolve({ cancelled: true });
        if (win) win.webContents.send('web-login-result', { cancelled: true });
      }
    });
  });
}

function closeLoginWin() {
  if (loginWin) {
    loginWin.destroy();
    loginWin = null;
  }
}

// ---------- 桌面歌词:透明置顶小窗 ----------
let lyricWin = null;

const LYRIC_W = 340;
const LYRIC_H = 188;

function lyricPosFile() {
  return path.join(app.getPath('userData'), 'lyric-pos.json');
}

function loadLyricPos() {
  try {
    const p = JSON.parse(require('fs').readFileSync(lyricPosFile(), 'utf8'));
    if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
  } catch (e) { /* 无存档 */ }
  return null;
}

function saveLyricPos(x, y) {
  try {
    require('fs').writeFileSync(lyricPosFile(), JSON.stringify({ x, y }));
  } catch (e) { /* 忽略 */ }
}

// 把窗口形状裁剪为圆角矩形(彻底消除透明窗四角的阴影/残留"尖尖")
function applyRoundedShape(win, w, h, r) {
  try {
    if (typeof win.setShape !== 'function') return;
    const rects = [];
    const R = Math.min(r, w / 2, h / 2);
    for (let y = 0; y < h; y++) {
      let inset = 0;
      if (y < R) {
        const dy = R - y;
        inset = Math.round(R - Math.sqrt(Math.max(0, R * R - dy * dy)));
      } else if (y > h - R) {
        const dy = y - (h - R);
        inset = Math.round(R - Math.sqrt(Math.max(0, R * R - dy * dy)));
      }
      rects.push({ x: inset, y, width: w - inset * 2, height: 1 });
    }
    win.setShape(rects);
  } catch (e) { /* 忽略 */ }
}

function createLyricWindow() {
  if (lyricWin && !lyricWin.isDestroyed()) return;
  lyricWin = new BrowserWindow({
    width: LYRIC_W,
    height: LYRIC_H,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-lyric.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  lyricWin.setAlwaysOnTop(true, 'screen-saver');
  // 注意:透明窗口 + setBackgroundMaterial(acrylic) 会填满窗口矩形导致 CSS 圆角失效,
  // 故不再启用亚克力,改用纯 CSS 半透明深色卡片(圆角干净、拖拽兼容性好)
  lyricWin.loadFile(path.join(__dirname, 'renderer', 'lyric.html'));
  // 窗口加载完成后:同步穿透状态 + 下发个性化配置(主题色/透明度/布局)
  lyricWin.webContents.once('did-finish-load', () => {
    try {
      if (lyricThrough) lyricWin.webContents.send('lyric-through-state', true);
      applyLyricConfig();
    } catch (e) { /* 忽略 */ }
  });
  // 裁剪窗口形状为圆角矩形,消除四角阴影残留
  try {
    applyRoundedShape(lyricWin, LYRIC_W, LYRIC_H, 16);
  } catch (e) { /* 忽略 */ }
  // 位置:优先恢复上次拖动位置,否则屏幕底部居中
  try {
    const saved = loadLyricPos();
    if (saved) {
      lyricWin.setPosition(Math.round(saved.x), Math.round(saved.y));
    } else {
      const { screen } = require('electron');
      const disp = screen.getPrimaryDisplay();
      const { x, width, height } = disp.workArea;
      lyricWin.setPosition(Math.round(x + (width - LYRIC_W) / 2), height - LYRIC_H - 30);
    }
  } catch (e) { /* 忽略 */ }
  // 拖动结束后记忆位置
  let posTimer = null;
  lyricWin.on('moved', () => {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      try {
        const [px, py] = lyricWin.getPosition();
        saveLyricPos(px, py);
      } catch (e) { /* 忽略 */ }
    }, 400);
  });
  lyricWin.on('closed', () => {
    lyricWin = null;
    // 通知主窗口:桌面歌词被关闭,同步关闭设置开关
    if (win && !win.isDestroyed()) {
      win.webContents.send('lyric-window-closed');
    }
  });
}

function destroyLyricWindow() {
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.destroy();
  }
  lyricWin = null;
}

// 注册 IPC:渲染进程 ↔ 桌面歌词
ipcMain.on('lyric-update', (_e, data) => {
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.webContents.send('lyric-data', data);
  }
});

// 遥控窗控制按钮 → 转发给主窗口执行
ipcMain.on('remote-control', (_e, action) => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('remote-control', action);
  }
});
ipcMain.handle('toggle-lyric-window', (_e, on) => {
  if (on) createLyricWindow();
  else destroyLyricWindow();
  return !!lyricWin;
});
ipcMain.on('lyric-close', () => destroyLyricWindow());

// ---------- 小窗鼠标穿透(硬穿透:开启后固定+穿透,纯看板仅显示) ----------
let lyricThrough = false;

function applyLyricThrough() {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  try {
    lyricWin.setIgnoreMouseEvents(lyricThrough);
    lyricWin.webContents.send('lyric-through-state', lyricThrough);
  } catch (e) { /* 忽略 */ }
}

ipcMain.handle('set-lyric-through', (_e, on) => {
  lyricThrough = !!on;
  applyLyricThrough();
  return lyricThrough;
});

// ---------- 小窗个性化配置(主题色/透明度/元素位置,持久化到 userData) ----------
const DEFAULT_LYRIC_CONFIG = {
  accent: '#3C4A6E',   // 主题色(文字/进度条/按钮统一派生)
  opacity: 100,        // 窗口整体透明度 35-100
  bgAlpha: 92,         // 卡片背景不透明度 35-95
  showCover: true,     // 显示封面
  coverSide: 'left',   // left / right
  coverSize: 86,       // 封面尺寸 56-120
  lyricSize: 14,       // 歌词字号 12-20
  offCover: 0, offName: 0, offSwap: 0, offBar: 0   // 元素垂直偏移 -40~40px
};
let lyricConfig = { ...DEFAULT_LYRIC_CONFIG };

function lyricConfigFile() {
  return path.join(app.getPath('userData'), 'lyric-config.json');
}
function loadLyricConfig() {
  try {
    lyricConfig = { ...DEFAULT_LYRIC_CONFIG, ...JSON.parse(fs.readFileSync(lyricConfigFile(), 'utf8')) };
  } catch (e) { /* 无配置,使用默认 */ }
}
function saveLyricConfig() {
  try { fs.writeFileSync(lyricConfigFile(), JSON.stringify(lyricConfig, null, 2)); } catch (e) { /* 忽略 */ }
}
function applyLyricConfig() {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  try {
    lyricWin.webContents.send('lyric-config', lyricConfig);
    const op = Math.max(0.3, Math.min(1, Number(lyricConfig.opacity) / 100));
    lyricWin.setOpacity(op);
  } catch (e) { /* 忽略 */ }
}
ipcMain.handle('lyric-config-get', () => lyricConfig);
ipcMain.on('lyric-config-set', (_e, cfg) => {
  lyricConfig = { ...DEFAULT_LYRIC_CONFIG, ...(cfg || {}) };
  saveLyricConfig();
  applyLyricConfig();
});
ipcMain.on('lyric-config-reset', () => {
  lyricConfig = { ...DEFAULT_LYRIC_CONFIG };
  saveLyricConfig();
  applyLyricConfig();
});

// 手动拖拽:主进程定时跟随系统光标(渲染进程只发 start/end,零中间延迟,丝滑跟手)
let lyricDragTimer = null;
let lyricDragOffset = null;

function stopLyricDrag() {
  if (lyricDragTimer) {
    clearInterval(lyricDragTimer);
    lyricDragTimer = null;
  }
  if (lyricDragOffset && lyricWin && !lyricWin.isDestroyed()) {
    try {
      const [px, py] = lyricWin.getPosition();
      saveLyricPos(px, py); // 拖动结束立即记忆位置
    } catch (e) { /* 忽略 */ }
  }
  lyricDragOffset = null;
}

ipcMain.on('lyric-drag-start', () => {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  stopLyricDrag();
  try {
    const { screen } = require('electron');
    const c = screen.getCursorScreenPoint();
    const [wx, wy] = lyricWin.getPosition();
    lyricDragOffset = { dx: c.x - wx, dy: c.y - wy };
    lyricDragTimer = setInterval(() => {
      if (!lyricWin || lyricWin.isDestroyed() || !lyricDragOffset) { stopLyricDrag(); return; }
      try {
        const p = screen.getCursorScreenPoint();
        lyricWin.setPosition(Math.round(p.x - lyricDragOffset.dx), Math.round(p.y - lyricDragOffset.dy));
      } catch (e) { stopLyricDrag(); }
    }, 16); // ~60fps,与鼠标移动同步
  } catch (e) { lyricDragOffset = null; }
});
ipcMain.on('lyric-drag-end', () => stopLyricDrag());

// 注册 IPC:渲染进程触发网页登录
ipcMain.handle('open-web-login', () => openWebLogin());
ipcMain.handle('close-web-login', () => { closeLoginWin(); });
