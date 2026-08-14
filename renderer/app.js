'use strict';

/* ============ 全局状态 ============ */
const state = {
  port: 0,
  profile: null,
  playlists: [],
  queue: [],
  index: -1,
  playing: false,
  level: 'lossless',
  playMode: 'order',       // order / shuffle / repeat
  lastQueue: [],           // 最近一次歌单渲染的歌曲(供"播放全部")
  currentPlaylistName: '我的歌单',
  currentPlId: null,       // 当前打开的歌单 id(供"从歌单移除")
  lastView: 'playlist',    // 进入歌词前的视图,用于"再点一下回来"
  likedIds: new Set(),     // 红心歌曲 id 集合
  fmMode: false,           // 私人 FM 模式
  lyric: [],          // [{ t, text, trans }]
  lyricTimer: null,
  seeking: false
};

const $ = (s) => document.querySelector(s);
const audio = $('#audio');

/* ============ API ============ */
async function api(path, opts) {
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, opts);
  return res.json();
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

/* ============ 初始化 ============ */
async function init() {
  state.port = new URLSearchParams(location.search).get('port') || '0';
  const ver = new URLSearchParams(location.search).get('version');
  if (ver) $('#brand-version').textContent = 'v' + ver;
  loadSettings();
  loadArchived();
  applySettings();
  loadBalanceCache(); // 音量平衡:恢复已校准的歌曲增益
  initSpectrum();
  bindEvents();
  // 铁律:启动永远先进主界面,任何情况不自动弹登录页。
  // 登录页只在用户主动点击时才出现(未登录用户卡 / 歌单空态提示)。
  await enterMainQuietly();
  retryProfileThenLogin();
}

// 静默进入主界面:凭证有效则加载歌单;无效则显示"点击登录"空态,绝不弹登录页
async function enterMainQuietly() {
  renderUser();
  switchView('home');
  const data = await api('/api/playlists').catch(() => null);
  if (data && !data.error) {
    state.playlists = data.playlists;
    renderPlaylistList(data.playlists);
    loadHome(); // 启动进首页(日推 + 推荐歌单)
    setNavActive('home');
    restorePlayback(true); // 登录有效:恢复队列与播放进度
    loadLiked();           // 红心状态
  } else {
    $('#pl-title').textContent = '我的歌单';
    $('#pl-sub').textContent = '';
    $('#song-list').innerHTML = '<div class="empty-tip login-hint" id="login-hint">登录已失效,点击这里重新登录</div>';
    const hint = $('#login-hint');
    if (hint) hint.addEventListener('click', showLogin);
    switchView('playlist');
    setNavActive('discover');
    restorePlayback(false); // 未登录:仅恢复队列显示
  }
}

// 后台每 2s 复核登录态,成功后刷新界面;确认失效则提示(不弹登录页)
async function retryProfileThenLogin() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const q = await api('/api/profile');
      if (q && q.logged && q.profile) {
        state.profile = q.profile;
        renderUser();
        if (!$('#playlist-list').children.length) {
          const data = await api('/api/playlists').catch(() => null);
          if (data && !data.error) {
            renderPlaylistList(data.playlists);
            loadHome();
            switchView('home');
            setNavActive('home');
            loadLiked();
          }
        }
        return;
      }
    } catch (e) { /* 忽略 */ }
  }
  if (!state.profile) {
    toast('登录已失效,请点击重新登录');
    $('#song-list').innerHTML = '<div class="empty-tip login-hint">登录已失效,点击这里重新登录</div>';
    const hint = $('#song-list .login-hint');
    if (hint) hint.addEventListener('click', showLogin);
  }
}

/* ---------- 歌单归档(右键归档,设置中恢复) ---------- */
let archived = [];
function loadArchived() {
  try { archived = JSON.parse(localStorage.getItem('nebula-archived') || '[]'); } catch (e) { archived = []; }
}
function saveArchived() {
  try { localStorage.setItem('nebula-archived', JSON.stringify(archived)); } catch (e) { /* 忽略 */ }
}
function isArchived(id) { return archived.some((a) => String(a.id) === String(id)); }

function archivePlaylist(pl) {
  if (isArchived(pl.id)) return;
  archived.push({ id: String(pl.id), name: pl.name });
  saveArchived();
  const list = state.playlists.filter((p) => !isArchived(p.id));
  renderPlaylistList(list);
  toast('已归档,可在设置中恢复');
}

function unarchivePlaylist(id) {
  archived = archived.filter((a) => String(a.id) !== String(id));
  saveArchived();
  renderArchivedSettings();
  const list = state.playlists.filter((p) => !isArchived(p.id));
  renderPlaylistList(list);
  toast('已恢复');
}

// 右键迷你菜单(歌单)
function showPlMenu(x, y, pl) {
  closePlMenu();
  const m = document.createElement('div');
  m.id = 'pl-menu';
  m.className = 'pl-menu';
  m.style.left = Math.min(x, window.innerWidth - 160) + 'px';
  m.style.top = Math.min(y, window.innerHeight - 110) + 'px';
  m.innerHTML = `
    <div class="pl-menu-item" id="pl-menu-archive">归档歌单</div>
    <div class="pl-menu-item danger" id="pl-menu-del">删除歌单</div>`;
  m.querySelector('#pl-menu-archive').addEventListener('click', () => { archivePlaylist(pl); closePlMenu(); });
  m.querySelector('#pl-menu-del').addEventListener('click', () => { closePlMenu(); deletePlaylist(pl); });
  document.body.appendChild(m);
}
function closePlMenu() {
  const m = document.getElementById('pl-menu');
  if (m) m.remove();
}

// 歌曲右键菜单
function showSongMenu(x, y, track) {
  closePlMenu();
  const m = document.createElement('div');
  m.id = 'pl-menu';
  m.className = 'pl-menu';
  m.style.left = Math.min(x, window.innerWidth - 170) + 'px';
  m.style.top = Math.min(y, window.innerHeight - 210) + 'px';
  let html = '<div class="pl-menu-item" id="song-menu-add">加入歌单</div>';
  if (track.artistId) html += '<div class="pl-menu-item" id="song-menu-artist">查看歌手</div>';
  html += '<div class="pl-menu-item" id="song-menu-copy-name">复制歌名</div>';
  html += '<div class="pl-menu-item" id="song-menu-copy-lyric">复制歌词</div>';
  html += '<div class="pl-menu-item" id="song-menu-share">分享</div>';
  if (state.currentPlId) {
    html += '<div class="pl-menu-item danger" id="song-menu-del">从歌单移除</div>';
  }
  m.innerHTML = html;
  m.querySelector('#song-menu-add').addEventListener('click', () => { closePlMenu(); openAddPl(track); });
  const artist = m.querySelector('#song-menu-artist');
  if (artist) artist.addEventListener('click', () => { closePlMenu(); openArtist(track.artistId); });
  m.querySelector('#song-menu-copy-name').addEventListener('click', () => {
    closePlMenu();
    if (window.player && window.player.copyText) {
      window.player.copyText(track.name);
      toast('已复制歌名');
    }
  });
  m.querySelector('#song-menu-copy-lyric').addEventListener('click', () => {
    closePlMenu();
    copyCurrentLyric(track);
  });
  m.querySelector('#song-menu-share').addEventListener('click', () => { closePlMenu(); copySongShare(track); });
  const del = m.querySelector('#song-menu-del');
  if (del) del.addEventListener('click', () => { closePlMenu(); removeFromPlaylist(track); });
  document.body.appendChild(m);
}

// 复制当前歌词(右键歌曲为当前播放歌曲时复制其歌词全文)
function copyCurrentLyric(track) {
  if (!window.player || !window.player.copyText) return;
  if (String(state.queue[state.index] && state.queue[state.index].id) !== String(track.id)) {
    toast('请先播放这首歌再复制歌词');
    return;
  }
  if (!state.lyric.length) { toast('暂无歌词'); return; }
  const text = state.lyric.map((l) => (l.trans ? `${l.text}\n${l.trans}` : l.text)).join('\n');
  window.player.copyText(text);
  toast(`已复制歌词(${state.lyric.length} 行)`);
}

// ---------- 歌手主页 ----------
let artistLastView = 'home';
async function openArtist(id) {
  if (!id) { toast('暂无歌手信息'); return; }
  artistLastView = document.querySelector('.view.active').id.replace('view-', '') || 'home';
  $('#artist-name').textContent = '加载中…';
  $('#artist-alias').textContent = '';
  $('#artist-fans').textContent = '';
  $('#artist-intro').textContent = '';
  $('#artist-cover').style.visibility = 'hidden';
  $('#artist-songs').innerHTML = '<div class="empty-tip">加载中…</div>';
  switchView('artist');
  const data = await api(`/api/artist?id=${id}`).catch(() => null);
  if (!data || data.error) {
    $('#artist-name').textContent = '加载失败';
    $('#artist-songs').innerHTML = '<div class="empty-tip">歌手信息加载失败</div>';
    return;
  }
  $('#artist-name').textContent = data.name || '未知歌手';
  $('#artist-alias').textContent = data.alias ? `别名: ${data.alias}` : '';
  $('#artist-fans').textContent = data.fans ? `粉丝 ${fmtCount(data.fans)}` : '';
  const img = $('#artist-cover');
  if (data.avatar) { img.src = data.avatar; img.style.visibility = 'visible'; }
  $('#artist-intro').textContent = data.briefDesc || '';
  $('#artist-intro').style.display = data.briefDesc ? '' : 'none';
  if (data.songs && data.songs.length) {
    renderSongList($('#artist-songs'), data.songs, true);
  } else {
    $('#artist-songs').innerHTML = '<div class="empty-tip">暂无热门歌曲</div>';
  }
}

