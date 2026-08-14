'use strict';

// 验证 Cookie 表格解析:自动筛选 music.163.com 域
const { parseCookiesFromText } = require('../core/server');

const sample = `__csrf\t00000000000000000000000000000000\t.music.163.com\t/\t2026-08-20\t38
BAIDUID\tFAKE-BAIDUID-TEST-00000000000000000000:FG=1\t.baidu.com\t/\t2026-11-04\t44
MUSIC_U\tFAKE_MUSIC_U_TEST_VALUE_00000000000000000000\t.music.163.com\t/\t2027-02-01\t841
NMTID\tFAKE-NMTID-TEST-000000000000000000000000\t.music.163.com\t/\t2026-10-19\t46
P_INFO\ttest@example.com|0000000000\t.163.com\t/\t2027-04-05\t106
sDeviceId\tFAKE%2BTEST%2BsDeviceId%2B000000000000\t.music.163.com\t/\t2026-10-19\t48
WM_NI\tFAKE-WM-NI-TEST-000000000000000000000000\tmusic.163.com\t/\t2027-09-09\t143`;

const map = parseCookiesFromText(sample);
console.log('解析结果 keys:', Object.keys(map).join(', '));
console.log('MUSIC_U =', map.MUSIC_U);
console.log('含 __csrf:', !!map.__csrf);
console.log('含 NMTID:', !!map.NMTID);
console.log('含 sDeviceId:', !!map.sDeviceId);
console.log('排除 baidu/163.com 无关项:', !map.BAIDUID && !map.P_INFO ? '✓' : '✗ 未排除: ' + Object.keys(map).filter((k) => ['BAIDUID', 'P_INFO'].includes(k)).join(','));

const ok = map.MUSIC_U && map.__csrf && map.NMTID && map.sDeviceId && !map.BAIDUID && !map.P_INFO;
console.log(ok ? '\nPASS: 解析正确' : '\nFAIL: 解析异常');
process.exit(ok ? 0 : 1);
