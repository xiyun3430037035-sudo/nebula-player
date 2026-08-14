'use strict';

// 本地代理服务:持有网易云登录态,向渲染进程提供接口,
// 并代理音频流(带 UA/Referer 绕防盗链,支持 Range 拖动)与下载。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { NeteaseApi, UA } = require('./api');
const logger = require('./log');

const REFERER = 'https://music.163.com';

// 解析 Cookie 文本:兼容 "k=v; k2=v2" 与浏览器复制的表格格式(自动筛 music.163.com 域)
function parseCookiesFromText(text) {
  const map = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length >= 3) {
      // 表格格式:name value domain path expires size httpOnly secure sameSite ...
      const name = fields[0].trim();
      const value = fields[1] ? fields[1].trim() : '';
      const domain = fields[2] || '';
      if (name && domain && domain.includes('music.163.com') && value) {
        map[name] = value;
      }
      continue;
    }
    // 普通 key=value 格式(分号或换行分隔)
    const parts = line.split(';');
    for (const part of parts) {
      const i = part.indexOf('=');
      if (i > 0) {
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k && v) map[k] = v;
      }
    }
  }
  return map;
}

// 清理 Windows 非法文件名:去掉 \ / : * ? " < > | 与控制字符,收尾的点和空格
function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
}

class PlayerServer {
  constructor(options = {}) {
    this.api = new NeteaseApi();
    this.storePath = options.storePath || null;
    this.onDownload = options.onDownload || null; // (song) => savePath | null
    this._colorCache = new Map(); // 封面 URL -> {r,g,b} | null
    if (options.logPath) logger.init(options.logPath);
    this.levels = {
      standard: { label: '标准' },
      higher: { label: '高品' },
      exhigh: { label: '超高' },
      lossless: { label: '无损' },
      hires: { label: 'Hi-Res' }
    };
    this._loadStore();
  }

  // ---------- 登录态持久化(双备份,防安装/写入异常丢失) ----------
  _loadStore() {
    if (!this.storePath) return;
    const read = (p) => {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
    };
    let data = read(this.storePath);
    if (!data) {
      data = read(this.storePath + '.bak');
      if (data && data.cookie) logger.log('warn', '主 session 缺失,已从备份恢复');
    }
    if (data && data.cookie) this.api.setCookie(data.cookie);
  }

  _saveStore() {
    if (!this.storePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const data = JSON.stringify({ cookie: this.api.cookie });
      fs.writeFileSync(this.storePath, data);
      fs.writeFileSync(this.storePath + '.bak', data);
    } catch (e) { /* 忽略 */ }
  }

  // 启动时同步校验登录态(await 完成后再建窗口)
  async initLogin() {
    this._loadStore();
    if (this.api.cookie) {
      try {
        this.api.profile = await this.api.loginStatus();
        if (this.api.profile) logger.log('info', 'initLogin ok: ' + this.api.profile.nickname);
      } catch (e) {
        logger.log('warn', 'initLogin failed: ' + String(e && e.message));
      }
    }
    return !!this.api.profile;
  }