// ---------- 歌单管理(创建/删除/加减歌曲) ----------
function postJson(path, body) {
  return fetch(`http://127.0.0.1:${state.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then((r) => r.json()).catch(() => ({ error: '网络异常' }));
}

async function createPlaylist(name) {
  if (!name) { toast('请输入歌单名'); return; }
  const r = await postJson('/api/playlist/create', { name });
  if (r.ok) {
    toast('歌单已创建');
    await loadPlaylists();
    closePlName();
  } else {
    toast(r.error || '创建失败');
  }
}

async function deletePlaylist(pl) {
  const ok = window.confirm(`确定删除歌单「${pl.name}」?删除后不可恢复`);
  if (!ok) return;
  const r = await postJson('/api/playlist/delete', { id: pl.id });
  if (r.ok) {
    toast('歌单已删除');
    if (String(state.currentPlId) === String(pl.id)) {
      state.currentPlId = null;
      switchView('home');
      setNavActive('home');
    }
    await loadPlaylists();
  } else {
    toast(r.error || '删除失败');
  }
}

async function openAddPl(track) {
  if (!state.playlists.length) { toast('没有可用的歌单,请先创建'); return; }
  const list = state.playlists.filter((p) => !isArchived(p.id));
  $('#add-pl-list').innerHTML = list.length
    ? list.map((p) => `<div class="add-pl-row" data-id="${p.id}">
        <span class="ap-name">${esc(p.name)}</span>
        <span class="ap-count">${p.count}</span>
      </div>`).join('')
    : '<div class="empty-tip">暂无歌单</div>';
  $('#add-pl-list').querySelectorAll('.add-pl-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const r = await postJson('/api/playlist/tracks', { op: 'add', pid: row.dataset.id, trackIds: [track.id] });
      if (r.ok) {
        toast(`已加入「${row.querySelector('.ap-name').textContent}」`);
        $('#add-pl-overlay').classList.add('hidden');
      } else {
        toast(r.error || '添加失败');
      }
    });
  });
  $('#add-pl-overlay').classList.remove('hidden');
}

async function removeFromPlaylist(track) {
  if (!state.currentPlId) { toast('不在歌单中'); return; }
  const r = await postJson('/api/playlist/tracks', { op: 'del', pid: state.currentPlId, trackIds: [track.id] });
  if (r.ok) {
    toast(`已从歌单移除「${track.name}」`);
    // 刷新当前歌单内容
    const name = state.currentPlaylistName;
    await openPlaylist(state.currentPlId, name, null);
    // 同步队列:移除队列中该曲
    state.queue = state.queue.filter((t) => String(t.id) !== String(track.id));
    if (state.index >= state.queue.length) state.index = Math.max(0, state.queue.length - 1);
  } else {
    toast(r.error || '移除失败');
  }
}

function openPlName() {
  $('#pl-name-input').value = '';
  $('#pl-name-overlay').classList.remove('hidden');
  setTimeout(() => $('#pl-name-input').focus(), 60);
}
function closePlName() {
  $('#pl-name-overlay').classList.add('hidden');
}

// 渲染设置面板中的"已归档歌单"入口行(数量)+ 同步刷新管理弹窗
function renderArchivedSettings() {
  const entry = $('#archived-entry');
  if (!entry) return;
  entry.style.display = archived.length ? 'flex' : 'none';
  $('#archived-count').textContent = archived.length;
  // 若管理弹窗开着,同步刷新列表
  if (!$('#archived-overlay').classList.contains('hidden')) renderArchivedManage();
}

// 归档管理二级页面(独立弹窗,列表可滚动)
function renderArchivedManage() {
  const box = $('#archived-manage');
  $('#archived-total').textContent = `(${archived.length})`;
  if (!archived.length) {
    box.innerHTML = '<div class="empty-tip">暂无归档歌单</div>';
    return;
  }
  box.innerHTML = archived.map((a) => `
    <div class="archived-row">
      <span class="archived-name" title="${esc(a.name)}">${esc(a.name)}</span>
      <button class="archived-restore" data-id="${esc(a.id)}">恢复</button>
    </div>`).join('');
  box.querySelectorAll('.archived-restore').forEach((btn) => {
    btn.addEventListener('click', () => unarchivePlaylist(btn.dataset.id));
  });
}
function openArchivedManage() {
  renderArchivedManage();
  $('#archived-overlay').classList.remove('hidden');
}
function closeArchivedManage() {
  $('#archived-overlay').classList.add('hidden');
}
function restoreAllArchived() {
  if (!archived.length) { toast('没有归档的歌单'); return; }
  archived = [];
  saveArchived();
  renderArchivedSettings();
  renderPlaylistList(state.playlists.filter((p) => !isArchived(p.id)));
  toast('已恢复全部归档歌单');
}

// 渲染侧栏歌单列表(过滤已归档)
function renderPlaylistList(playlists) {
  const list = $('#playlist-list');
  list.innerHTML = '';
  const visible = playlists.filter((p) => !isArchived(p.id));
  const frag = document.createDocumentFragment();
  visible.forEach((pl, i) => {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    item.dataset.id = pl.id;
    item.dataset.name = pl.name;
    item.innerHTML = `
      <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
      <span class="pl-name">${esc(pl.name)}</span>
      <span class="pl-count">${pl.count}</span>`;
    item.title = pl.name;
    item.addEventListener('click', () => openPlaylist(pl.id, pl.name, item));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showPlMenu(e.clientX, e.clientY, pl);
    });
    frag.appendChild(item);
    if (i === 0) {
      item.classList.add('active');
      state._firstItem = item;
      state._firstPl = pl;
    }
  });
  list.appendChild(frag);
  if (!visible.length && state.playlists.length) {
    list.innerHTML = '<div class="empty-tip">所有歌单已归档,可在设置中恢复</div>';
  }
}

// 自愈:若登录态实际存在(初始化误判),自动关闭登录页进入主界面
function startLoginSelfHeal() {
  let tries = 0;
  const timer = setInterval(async () => {
    if ($('#login-overlay').classList.contains('hidden')) { clearInterval(timer); return; }
    if (++tries > 20) { clearInterval(timer); return; }
    try {
      const p = await api('/api/profile');
      if (p && p.logged && p.profile) {
        clearInterval(timer);
        state.profile = p.profile;
        hideLogin();
        onLoggedIn();
        toast('登录态已恢复');
      }
    } catch (e) { /* 忽略 */ }
  }, 1500);
}

// 生成全窗底频谱柱:按播放栏宽度定数量(约 10px 一根),flex 拉伸占满整个底部
function initSpectrum() {
  const bar = $('#spectrum-bar');
  if (!bar) return;
  const rebuild = () => {
    const host = bar.parentElement;
    const width = host ? host.clientWidth : 1200;
    const count = Math.max(48, Math.min(240, Math.floor((width - 48) / 10)));
    bar.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) frag.appendChild(document.createElement('span'));
    bar.appendChild(frag);
  };
  rebuild();
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  });
}

/* ============ 登录 ============ */
function showLogin() {
  const ov = $('#login-overlay');
  ov.classList.remove('hidden');
  switchLoginTab('qr');
  if (!$('#qr-img').src) loadQr();
}

function hideLogin() {
  $('#login-overlay').classList.add('hidden');
}

function switchLoginTab(name) {
  $('#tab-web').classList.toggle('active', name === 'web');
  $('#tab-qr').classList.toggle('active', name === 'qr');
  $('#tab-cookie').classList.toggle('active', name === 'cookie');
  $('#web-panel').style.display = name === 'web' ? 'block' : 'none';
  $('#qr-panel').style.display = name === 'qr' ? 'block' : 'none';
  $('#cookie-panel').style.display = name === 'cookie' ? 'block' : 'none';
}

// 浏览器登录:打开官方登录页,自动抓取 Cookie
async function webLogin() {
  if (!window.player || !window.player.openWebLogin) {
    toast('当前环境不支持,请使用「粘贴 Cookie」方式');
    return;
  }
  const btn = $('#web-login');
  const st = $('#web-status');
  btn.disabled = true;
  btn.textContent = '等待登录…(登录完成后自动关闭)';
  st.textContent = '请在打开的窗口完成登录';
  const r = await window.player.openWebLogin();
  if (r && r.ok && r.profile) {
    state.profile = r.profile;
    st.textContent = '';
    hideLogin();
    onLoggedIn();
    toast('登录成功');
  } else if (r && r.cancelled) {
    st.textContent = '已取消登录';
  } else {
    st.textContent = (r && r.error) || '登录失败,请重试';
  }
  btn.disabled = false;
  btn.textContent = '打开网易云登录页面';
}

async function loadQr() {
  const st = $('#qr-status');
  st.textContent = '加载二维码中…';
  $('#qr-img').src = '';
  try {
    const qr = await api('/api/login/qr');
    if (qr.qrimg) {
      $('#qr-img').src = qr.qrimg;
      st.textContent = '请使用网易云音乐 APP 扫码';
      pollLogin();
    } else {
      st.textContent = '二维码加载失败,请重试';
    }
  } catch (e) {
    st.textContent = '网络异常,请检查网络后重试';
  }
}

/* ============ 日志 ============ */
async function openLog() {
  const ov = $('#log-overlay');
  ov.classList.remove('hidden');
  $('#log-body').textContent = '加载中…';
  const data = await api('/api/log').catch(() => null);
  $('#log-body').textContent = (data && data.log) || '(暂无日志)';
}

async function pollLogin() {
  for (let i = 0; i < 60; i++) {
    const ov = $('#login-overlay');
    if (ov.classList.contains('hidden')) return;
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const st = await api('/api/login/status');
      if (st.state === 'scanned') {
        $('#qr-status').textContent = st.user && st.user.nickname
          ? `已扫码(${st.user.nickname}),请在手机上确认`
          : '已扫码,请在手机上确认';
      } else if (st.state === 'authorized') {
        if (st.profile) state.profile = st.profile;
        hideLogin();
        onLoggedIn();
        toast('登录成功');
        return;
      } else if (st.state === 'risk') {
        $('#qr-status').textContent = '被风控拦截(8821),建议改用 Cookie 登录';
        return;
      } else if (st.state === 'expired') {
        $('#qr-status').textContent = '二维码已过期,请刷新';
        return;
      }
    } catch (e) { /* 继续轮询 */ }
  }
  $('#qr-status').textContent = '二维码已过期,请刷新';
}

async function onLoggedIn() {
  // 若授权后用户信息尚未取到,主动刷新一次
  if (!state.profile) {
    const p = await api('/api/profile').catch(() => null);
    if (p && p.profile) state.profile = p.profile;
  }
  renderUser();
  await loadPlaylists();
  loadHome();
  switchView('home');
  setNavActive('home');
  loadLiked(); // 红心状态
}

// ---------- 首页(每日推荐 + 推荐歌单) ----------
let homeLoaded = false;
async function loadHome() {
  if (homeLoaded) { switchView('home'); return; }
  renderDateCard();
  const greet = $('#home-greet');
  const now = new Date().getHours();
  const hi = now < 6 ? '夜深了' : now < 12 ? '早上好' : now < 14 ? '中午好' : now < 18 ? '下午好' : '晚上好';
  greet.textContent = `${hi}${state.profile && state.profile.nickname ? ', ' + state.profile.nickname : ''} · 每日推荐`;
  // 日推
  const r = await api('/api/recommend/songs').catch(() => null);
  if (r && Array.isArray(r.songs) && r.songs.length) {
    state.dailySongs = r.songs;
    renderSongList($('#home-song-list'), r.songs, true);
    $('#home-play-all').style.display = '';
  } else {
    $('#home-song-list').innerHTML = '<div class="empty-tip">每日推荐加载失败,请稍后重试</div>';
    $('#home-play-all').style.display = 'none';
  }
  // 推荐歌单
  const pl = await api('/api/personalized?limit=10').catch(() => null);
  const list = (pl && pl.playlists) || [];
  if (list.length) {
    $('#home-pl-grid').innerHTML = list.map((p) => `
      <div class="home-pl-card" data-id="${p.id}" data-name="${esc(p.name)}">
        <img src="${esc(p.cover)}" alt="" loading="lazy">
        <div class="home-pl-name">${esc(p.name)}</div>
        <div class="home-pl-count">${fmtCount(p.count)}</div>
      </div>`).join('');
    $('#home-pl-grid').querySelectorAll('.home-pl-card').forEach((c) => {
      c.addEventListener('click', () => openPlaylist(c.dataset.id, c.dataset.name, null));
    });
  }
  homeLoaded = true;
}

// 日期卡:大日期 + 星期/月/年 + 农历
const LUNAR_DAYS = ['', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
function renderDateCard() {
  const d = new Date();
  $('#date-day').textContent = String(d.getDate()).padStart(2, '0');
  $('#date-line1').textContent = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  $('#date-line2').textContent = `${d.getMonth() + 1}月 ${d.getFullYear()}`;
  let lunar = '';
  try {
    const monthStr = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long' }).format(d);
    const dayRaw = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { day: 'numeric' }).format(d);
    const m = String(dayRaw).match(/\d+/);
    const dayNum = m ? Number(m[0]) : 0;
    lunar = '农历' + monthStr + (LUNAR_DAYS[dayNum] || dayRaw);
  } catch (e) { lunar = ''; }
  $('#date-lunar').textContent = lunar;
}

function fmtCount(n) {
  if (!n) return '';
  return n >= 100000000 ? (n / 100000000).toFixed(1) + ' 亿'
    : n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n);
}

function setNavActive(name) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const el = $('#nav-' + name);
  if (el) el.classList.add('active');
}

// ---------- 歌曲百科(头部:封面/歌名/译名/发布时间 + 元数据 + 相似/相关) ----------
let wikiLastView = 'home';
let wikiSeq = 0;        // 请求序号:快速切换歌曲时丢弃旧响应,防止旧数据覆盖新页面
let wikiCurId = null;   // 当前百科页展示的歌曲 id
const wikiCache = new Map(); // id -> { name, artist, info, wiki },同歌再点直接渲染缓存,不再请求

function resetWikiLoading() {
  $('#wiki-title').textContent = '歌曲百科';
  $('#wiki-tns').textContent = '';
  $('#wiki-meta-line').textContent = '';
  $('#wiki-cover').style.visibility = 'hidden';
  $('#wiki-metas').innerHTML = '';
  $('#wiki-similar').innerHTML = '<div class="empty-tip">加载中…</div>';
  $('#wiki-playlists').innerHTML = '';
}

function renderWiki(id, payload) {
  const { name, info, wiki } = payload;
  // 头部信息
  if (info && !info.error) {
    $('#wiki-title').textContent = info.name || name || '歌曲百科';
    const tns = [info.alias, info.tns].filter(Boolean).join(' / ');
    $('#wiki-tns').textContent = tns ? '译名: ' + tns : '';
    const parts = [];
    if (info.artists) parts.push(info.artists);
    if (info.publishTime) parts.push(new Date(info.publishTime).toLocaleDateString('zh-CN'));
    if (info.album) parts.push('专辑《' + info.album + '》');
    if (info.pop) parts.push('热度 ' + info.pop);
    $('#wiki-meta-line').textContent = parts.join(' · ');
    if (info.cover) {
      $('#wiki-cover').src = info.cover;
      $('#wiki-cover').style.visibility = 'visible';
    }
  }
  if (!wiki || wiki.error || !wiki.data) {
    $('#wiki-metas').innerHTML = '<div class="empty-tip">百科加载失败</div>';
    return;
  }
  const blocks = (wiki.data.blocks) || [];
  // 元数据(曲风/语种/BPM 等,有值才显示)
  const basic = blocks.find((b) => (b.code || '').includes('SONG_BASIC'));
  const chips = [];
  if (basic && basic.creatives) {
    basic.creatives.forEach((c) => {
      const ue = c.uiElement || {};
      const label = (ue.mainTitle && ue.mainTitle.title) || '';
      const vals = (ue.labels || []).map((l) => l.title || l.text || '').filter(Boolean);
      if (label && vals.length) chips.push({ label, vals });
    });
  }
  $('#wiki-metas').innerHTML = chips.length
    ? chips.map((c) => `<span class="wiki-meta-chip"><b>${esc(c.label)}</b>${esc(c.vals.join(' / '))}</span>`).join('')
    : '<div class="empty-tip">暂无百科元数据</div>';
  // 相似歌曲 + 相关歌单
  const similar = [];
  const relPls = [];
  blocks.forEach((b) => {
    const isPlBlock = (b.showType || '').includes('PLAYLIST');
    const isSongBlock = (b.showType || '') === 'LIST_SONG';
    (b.creatives || []).forEach((cr) => {
      (cr.resources || []).forEach((r) => {
        const ue = r.uiElement || {};
        const t = (ue.mainTitle && ue.mainTitle.title) || '';
        const img = (((ue.images || [])[0] || {}).imageUrl || '').replace(/^http:\/\//, 'https://');
        const sub = ((ue.subTitles || [])[0] || {}).title || '';
        if (isSongBlock && r.resourceType === 'SONG') {
          similar.push({ id: r.resourceId, name: t, artists: sub, cover: img });
        } else if (isPlBlock) {
          relPls.push({ id: r.resourceId, name: t, cover: img });
        }
      });
    });
  });
  if (similar.length) {
    renderSongList($('#wiki-similar'), similar, true);
  } else {
    $('#wiki-similar').innerHTML = '<div class="empty-tip">暂无相似歌曲</div>';
  }
  if (relPls.length) {
    $('#wiki-playlists').innerHTML = relPls.map((p) => `
      <div class="wiki-pl-row" data-id="${p.id}" data-name="${esc(p.name)}">
        <img src="${esc(p.cover)}" alt="" loading="lazy">
        <span class="wp-name">${esc(p.name)}</span>
      </div>`).join('');
    $('#wiki-playlists').querySelectorAll('.wiki-pl-row').forEach((row) => {
      row.addEventListener('click', () => openPlaylist(row.dataset.id, row.dataset.name, null));
    });
  } else {
    $('#wiki-playlists').innerHTML = '<div class="empty-tip">暂无相关歌单</div>';
  }
}

async function openWiki(id, name, artist) {
  if (!id) { toast('暂无歌曲信息'); return; }
  const key = String(id);
  // 已经在百科页且展示的就是这首歌:再点不刷新,避免重复请求和重绘
  if (document.querySelector('.view.active').id === 'view-wiki' && wikiCurId === key) return;
  wikiLastView = document.querySelector('.view.active').id.replace('view-', '') || 'home';
  const seq = ++wikiSeq;
  wikiCurId = key;
  const cached = wikiCache.get(key);
  if (cached) {
    switchView('wiki');
    renderWiki(key, cached);
    return;
  }
  resetWikiLoading();
  switchView('wiki');
  // 并行:歌曲详情 + 百科
  const [info, wiki] = await Promise.all([
    api(`/api/song/info?id=${id}`).catch(() => null),
    api(`/api/wiki?id=${id}`).catch(() => null)
  ]);
  if (seq !== wikiSeq) return; // 已有更新的请求,丢弃本次响应
  if (info && !info.error && wiki && !wiki.error && wiki.data) {
    if (wikiCache.size > 30) {
      const firstKey = wikiCache.keys().next().value;
      if (firstKey !== undefined) wikiCache.delete(firstKey);
    }
    wikiCache.set(key, { name, artist, info, wiki });
  }
  renderWiki(key, { name, artist, info, wiki });
}

function renderUser() {
  const p = state.profile || {};
  $('#user-name').textContent = p.nickname || '用户';
  const av = $('#user-avatar');
  if (p.avatarUrl) {
    av.innerHTML = `<img src="${esc(p.avatarUrl)}" alt="">`;
  } else {
    av.textContent = (p.nickname || '?').slice(0, 1);
  }
  const isVip = p.vipType && p.vipType !== 0;
  $('#user-vip').textContent = isVip ? 'VIP' : '';
  $('#user-vip').style.display = isVip ? 'inline-block' : 'none';
}

/* ============ 歌单 ============ */
async function loadPlaylists() {
  const data = await api('/api/playlists');
  if (data.error) {
    toast(data.error);
    return;
  }
  state.playlists = data.playlists;
  renderPlaylistList(data.playlists);
}

async function openPlaylist(id, name, item) {
  document.querySelectorAll('.playlist-item').forEach((n) => n.classList.remove('active'));
  if (item) item.classList.add('active');
  setNavActive('discover');
  state.currentPlId = id;
  // 清空歌单内过滤
  const plFilterInput = $('#pl-filter-input');
  if (plFilterInput.value) {
    plFilterInput.value = '';
    plFilterInput.closest('.pl-filter-bar').classList.remove('has-text');
  }
  state.currentPlaylistName = name;
  switchView('playlist');
  $('#pl-title').textContent = name;
  $('#pl-sub').textContent = '加载中…';
  const data = await api(`/api/playlist?id=${id}`);
  if (data.error) { $('#pl-sub').textContent = data.error; return; }
  $('#pl-sub').textContent = `${data.tracks.length} 首`;
  // 记录当前歌单歌曲,供"播放全部"使用
  state.lastQueue = data.tracks;
  renderSongList($('#song-list'), data.tracks, true);
}

/* ============ 歌曲列表渲染(虚拟滚动:仅渲染可见行,大歌单不卡) ============ */
const ROW_H = 52;

function buildSongRow(t, i, isQueue, active) {
  const row = document.createElement('div');
  row.className = 'song-row' + (active ? ' active' : '');
  row.dataset.index = i;
  const vip = t.vip ? '<span class="vip-tag">VIP</span>' : '';
  row.innerHTML = `
    <span class="idx">${i + 1}</span>
    <div class="cov">${t.cover ? `<img loading="lazy" src="${esc(t.cover)}" alt="">` : ''}</div>
    <div class="tt">
      <div class="name">${esc(t.name)}</div>
      <div class="artist">${esc(t.artists || '未知歌手')}</div>
    </div>
    <span class="album">${esc(t.album || '')}</span>
    <span class="dur">${fmtTime(t.duration / 1000)}</span>
    ${vip}
    <svg class="play-ind" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  return row;
}

function renderSongList(el, tracks, isQueue) {
  el._tracks = tracks || [];
  el._isQueue = !!isQueue;
  if (typeof el._activeIndex !== 'number') el._activeIndex = -1;
  // 虚拟滚动只对独立滚动的列表(歌单/搜索);首页/百科/歌手列表父容器滚动,全量渲染
  const useVirtual = el.id === 'song-list' || el.id === 'search-list';
  el.innerHTML = '';
  if (!el._tracks.length) {
    el.innerHTML = '<div class="empty-tip">暂无歌曲</div>';
    return;
  }
  if (!useVirtual) {
    const frag = document.createDocumentFragment();
    el._tracks.forEach((t, i) => {
      const row = buildSongRow(t, i, el._isQueue, el._activeIndex === i);
      frag.appendChild(row);
    });
    el.appendChild(frag);
    el.onclick = (e) => {
      const row = e.target.closest('.song-row');
      if (!row) return;
      const t = el._tracks[Number(row.dataset.index)];
      if (!t) return;
      if (el._isQueue) {
        // 随机模式下点歌:洗当前列表并定位到点的这首,保持后续随机顺序
        if (state.playMode === 'shuffle' && el._tracks.length > 1) {
          applyShuffle(el._tracks);
          const ni = state.queue.findIndex((x) => x.id === t.id);
          playAt(ni >= 0 ? ni : 0);
        } else {
          state.queue = el._tracks;
          playAt(Number(row.dataset.index));
        }
      }
      else playTrack(t);
    };
    el.oncontextmenu = (e) => {
      const row = e.target.closest('.song-row');
      if (!row) return;
      e.preventDefault();
      const t = el._tracks[Number(row.dataset.index)];
      if (t) showSongMenu(e.clientX, e.clientY, t);
    };
    return;
  }
  // 虚拟滚动
  el.innerHTML = '<div class="vs-ph"></div><div class="vs-win"></div>';
  const ph = el.querySelector('.vs-ph');
  const win = el.querySelector('.vs-win');
  ph.style.height = (el._tracks.length * ROW_H) + 'px';
  const paint = () => {
    const st = el.scrollTop || 0;
    const start = Math.max(0, Math.floor(st / ROW_H) - 4);
    const end = Math.min(el._tracks.length, Math.ceil((st + (el.clientHeight || 400)) / ROW_H) + 4);
    win.style.transform = 'translateY(' + (start * ROW_H) + 'px)';
    win.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      frag.appendChild(buildSongRow(el._tracks[i], i, el._isQueue, el._activeIndex === i));
    }
    win.appendChild(frag);
  };
  let raf = 0;
  el.onscroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); };
  el.onclick = (e) => {
    const row = e.target.closest('.song-row');
    if (!row) return;
    const t = el._tracks[Number(row.dataset.index)];
    if (!t) return;
    if (el._isQueue) {
      // 随机模式下点歌:洗当前列表并定位到点的这首,保持后续随机顺序
      if (state.playMode === 'shuffle' && el._tracks.length > 1) {
        applyShuffle(el._tracks);
        const ni = state.queue.findIndex((x) => x.id === t.id);
        playAt(ni >= 0 ? ni : 0);
      } else {
        state.queue = el._tracks;
        playAt(Number(row.dataset.index));
      }
    }
    else playTrack(t);
  };
  el.oncontextmenu = (e) => {
    const row = e.target.closest('.song-row');
    if (!row) return;
    e.preventDefault();
    const t = el._tracks[Number(row.dataset.index)];
    if (t) showSongMenu(e.clientX, e.clientY, t);
  };
  el._paint = paint;
  paint();
}

