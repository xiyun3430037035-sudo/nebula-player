'use strict';

// 网易云音乐接口封装(基于 NeteaseCloudMusicApi 权威实现,weapi 加密,仅供个人自用研究)
const { weapi, eapi } = require('./crypto');
const { log } = require('./log');

const DOMAIN = 'https://music.163.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NMTID_CHARS = 'abcdef0123456789';
const EAPI_DOMAIN = 'https://interface.music.163.com';
// PC 客户端 UA:interface.music.163.com /eapi/* 需要桌面客户端指纹
const EAPI_UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152';
const PC_OS = {
  osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
  os: 'pc',
  appver: '3.1.17.204416'
};

function randNmtid() {
  let s = '';
  for (let i = 0; i < 32; i++) s += NMTID_CHARS[Math.floor(Math.random() * 16)];
  return s;
}

function generateDeviceId() {
  const hexChars = '0123456789ABCDEF';
  let s = '';
  for (let i = 0; i < 52; i++) s += hexChars[Math.floor(Math.random() * 16)];
  return s;
}

class NeteaseApi {
  constructor() {
    // 未登录基础 cookie
    this.cookie = `__remember_me=true; NMTID=${randNmtid()}`;
    this.deviceId = generateDeviceId(); // EAPI 客户端设备指纹,会话内固定
    this.profile = null;
  }

  async weapiRequest(path, data, extraCookie) {
    // csrf_token 需加密进 data(权威实现)
    const payload = { ...(data || {}), csrf_token: this._csrf() };
    const body = weapi(payload);
    const params = new URLSearchParams();
    params.append('params', body.params);
    params.append('encSecKey', body.encSecKey);
    const cookie = extraCookie ? `${this.cookie}; ${extraCookie}` : this.cookie;
    const resp = await fetch(`${DOMAIN}/weapi/${path}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Referer': 'https://music.163.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie
      },
      body: params.toString()
    });
    // 关键:合并响应 Set-Cookie(扫码轮询必须把服务端下发的临时 Cookie 累积带回,
    // 否则状态无法从 802 推进到 803)
    try {
      const setCookies = typeof resp.headers.getSetCookie === 'function'
        ? resp.headers.getSetCookie()
        : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
      if (setCookies.length) this.setCookie(setCookies.join(';'));
    } catch (e) { /* 忽略 */ }
    const text = await resp.text();
    // 200 空响应 = 风控/解密失败
    if (!text) throw new Error('EMPTY_RESPONSE 请求被网易云风控拦截,请稍后重试');
    return JSON.parse(text);
  }

  _csrf() {
    const m = /__csrf=([^;]+)/.exec(this.cookie);
    return m ? m[1] : '';
  }

  setCookie(cookie) {
    if (!cookie) return;
    // 合并:保留基础字段,覆盖登录态字段
    const parts = cookie.split(';').map((s) => s.trim()).filter(Boolean);
    const map = {};
    this.cookie.split(';').forEach((s) => {
      const i = s.indexOf('=');
      if (i > 0) map[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    parts.forEach((s) => {
      const i = s.indexOf('=');
      if (i > 0) map[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    this.cookie = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // ---------- PC 客户端 EAPI 请求(interface.music.163.com /eapi/*) ----------
  _pcHeader() {
    return {
      osver: PC_OS.osver,
      deviceId: this.deviceId,
      os: PC_OS.os,
      appver: PC_OS.appver,
      versioncode: '140',
      mobilename: '',
      buildver: Date.now().toString().slice(0, 10),
      resolution: '1920x1080',
      __csrf: this._csrf(),
      channel: 'netease',
      requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`
    };
  }

