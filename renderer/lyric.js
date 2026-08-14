'use strict';

const $ = (s) => document.querySelector(s);
const coverEl = $('#cover');
const coverPh = $('#cover-ph');

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------- 歌词:单条显示 + 译文,淡出 → 换文本 → 淡入(排队不丢) ---------- */
const curEl = $('#l-cur');
const transEl = $('#l-trans');

let lyricBusy = false;
let lyricPending = null;

function setCur(text, trans) {
  if (curEl.textContent === text && transEl.textContent === trans) return;
  if (lyricBusy) {
    lyricPending = { cur: text, trans: trans || '' };
    return;
  }
  lyricBusy = true;
  curEl.classList.add('out');
  transEl.classList.add('out');
  setTimeout(() => {
    curEl.textContent = text;
    transEl.textContent = trans || '';
    void curEl.offsetWidth; // 强制重排,重新触发过渡
    curEl.classList.remove('out');
    transEl.classList.remove('out');
    lyricBusy = false;
    checkSingleLine();
    if (lyricPending) {
      const p = lyricPending;
      lyricPending = null;
      setCur(p.cur, p.trans);
    }
  }, 120);
}

// 单行歌词:字放大(.single)
function checkSingleLine() {
  requestAnimationFrame(() => {
    const hasText = !!curEl.textContent;
    const single = hasText && !transEl.textContent && curEl.scrollHeight <= curEl.clientHeight + 2;
    curEl.classList.toggle('single', single);
  });
}

/* ---------- 播放/暂停图标 ---------- */
const ICON_PLAY = 'M8 5v14l11-7z';
const ICON_PAUSE = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';

let lastCover = null;
let seekingRemote = false;

window.lyricWin.onData((d) => {
  setCur((d && d.cur) || '', (d && d.curTrans) || '');
  document.body.classList.toggle('empty', !(d && d.has));
  document.body.classList.toggle('paused', !(d && d.playing));

  // 封面 + 背景模糊(仅变化时更新)
  const cover = (d && d.cover) || '';
  if (cover !== lastCover) {
    lastCover = cover;
    if (cover) {
      coverEl.innerHTML = `<img src="${cover}" alt="">`;
      coverPh.style.display = 'none';
      $('#bg-blur').style.setProperty('--bg-img', `url("${cover}")`);
    } else {
      coverEl.innerHTML = '';
      coverPh.style.display = 'flex';
      $('#bg-blur').style.setProperty('--bg-img', 'none');
    }
  }
  const name = (d && d.name) || 'Nebula';
  const artist = (d && d.artist) || '';
  $('#name').textContent = name;
  $('#artist').textContent = artist;
  const dur = (d && d.dur) || 0;
  $('#t-cur').textContent = fmt((d && d.curTime) || 0);
  $('#t-dur').textContent = fmt(dur);
  $('#seek').max = dur || 1;
  if (!seekingRemote) {
    $('#bar-fill').style.width = (dur ? Math.min(100, ((d.curTime || 0) / dur) * 100) : 0).toFixed(1) + '%';
    $('#seek').value = (d.curTime || 0);
  }
  $('#ctl-path').setAttribute('d', d && d.playing ? ICON_PAUSE : ICON_PLAY);
});

/* ---------- 控制按钮 + seek ---------- */
$('#ctl-prev').addEventListener('click', () => window.lyricWin.control('prev'));
$('#ctl-toggle').addEventListener('click', () => window.lyricWin.control('toggle'));
$('#ctl-next').addEventListener('click', () => window.lyricWin.control('next'));

const seekEl = $('#seek');
seekEl.addEventListener('pointerdown', () => { seekingRemote = true; });
seekEl.addEventListener('pointerup', () => {
  seekingRemote = false;
  window.lyricWin.control({ action: 'seek', time: Number(seekEl.value) });
});
seekEl.addEventListener('input', () => {
  const pct = seekEl.max > 0 ? (seekEl.value / seekEl.max) * 100 : 0;
  $('#bar-fill').style.width = pct.toFixed(1) + '%';
  $('#t-cur').textContent = fmt(Number(seekEl.value));
});

/* ---------- 悬停切换:控制按钮 <-> 歌词(移开 800ms) ---------- */
const ctlRow = $('#ctl-row');
const lyricScroll = $('#lyric-scroll');
let swapTimer = null;