function markActiveRow(el, index) {
  if (!el) return;
  el._activeIndex = index;
  if (el._paint) el._paint();
  else {
    const rows = el.querySelectorAll('.song-row');
    rows.forEach((r) => r.classList.toggle('active', Number(r.dataset.index) === index));
  }
}

// 歌单视图高亮跟随当前播放歌曲:随机模式下 queue 顺序 ≠ 歌单原序,
// 按歌曲 id 在歌单原列表中定位,而不是用 queue 下标(否则高亮落在错位的歌上)
function markActiveSongList() {
  const el = $('#song-list');
  if (!el) return;
  const t = state.queue[state.index];
  if (!t || !el._tracks || !el._tracks.length) { markActiveRow(el, -1); return; }
  const i = el._tracks.findIndex((x) => x && String(x.id) === String(t.id));
  markActiveRow(el, i >= 0 ? i : -1);
}

/* ============ 播放 ============ */
async function playAt(index) {
  if (index < 0 || index >= state.queue.length) return;
  state.index = index;
  const t = state.queue[index];
  await loadAndPlay(t);
  savePlayback(true);
  markActiveSongList();
  // 队列面板打开时刷新高亮(行点击/切歌/拖拽后均生效)
  if (!$('#queue-overlay').classList.contains('hidden')) renderQueue();
}