  _pcCookie(header) {
    // 客户端头字段优先,叠加已有会话 cookie(扫码 803 后 MUSIC_U 也要带上)
    const map = {};
    this.cookie.split(';').forEach((s) => {
      const i = s.indexOf('=');
      if (i > 0) map[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    Object.entries(header).forEach(([k, v]) => { map[k] = v; });
    return Object.entries(map)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('; ');
  }

  async eapiRequest(path, data) {
    const header = this._pcHeader();
    const payload = { ...(data || {}), header };
    const body = eapi(`/api/${path}`, payload);
    const resp = await fetch(`${EAPI_DOMAIN}/eapi/${path}`, {
      method: 'POST',
      headers: {
        'User-Agent': EAPI_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': this._pcCookie(header)
      },
      body: new URLSearchParams({ params: body.params }).toString()
    });
    // 关键:合并响应 Set-Cookie(扫码确认 803 的登录态靠响应头带出)
    try {
      const setCookies = typeof resp.headers.getSetCookie === 'function'
        ? resp.headers.getSetCookie()
        : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
      if (setCookies.length) this.setCookie(setCookies.join(';'));
    } catch (e) { /* 忽略 */ }
    const text = await resp.text();
    if (!text) throw new Error('EMPTY_RESPONSE 请求被网易云风控拦截,请稍后重试');
    return JSON.parse(text);
  }

  // ---------- 扫码登录(PC 版,type=3) ----------
  async qrCreateKey() {
    // type=3 是 PC 客户端会话:扫码时手机端显示"您正在登录 PC 版",
    // 与 Web 版(type=1)区分,绕开 Web 版 8821 风控
    const res = await this.eapiRequest('login/qrcode/unikey', { type: 3 });
    return res.unikey || (res.data && res.data.unikey) || null;
  }

  qrLoginUrl(key) {
    return `https://music.163.com/login?codekey=${encodeURIComponent(key)}`;
  }

  // 返回 { state, code, message, user } : pending / scanned / authorized / expired
  async qrCheck(key) {
    let res = await this.eapiRequest('login/qrcode/client/login', { key, type: 3 });
    let retried = false;
    if (Number(res.code) === 502 && !retried) {
      // 确认后服务端偶尔返回 502,再试一次
      retried = true;
      log('info', 'qr eapi 502 detected, retry once');
      res = await this.eapiRequest('login/qrcode/client/login', { key, type: 3 });
    }
    const code = Number(res.code);
    const common = { code, message: res.message || '' };
    if (code === 800) return { state: 'expired', ...common };
    if (code === 801) return { state: 'pending', ...common };
    if (code === 802) {
      // 已扫码,等待确认;接口会返回扫码用户信息
      return {
        state: 'scanned',
        ...common,
        user: res.nickname ? { nickname: res.nickname, avatarUrl: res.avatarUrl } : null
      };
    }
    if (code === 803) {
      // 登录 cookie 由 Set-Cookie 响应头带出(eapiRequest 已合并进 this.cookie),
      // 响应体带 cookie 字段时也取一遍,双保险
      if (Array.isArray(res.cookie)) this.setCookie(res.cookie.join(';'));
      else if (typeof res.cookie === 'string') this.setCookie(res.cookie);
      return { state: 'authorized', ...common };
    }
    if (code === 8821) {
      // 网易云风控:要求行为验证,第三方扫码登录被拒绝
      return { state: 'risk', ...common };
    }
    if (code === -460) return { state: 'expired', ...common };
    return { state: 'pending', ...common };
  }

  async loginStatus() {
    const res = await this.weapiRequest('w/nuser/account/get', { timestamp: Date.now() });
    if (res.code === 200 && res.profile) {
      this.profile = {
        uid: res.profile.userId,
        nickname: res.profile.nickname,
        avatarUrl: res.profile.avatarUrl,
        vipType: res.profile.vipType || 0
      };
      return this.profile;
    }
    return null;
  }

  // ---------- 歌单 ----------
  async userPlaylist(uid, limit = 200, offset = 0) {
    const res = await this.weapiRequest('user/playlist', { uid, limit, offset, timestamp: Date.now() });
    const list = (res.playlist || []).map((p) => ({
      id: p.id,
      name: p.name,
      count: p.trackCount,
      cover: p.coverImgUrl,
      creator: p.creator ? p.creator.nickname : ''
    }));
    return { playlists: list, total: res.count || 0 };
  }

  async playlistDetail(id) {
    const res = await this.weapiRequest('v6/playlist/detail', {
      id, n: 100000, s: 8, timestamp: Date.now()
    });
    const p = res.playlist || {};
    let tracks = (p.tracks || []).map((t) => this._fmtTrack(t));
    // v6 接口的 tracks 只返回前 ~20 首,完整歌曲在 trackIds 里,按 id 分批补齐
    const trackIds = (p.trackIds || []).map((x) => x.id).filter(Boolean);
    if (trackIds.length > tracks.length) {
      const have = new Set(tracks.map((t) => t.id));
      const need = trackIds.filter((x) => !have.has(x));
      const byId = new Map(tracks.map((t) => [t.id, t]));
      for (let i = 0; i < need.length; i += 200) {
        const batch = need.slice(i, i + 200);
        let detail = null;
        try {
          detail = await this.weapiRequest('v3/song/detail', {
            c: '[' + batch.map((x) => '{"id":' + x + '}').join(',') + ']'
          });
        } catch (e) { /* 单批失败跳过 */ }
        const list = ((detail && detail.songs) || []).map((t) => this._fmtTrack(t));
        list.forEach((t) => byId.set(t.id, t));
        if (!list.length) break; // 防死循环
      }
      tracks = trackIds.map((x) => byId.get(x)).filter(Boolean);
    }
    return { id: p.id, name: p.name, cover: p.coverImgUrl, tracks };
  }

  // ---------- 搜索 ----------
  async search(keywords, limit = 50, offset = 0) {
    const res = await this.weapiRequest('cloudsearch/pc', {
      s: keywords, type: 1, limit, offset, total: true, timestamp: Date.now()
    });
    const songs = (res.result && res.result.songs ? res.result.songs : []).map((t) => this._fmtTrack(t));
    return { songs, total: res.result ? res.result.songCount || 0 : 0 };
  }

  // ---------- 播放地址 ----------
  async songUrl(ids, level = 'lossless') {
    const res = await this.weapiRequest('song/enhance/player/url/v1', {
      ids: '[' + ids.join(',') + ']',
      level,
      encodeType: 'flac',
      timestamp: Date.now()
    });
    const map = {};
    (res.data || []).forEach((d) => {
      if (d && d.id && d.url) {
        map[d.id] = { url: d.url, br: d.br || 0, type: d.type || 'mp3' };
      }
    });
    return map;
  }

  // ---------- 歌词 ----------
  async lyric(id) {
    // 尝试多种参数形态,取第一个有歌词内容的
    const variants = [
      { id, timestamp: Date.now() },
      { id, lv: -1, kv: -1, tv: -1, timestamp: Date.now() },
      { id, lv: -1, tv: -1, timestamp: Date.now() }
    ];
    for (const data of variants) {
      const res = await this.weapiRequest('song/lyric', data);
      const lrc = (res.lrc && res.lrc.lyric) || '';
      if (lrc) return { lrc, tlyric: (res.tlyric && res.tlyric.lyric) || '' };
    }
    return { lrc: '', tlyric: '' };
  }

  // ---------- 歌曲百科(音乐百科基础信息) ----------
  async wikiSummary(id) {
    try {
      const res = await this.weapiRequest('song/play/about/block/page', { songId: id });
      return res;
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // ---------- 每日推荐歌曲(需要 os=ios cookie) ----------
  async recommendSongs() {
    try {
      const res = await this.weapiRequest('v3/discovery/recommend/songs', {}, 'os=ios');
      const daily = (res.data && res.data.dailySongs) || [];
      return {
        songs: daily.map((t) => this._fmtTrack(t)),
        reasons: (res.data && res.data.recommendReasons) || []
      };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // ---------- 推荐歌单 ----------
  async personalized(limit = 8) {
    try {
      const res = await this.weapiRequest('personalized/playlist', { limit, total: true, n: 1000 });
      const list = res.result || [];
      return list.map((p) => ({
        id: p.id,
        name: p.name,
        cover: (p.picUrl || p.coverImgUrl || '').replace(/^http:\/\//, 'https://'),
        count: p.playCount || 0
      }));
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // ---------- 歌单管理(创建/删除/加减歌曲) ----------
  // 这些接口需要 os=pc; appver=2.9.7 附加 cookie
  async playlistCreate(name, privacy = 0) {
    try {
      const res = await this.weapiRequest('playlist/create', { name, privacy, type: 'NORMAL' }, 'os=pc; appver=2.9.7');
      return { id: res.playlist ? res.playlist.id : null, ok: res.code === 200, code: res.code };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  async playlistDelete(id) {
    try {
      const res = await this.weapiRequest('playlist/remove', { ids: '[' + id + ']' }, 'os=pc; appver=2.9.7');
      return { ok: res.code === 200, code: res.code };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // op: 'add' | 'del'
  async playlistTracks(op, pid, trackIds) {
    try {
      const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
      const res = await this.weapiRequest('playlist/manipulate/tracks', {
        op,
        pid,
        trackIds: JSON.stringify(ids),
        imme: 'true'
      }, 'os=pc; appver=2.9.7');
      return { ok: res.code === 200, code: res.code, data: res };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // ---------- 歌曲详情(名称/译名/封面/发布时间) ----------
  async songDetail(id) {
    try {
      const res = await this.weapiRequest('v3/song/detail', { c: '[{"id":' + id + '}]' });
      const s = (res.songs || [])[0] || {};
      const al = s.al || {};
      return {
        id: s.id,
        name: s.name || '',
        alias: (s.alia || []).join(' / '),
        tns: (s.tns || []).join(' / '),
        album: al.name || '',
        cover: (al.picUrl || '').replace(/^http:\/\//, 'https://'),
        publishTime: s.publishTime || al.publishTime || 0,
        pop: s.pop || 0,
        artists: (s.ar || []).map((a) => a.name).join(' / ')
      };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // ---------- 红心收藏 ----------
  async likeSong(id, like = true) {
    try {
      const res = await this.weapiRequest('radio/like', { alg: 'itembased', trackId: id, like, time: '3' }, 'os=pc; appver=2.9.7');
      return { ok: res.code === 200, code: res.code };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  async likedList(uid) {
    try {
      const res = await this.weapiRequest('song/like/get', { uid });
      return { ids: res.ids || [], ok: res.code === 200, code: res.code };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // ---------- 私人 FM ----------
  async personalFm() {
    try {
      const res = await this.weapiRequest('v1/radio/get', {});
      const list = Array.isArray(res.data) ? res.data : [];
      return list.map((t) => this._fmtTrack(t));
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // ---------- 收听上报(计入网易云统计/年报) ----------
  async reportPlay(id, duration) {
    try {
      const ts = Date.now();
      const logs = JSON.stringify([{
        action: 'play',
        json: {
          type: 'song',
          id,
          sourceId: 0,
          contentId: '',
          ts,
          position: 0,
          duration: Math.max(30, Math.floor(duration || 0)),
          e_r: true,
          download: 0
        }
      }]);
      const res = await this.weapiRequest('feedback/weblog', { logs });
      return { ok: res.code === 200, code: res.code };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  // ---------- 歌手主页(头部/介绍/热门歌曲) ----------
  async artistInfo(id) {
    try {
      const head = await this.weapiRequest('artist/head/info/get', { id });
      const intro = await this.weapiRequest('artist/introduction', { id });
      return { head: head.data || {}, intro: intro.data || {} };
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  async artistTopSongs(id) {
    try {
      const res = await this.weapiRequest('artist/top/song', { id });
      return (res.songs || []).map((t) => this._fmtTrack(t));
    } catch (e) {
      return { error: String(e && e.message) };
    }
  }

  _fmtTrack(t) {
    return {
      id: t.id,
      name: t.name,
      artists: (t.ar || t.artists || []).map((a) => a.name).join(' / '),
      artistId: ((t.ar || t.artists || [])[0] || {}).id || 0,
      album: (t.al || t.album || {}).name || '',
      cover: ((t.al || t.album || {}).picUrl || '').replace(/^http:\/\//, 'https://'),
      duration: t.dt || t.duration || 0,
      fee: t.fee != null ? t.fee : 0,
      vip: (t.fee === 1 || t.fee === 4) || false
    };
  }
}

module.exports = { NeteaseApi, UA };