function showControls() {
  clearTimeout(swapTimer);
  ctlRow.classList.add('show');
  ctlRow.classList.remove('hide');
  lyricScroll.classList.add('hide');
  lyricScroll.classList.remove('show');
}
function showLyrics() {
  ctlRow.classList.add('hide');
  ctlRow.classList.remove('show');
  lyricScroll.classList.add('show');
  lyricScroll.classList.remove('hide');
}
document.addEventListener('mousemove', (e) => {
  if (e.target.closest('.ctl') || e.target.closest('.seek') || e.target.closest('.bar')) {
    showControls();
    return;
  }
  clearTimeout(swapTimer);
  swapTimer = setTimeout(showLyrics, 800);
});
document.addEventListener('mouseleave', () => {
  clearTimeout(swapTimer);
  swapTimer = setTimeout(showLyrics, 300);
});

/* ---------- 手动拖拽(主进程光标跟随,按钮/进度条不触发) ---------- */
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('#close-btn') || e.target.closest('.ctl') || e.target.closest('.seek') || e.target.closest('.bar')) return;
  window.lyricWin.startDrag();
});
function endDrag() { window.lyricWin.endDrag(); }
document.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);
document.addEventListener('mouseleave', endDrag);

/* ---------- 个性化配置:主题色/透明度/封面布局/元素偏移(变量注入) ---------- */
function hexToRgb(hex) {
  let m = String(hex || '').replace('#', '');
  if (m.length === 3) m = m.split('').map((c) => c + c).join('');
  const v = parseInt(m, 16);
  if (isNaN(v)) return [60, 74, 110];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function lighten(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const f = (v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
  const to = (v) => Math.max(0, Math.min(255, f(v))).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
function clampNum(v, lo, hi, def) {
  const n = Number(v);
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}
function applyConfig(cfg) {
  const c = cfg || {};
  const acc = /^#[0-9a-fA-F]{3,8}$/.test(c.accent || '') ? c.accent : '#3C4A6E';
  const s = document.documentElement.style;
  const set = (k, v) => s.setProperty(k, v);
  set('--acc', acc);
  set('--acc-bar', lighten(acc, 0.22));
  set('--acc-soft', rgba(acc, 0.45));
  set('--acc-faint', rgba(acc, 0.4));
  set('--acc-25', rgba(acc, 0.25));
  set('--acc-62', rgba(acc, 0.62));
  set('--acc-18', rgba(acc, 0.18));
  set('--acc-14', rgba(acc, 0.14));
  set('--acc-12', rgba(acc, 0.12));
  set('--acc-10', rgba(acc, 0.1));
  set('--acc-06', rgba(acc, 0.06));
  set('--acc-main-bg', rgba(acc, 0.18));
  set('--acc-main-hover', rgba(acc, 0.28));
  const bgA = clampNum(c.bgAlpha, 35, 95, 92) / 100;
  set('--card-bg', `rgba(247,247,252,${bgA})`);
  set('--bg-mask', `rgba(247,247,252,${Math.min(0.7, bgA + 0.05)})`);
  document.body.classList.toggle('no-cover', c.showCover === false);
  document.body.classList.toggle('cover-right', c.coverSide === 'right');
  set('--cover-size', clampNum(c.coverSize, 56, 120, 86) + 'px');
  set('--lyric-size', clampNum(c.lyricSize, 12, 20, 14) + 'px');
  const off = (v) => clampNum(v, -40, 40, 0) + 'px';
  set('--off-cover', off(c.offCover));
  set('--off-name', off(c.offName));
  set('--off-swap', off(c.offSwap));
  set('--off-bar', off(c.offBar));
}
window.lyricWin.onConfig(applyConfig);
window.lyricWin.getConfig().then(applyConfig).catch(() => {});

/* ---------- 穿透状态:开启=看板模式,强制显示歌词(鼠标事件被穿透阻断,悬停切换失效) ---------- */
window.lyricWin.onThroughState((on) => {
  document.body.classList.toggle('through', on);
  if (on) showLyrics();   // 穿透时永远显示歌词
  else showControls();    // 关闭穿透恢复交互默认(显示控制按钮)
});

/* ---------- 关闭 ---------- */
$('#close-btn').addEventListener('click', () => window.lyricWin.close());