async function playTrack(t) {
  state.queue = [t];
  state.index = 0;
  await loadAndPlay(t);
}

async function loadAndPlay(t, opts = {}) {
  const data = await api(`/api/song/url?id=${t.id}&level=${state.level}`);
  if (data.error) { toast(data.error); return; }
  if (!data.url) {
    toast('无法获取播放地址(可能无版权或需要 VIP)');
    setPlaying(false);
    return;
  }
  $('#pb-title').textContent = t.name;
  $('#pb-artist').textContent = t.artists || '未知歌手';
  const cov = $('.cover');
  cov.innerHTML = t.cover ? `<img src="${esc(t.cover)}" alt="">` : '';
  // 内容区封面模糊背景
  const appBg = $('#app-bg');
  if (appBg) appBg.style.setProperty('--app-bg-img', t.cover ? `url("${t.cover}")` : 'none');
  applyCoverAccent(t.cover); // 异步取封面主色,驱动高亮自适应(不阻塞播放)
  balanceReset(t.id);       // 音量平衡:切歌后应用历史增益或开始重新测量
  probeNextSong();          // 后台预分析下一首,轮到它时开局即正确音量
  // 必须用绝对地址:页面以 file:// 加载,相对路径会解析失败
  audio.src = `http://127.0.0.1:${state.port}/api/stream?url=${encodeURIComponent(data.url)}`;
  // 恢复进度:等元数据加载完再跳转
  if (opts.seek > 0) {
    audio.addEventListener('loadedmetadata', function onMeta() {
      audio.removeEventListener('loadedmetadata', onMeta);
      try { audio.currentTime = Math.min(opts.seek, audio.duration || opts.seek); } catch (e) { /* 忽略 */ }
    }, { once: true });
  }
  if (opts.autoplay !== false) audio.play();
  loadLyric(t.id);
  updateMediaSession(t);
  updateLikeBtn();
}

// 封面主色 → body 的 --cover-accent,歌单高亮用它半透明渲染(红封面显示淡红,不突兀)
let coverAccentSeq = 0;
async function applyCoverAccent(cover) {
  const seq = ++coverAccentSeq;
  document.body.style.removeProperty('--cover-accent');
  if (!cover || !state.port) return;
  try {
    const data = await api(`/api/cover/color?url=${encodeURIComponent(cover)}`);
    if (seq !== coverAccentSeq) return; // 已切歌,丢弃过期响应
    if (data && typeof data.r === 'number') {
      document.body.style.setProperty('--cover-accent', `${data.r}, ${data.g}, ${data.b}`);
    }
  } catch (e) { /* 保持默认高亮色 */ }
}

/* ============ 红心收藏 ============ */
async function loadLiked() {
  if (!state.profile || !state.profile.uid) return;
  const r = await api(`/api/likes?uid=${state.profile.uid}`).catch(() => null);
  if (r && Array.isArray(r.ids)) {
    state.likedIds = new Set(r.ids.map(String));
    updateLikeBtn();
  }
}

function currentSongId() {
  const t = state.queue[state.index];
  return t ? String(t.id) : '';
}

function updateLikeBtn() {
  const btn = $('#like-btn');
  if (!btn) return;
  const id = currentSongId();
  btn.classList.toggle('active', !!id && state.likedIds.has(id));
}

async function toggleLike() {
  if (!state.profile) { toast('请先登录'); return; }
  const id = currentSongId();
  if (!id) { toast('请先选择歌曲'); return; }
  const like = !state.likedIds.has(id);
  const r = await postJson('/api/like', { id, like });
  if (r.ok) {
    if (like) state.likedIds.add(id); else state.likedIds.delete(id);
    updateLikeBtn();
    toast(like ? '已收藏' : '已取消收藏');
  } else {
    toast(r.error || '操作失败');
  }
}

/* ============ 私人 FM ============ */
async function toggleFm() {
  if (state.fmMode) {
    state.fmMode = false;
    $('#nav-fm').classList.remove('active');
    toast('已退出私人 FM');
    return;
  }
  const r = await api('/api/fm').catch(() => null);
  const songs = (r && r.songs) || [];
  if (!songs.length) { toast('私人 FM 加载失败'); return; }
  state.fmMode = true;
  state.queue = songs;
  playAt(0);
  $('#nav-fm').classList.add('active');
  toast('私人 FM 开始');
}

// FM 播完前拉下一批,保持连续
async function fmFetchMore() {
  const r = await api('/api/fm').catch(() => null);
  const songs = (r && r.songs) || [];
  if (songs.length) state.queue = state.queue.concat(songs);
}

/* ============ 系统媒体控制(SMTC,任务栏/锁屏) ============ */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (d.seekTime != null) { try { audio.currentTime = d.seekTime; } catch (e) { /* 忽略 */ } }
    });
  } catch (e) { /* 忽略 */ }
}

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t ? t.name : 'Nebula',
      artist: t ? t.artists || '' : '',
      album: t && t.album ? t.album : '',
      artwork: t && t.cover ? [{ src: t.cover, sizes: '512x512', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  } catch (e) { /* 忽略 */ }
}

/* ============ 播放记忆(下次打开恢复队列与进度) ============ */
const LEVELS = ['standard', 'higher', 'exhigh', 'lossless', 'hires'];
const MODES = ['order', 'reverse', 'shuffle', 'repeat'];
let lastPlaybackSave = 0;

function savePlayback(force) {
  if (!state.queue.length || state.index < 0) return;
  const now = Date.now();
  if (!force && now - lastPlaybackSave < 5000) return;
  lastPlaybackSave = now;
  const t = state.queue[state.index] || {};
  try {
    localStorage.setItem('nebula-playback', JSON.stringify({
      ts: now,
      queue: state.queue.map((s) => ({ id: s.id, name: s.name, artists: s.artists, cover: s.cover })),
      index: state.index,
      currentTime: audio.currentTime || 0,
      playing: state.playing,
      level: state.level,
      playMode: state.playMode
    }));
  } catch (e) { /* 忽略 */ }
}

// 启动时恢复上次播放:canPlay=false(未登录)时只恢复队列显示
async function restorePlayback(canPlay) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('nebula-playback') || 'null'); } catch (e) { /* 忽略 */ }
  if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) return;
  if (LEVELS.includes(saved.level)) state.level = saved.level;
  if (MODES.includes(saved.playMode)) {
    state.playMode = saved.playMode;
    applyModeIcon();
  }
  state.queue = saved.queue.map((s) => ({ ...s }));
  state.index = Math.min(Math.max(Number(saved.index) || 0, 0), state.queue.length - 1);
  const t = state.queue[state.index];
  if (!t) return;
  renderQueue();
  // 播放栏信息先渲染,再异步取地址
  $('#pb-title').textContent = t.name;
  $('#pb-artist').textContent = t.artists || '未知歌手';
  const cov = $('.cover');
  cov.innerHTML = t.cover ? `<img src="${esc(t.cover)}" alt="">` : '';
  if (canPlay) {
    const seek = Math.max(0, Number(saved.currentTime) || 0);
    const resume = !!saved.playing;
    await loadAndPlay(t, { autoplay: resume, seek });
    if (!resume) setPlaying(false);
    toast(resume ? '已恢复上次播放' : '已恢复上次队列');
  }
}

function setPlaying(p) {
  state.playing = p;
  $('#play-btn').classList.toggle('playing', p);
  $('.cover').classList.toggle('spinning', p);
  $('#spectrum-bar').classList.toggle('playing', p);
}

/* ---------- 收听上报(计入网易云年报/推荐;每首歌最多 2 次,防刷量) ---------- */
if (!state.reported) state.reported = {};