  _saveStore() {
    if (!this.storePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify({ cookie: this.api.cookie }));
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 启动 ----------
  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  // ---------- 请求处理 ----------
  _handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const q = url.searchParams;
    try {
      if (p === '/api/health') return this._json(res, { ok: true, port: this.port });
      if (p === '/api/levels') return this._json(res, { levels: this.levels });
      if (p === '/api/log') return this._json(res, { log: logger.read(300) });
      if (p === '/api/login/qr') return this._qr(res);
      if (p === '/api/login/status') return this._loginStatus(res);
      if (p === '/api/login/cookie') return this._cookieLogin(req, res);
      if (p === '/api/profile') return this._profile(res);
      if (p === '/api/logout') return this._logout(res);
      if (p === '/api/playlists') return this._playlists(res, q.get('offset') || 0);
      if (p === '/api/playlist') return this._playlist(res, q.get('id'));
      if (p === '/api/playlist/create') return this._playlistCreate(req, res);
      if (p === '/api/playlist/delete') return this._playlistDelete(req, res);
      if (p === '/api/playlist/tracks') return this._playlistTracks(req, res);
      if (p === '/api/search') return this._search(res, q.get('q'), q.get('offset') || 0);
      if (p === '/api/song/url') return this._songUrl(res, q.get('id'), q.get('level'));
      if (p === '/api/lyric') return this._lyric(res, q.get('id'));
      if (p === '/api/stream') { this._stream(req, res, q.get('url')); return; }
      if (p === '/api/log/event') { this._logEvent(req, res); return; }
      if (p === '/api/download') return this._download(res, q.get('id'), q.get('level'));
      if (p === '/api/recommend/songs') return this._recommendSongs(res);
      if (p === '/api/personalized') return this._personalized(res, q.get('limit'));
      if (p === '/api/wiki') return this._wiki(res, q.get('id'));
      if (p === '/api/song/info') return this._songInfo(res, q.get('id'));
      if (p === '/api/cover/color') return this._coverColor(res, q.get('url'));
      if (p === '/api/report/play') return this._reportPlay(req, res);
      if (p === '/api/like') return this._like(req, res);
      if (p === '/api/likes') return this._likes(res, q.get('uid'));
      if (p === '/api/fm') return this._fm(res);
      if (p === '/api/artist') return this._artist(res, q.get('id'));
      this._json(res, { error: 'not found' }, 404);
    } catch (e) {
      this._json(res, { error: String(e && e.message || e) }, 500);
    }
  }

