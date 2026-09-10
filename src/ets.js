'use strict';
/**
 * 官方 E/ts 规范化（移植自安卓端 TsDecryptor）：
 *   官方 CDN 直链（/E/ts/ 路径）= 512 字节私有头 + 数据段。
 *   头部 offset 500 有签名（THUNDERCRYP3 / HHCMUSECRYP1 / HHCMUSECRYP2）时，
 *   数据段按头部参数做 AES-256-ECB 分段加密，需解密；无签名的变体只需剥头。
 *   normalizeFile 输出统一的标准 MPEG-TS（188 字节包）。
 */

const fs = require('fs');
const crypto = require('crypto');

const HEADER_SIZE = 512;
const TS_PACKET_SIZE = 188;
const MAX_VALIDATION_PACKETS = 32 * 1024;

const THUNDER_KEYS = [
  'c6d3cdd0f1ebf5ded4d7d3cebbd3dad2cecdd0b8deaccbead2c5cac3c2dba6ac',
  'f5deebd8d3ced7b9dad2d3d8d0bcd9f6cbd7c9c2cab1d0f0a6f8d0afd0d3b9d4',
  'c3d4d7b2c2d5aaeecbd3b7dcbcc6b4f4b7d4b2b2fed5e0cbd3d5b2d7c6b7cef3',
  'b6bdaea7ced2d2b4aac1bbd3cbc8b7d6aacbbdaecbd4cbb5f9daddc0cecbe4d7',
  'd7d3d4dde8cedaf3c7b4cbddd2d3aee7f5d6d6b2d2aed0c9cbcddbb2ddf0e6c9',
  'b4d3d3b0d9d6cbe2e2aeaea2d6b8c7b2c3c9e5bbd6d9c7bcaee2d2dababac1b2',
  'd9d6cbe2e2aeaea2d6b2c7b2c3e0e5bbd6d9c7bcaee2d2dababad6b2d3d3b1bb',
  'e2aeaea2d69dc7b2c35fe5bbd6d9c7bcaee2d2dababac2b2d3d3d9bbd6cbe2f0',
  '97bbecd2fab782f0c1d0f6b3bab2c8a9dec7d0ec62fdf8b1d3d2cebccef5c4dd',
  'eadcd4eecad6d3bec7ae81fde6badcd7eecf98d3c1f6d1cefac8d4c2b6d2c4c6',
  'e7bed4c1b5fdd8bcbfd7d0c867d3cbcbd1d4d1d6d4d8e1c8c4c7d1d6eedee1c8',
  'f2b1c8bdbbd4cfeff1b0d0f0d3cbddd4cec492d8d3c2b3e1daedb5fdb1bcf0d0',
  'd3cdd2d6d2f5d1dc81c1b3ba90eec2ee81cecece90c5fdc4ceb2d4cdc4bbd5f5',
  'f5cbaee0b9c9e8cafafae5bfcdcebccef5acc3c4b9d6bccdfadcc3f5bfd6b6d2',
  'd6d3c3b7dcdad2f4b7d6b3c3fedca3f4baccd2c2eeecf3e3b7c3cabdfefcbfab',
  'e0b4e4f8b8c9c9d3a3a5cfdad2cab5d2f3a6dbf3d6bfd2bfaecbcba5cec5bcc3',
];
const HHC1_KEYS = [
  'd7cad2d3d3b1e0d0d4cfcbc5bbb0b5f3d1d6d4d7a7aec3d4b6b2bad4f8bbf5b6',
  'd3cfd2d0b2b6d5d2bbf8dfb2babacebec3c3b4fdb7d7d6d7b8f7aed3c9c2d3ce',
  'cec4babde1b1f5bbc9b6d3b6edf8ebf8ceb2c5b2aabbf3bbc8d6d3d0cbd2d1c5',
  'f6f8dad0d4d0b6d3f2c5f8d0b5b7c7d3dcbad7e0bdb0c8c1f7aecaa6b6d6d0d4',
  'd4b1d2d7bbd8d3d3ceced7b2b4bdd3bbd1d6d4d6a7aebbd8ced1bed4e1a7fdf2',
  'd3d3d3eec7b9d6d2ddb1c1b2ced4d3b1cabbdad8d3b7cacedaf2c7c5d7d7b0c6',
  'd6d7b9c3aed3dbbbc7d4c6b9f3bbe4dbd6b8d6c6aeb8bee4d3d4b8d0ebdab8d0',
  'd0aabbaecbbad2d2f9cdd4e0b2b6c0b2bbf8f1bbd0babdbfd0cddac9d6b2d6d0',
  'd7b1b0b6d3a5b2f8cabec3c9b3d3f4f7ceced3d3dededadac7c7cad1f3f3c2d4',
  'f8c3d3c6c0c0b9c8d6f1b1e7b8d5d4c7bbdfbbd0b6d2cac8f8b2abe7bad7d4b4',
  'd6bbd2d5aebcb2feb2b2d7d2bbbbd3d4bcd6d4b5baaabbc2d6c8cec6aacbaaa9',
  'aee2c0ebd2b6d6d6d4f8aeaed0ced2d2ccded4d4c3b3b5c0f1dcc2f1c3b5c6d3',
  'cbb4b2dcb3d3bbb2c6d0d3d7dfc4e2d3cacbbeceaef9d8cab6d3c3d0f8fbcfa2',
  'aee1c0cfd2d6d6ced4aeaee4c0d2d2b2f1d4d4aecbc0c0cec0f1f1cad4bcc3d0',
  'bebad0c4b4f5a2d1bad7d7d3ced3d3d0d2cfd4cad4c4bbc2b1cec9b5f0caabdc',
  'bda2dee4d2bbd7cbe0d8d3f9d7d2d4d2e3b2bbd4d2b2cab9d4bbd3dbb7d3c6c6',
];
const HHC2_KEYS = [
  'b1b4d6d6f8f3aeaed5cab5b5dfc2d8c0b9cbb4b2fac0e6bbd6c9cdbfaefaf6c9',
  'c0dac9c9d5c9d3d3dfcfebebc1cdd6d6eeacaeaec3d2cbc9f1e2c0fad3bfbfb6',
  'd5b5b7bddfc0b2abc7d6b4c4faf7cbaad6d3ceb2c6c3e5bbb9d2d5ced9b2dfc5',
  'a8f8bfcdc1d6d7b7eedae4a3cacacacaebebebebd0c7c1c3d0bfb7f7b1cac9ce',
  'ced7d5d6aaf4dfc6d6c6d2c8aee4f2a8cacdc0d2c6e2fbb2d2cab6b1d4c6f8f8',
  'f8f8f8f8c8b1b1c4a1b8dcd3d6d6d6d6aeaeaeaecac7c5b1b5bfadb0b6b6b6b6',
  'c3b5cecbedc3b4e3cbcbd5b2e3e3bdbbcab6b6caa4e0f8a4d5d2c3d5dfb2eddf',
  'e1cbf2b8b8b4c7d4eff8a7f2b3bcc0c4b5d7efdac7cac0cda7aea1e2b3cdc1d6',
  'b6b9c7d4dba5fcf2b1b3beb9f8c7c3fab4d4b1d3ecf2a9c3c8c1cab2f1a6a6bb',
  'd9aef8fbcebebed5b4c3c3dfb6d2b6cec3b2f8b4c7b7b9d6c9f2faaed6b1c0d3',
  'c8d2b9d7a1f2cae3d3c1bed2c3b8fcb2d3d3cab9dadab3fab9b5bfd6fad0c9ae',
  'a6dad9aec7d0d0c8fce9d5a5d6d3d6c6d0daaee4d4bcb7c6add2d1dfc4b0cab9',
  'd2b6b8cebbfed1e1d6cad2b6d3aebbfeb5d6cacab1d3afaecebdb5cae1d9b1af',
  'd3e4aed0b6c9cab6f8c6c7f8b3b6ced2cbf8bde6d6d1cac7aef8a4bfd7d6b5b9',
  'b9bebec2fafcfcc3b4ceb4ceceaaceaad6c9d6c9aecfaecfc8c6c8c6abc6abc6',
  'f8f8dff8c7c9d2b7fcc6b2a5c8d6b9c4cbaecab1d6c9c9c6aec6cfe4b1d5b1b4',
];
const SIGNATURES = {
  THUNDERCRYP3: THUNDER_KEYS,
  HHCMUSECRYP1: HHC1_KEYS,
  HHCMUSECRYP2: HHC2_KEYS,
};

