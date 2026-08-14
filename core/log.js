'use strict';

// 极简日志模块:追加写文件,支持读取尾部
const fs = require('fs');
const path = require('path');

let logFile = '';
const MAX_BYTES = 512 * 1024; // 512KB 后轮转

function init(file) {
  logFile = file || '';
  if (logFile) {
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (e) { /* 忽略 */ }
  }
}

function log(level, msg) {
  if (!logFile) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [${level}] ${msg}\n`;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_BYTES) {
      fs.renameSync(logFile, logFile + '.old');
    }
    fs.appendFileSync(logFile, line);
  } catch (e) { /* 忽略 */ }
}

function read(limit) {
  if (!logFile) return '';
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-(limit || 300)).join('\n');
  } catch (e) {
    return '';
  }
}

module.exports = { init, log, read };
