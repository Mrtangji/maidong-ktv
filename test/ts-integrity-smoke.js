'use strict';
/* 冒烟测试：TS 完整性校验 192 修复 + 头偏移探测 192 变体 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ets = require('D:/WorkBuddy/maidong-server/src/ets');

// BulkDownloader.checkTsIntegrity 不便独立实例化（构造需要目录），复制同逻辑不可取——
// 直接 require bulk.js 并用最小参数实例化（只用到 fs，无副作用）
const { BulkDownloader } = require('D:/WorkBuddy/maidong-server/src/bulk.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsbug-'));
const mk = (name, buf) => { const p = path.join(tmp, name); fs.writeFileSync(p, buf); return p; };

const pkt188 = Buffer.alloc(188, 0); pkt188[0] = 0x47;
const pkt192 = Buffer.alloc(192, 0); pkt192[4] = 0x47;   // M2TS：+4 处才是同步字节

const b = new BulkDownloader(tmp, tmp);
let pass = 0, failN = 0;
const t = (name, cond) => { cond ? pass++ : (failN++, console.log('FAIL:', name)); };

// 188 标准 TS：通过
t('188 标准 TS 通过', b.checkTsIntegrity(mk('a.ts', Buffer.concat([pkt188, pkt188, pkt188]))) === true);
// 192 M2TS：修复前会误判 false → 必须通过
t('192 M2TS 通过（+4 偏移修复）', b.checkTsIntegrity(mk('b.ts', Buffer.concat([pkt192, pkt192, pkt192]))) === true);
// 188 但同步字节坏：不通过
const bad188 = Buffer.concat([pkt188, pkt188, pkt188]); bad188[188] = 0x12;
t('188 中间包坏 → 拒绝', b.checkTsIntegrity(mk('c.ts', bad188)) === false);
// 192 中间包坏：不通过
const bad192 = Buffer.concat([pkt192, pkt192, pkt192]); bad192[192 + 4] = 0x12;
t('192 中间包坏 → 拒绝', b.checkTsIntegrity(mk('d.ts', bad192)) === false);
// 大小不对齐：拒绝
t('非整包对齐 → 拒绝', b.checkTsIntegrity(mk('e.ts', Buffer.alloc(1000))) === false);

// ets.isValidTsStream 同逻辑
t('ets isValidTsStream 192 通过', ets.isValidTsStream(path.join(tmp, 'b.ts')) === true);
t('ets isValidTsStream 188 通过', ets.isValidTsStream(path.join(tmp, 'a.ts')) === true);

// detectHeaderOffset：512 私有头 + 192 M2TS 数据段 → 应探出 512（192 变体）
const header512 = Buffer.alloc(512, 0x55);
const m2tsData = Buffer.concat(Array.from({ length: 10 }, () => pkt192));
const f192 = mk('f.ts', Buffer.concat([header512, m2tsData]));
const head = Buffer.alloc(4096); head.set(header512, 0);
head.set(m2tsData.subarray(0, 4096 - 512), 512);
t('detectHeaderOffset 192 变体 → 512', ets.detectHeaderOffset(fs.statSync(f192).size, head) === 512);

// detectHeaderOffset：512 头 + 188 数据段 → 512（原逻辑回归）
const tsData = Buffer.concat(Array.from({ length: 10 }, () => pkt188));
head.set(tsData.subarray(0, 4096 - 512), 512);
const f188 = mk('g.ts', Buffer.concat([header512, tsData]));
t('detectHeaderOffset 188 → 512（回归）', ets.detectHeaderOffset(fs.statSync(f188).size, head) === 512);

// detectHeaderOffset 的调用契约：仅在首字节非 0x47 时才会被调用（纯 TS 提前返回），
// 纯 TS 数据输入属于超出契约场景，不做断言。

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${failN} 失败`);
process.exit(failN ? 1 : 0);