function u8(buf, i) { return buf[i] & 0xff; }

/** 解析 512 字节头：有已知签名返回解密参数，否则 null。 */
function parseEncryptedHeader(header) {
  const sig = header.toString('ascii', 500, 512);
  const table = SIGNATURES[sig];
  if (!table) return null;
  const segmentSize = u8(header, 452) * 1024;
  const mode = u8(header, 453);
  const interval = u8(header, 454);
  const firstEncryptedSegment = u8(header, 457);
  if (segmentSize <= 0 || mode !== 0) return null;
  const keyHex = table[u8(header, 53) & 0x0f];
  return {
    key: Buffer.from(keyHex, 'hex'),
    segmentSize,
    interval,
    firstEncryptedSegment,
  };
}

function shouldDecrypt(segmentIndex, firstEncryptedSegment, interval) {
  if (interval === 0) return true;
  return segmentIndex === firstEncryptedSegment ||
    (segmentIndex > firstEncryptedSegment && segmentIndex % interval === 1);
}

/** 文件头偏移探测（无签名变体）：找 188/192 间隔连续 8 包同步字节、且 (size-i) 整包对齐的起点。 */
function detectHeaderOffset(size, head) {
  // 188 标准 TS：同步字节就在包首
  for (let i = 1; i <= head.length - TS_PACKET_SIZE * 8; i++) {
    if ((size - i) % TS_PACKET_SIZE !== 0) continue;
    let ok = true;
    for (let k = 0; k < 8; k++) {
      if (head[i + k * TS_PACKET_SIZE] !== 0x47) { ok = false; break; }
    }
    if (ok) return i;
  }
  // 192 M2TS：每包前 4 字节 TP_extra_header，0x47 在包首 +4 处
  const M2TS_PACKET = 192;
  for (let i = 1; i <= head.length - M2TS_PACKET * 8; i++) {
    if ((size - i) % M2TS_PACKET !== 0) continue;
    let ok = true;
    for (let k = 0; k < 8; k++) {
      if (head[i + 4 + k * M2TS_PACKET] !== 0x47) { ok = false; break; }
    }
    if (ok) return i;
  }
  return 0;
}