function reportPlay(id, duration) {
  fetch(`http://127.0.0.1:${state.port}/api/report/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, duration: Math.max(30, Math.floor(duration || 30)) })
  }).catch(() => {});
}

// 播放满 5s 上报一次(计入"听过";官方网页版也是几秒内即上报)
function checkReport() {
  if (!settings.report || !state.profile) return;
  const t = state.queue[state.index];
  if (!t || audio.paused) return;
  const key = String(t.id);
  const ct = audio.currentTime || 0;
  if (ct >= 5 && !state.reported[key + ':5']) {
    state.reported[key + ':5'] = true;
    reportPlay(t.id, ct);
  }
}

// 完整播放结束再上报一次(计入"完整收听")
function reportOnEnded() {
  if (!settings.report || !state.profile) return;
  const t = state.queue[state.index];
  if (!t) return;
  const key = String(t.id);
  if (!state.reported[key + ':end']) {
    state.reported[key + ':end'] = true;
    reportPlay(t.id, Math.floor(audio.duration || 0) || 60);
  }
}

// ---------- 播放模式 ----------
const MODE_META = {
  order: { title: '播放模式:正序循环', d: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z', flip: false },
  reverse: { title: '播放模式:倒序循环', d: 'M13.5 3.5c-4.97 0-9 4.03-9 9H2l3.5 3.5L9 12.5H6.5c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.87 0-3.6-.73-4.9-1.9l-1.4 1.4c1.77 1.68 4.14 2.5 6.3 2.5 4.97 0 9-4.03 9-9s-4.03-9-9-9zm-.5 5v5.5l4.5 2.7.8-1.3-3.8-2.3V8.5h-1.5z', flip: false },
  shuffle: { title: '播放模式:随机播放', d: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z', flip: false },
  repeat: { title: '播放模式:单曲循环', d: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z', flip: false }
};

function cyclePlayMode() {
  const order = ['order', 'reverse', 'shuffle', 'repeat'];
  const i = order.indexOf(state.playMode);
  setPlayMode(order[(i + 1) % order.length]);
}

let preShuffleQueue = null; // 进入随机前的队列快照,退出随机时还原

// 在随机模式下对指定列表洗牌:当前歌保持播放,只重新定位它在新队列里的位置
function applyShuffle(pool) {
  if (!pool || pool.length < 2) return;
  if (preShuffleQueue === null && state.queue.length > 1) preShuffleQueue = state.queue.slice();
  const cur = state.queue[state.index] || null;
  state.queue = shuffleArray(pool);
  if (cur) {
    const ni = state.queue.findIndex((x) => x.id === cur.id);
    if (ni >= 0) state.index = ni;
  }
}

function setPlayMode(mode) {
  // 进入随机:给当前队列洗牌(空队列/单曲时只切换模式,点歌时再洗)
  if (mode === 'shuffle' && state.playMode !== 'shuffle' && state.queue.length > 1) {
    applyShuffle(state.queue);
  }
  // 退出随机:还原进入前的顺序
  if (state.playMode === 'shuffle' && mode !== 'shuffle') {
    if (preShuffleQueue && preShuffleQueue.length) {
      const cur = state.queue[state.index] || null;
      state.queue = preShuffleQueue;
      if (cur) {
        const ni = state.queue.findIndex((x) => x.id === cur.id);
        if (ni >= 0) state.index = ni;
      }
      preShuffleQueue = null;
      renderQueue();
    } else if (state.lastQueue.length) {
      state.queue = state.lastQueue.slice();
      renderQueue();
    }
  }
  state.playMode = mode;
  applyModeIcon();
  toast(MODE_META[state.playMode].title.replace('播放模式:', ''));
  if (state.queue.length) renderQueue();
}

function applyModeIcon() {
  const meta = MODE_META[state.playMode];
  $('#mode-icon').setAttribute('d', meta.d);
  $('#mode-icon').style.transform = meta.flip ? 'scaleX(-1)' : '';
  $('#mode-btn').title = meta.title;
}

// Fisher-Yates 洗牌(预随机:随机模式下一次洗好,顺序可复现)
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function playAll() {
  if (!state.lastQueue.length) { toast('当前歌单没有歌曲'); return; }
  if (state.playMode === 'shuffle') {
    // 随机模式:整个歌单预先洗成固定顺序(播放列表可见,上一首/下一首按此顺序),从头播放
    state.queue = shuffleArray(state.lastQueue);
    playAt(0);
    renderQueue(); // 队列面板立即显示洗牌后的排序
    toast(`随机播放 ${state.queue.length} 首`);
    return;
  }
  state.queue = state.lastQueue;
  let start = 0;
  if (state.playMode === 'reverse') start = state.queue.length - 1;
  playAt(start);
}

function togglePlay() {
  if (audio.src && !audio.paused) {
    audio.pause();
  } else if (audio.src) {
    audio.play();
  } else if (state.queue.length) {
    playAt(state.index >= 0 ? state.index : 0);
  }
}

function next() {
  if (!state.queue.length) return;
  const n = state.queue.length;
  // 私人 FM:顺序播放,末尾自动拉下一批保持连续
  if (state.fmMode) {
    const ni = state.index + 1;
    if (ni >= n) fmFetchMore().then(() => { if (state.index + 1 < state.queue.length) playAt(state.index + 1); });
    else playAt(ni);
    return;
  }
  if (state.playMode === 'repeat') {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  // shuffle 模式:队列已预先洗好,按顺序循环即可(可复现,不再实时随机抽歌)
  if (state.playMode === 'reverse') {
    playAt((state.index - 1 + n) % n);
    return;
  }
  playAt((state.index + 1) % n);
}
function prev() {
  if (!state.queue.length) return;
  const n = state.queue.length;
  // 单曲循环:上一曲 = 重播当前歌(与下一首一致)
  if (state.playMode === 'repeat') {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  if (state.playMode === 'reverse') playAt((state.index + 1) % n);
  else playAt((state.index - 1 + n) % n);
}

/* ============ 歌词 ============ */
let lyricFollow = true;   // 是否跟随当前行自动滚动(用户滚轮后暂停 3s)
let lyricFollowTimer = null;

// 歌词始终居中:上下 padding 各为面板高度一半,首尾行也能滚到中间
function adjustLyricPadding() {
  const panel = $('#lyric-panel');
  if (!panel) return;
  const half = Math.max(80, Math.floor(panel.clientHeight / 2));
  panel.style.paddingTop = half + 'px';
  panel.style.paddingBottom = half + 'px';
}
function parseLrc(text) {
  if (!text) return [];
  const lines = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]\s*(.*)/;
  text.split('\n').forEach((line) => {
    const m = re.exec(line.trim());
    if (m) {
      const t = Number(m[1]) * 60 + Number(m[2]) + Number('0.' + (m[3] || '0').padEnd(3, '0'));
      if (m[4].trim()) lines.push({ t, text: m[4].trim() });
    }
  });
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

async function loadLyric(id) {
  lyricFollow = true;
  state._lastLyricIdx = undefined; // 重置高亮索引,保证切歌后动画立即生效
  const data = await api(`/api/lyric?id=${id}`).catch(() => null);
  const lrc = data ? parseLrc(data.lrc || '') : [];
  const trans = data ? parseLrc(data.tlyric || '') : [];
  // 按时间轴合并译文
  state.lyric = lrc.map((l) => {
    let tr = '';
    for (const t of trans) {
      if (Math.abs(t.t - l.t) < 0.15) { tr = t.text; break; }
    }
    return { ...l, trans: tr };
  });
  const panel = $('#lyric-panel');
  if (state.lyric.length) {
    panel.innerHTML = state.lyric.map((l) =>
      `<div class="lyric-line">${esc(l.text)}${l.trans ? `<span class="trans">${esc(l.trans)}</span>` : ''}</div>`
    ).join('');
  } else {
    panel.innerHTML = '<div class="empty-tip">暂无歌词</div>';
  }
  // 用户滚轮滚动时暂停自动跟随,3 秒后恢复
  panel.onwheel = () => {
    lyricFollow = false;
    clearTimeout(lyricFollowTimer);
    lyricFollowTimer = setTimeout(() => { lyricFollow = true; }, 3000);
  };
  // 点击歌词跳转到对应时间,并恢复跟随
  panel.onclick = (e) => {
    const line = e.target.closest('.lyric-line');
    if (!line || !state.lyric.length) return;
    const idx = Array.from(panel.children).indexOf(line);
    if (idx >= 0 && state.lyric[idx]) {
      lyricFollow = true;
      audio.currentTime = state.lyric[idx].t;
      updateLyric();
    }
  };
  adjustLyricPadding();
}

function updateLyric() {
  if (!state.lyric.length) return;
  const t = audio.currentTime;
  let idx = -1;
  for (let i = 0; i < state.lyric.length; i++) {
    if (state.lyric[i].t <= t) idx = i;
    else break;
  }
  const panel = $('#lyric-panel');
  const lines = panel.querySelectorAll('.lyric-line');
  // 当前行没变化则不重复设置样式(性能)
  if (idx === state._lastLyricIdx) return;
  state._lastLyricIdx = idx;
  pushDesktopLyric(true);
  // 距离渐隐:越远越透明(0 当前 / 1-3 渐显 / >=4 几乎不可见)
  const OP = [1, 0.68, 0.45, 0.24];
  lines.forEach((l, i) => {
    const d = Math.abs(i - idx);
    l.classList.toggle('active', d === 0);
    l.style.opacity = d === 0 ? '' : String(d < OP.length ? OP[d] : 0.06);
  });
  if (idx >= 0 && lyricFollow) {
    const el = lines[idx];
    const target = el.offsetTop - panel.clientHeight / 2 + el.clientHeight / 2;
    if (Math.abs(panel.scrollTop - target) > 4) panel.scrollTop = target;
  }
}

// 歌词视图切换:点一下进入,再点一下回到原界面
function showLyricView() {
  if (!state.lyric.length && !audio.src) {
    toast('暂无歌词');
    return;
  }
  state.lastView = state.lastView === 'lyric' ? state.lastView : (document.querySelector('.view.active').id.replace('view-', '') || 'playlist');
  switchView('lyric');
  updateLyric();
}

function toggleLyricView() {
  const isLyric = document.querySelector('.view.active') === $('#view-lyric');
  if (isLyric) {
    switchView(state.lastView === 'lyric' ? 'playlist' : state.lastView || 'playlist');
  } else {
    showLyricView();
  }
}

/* ============ 搜索 ============ */
let searchTimer = null;
function onSearchInput() {
  const q = $('#search-input').value.trim();
  $('#search-bar').classList.toggle('has-text', !!q);
  clearTimeout(searchTimer);
  if (!q) {
    switchView('playlist');
    return;
  }
  searchTimer = setTimeout(() => doSearch(q), 300);
}

async function doSearch(q) {
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  $('#search-sub').textContent = data.total ? `找到 ${data.total} 首` : '';
  const list = $('#search-list');
  renderSongList(list, data.songs, false);
  switchView('search');
  markActiveRow(list, -1);
}

/* ============ 下载 ============ */
async function downloadCurrent() {
  if (state.index < 0) { toast('请先选择歌曲'); return; }
  const t = state.queue[state.index];
  toast('开始下载…');
  try {
    const data = await api(`/api/download?id=${t.id}&level=${state.level}`);
    if (data.cancelled) { toast('已取消'); return; }
    if (data.ok) toast('下载完成');
    else toast(data.error || '下载失败');
  } catch (e) {
    toast('下载失败');
  }
}

/* ============ 定位当前歌曲 / 分享 ============ */
function locateCurrentSong() {
  const t = state.queue[state.index];
  if (!t) { toast('当前没有播放中的歌曲'); return; }
  const el = $('#song-list');
  if (!el || !el._tracks || !el._tracks.length) { toast('当前没有可定位的歌单'); return; }
  const i = el._tracks.findIndex((x) => x && String(x.id) === String(t.id));
  if (i < 0) { toast('当前歌曲不在该歌单中'); return; }
  // 切到歌单视图(歌单列表始终持有最近打开的歌单),滚动并闪烁定位
  if (document.querySelector('.view.active').id !== 'view-playlist') switchView('playlist');
  setNavActive('discover');
  markActiveRow(el, i);
  if (el._paint) {
    const top = Math.max(0, i * ROW_H - Math.max(0, (el.clientHeight - ROW_H) / 2));
    el.scrollTop = top;
    el._paint();
  }
  const row = el.querySelector(`.song-row[data-index="${i}"]`);
  if (row) {
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1400);
  }
}

function songShareLink(t) {
  return `https://music.163.com/#/song?id=${encodeURIComponent(t.id)}`;
}

function copySongShare(t) {
  if (!window.player || !window.player.copyText) { toast('当前环境不支持复制'); return; }
  const link = songShareLink(t);
  const text = `《${t.name}》 - ${t.artists || '未知歌手'}\n来自 Nebula 播放器\n${link}`;
  window.player.copyText(text);
  toast('已复制分享文案');
}

/* ============ 设置(持久化到本机) ============ */
const DEFAULT_SETTINGS = { spectrum: true, balance: true, spin: true, blur: true, trans: true, desktopLyric: false, through: false, report: true, zoom: 1 };
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('nebula-settings') || '{}') };
  } catch (e) { /* 使用默认 */ }
}

