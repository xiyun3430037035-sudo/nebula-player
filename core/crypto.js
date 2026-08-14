'use strict';

// 网易云 weapi 加密实现(纯 Node,无第三方依赖)
const crypto = require('crypto');

const MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const PUB_KEY = '010001';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const EAPI_KEY = 'e82ckenh8dichen8';

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomSecretKey(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'));
  let enc = cipher.update(text, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

function rsaEncrypt(text) {
  // 网易云 weapi:对反转后的明文做 RSA 裸加密(无 padding,即 forge 'NONE')。
  // 注意:此公钥为 1024 位(modulus 128 字节),输出固定 256 hex 字符,padStart(256)。
  const reversed = Buffer.from(text, 'utf8').reverse();
  const hex = reversed.toString('hex');
  const message = BigInt('0x' + hex);
  const exp = BigInt('0x' + PUB_KEY);
  const mod = BigInt('0x' + MODULUS);
  let result = 1n;
  let base = message % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % mod;
    e >>= 1n;
    base = (base * base) % mod;
  }
  return result.toString(16).padStart(256, '0');
}

function weapi(params) {
  const text = JSON.stringify(params || {});
  const secretKey = randomSecretKey(16);
  // 双重 AES:文本先由预设密钥加密,再由随机密钥加密
  const data = aesEncrypt(aesEncrypt(text, PRESET_KEY), secretKey);
  return {
    params: data,
    encSecKey: rsaEncrypt(secretKey)
  };
}

// 网易云 PC 客户端 EAPI 加密:消息 = url-36cd479b6b5-json-36cd479b6b5-md5,
// 再用固定 key 做 AES-128-ECB(PKCS7),输出大写 hex。
// url 传入的是 `/api/xxx` 形式的路径(与真实 /eapi/xxx 端点一一对应)。
function eapi(url, params) {
  const text = JSON.stringify(params || {});
  const digest = crypto.createHash('md5')
    .update(`nobody${url}use${text}md5forencrypt`)
    .digest('hex');
  const plaintext = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null);
  const enc = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final()
  ]);
  return { params: enc.toString('hex').toUpperCase() };
}

module.exports = { weapi, eapi };