  _json(res, data, code = 200) {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  // 渲染进程上报事件(播放错误等),写入日志便于排查
  _logEvent(req, res) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        logger.log('info', '[renderer] ' + String(data.msg || ''));
      } catch (e) { /* 忽略 */ }
      this._json(res, { ok: true });
    });
  }

  async _qr(res) {
    const key = await this.api.qrCreateKey();
    if (!key) return this._json(res, { error: '二维码获取失败' }, 502);
    const qrurl = this.api.qrLoginUrl(key);
    let qrimg = '';
    try {
      qrimg = await QRCode.toDataURL(qrurl, { width: 280, margin: 1 });
    } catch (e) { /* 前端降级为无图 */ }
    this._qrKey = key;
    this._json(res, { key, qrurl, qrimg });
  }

  async _loginStatus(res) {
    if (!this._qrKey) return this._json(res, { state: 'idle' });
    try {
      const st = await this.api.qrCheck(this._qrKey);
      logger.log('info', `qr poll => state=${st.state} code=${st.code} msg="${st.message || ''}"${st.user ? ' user=' + st.user.nickname : ''}`);
      if (st.state === 'authorized') {
        // 扫码授权成功:先落盘登录态;取用户信息失败也不阻塞登录
        this._saveStore();
        let profile = null;
        try {
          profile = await this.api.loginStatus();
          logger.log('info', 'loginStatus after qr: ' + (profile ? 'ok ' + profile.nickname : 'null'));
        } catch (e) {
          logger.log('warn', 'loginStatus after qr failed: ' + String(e && e.message));
        }
        this._json(res, { state: 'authorized', profile });
      } else {
        this._json(res, { state: st.state, user: st.user || null });
      }
    } catch (e) {
      // 轮询本身异常时按等待处理,避免前端误判
      logger.log('warn', 'qr poll exception: ' + String(e && e.message));
      this._json(res, { state: 'pending' });
    }
  }

  async _profile(res) {
    if (!this.api.cookie) return this._json(res, { logged: false, hasCookie: false });
    let profile = this.api.profile;
    if (!profile) profile = await this.api.loginStatus();
    this._json(res, { logged: !!profile, hasCookie: true, profile });
  }

  async _logout(res) {
    this.api.cookie = '';
    this.api.profile = null;
    if (this.storePath) {
      try { fs.unlinkSync(this.storePath); } catch (e) { /* 忽略 */ }
    }
    this._json(res, { ok: true });
  }

  // 统一应用 Cookie 并验证登录态(网页登录窗口与手动粘贴共用)
  async applyCookie(rawCookieText) {
    const map = parseCookiesFromText(rawCookieText);
    const keys = Object.keys(map);
    if (!map.MUSIC_U && !map.MUSIC_A) {
      return { ok: false, error: '未获取到 MUSIC_U 登录凭证' };
    }
    this.api.setCookie(keys.map((k) => `${k}=${map[k]}`).join('; '));
    let profile = null;
    try {
      profile = await this.api.loginStatus();
    } catch (e) {
      logger.log('warn', 'applyCookie status failed: ' + String(e && e.message));
    }
    if (!profile) return { ok: false, error: 'Cookie 无效或已过期,请重新登录' };
    this._saveStore();
    logger.log('info', `cookie login ok: ${profile.nickname} (${keys.length} cookies)`);
    return { ok: true, profile };
  }

  // Cookie 登录(浏览器导入):POST { cookie: "表格或 k=v 文本" }
  async _cookieLogin(req, res) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const raw = String(data.cookie || '').trim();
        if (!raw) return this._json(res, { error: 'Cookie 不能为空' }, 400);
        const r = await this.applyCookie(raw);
        this._json(res, r.ok ? { ok: true, profile: r.profile } : { error: r.error });
      } catch (e) {
        this._json(res, { error: String(e && e.message) }, 500);
      }
    });
  }

  async _playlists(res, offset) {
    if (!this.api.cookie) return this._json(res, { error: 'not logged in' }, 401);
    const profile = this.api.profile || await this.api.loginStatus();
    if (!profile) return this._json(res, { error: 'login expired' }, 401);
    const data = await this.api.userPlaylist(profile.uid, 200, Number(offset));
    this._json(res, data);
  }

  async _playlist(res, id) {
    if (!id) return this._json(res, { error: 'no id' }, 400);
    const data = await this.api.playlistDetail(Number(id));
    this._json(res, data);
  }

  async _search(res, q, offset) {
    if (!q) return this._json(res, { songs: [], total: 0 });
    const data = await this.api.search(q, 50, Number(offset));
    this._json(res, data);
  }

  async _songUrl(res, id, level) {
    if (!id) return this._json(res, { error: 'no id' }, 400);
    const lv = this.levels[level] ? level : 'lossless';
    const map = await this.api.songUrl([Number(id)], lv);
    const item = map[id] || null;
    // 注意:必须返回 url 字符串,前端直接用于 audio.src
    this._json(res, { url: item ? item.url : null, br: item ? item.br : 0, level: lv });
  }

  async _lyric(res, id) {
    if (!id) return this._json(res, { error: 'no id' }, 400);
    const data = await this.api.lyric(Number(id));
    this._json(res, data);
  }

  // ---------- 每日推荐 ----------
  async _recommendSongs(res) {
    const data = await this.api.recommendSongs();
    this._json(res, data);
  }

  // ---------- 推荐歌单 ----------
  async _personalized(res, limit) {
    const n = Math.min(Math.max(Number(limit) || 8, 1), 30);
    const data = await this.api.personalized(n);
    this._json(res, Array.isArray(data) ? { playlists: data } : data);
  }

  // ---------- 歌曲百科 ----------
  async _wiki(res, id) {
    if (!id) return this._json(res, { error: 'no id' }, 400);
    const data = await this.api.wikiSummary(Number(id));
    this._json(res, data);
  }

  // ---------- 歌曲详情 ----------
  async _songInfo(res, id) {
    if (!id) return this._json(res, { error: 'no id' }, 400);
    const data = await this.api.songDetail(Number(id));
    this._json(res, data);
  }

  // ---------- 封面主色(供前端高亮自适应背景) ----------
  async _coverColor(res, url) {
    if (!url) return this._json(res, { error: 'no url' }, 400);
    const c = await this.getCoverColor(String(url));
    if (!c) return this._json(res, { error: 'no color' }, 502);
    this._json(res, c);
  }

  getCoverColor(url) {
    if (this._colorCache && this._colorCache.has(url)) return Promise.resolve(this._colorCache.get(url));
    return this._fetchCoverColor(url).then((c) => {
      if (this._colorCache.size > 200) this._colorCache.clear();
      this._colorCache.set(url, c);
      return c;
    });
  }

  async _fetchCoverColor(url) {
    try {
      const nativeImage = require('electron').nativeImage; // 仅 Electron 主进程可用
      const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': REFERER } });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return null;
      const small = img.resize({ width: 16, height: 16 });
      const bmp = small.toBitmap(); // BGRA 预乘
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i + 3 < bmp.length; i += 4) {
        r += bmp[i + 2]; g += bmp[i + 1]; b += bmp[i]; n++;
      }
      if (!n) return null;
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    } catch (e) {
      logger.log('warn', 'cover color failed: ' + String(e && e.message));
      return null;
    }
  }

  // ---------- 收听上报 ----------
  async _reportPlay(req, res) {
    try {
      const data = await this._readBody(req);
      const id = Number(data.id);
      const duration = Math.max(30, Number(data.duration) || 30);
      if (!id) return this._json(res, { error: 'no id' }, 400);
      const r = await this.api.reportPlay(id, duration);
      this._json(res, r);
    } catch (e) {
      this._json(res, { error: String(e && e.message) }, 400);
    }
  }

  // ---------- 红心收藏 ----------
  async _like(req, res) {
    try {
      const data = await this._readBody(req);
      const id = Number(data.id);
      if (!id) return this._json(res, { error: 'no id' }, 400);
      const like = data.like !== false && data.like !== 'false';
      const r = await this.api.likeSong(id, like);
      this._json(res, r);
    } catch (e) {
      this._json(res, { error: String(e && e.message) }, 400);
    }
  }

  async _likes(res, uid) {
    if (!uid) return this._json(res, { error: 'no uid' }, 400);
    const r = await this.api.likedList(Number(uid));
    this._json(res, r);
  }

  // ---------- 私人 FM ----------
  async _fm(res) {
    const r = await this.api.personalFm();
    this._json(res, Array.isArray(r) ? { songs: r } : r);
  }

  // ---------- 歌手主页 ----------
  async _artist(res, id) {
    if (!id) return this._json(res, { error: 'no id' }, 400);
    const nid = Number(id);
    const info = await this.api.artistInfo(nid);
    const songs = await this.api.artistTopSongs(nid);
    if (info.error || songs.error) return this._json(res, { error: info.error || songs.error });
    // 提取头部信息
    const a = info.head.artist || info.head || {};
    const introText = (info.intro.briefDesc) || (info.head.artist && info.head.artist.briefDesc) || '';
    this._json(res, {
      id: nid,
      name: a.name || '',
      avatar: (a.avatar || a.picUrl || '').replace(/^http:\/\//, 'https://'),
      fans: a.fansCount || 0,
      alias: (a.alias || []).join(' / '),
      briefDesc: introText,
      songs
    });
  }

  // 读取 POST JSON body(统一 helper)
  _readBody(req, max = 256 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > max) { req.destroy(); reject(new Error('body too large')); }
      });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('invalid json')); }
      });
      req.on('error', reject);
    });
  }

  // ---------- 歌单管理(创建/删除/加减歌曲) ----------
  async _playlistCreate(req, res) {
    try {
      const data = await this._readBody(req);
      const name = String(data.name || '').trim();
      if (!name) return this._json(res, { error: '歌单名不能为空' }, 400);
      const r = await this.api.playlistCreate(name);
      this._json(res, r);
    } catch (e) {
      this._json(res, { error: String(e && e.message) }, 400);
    }
  }

  async _playlistDelete(req, res) {
    try {
      const data = await this._readBody(req);
      const id = Number(data.id);
      if (!id) return this._json(res, { error: 'no id' }, 400);
      const r = await this.api.playlistDelete(id);
      this._json(res, r);
    } catch (e) {
      this._json(res, { error: String(e && e.message) }, 400);
    }
  }

  async _playlistTracks(req, res) {
    try {
      const data = await this._readBody(req);
      const op = data.op === 'del' ? 'del' : 'add';
      const pid = Number(data.pid);
      const ids = Array.isArray(data.trackIds) ? data.trackIds.map(Number) : [Number(data.trackIds)];
      if (!pid || !ids.length || ids.some((i) => !i)) return this._json(res, { error: 'bad params' }, 400);
      const r = await this.api.playlistTracks(op, pid, ids);
      this._json(res, r);
    } catch (e) {
      this._json(res, { error: String(e && e.message) }, 400);
    }
  }

  // ---------- 音频流代理(fetch 跟随重定向 + 智能识别音频类型) ----------
  async _stream(req, res, targetUrl) {
    if (!targetUrl) return this._json(res, { error: 'no url' }, 400);
    const range = req.headers.range || '';
    const headers = { 'User-Agent': UA, 'Referer': REFERER };
    if (range) headers['Range'] = range;
    try {
      const up = await fetch(targetUrl, { headers, redirect: 'follow' });
      let ctype = up.headers.get('content-type') || '';
      // Chromium 的 <audio> 对 octet-stream 会拒绝播放,按 URL 后缀识别
      if (!ctype || ctype.includes('octet-stream')) {
        ctype = /\.(flac)(\?|$)/i.test(targetUrl) ? 'audio/flac'
          : /\.(m4a|aac|mp4)(\?|$)/i.test(targetUrl) ? 'audio/mp4'
          : /\.(mp3)(\?|$)/i.test(targetUrl) ? 'audio/mpeg'
          : 'audio/mpeg';
      }
      const h = {
        'Content-Type': ctype,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      };
      const cl = up.headers.get('content-length');
      if (cl) h['Content-Length'] = cl;
      const cr = up.headers.get('content-range');
      if (cr) h['Content-Range'] = cr;
      res.writeHead(up.status, h);
      logger.log('info', `stream ${up.status} ${ctype} len=${cl || '?'} <- ${targetUrl.slice(0, 70)}`);
      const reader = up.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise((ok) => res.once('drain', ok));
        }
      } catch (e) { /* 客户端断开 */ }
      res.end();
    } catch (e) {
      logger.log('warn', 'stream error: ' + String(e && e.message));
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'stream failed' }));
      } else {
        res.end();
      }
    }
  }

  // ---------- 下载 ----------
  async _download(res, id, level) {
    if (!id) return this._json(res, { error: 'no id' }, 400);
    const lv = this.levels[level] ? level : 'lossless';
    const levelLabel = this.levels[lv].label;
    try {
      const map = await this.api.songUrl([Number(id)], lv);
      const song = map[id];
      if (!song || !song.url) return this._json(res, { error: '无法获取播放地址(可能无版权或需要VIP)' }, 403);
      // 歌曲信息 → 文件名:歌曲名-歌手_品质
      let detail = null;
      try { detail = await this.api.songDetail(Number(id)); } catch (e) { /* 拿不到就用默认名 */ }
      // 多歌手"周杰伦 / A-LNK"统一转成 "-",并折叠连续横线(歌手名可能自带尾横线)
      const toFilePart = (s) => sanitizeFileName(
        String(s || '').replace(/\s*\/\s*/g, '-').replace(/-{2,}/g, '-')
      );
      const songName = toFilePart(detail && detail.name);
      const artist = toFilePart(detail && detail.artists);
      const baseName = [songName, artist].filter(Boolean).join('-') || `song_${id}`;
      const ext = ['mp3', 'flac', 'm4a', 'aac'].includes(song.type)
        ? song.type
        : /\.(flac)(\?|$)/i.test(song.url) ? 'flac'
          : /\.(m4a|aac|mp4)(\?|$)/i.test(song.url) ? 'm4a'
            : 'mp3';
      if (this.onDownload) {
        const savePath = await this.onDownload({
          id: Number(id), level: lv, url: song.url,
          name: detail ? detail.name : '',
          artist: detail ? detail.artists : '',
          baseName: `${baseName}_${levelLabel}`,
          ext
        });
        if (!savePath) return this._json(res, { cancelled: true });
        await this._pipeToFile(song.url, savePath);
        return this._json(res, { ok: true, path: savePath });
      }
      const name = path.join(process.cwd(), `${baseName}_${levelLabel}.${ext}`);
      await this._pipeToFile(song.url, name);
      this._json(res, { ok: true, path: name });
    } catch (e) {
      this._json(res, { error: String(e && e.message || e) }, 500);
    }
  }

  _pipeToFile(url, savePath) {
    return new Promise((resolve, reject) => {
      const headers = { 'User-Agent': UA, 'Referer': REFERER };
      const mod = url.startsWith('https:') ? https : http;
      const upstream = mod.get(url, { headers }, (up) => {
        if (up.statusCode >= 400) {
          reject(new Error('上游返回 ' + up.statusCode));
          return;
        }
        const out = fs.createWriteStream(savePath);
        up.pipe(out);
        up.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
      });
      upstream.on('error', reject);
    });
  }
}

module.exports = { PlayerServer, parseCookiesFromText, sanitizeFileName };