function saveSettings() {
  try { localStorage.setItem('nebula-settings', JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
}

function applySettings() {
  document.body.classList.toggle('no-spectrum', !settings.spectrum);
  document.body.classList.toggle('no-spin', !settings.spin);
  document.body.classList.toggle('no-blur', !settings.blur);
  document.body.classList.toggle('no-trans', !settings.trans);
  document.documentElement.style.zoom = String(settings.zoom);
  // 桌面歌词窗口开关
  if (window.player && window.player.toggleLyricWin) {
    window.player.toggleLyricWin(!!settings.desktopLyric).catch(() => {});
  }
  // 小窗鼠标穿透
  if (window.player && window.player.setLyricThrough) {
    window.player.setLyricThrough(!!settings.through).catch(() => {});
  }
}

/* ============ 音量平衡(响度归一化) ============ */
let balCtx = null, balSource = null, balAnalyser = null, balGain = null;
const balGainCache = new Map();   // songId -> 归一化增益
let balMeasuring = false;         // 正在测量当前歌响度
let balEstDb = null;              // 响度 EMA(时间域 RMS dB)
let balSamples = 0;               // 距上次调整的采样数
let balLastGain = 1;              // 上次应用的增益(新歌起点,避免从 1 直接跳变)
const BAL_TARGET_DB = -16;        // 目标响度(时间域 RMS)
const BAL_MAX_CUT_DB = 12;        // 最多压 12dB(音量保护)
const BAL_MAX_BOOST_DB = 4;       // 最多抬 4dB(保守,防"突然变大")
const BAL_EMA = 0.08;             // 响度估计平滑系数(≈5s 窗口)
const BAL_ADJUST_EVERY = 6;       // 每 6 个样本(~2.4s)调整一次
const BAL_RAMP_S = 1.5;           // 增益渐变时间常数(秒)

function ensureBalanceGraph() {
  if (balCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    balCtx = new AC();
    balSource = balCtx.createMediaElementSource(audio);
    balAnalyser = balCtx.createAnalyser();
    balAnalyser.fftSize = 1024;
    balAnalyser.smoothingTimeConstant = 0.3;
    balGain = balCtx.createGain();
    balGain.gain.value = 1;
    balSource.connect(balAnalyser);
    balAnalyser.connect(balGain);
    balGain.connect(balCtx.destination);
  } catch (e) { /* 不支持 Web Audio 时静默降级 */ }
}

function resumeBalanceCtx() {
  if (balCtx && balCtx.state === 'suspended') balCtx.resume().catch(() => {});
}

// 切歌时调用:有历史增益直接应用;没有则从上一首歌的增益起步并开始测量
function balanceReset(songId) {
  balMeasuring = false;
  balSamples = 0;
  balEstDb = null;
  if (!balGain || !balCtx) return;
  const g = songId ? balGainCache.get(String(songId)) : null;
  const start = g || balLastGain || 1;
  balGain.gain.setTargetAtTime(start, balCtx.currentTime, 0.3);
  if (!g && settings.balance) balMeasuring = true;
}

// 每 400ms 采样;响度估计平滑后算一次固定增益并锁定(整首歌不再变动)
function balanceTick() {
  if (!settings.balance || !balAnalyser || !balGain || !balMeasuring) return;
  if (audio.paused || audio.ended) return;
  const cur = state.queue[state.index];
  if (!cur) return;
  const buf = new Float32Array(balAnalyser.fftSize);
  balAnalyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms < 0.001) return; // 静音帧(播放前几帧可能全零)不算样本,避免拉低均值
  const db = 20 * Math.log10(rms);
  balEstDb = balEstDb === null ? db : balEstDb + BAL_EMA * (db - balEstDb);
  balSamples++;
  if (balSamples >= BAL_ADJUST_EVERY) {
    balSamples = 0;
    const corr = Math.max(-BAL_MAX_CUT_DB, Math.min(BAL_MAX_BOOST_DB, BAL_TARGET_DB - balEstDb));
    const gain = Math.pow(10, corr / 20);
    balLastGain = gain;
    balGain.gain.setTargetAtTime(gain, balCtx.currentTime, BAL_RAMP_S);
    balGainCache.set(String(cur.id), gain);
    if (balGainCache.size > 500) balGainCache.delete(balGainCache.keys().next().value);
    saveBalanceCache();   // 持久化:以后播放开局直接生效
    balMeasuring = false; // 锁定固定增益,整首歌不再变动
  }
}

function balanceStateChanged() {
  if (!balGain || !balCtx) return;
  if (settings.balance) {
    const cur = state.queue[state.index];
    const g = cur ? balGainCache.get(String(cur.id)) : null;
    if (g) balGain.gain.setTargetAtTime(g, balCtx.currentTime, 0.15);
    else balanceReset(cur && cur.id);
    probeNextSong();
  } else {
    balGain.gain.setTargetAtTime(1, balCtx.currentTime, 0.15);
    balMeasuring = false;
    stopProbe();
  }
}

// ---------- 后台预分析(开局定响度) ----------
let balProbeEl = null, balProbeSource = null, balProbeAnalyser = null;
let balProbe = null; // { songId, estDb, samples, timer }
let balProbeSeq = 0;  // 竞态保护:快速切歌时丢弃旧预分析

function loadBalanceCache() {
  try {
    const raw = JSON.parse(localStorage.getItem('nebula-balance-gains') || '{}');
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number' && isFinite(v) && v > 0) balGainCache.set(k, v);
    }
  } catch (e) { /* 忽略 */ }
}

function saveBalanceCache() {
  try {
    const obj = {};
    for (const [k, v] of balGainCache) obj[k] = v;
    localStorage.setItem('nebula-balance-gains', JSON.stringify(obj));
  } catch (e) { /* 忽略 */ }
}

function stopProbe() {
  if (balProbe) {
    clearTimeout(balProbe.timer);
    balProbe = null;
  }
  if (balProbeEl) {
    try { balProbeEl.pause(); balProbeEl.removeAttribute('src'); balProbeEl.load(); } catch (e) { /* 忽略 */ }
  }
}

function ensureProbeGraph() {
  if (balProbeEl || !balCtx) return;
  try {
    balProbeEl = document.createElement('audio');
    balProbeEl.preload = 'auto';
    balProbeSource = balCtx.createMediaElementSource(balProbeEl);
    balProbeAnalyser = balCtx.createAnalyser();
    balProbeAnalyser.fftSize = 1024;
    balProbeSource.connect(balProbeAnalyser); // 不接 destination → 后台无声
  } catch (e) { /* 忽略 */ }
}

// 当前歌播放时,预分析下一首的前几秒并缓存增益;轮到它时开局即正确音量
async function probeNextSong() {
  if (!settings.balance || !balCtx || !state.queue.length) return;
  const seq = ++balProbeSeq;
  const n = state.queue.length;
  let ni = state.index + 1;
  if (state.playMode === 'reverse') ni = state.index - 1 + n;
  else if (state.playMode === 'repeat') return;
  if (state.fmMode) return;
  ni = ((ni % n) + n) % n;
  if (ni === state.index) return;
  const nt = state.queue[ni];
  if (!nt || balGainCache.has(String(nt.id))) return;
  stopProbe();
  ensureProbeGraph();
  if (!balProbeEl || !balProbeAnalyser) return;
  let url = null;
  try {
    const data = await api(`/api/song/url?id=${nt.id}&level=${state.level}`);
    url = data.url;
  } catch (e) { return; }
  if (!url) return;
  if (seq !== balProbeSeq) return; // 期间已切歌,丢弃
  balProbe = { songId: String(nt.id), estDb: null, samples: 0, timer: null };
  balProbeEl.src = `http://127.0.0.1:${state.port}/api/stream?url=${encodeURIComponent(url)}`;
  balProbeEl.play().catch(() => {});
  resumeBalanceCtx();
  balProbe.timer = setTimeout(() => { if (balProbe) stopProbe(); }, 12000);
}

// 每 400ms 采样预分析元素,够样本后算出增益并持久化
function probeTick() {
  if (!balProbe || !balProbeAnalyser) return;
  const p = balProbe;
  const buf = new Float32Array(balProbeAnalyser.fftSize);
  balProbeAnalyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms < 0.001) return;
  const db = 20 * Math.log10(rms);
  p.estDb = p.estDb === null ? db : p.estDb + BAL_EMA * (db - p.estDb);
  p.samples++;
  if (p.samples >= BAL_ADJUST_EVERY) {
    const corr = Math.max(-BAL_MAX_CUT_DB, Math.min(BAL_MAX_BOOST_DB, BAL_TARGET_DB - p.estDb));
    const gain = Math.pow(10, corr / 20);
    balGainCache.set(p.songId, gain);
    if (balGainCache.size > 500) balGainCache.delete(balGainCache.keys().next().value);
    saveBalanceCache();
    stopProbe();
  }
}

// 发送完整数据到桌面歌词窗口(节流 500ms;行切换时 force 立即发送)
let lastDesktopPush = 0;
function pushDesktopLyric(force) {
  if (!settings.desktopLyric || !window.player || !window.player.sendLyric) return;
  const now = Date.now();
  if (!force && now - lastDesktopPush < 500) return;
  lastDesktopPush = now;
  // 计算当前歌词行
  let idx = -1;
  const t = audio.currentTime;
  for (let i = 0; i < state.lyric.length; i++) {
    if (state.lyric[i].t <= t) idx = i;
    else break;
  }
  const song = state.queue[state.index] || {};
  window.player.sendLyric({
    cur: idx >= 0 ? state.lyric[idx].text : '',
    curTrans: idx >= 0 ? (state.lyric[idx].trans || '') : '',
    next: idx >= 0 && idx + 1 < state.lyric.length ? state.lyric[idx + 1].text : '',
    has: idx >= 0,
    cover: song.cover || '',
    name: song.name || '',
    artist: song.artists || '',
    dur: audio.duration || 0,
    curTime: audio.currentTime || 0,
    playing: state.playing
  });
}

function openSettings() {
  $('#set-spectrum').checked = settings.spectrum;
  $('#set-balance').checked = settings.balance;
  $('#set-spin').checked = settings.spin;
  $('#set-blur').checked = settings.blur;
  $('#set-trans').checked = settings.trans;
  $('#set-desktop-lyric').checked = settings.desktopLyric;
  $('#set-through').checked = settings.through;
  $('#set-report').checked = settings.report;
  $('#set-zoom').value = String(settings.zoom);
  renderArchivedSettings();
  $('#settings-overlay').classList.remove('hidden');
}

/* ============ 视图切换 ============ */
function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const map = { home: '#view-home', playlist: '#view-playlist', search: '#view-search', lyric: '#view-lyric', wiki: '#view-wiki', artist: '#view-artist' };
  const el = $(map[name]);
  if (el) {
    el.classList.add('active');
    el.style.display = 'none';
    el.offsetHeight; // 触发重排以重启动画
    el.style.display = '';
  }
}

