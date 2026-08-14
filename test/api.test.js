'use strict';

// 纯 Node 验证:weapi 加密 + 网易云接口连通性(不依赖 Electron)
const { NeteaseApi } = require('../core/api');

async function main() {
  const api = new NeteaseApi();
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  };

  // 1. 二维码 key(验证 weapi 加密与网络)
  try {
    const key = await api.qrCreateKey();
    check('login/qr/key 获取二维码 key', !!key, key ? `unikey=${key.slice(0, 8)}…` : '(返回空)');
  } catch (e) {
    check('login/qr/key 获取二维码 key', false, String(e && e.message));
  }

  // 2. 二维码 URL(本地生成)
  try {
    const key = await api.qrCreateKey();
    const url = api.qrLoginUrl(key);
    check('二维码登录 URL 生成', !!url && url.includes('codekey='), url.slice(0, 60));
  } catch (e) {
    check('二维码登录 URL 生成', false, String(e && e.message));
  }

  // 3. 搜索(未登录可用)
  try {
    const { songs, total } = await api.search('周杰伦', 5);
    check('cloudsearch 搜索', songs.length > 0, `命中 ${total} 首,首条: ${songs[0] ? songs[0].name + ' - ' + songs[0].artists : '无'}`);
  } catch (e) {
    check('cloudsearch 搜索', false, String(e && e.message));
  }

  // 4. 播放地址(未登录请求 lossless,链路应通,url 可能为 null)
  try {
    const { songs } = await api.search('晴天 周杰伦', 1);
    if (songs.length) {
      const map = await api.songUrl([songs[0].id], 'lossless');
      const r = map[songs[0].id];
      check('song/enhance/player/url/v1 播放地址', true, r ? `拿到 URL(br=${r.br})` : '(未登录,VIP 音质返回空属预期)');
    } else {
      check('song/enhance/player/url/v1 播放地址', false, '未找到测试歌曲');
    }
  } catch (e) {
    check('song/enhance/player/url/v1 播放地址', false, String(e && e.message));
  }

  // 5. 歌词
  try {
    const { songs } = await api.search('晴天 周杰伦', 1);
    if (songs.length) {
      const l = await api.lyric(songs[0].id);
      check('song/lyric 歌词', !!(l.lrc && l.lrc.length), `歌词 ${l.lrc.length} 字符`);
    } else {
      check('song/lyric 歌词', false, '无测试歌曲');
    }
  } catch (e) {
    check('song/lyric 歌词', false, String(e && e.message));
  }

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
