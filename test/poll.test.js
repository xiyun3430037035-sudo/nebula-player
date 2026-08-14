'use strict';

// 模拟扫码轮询,验证 Set-Cookie 累积(用户扫码确认后状态能否推进)
const { NeteaseApi } = require('../core/api');

async function main() {
  const api = new NeteaseApi();
  console.log('初始 cookie:', api.cookie);

  const key = await api.qrCreateKey();
  console.log('unikey:', key);

  for (let i = 0; i < 3; i++) {
    const st = await api.qrCheck(key);
    const csrf = api._csrf();
    console.log(`轮询${i + 1}: state=${st.state} | 当前cookie含__csrf=${csrf ? 'yes(' + csrf.slice(0,6) + '…)' : 'no'} | cookie长度=${api.cookie.length}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('\n最终 cookie:', api.cookie.slice(0, 200));
}

main().catch((e) => console.error('err', e));