/* ============ Toast ============ */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ============ 事件绑定 ============ */
function bindEvents() {
  $('#qr-refresh').addEventListener('click', loadQr);
  $('#open-log').addEventListener('click', openLog);
  $('#close-log').addEventListener('click', () => $('#log-overlay').classList.add('hidden'));
  $('#refresh-log').addEventListener('click', openLog);
  $('#log-overlay').addEventListener('click', (e) => {
    if (e.target === $('#log-overlay')) $('#log-overlay').classList.add('hidden');
  });
  // 未登录时点击用户卡打开登录页(用户主动触发,启动永不自动弹)
  $('#user-card').addEventListener('click', () => {
    if (!state.profile) showLogin();
  });
  $('#tab-web').addEventListener('click', () => switchLoginTab('web'));
  $('#tab-qr').addEventListener('click', () => switchLoginTab('qr'));
  $('#tab-cookie').addEventListener('click', () => switchLoginTab('cookie'));
  $('#web-login').addEventListener('click', webLogin);

  // 主进程推送的登录结果(网页登录窗口成功时)
  if (window.player && window.player.onWebLoginResult) {
    window.player.onWebLoginResult((r) => {
      if (r && r.ok && r.profile) {
        state.profile = r.profile;
        hideLogin();
        onLoggedIn();
        toast('登录成功');
      }
    });
  }

  // Cookie 登录
  $('#cookie-login').addEventListener('click', async () => {
    const cookie = $('#cookie-input').value.trim();
    if (!cookie) { toast('请先粘贴 Cookie'); return; }
    const btn = $('#cookie-login');
    btn.disabled = true;
    btn.textContent = '验证中…';
    try {
      const resp = await fetch(`http://127.0.0.1:${state.port}/api/login/cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie })
      });
      const data = await resp.json();
      if (data.ok && data.profile) {
        state.profile = data.profile;
        hideLogin();
        onLoggedIn();
        toast('登录成功');
      } else {
        toast(data.error || 'Cookie 无效,请重新获取');
      }
    } catch (e) {
      toast('网络异常,请重试');
    }
    btn.disabled = false;
    btn.textContent = '登录';
  });
  $('#logout-btn').addEventListener('click', async () => {
    await api('/api/logout');
    location.reload();
  });

  $('#play-btn').addEventListener('click', togglePlay);
  $('#next-btn').addEventListener('click', next);
  $('#prev-btn').addEventListener('click', prev);
  $('#download-btn').addEventListener('click', downloadCurrent);
  $('#lyric-btn').addEventListener('click', toggleLyricView);
  $('#lyric-back').addEventListener('click', () => switchView(state.lastView === 'lyric' ? 'playlist' : state.lastView || 'playlist'));
  $('#play-all-btn').addEventListener('click', playAll);
  $('#mode-btn').addEventListener('click', cyclePlayMode);
  $('#queue-btn').addEventListener('click', openQueue);
  $('#clear-queue').addEventListener('click', clearQueue);
  $('#close-queue').addEventListener('click', () => $('#queue-overlay').classList.add('hidden'));
  $('#queue-overlay').addEventListener('click', (e) => {
    if (e.target === $('#queue-overlay')) $('#queue-overlay').classList.add('hidden');
  });
  window.addEventListener('resize', adjustLyricPadding);

  // 歌单内搜索(前端过滤)
  const plFilterInput = $('#pl-filter-input');
  plFilterInput.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    plFilterInput.closest('.pl-filter-bar').classList.toggle('has-text', !!q);
    applyPlaylistFilter(q);
  });
  $('#pl-filter-clear').addEventListener('click', () => {
    plFilterInput.value = '';
    plFilterInput.closest('.pl-filter-bar').classList.remove('has-text');
    applyPlaylistFilter('');
    plFilterInput.focus();
  });

  // 多媒体键(Fn+F5/F6/F7 等,由主进程 globalShortcut 转发)
  if (window.player && window.player.onMediaKey) {
    window.player.onMediaKey((action) => {
      if (action === 'playpause') togglePlay();
      else if (action === 'next') next();
      else if (action === 'prev') prev();
      else if (action === 'stop') audio.pause();
    });
  }

  $('#nav-home').addEventListener('click', () => {
    setNavActive('home');
    if (homeLoaded) switchView('home');
    else loadHome();
  });
  $('#nav-discover').addEventListener('click', () => {
    setNavActive('discover');
    $('#search-input').value = '';
    $('#search-bar').classList.remove('has-text');
    if (state._firstItem) state._firstItem.click();
    else switchView('playlist');
  });
  $('#nav-search').addEventListener('click', () => {
    setNavActive('search');
    $('#search-input').focus();
  });
  $('#nav-settings').addEventListener('click', openSettings);
  $('#close-settings').addEventListener('click', () => $('#settings-overlay').classList.add('hidden'));
  $('#settings-overlay').addEventListener('click', (e) => {
    if (e.target === $('#settings-overlay')) $('#settings-overlay').classList.add('hidden');
  });

  // 首页:播放全部日推
  $('#home-play-all').addEventListener('click', () => {
    if (!state.dailySongs || !state.dailySongs.length) { toast('暂无日推歌曲'); return; }
    state.queue = state.dailySongs;
    playAt(0);
  });
  // 新建歌单
  $('#pl-new-btn').addEventListener('click', openPlName);
  $('#pl-name-ok').addEventListener('click', () => createPlaylist($('#pl-name-input').value.trim()));
  $('#pl-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPlaylist($('#pl-name-input').value.trim());
  });
  $('#close-pl-name').addEventListener('click', closePlName);
  $('#pl-name-overlay').addEventListener('click', (e) => {
    if (e.target === $('#pl-name-overlay')) closePlName();
  });
  $('#close-add-pl').addEventListener('click', () => $('#add-pl-overlay').classList.add('hidden'));
  $('#add-pl-overlay').addEventListener('click', (e) => {
    if (e.target === $('#add-pl-overlay')) $('#add-pl-overlay').classList.add('hidden');
  });
  // 归档管理二级页面
  $('#open-archived').addEventListener('click', openArchivedManage);
  $('#close-archived').addEventListener('click', closeArchivedManage);
  $('#archived-overlay').addEventListener('click', (e) => {
    if (e.target === $('#archived-overlay')) closeArchivedManage();
  });
  $('#archived-restore-all').addEventListener('click', restoreAllArchived);
  // 歌曲百科
  $('#wiki-btn').addEventListener('click', () => {
    const t = state.queue[state.index];
    if (!t) { toast('请先选择歌曲'); return; }
    openWiki(t.id, t.name, t.artists);
  });
  $('#wiki-back').addEventListener('click', () => switchView(wikiLastView === 'wiki' ? 'home' : wikiLastView || 'home'));
  // 歌手主页返回
  $('#artist-back').addEventListener('click', () => switchView(artistLastView === 'artist' ? 'home' : artistLastView || 'home'));

  // 设置项
  const bindSetting = (id, key) => {
    document.getElementById(id).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      saveSettings();
      applySettings();
    });
  };
  bindSetting('set-spectrum', 'spectrum');
  $('#set-balance').addEventListener('change', (e) => {
    settings.balance = e.target.checked;
    saveSettings();
    applySettings();
    balanceStateChanged();
  });
  bindSetting('set-spin', 'spin');
  bindSetting('set-blur', 'blur');
  bindSetting('set-trans', 'trans');
  bindSetting('set-desktop-lyric', 'desktopLyric');
  bindSetting('set-through', 'through');
  bindSetting('set-report', 'report');
  $('#set-zoom').addEventListener('change', (e) => {
    settings.zoom = Number(e.target.value);
    saveSettings();
    applySettings();
  });

  // ---------- 小窗样式配置(主题色/透明度/封面布局/元素偏移) ----------
  const LYRIC_SWATCHES = ['#3C4A6E', '#6B7FD4', '#7C4DFF', '#E91E63', '#FF6F00', '#00897B', '#C62828', '#2E7D32', '#5D4037', '#37474F'];
  const LCFG_OFF = [
    ['lcfg-off-cover', 'offCover', 'lcfg-off-cover-val'],
    ['lcfg-off-name', 'offName', 'lcfg-off-name-val'],
    ['lcfg-off-swap', 'offSwap', 'lcfg-off-swap-val'],
    ['lcfg-off-bar', 'offBar', 'lcfg-off-bar-val']
  ];
  let lcfg = {};
  const pushLcfg = () => window.player.lyricConfigSet({ ...lcfg });
  function renderLcfgSwatches() {
    const wrap = $('#lcfg-swatches');
    const cur = String(lcfg.accent || '').toLowerCase();
    wrap.innerHTML = LYRIC_SWATCHES.map((c) =>
      `<div class="lcfg-swatch${c.toLowerCase() === cur ? ' on' : ''}" style="background:${c}" data-c="${c}"></div>`).join('');
    wrap.querySelectorAll('.lcfg-swatch').forEach((s) => {
      s.addEventListener('click', () => {
        lcfg.accent = s.dataset.c;
        $('#lcfg-accent').value = lcfg.accent;
        renderLcfgSwatches();
        pushLcfg();
      });
    });
  }
  function syncLcfgUI() {
    $('#lcfg-accent').value = lcfg.accent || '#3C4A6E';
    renderLcfgSwatches();
    $('#lcfg-opacity').value = lcfg.opacity;
    $('#lcfg-opacity-val').textContent = lcfg.opacity + '%';
    $('#lcfg-bg').value = lcfg.bgAlpha;
    $('#lcfg-bg-val').textContent = lcfg.bgAlpha + '%';
    $('#lcfg-cover').checked = !!lcfg.showCover;
    $('#lcfg-cover-right').checked = lcfg.coverSide === 'right';
    $('#lcfg-coversize').value = lcfg.coverSize;
    $('#lcfg-coversize-val').textContent = lcfg.coverSize;
    $('#lcfg-lyricsize').value = lcfg.lyricSize;
    $('#lcfg-lyricsize-val').textContent = lcfg.lyricSize;
    LCFG_OFF.forEach(([id, key, valId]) => {
      $(`#${id}`).value = lcfg[key];
      $(`#${valId}`).textContent = lcfg[key];
    });
  }
  async function openLyricConfig() {
    lcfg = await window.player.lyricConfigGet();
    syncLcfgUI();
    $('#lyric-config-overlay').classList.remove('hidden');
    if (!settings.desktopLyric) toast('建议先开启桌面歌词,边调边看');
  }
  const closeLyricConfig = () => $('#lyric-config-overlay').classList.add('hidden');
  $('#open-lyric-config').addEventListener('click', openLyricConfig);
  $('#close-lcfg').addEventListener('click', closeLyricConfig);
  $('#lyric-config-overlay').addEventListener('click', (e) => {
    if (e.target === $('#lyric-config-overlay')) closeLyricConfig();
  });
  $('#lcfg-accent').addEventListener('input', (e) => {
    lcfg.accent = e.target.value;
    renderLcfgSwatches();
    pushLcfg();
  });
  $('#lcfg-opacity').addEventListener('input', (e) => {
    lcfg.opacity = Number(e.target.value);
    $('#lcfg-opacity-val').textContent = lcfg.opacity + '%';
    pushLcfg();
  });
  $('#lcfg-bg').addEventListener('input', (e) => {
    lcfg.bgAlpha = Number(e.target.value);
    $('#lcfg-bg-val').textContent = lcfg.bgAlpha + '%';
    pushLcfg();
  });
  $('#lcfg-cover').addEventListener('change', (e) => {
    lcfg.showCover = e.target.checked;
    pushLcfg();
  });
  $('#lcfg-cover-right').addEventListener('change', (e) => {
    lcfg.coverSide = e.target.checked ? 'right' : 'left';
    pushLcfg();
  });
  $('#lcfg-coversize').addEventListener('input', (e) => {
    lcfg.coverSize = Number(e.target.value);
    $('#lcfg-coversize-val').textContent = lcfg.coverSize;
    pushLcfg();
  });
  $('#lcfg-lyricsize').addEventListener('input', (e) => {
    lcfg.lyricSize = Number(e.target.value);
    $('#lcfg-lyricsize-val').textContent = lcfg.lyricSize;
    pushLcfg();
  });
  LCFG_OFF.forEach(([id, key, valId]) => {
    $(`#${id}`).addEventListener('input', (e) => {
      lcfg[key] = Number(e.target.value);
      $(`#${valId}`).textContent = lcfg[key];
      pushLcfg();
    });
  });
  $('#lcfg-reset').addEventListener('click', async () => {
    window.player.lyricConfigReset();
    lcfg = await window.player.lyricConfigGet();
    syncLcfgUI();
    toast('已恢复默认小窗样式');
  });

  $('#search-input').addEventListener('input', onSearchInput);
  $('#search-clear').addEventListener('click', () => {
    $('#search-input').value = '';
    onSearchInput();
    $('#search-input').focus();
  });

  $('#level-select').addEventListener('change', (e) => {
    state.level = e.target.value;
    if (state.index >= 0) {
      const t = state.queue[state.index];
      loadAndPlay(t).then(() => toast(`已切换音质`));
    }
  });

  // 进度条
  $('#seek').addEventListener('input', (e) => {
    state.seeking = true;
    if (audio.duration) {
      const t = (Number(e.target.value) / 1000) * audio.duration;
      $('#time-cur').textContent = fmtTime(t);
    }
  });
  $('#seek').addEventListener('change', (e) => {
    if (audio.duration) {
      audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
    }
    state.seeking = false;
  });

  // 音量(记忆上次设置)
  const vol = $('#volume');
  let savedVol = 80;
  try { savedVol = Number(localStorage.getItem('nebula-volume')) || 80; } catch (e) { /* 忽略 */ }
  savedVol = Math.min(100, Math.max(0, savedVol));
  vol.value = String(savedVol);
  audio.volume = savedVol / 100;
  vol.addEventListener('input', (e) => {
    audio.volume = Number(e.target.value) / 100;
    try { localStorage.setItem('nebula-volume', String(e.target.value)); } catch (err) { /* 忽略 */ }
  });

  // 音量平衡:初始化 Web Audio 链路 + 周期采样响度
  ensureBalanceGraph();
  setInterval(() => { balanceTick(); probeTick(); }, 400);

  // 音频事件
  audio.addEventListener('timeupdate', () => {
    if (!state.seeking && audio.duration) {
      $('#seek').value = (audio.currentTime / audio.duration) * 1000;
      $('#time-cur').textContent = fmtTime(audio.currentTime);
    }
    updateLyric();
    pushDesktopLyric(false); // 节流刷新进度/封面等
    savePlayback(false);     // 节流保存播放进度
    checkReport();           // 收听上报(满 30s)
  });
  audio.addEventListener('loadedmetadata', () => {
    $('#time-total').textContent = fmtTime(audio.duration);
  });
  audio.addEventListener('play', () => { resumeBalanceCtx(); setPlaying(true); savePlayback(true); pushDesktopLyric(true); if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'playing'; } catch (e) { /* 忽略 */ } } });
  audio.addEventListener('pause', () => { setPlaying(false); savePlayback(true); pushDesktopLyric(true); if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = 'paused'; } catch (e) { /* 忽略 */ } } });
  audio.addEventListener('ended', () => { reportOnEnded(); next(); });
  // 高频驱动歌词行检测(弥补 timeupdate ~250ms 量化,降低歌词切换延迟)
  setInterval(() => {
    if (!audio.paused && audio.src) {
      updateLyric();
      pushDesktopLyric(false);
    }
  }, 100);
  audio.addEventListener('error', () => {
    toast('播放出错(可能无版权)');
    setPlaying(false);
    // 上报错误详情到日志
    const info = { msg: 'audio error, src=' + (audio.src || '').slice(0, 160) + ', readyState=' + audio.readyState + ', networkState=' + audio.networkState };
    fetch(`http://127.0.0.1:${state.port}/api/log/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(info)
    }).catch(() => {});
  });

  // 空格键播放/暂停,双击封面看歌词(阻止文本选中)
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.matches('input, select')) {
      e.preventDefault();
      togglePlay();
    }
    // 多媒体键兜底:F5/F6/F7
    if (e.code === 'F5') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'F6') { e.preventDefault(); next(); }
    else if (e.code === 'F7') { e.preventDefault(); prev(); }
  });
  // 封面:单击进歌曲百科,双击进歌词(延迟区分)
  let coverClickTimer = null;
  $('.cover').addEventListener('click', () => {
    clearTimeout(coverClickTimer);
    coverClickTimer = setTimeout(() => {
      const t = state.queue[state.index];
      if (t) openWiki(t.id, t.name, t.artists);
      else toast('请先选择歌曲');
    }, 260);
  });
  $('.cover').addEventListener('dblclick', (e) => {
    e.preventDefault();
    clearTimeout(coverClickTimer);
    toggleLyricView();
  });
  $('#pb-title').addEventListener('click', toggleLyricView);
  $('#pb-title').style.cursor = 'pointer';

  // 退出前兜底保存播放状态
  window.addEventListener('beforeunload', () => savePlayback(true));

  // 点击任意处关闭右键菜单
  document.addEventListener('click', closePlMenu);

  // 红心收藏
  $('#like-btn').addEventListener('click', toggleLike);

  // 私人 FM
  $('#nav-fm').addEventListener('click', toggleFm);

  // 定位到歌单中的当前歌曲
  $('#locate-btn').addEventListener('click', locateCurrentSong);

  // 系统媒体控制(SMTC)
  setupMediaSession();

  // 桌面歌词窗口被用户关闭(点 ✕)时,同步关闭设置开关
  if (window.player && window.player.onLyricWindowClosed) {
    window.player.onLyricWindowClosed(() => {
      settings.desktopLyric = false;
      saveSettings();
      $('#set-desktop-lyric').checked = false;
    });
  }

  // 遥控窗控制按钮 → 执行播放操作
  if (window.player && window.player.onRemoteControl) {
    window.player.onRemoteControl((cmd) => {
      const action = typeof cmd === 'string' ? cmd : (cmd && cmd.action);
      if (action === 'toggle') togglePlay();
      else if (action === 'next') next();
      else if (action === 'prev') prev();
      else if (action === 'seek' && cmd && Number.isFinite(Number(cmd.time))) {
        try { audio.currentTime = Number(cmd.time); } catch (e) { /* 忽略 */ }
      }
    });
  }
}

/* ============ 播放列表 ============ */
function openQueue() {
  renderQueue();
  $('#queue-overlay').classList.remove('hidden');
}

function renderQueue() {
  const q = state.queue;
  const list = $('#queue-list');
  $('#queue-count').textContent = q.length || '';
  if (!q.length) {
    list.innerHTML = '<div class="empty-tip">播放列表为空,点击歌曲开始播放</div>';
    return;
  }
  // 下一首(仅正序/倒序可预知,随机/单曲不可预知)
  let nextIdx = -1;
  if (state.playMode === 'order') nextIdx = (state.index + 1) % q.length;
  else if (state.playMode === 'reverse') nextIdx = (state.index - 1 + q.length) % q.length;
  list.innerHTML = q.map((t, i) => {
    const isActive = i === state.index;
    const isNext = !isActive && i === nextIdx;
    const idxMark = isActive
      ? '<span class="q-idx" style="color:var(--on-container);font-weight:600;">▶</span>'
      : isNext
        ? '<span class="q-next">下一首</span>'
        : `<span class="q-idx">${i + 1}</span>`;
    return `<div class="queue-row${isActive ? ' active' : ''}" data-i="${i}" draggable="true" title="拖动排序">
      ${idxMark}
      <span class="q-name">${esc(t.name)}</span>
      <span class="q-artist">${esc(t.artists || '')}</span>
      <button class="q-mv up" title="上移" data-i="${i}">&uarr;</button>
      <button class="q-mv down" title="下移" data-i="${i}">&darr;</button>
      <button class="q-del" title="移除" data-i="${i}">✕</button>
    </div>`;
  }).join('');
  // 点击播放(排除删除/上移/下移按钮)
  list.querySelectorAll('.queue-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.q-del, .q-mv')) return;
      playAt(Number(row.dataset.i)); // playAt 会在面板可见时刷新高亮
    });
  });
  // 删除单曲
  list.querySelectorAll('.q-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(Number(btn.dataset.i));
    });
  });
  // 上移/下移
  list.querySelectorAll('.q-mv').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(btn.dataset.i);
      if (btn.classList.contains('up')) moveQueueItem(i, i - 1);
      else moveQueueItem(i, i + 1);
    });
  });
  bindQueueDrag(list);
}

// 从队列移除(同步 index/播放状态)
function removeFromQueue(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.queue.splice(i, 1);
  if (i < state.index) state.index--;
  else if (i === state.index && state.index >= state.queue.length) state.index = state.queue.length - 1;
  if (!state.queue.length) {
    state.index = -1;
    stopAndClearPlayback();
    return;
  }
  savePlayback(true);
  renderQueue();
  updateLikeBtn();
  markActiveSongList();
}

// 清空队列:停止播放并重置播放器状态
function clearQueue() {
  if (!state.queue.length) return;
  state.queue = [];
  state.index = -1;
  preShuffleQueue = null;
  stopAndClearPlayback();
}

// 停止播放并清空播放栏/歌词/存储(队列为空时调用)
function stopAndClearPlayback() {
  try { audio.pause(); } catch (e) { /* 忽略 */ }
  try { audio.removeAttribute('src'); audio.load(); } catch (e) { /* 忽略 */ }
  setPlaying(false);
  $('#pb-title').textContent = '';
  $('#pb-artist').textContent = '';
  const cov = $('.cover');
  if (cov) cov.innerHTML = '';
  const lyr = $('#lyric-panel');
  if (lyr) lyr.innerHTML = '';
  const appBg = $('#app-bg');
  if (appBg) appBg.style.removeProperty('--app-bg-img');
  document.body.style.removeProperty('--cover-accent');
  updateMediaSession(null);
  try { localStorage.removeItem('nebula-playback'); } catch (e) { /* 忽略 */ }
  renderQueue();
  updateLikeBtn();
  markActiveSongList();
}

// 安全移动队列项(边界钳制),并同步当前播放索引;拖拽与上/下移共用
function moveQueueItem(from, to) {
  const q = state.queue;
  if (from === to) return;
  if (from < 0 || from >= q.length) return;
  to = Math.max(0, Math.min(to, q.length - 1));
  if (to === from) return;
  const [m] = q.splice(from, 1);
  q.splice(to, 0, m);
  if (from === state.index) state.index = to;
  else if (from < state.index && to >= state.index) state.index--;
  else if (from > state.index && to <= state.index) state.index++;
  savePlayback(true);
  renderQueue();
  markActiveSongList();
}

// 队列拖拽排序(事件委托;列表节点跨重绘复用,每个列表只绑定一次,避免处理器累积)
let qDragFrom = -1;
function bindQueueDrag(list) {
  if (list.dataset.dragBound) return;
  list.dataset.dragBound = '1';
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.queue-row');
    if (!row) return;
    qDragFrom = Number(row.dataset.i);
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragend', () => {
    qDragFrom = -1;
    list.querySelectorAll('.queue-row').forEach((r) => r.classList.remove('dragging', 'drop-hint'));
  });
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    const row = e.target.closest('.queue-row');
    list.querySelectorAll('.queue-row').forEach((r) => r.classList.remove('drop-hint'));
    if (row && qDragFrom >= 0) row.classList.add('drop-hint');
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const row = e.target.closest('.queue-row');
    if (!row || qDragFrom < 0) return;
    moveQueueItem(qDragFrom, Number(row.dataset.i));
    qDragFrom = -1;
  });
}

// 歌单内过滤(基于最近一次歌单)
function applyPlaylistFilter(q) {
  const keyword = String(q || '').trim().toLowerCase();
  const tracks = state.lastQueue;
  const list = keyword
    ? tracks.filter((t) => (t.name + ' ' + (t.artists || '') + ' ' + (t.album || '')).toLowerCase().includes(keyword))
    : tracks;
  renderSongList($('#song-list'), list, true);
  $('#pl-sub').textContent = list.length ? `${list.length} 首` : '无匹配结果';
}

init();