/** 输出是否为合法 TS（抽样校验包头 0x47）。 */
function isValidTsStream(file) {
  try {
    const size = fs.statSync(file).size;
    if (size <= 0) return false;
    let pkt = 0;
    if (size % 188 === 0) pkt = 188;
    else if (size % 192 === 0) pkt = 192;
    else return false;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1);
      // 192 字节 M2TS 包：每包前 4 字节是 TP_extra_header，0x47 同步字节在 +4 偏移处
      const syncPos = (pos) => (pkt === 192 ? pos + 4 : pos);
      const syncOk = (pos) => { fs.readSync(fd, buf, 0, 1, syncPos(pos)); return buf[0] === 0x47; };
      if (!syncOk(0)) return false;
      if (!syncOk(size - pkt)) return false;
      const mid = Math.floor(size / 2 / pkt) * pkt;
      if (size > pkt * 2 && !syncOk(mid)) return false;
      return true;
    } finally { fs.closeSync(fd); }
  } catch (_) { return false; }
}

/**
 * 规范化官方 E/ts → 标准 TS（就地替换）。
 * 返回 { changed, decrypted, stripped }；changed=false 表示无需处理（已是标准 TS）。
 * 处理失败抛异常，调用方自行决定回退策略。
 */
async function normalizeFile(inputPath, signal) {
  const stat = fs.statSync(inputPath);
  const size = stat.size;
  const result = { changed: false, decrypted: false, stripped: false };
  if (size < HEADER_SIZE + TS_PACKET_SIZE) return result;

  const fd = fs.openSync(inputPath, 'r');
  let header;
  let probe;
  try {
    const probeSize = Math.min(size, 4096);
    probe = Buffer.alloc(probeSize);
    const n = fs.readSync(fd, probe, 0, probeSize, 0);
    if (n < HEADER_SIZE) return result;
    header = probe.subarray(0, HEADER_SIZE);
  } finally { fs.closeSync(fd); }

  const signed = parseEncryptedHeader(header);
  const firstByte = header[0];
  if (!signed && firstByte === 0x47) return result;   // 已是标准 TS

  const tmp = inputPath + '.norm';
  if (signed) {
    // 有签名：AES-256-ECB 分段解密 + 剥头（与安卓 TsDecryptor 完全一致）
    const cipher = crypto.createDecipheriv('aes-256-ecb', signed.key, null);
    cipher.setAutoPadding(false);
    const inStream = fs.createReadStream(inputPath, { start: HEADER_SIZE, signal: signal || undefined });
    const outStream = fs.createWriteStream(tmp, { signal: signal || undefined });
    await new Promise((resolve, reject) => {
      let segmentIndex = 0;
      let rest = Buffer.alloc(0);
      const flushSegment = (seg) => {
        if (shouldDecrypt(segmentIndex, signed.firstEncryptedSegment, signed.interval)) {
          const encLen = seg.length - (seg.length % 16);
          if (encLen > 0) {
            outStream.write(cipher.update(seg.subarray(0, encLen)));
            if (encLen < seg.length) outStream.write(seg.subarray(encLen));
          } else {
            outStream.write(seg);
          }
        } else {
          outStream.write(seg);
        }
        segmentIndex++;
      };
      inStream.on('data', (chunk) => {
        const data = Buffer.concat([rest, chunk]);
        const segSize = signed.segmentSize;
        let pos = 0;
        while (data.length - pos >= segSize) {
          flushSegment(data.subarray(pos, pos + segSize));
          pos += segSize;
        }
        rest = data.subarray(pos);
      });
      inStream.on('error', reject);
      outStream.on('error', reject);
      inStream.on('end', () => {
        try {
          if (rest.length > 0) flushSegment(rest);
          outStream.end(cipher.final());
        } catch (e) { reject(e); }
      });
      outStream.on('finish', resolve);
    });
    if (fs.statSync(tmp).size !== size - HEADER_SIZE) {
      fs.unlinkSync(tmp);
      throw new Error('E/ts 解密后长度不符');
    }
    result.decrypted = true;
  } else {
    // 无签名：纯私有头（512 字节等），探测偏移后剥掉
    const off = detectHeaderOffset(size, probe);
    if (!off) throw new Error('无法识别的 ts 文件头');
    await new Promise((resolve, reject) => {
      const rd = fs.createReadStream(inputPath, { start: off, signal: signal || undefined });
      const wr = fs.createWriteStream(tmp);
      rd.on('error', reject); wr.on('error', reject);
      wr.on('finish', resolve);
      rd.pipe(wr);
    });
    result.stripped = true;
  }

  if (!isValidTsStream(tmp)) {
    fs.unlinkSync(tmp);
    throw new Error('E/ts 规范化后 TS 校验失败');
  }
  fs.renameSync(tmp, inputPath);
  result.changed = true;
  return result;
}

module.exports = { normalizeFile, parseEncryptedHeader, detectHeaderOffset, isValidTsStream };
