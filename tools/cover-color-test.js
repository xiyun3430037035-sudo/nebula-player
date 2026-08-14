'use strict';

// 验证封面主色接口(依赖 Electron nativeImage,需用 electron 运行):
//   node_modules\.bin\electron.cmd tools\cover-color-test.js [封面URL]
const { app } = require('electron');
const { PlayerServer } = require('../core/server');

app.whenReady().then(async () => {
  const url = process.argv[2] || 'https://p2.music.126.net/rM6PP_YrU0HjFes4jggIOw==/109951172445882513.jpg';
  const server = new PlayerServer({});
  try {
    const c = await server.getCoverColor(url);
    console.log('cover color =', JSON.stringify(c));
    const c2 = await server.getCoverColor(url); // 命中缓存
    console.log('cached      =', JSON.stringify(c2));
    process.exit(c && typeof c.r === 'number' ? 0 : 1);
  } catch (e) {
    console.error('ERR', e);
    process.exit(1);
  }
});
