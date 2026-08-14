'use strict';

// 验证下载文件名生成:歌曲名-歌手_品质(端到端,真实请求一首歌)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { PlayerServer } = require('../core/server');

(async () => {
  const server = new PlayerServer({});
  const { songs } = await server.api.search('晴天 周杰伦', 3);
  if (!songs.length) { console.log('FAIL: 搜索无结果'); process.exit(1); }
  const t = songs.find((s) => s.name.includes('晴天')) || songs[0];

  let payload = null;
  const savePath = path.join(os.tmpdir(), `nebula-dl-name-${t.id}.bin`);
  server.onDownload = async (song) => {
    payload = song;
    return savePath;
  };
  const fakeRes = { _json: () => {}, writeHead() {}, end() {} };
  await server._download(fakeRes, t.id, 'lossless');

  const stat = fs.existsSync(savePath) ? fs.statSync(savePath) : null;
  if (stat) fs.unlinkSync(savePath);

  const baseName = payload ? payload.baseName : '';
  const ext = payload ? payload.ext : '';
  const hasSongName = baseName.includes('晴天');
  const hasArtist = baseName.includes('周杰伦');
  const hasQuality = baseName.includes('无损');
  const hasExt = ['mp3', 'flac', 'm4a', 'aac'].includes(ext);
  const wroteFile = !!stat && stat.size > 1000;

  console.log('baseName =', baseName, '| ext =', ext, '| 落盘 =', wroteFile ? 'OK' : 'FAIL');
  const ok = hasSongName && hasArtist && hasQuality && hasExt && wroteFile;
  console.log(ok ? 'PASS: 文件名 = 歌曲名-歌手_品质' : `FAIL: ${[
    !hasSongName && '缺歌名', !hasArtist && '缺歌手', !hasQuality && '缺品质',
    !hasExt && '扩展名异常', !wroteFile && '未落盘'
  ].filter(Boolean).join(',')}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
