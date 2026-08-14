'use strict';

// EAPI (PC 客户端) 扫码登录探针:验证 unikey / client/login 是否返回 PC 版会话。
// 用法: node tools/eapi-probe.js [unikey]
const crypto = require('crypto');

const EAPI_KEY = 'e82ckenh8dichen8';
const API_DOMAIN = 'https://interface.music.163.com';
const EAPI_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152';

function generateDeviceId() {
  const hexChars = '0123456789ABCDEF';
  let s = '';
  for (let i = 0; i < 52; i++) s += hexChars[Math.floor(Math.random() * 16)];
  return s;
}

function eapiEncrypt(url, object) {
  const text = JSON.stringify(object);
  const digest = crypto.createHash('md5').update(`nobody${url}use${text}md5forencrypt`).digest('hex');
  const plaintext = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return enc.toString('hex').toUpperCase();
}

function buildHeader(deviceId) {
  return {
    osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
    deviceId,
    os: 'pc',
    appver: '3.1.17.204416',
    versioncode: '140',
    mobilename: '',
    buildver: Date.now().toString().substr(0, 10),
    resolution: '1920x1080',
    __csrf: '',
    channel: 'netease',
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`
  };
}

function buildCookie(header) {
  return Object.entries(header)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('; ');
}

async function eapiRequest(path, data, deviceId) {
  const header = buildHeader(deviceId);
  const payload = { ...data, header };
  const params = eapiEncrypt(`/api/${path}`, payload);
  const resp = await fetch(`${API_DOMAIN}/eapi/${path}`, {
    method: 'POST',
    headers: {
      'User-Agent': EAPI_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': buildCookie(header)
    },
    body: new URLSearchParams({ params }).toString()
  });
  const setCookies = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie()
    : (resp.headers.get('set-cookie') ? [resp.headers.get('set-cookie')] : []);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
  return { status: resp.status, json, setCookies };
}

async function main() {
  const deviceId = generateDeviceId();
  console.log('deviceId =', deviceId);

  const keyRes = await eapiRequest('login/qrcode/unikey', { type: 3 }, deviceId);
  console.log('\n[unikey] status =', keyRes.status);
  console.log('[unikey] body =', JSON.stringify(keyRes.json));
  const unikey = keyRes.json && (keyRes.json.unikey || (keyRes.json.data && keyRes.json.data.unikey));
  if (!unikey) {
    console.log('unikey 获取失败,终止');
    return;
  }
  console.log('[unikey] 二维码内容: https://music.163.com/login?codekey=' + unikey);

  const argKey = process.argv[2];
  const key = argKey || unikey;
  const checkRes = await eapiRequest('login/qrcode/client/login', { key, type: 3 }, deviceId);
  console.log('\n[check] status =', checkRes.status);
  console.log('[check] body =', JSON.stringify(checkRes.json));
  console.log('[check] set-cookie 条数 =', checkRes.setCookies.length);
}

main().catch((e) => {
  console.error('probe error:', e);
  process.exit(1);
});
