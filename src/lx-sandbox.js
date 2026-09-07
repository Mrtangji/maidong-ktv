'use strict';
/**
 * LX Music 自定义源脚本沙箱（Node 版）
 *
 * 移植自 maidong-ktv：
 *   app/src/main/assets/lx_sandbox.html  —— lx shim 契约
 *   app/src/main/java/com/local/ktv/LxSourceSandbox.kt —— 原生桥（HTTP/crypto/zlib）
 *
 * 在 Node 里 crypto / zlib / http 都是原生能力，不再需要 WebView 桥。
 * 对脚本暴露的 API 与 lx-music-desktop 一致：
 *   lx.EVENT_NAMES / lx.on / lx.send / lx.request / lx.utils(buffer|crypto|zlib)
 */

const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const EVENT_NAMES = { inited: 'inited', request: 'request', updateAlert: 'updateAlert' };
const INIT_TIMEOUT_MS = 20_000;
const RESOLVE_TIMEOUT_MS = 120_000;

// ---------- HTTP（lx.request 的原生实现） ----------

function decompress(buffer, encoding) {
  if (!buffer || !buffer.length) return buffer;
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('deflate')) return zlib.inflateSync(buffer);
  } catch (_) { /* 解压失败按原样返回 */ }
  return buffer;
}

/**
 * 执行 HTTP 请求，回调 (err, resp, bodyBuffer)。
 * options: { url, method, headers, body, form, timeout, responseType }
 */
function httpRequest(options, callback) {
  const opt = options || {};
  let target;
  try {
    target = new URL(opt.url);
  } catch (e) {
    return setTimeout(() => callback(new Error('invalid url')), 0);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return setTimeout(() => callback(new Error('Unsupported URL')), 0);
  }

  const headers = {};
  Object.keys(opt.headers || {}).forEach((name) => { headers[name] = String(opt.headers[name]); });
  if (!headers['User-Agent']) headers['User-Agent'] = 'lx-music-request/2.0.0';

  let body = null;
  let method = String(opt.method || '').toUpperCase();
  if (opt.form != null) {
    body = typeof opt.form === 'string'
      ? Buffer.from(opt.form)
      : Buffer.from(new URLSearchParams(Object.entries(opt.form).map(([k, v]) => [k, String(v)])).toString());
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (opt.body != null) {
    body = Buffer.isBuffer(opt.body) ? opt.body : Buffer.from(String(opt.body));
  }
  if (!method) method = body ? 'POST' : 'GET';

  const reqOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method,
    headers,
    timeout: Math.min(Math.max(Number(opt.timeout) || 15_000, 1_000), 30_000),
  };

  const doRequest = (urlObj, redirectsLeft) => {
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
      timeout: reqOptions.timeout,
    }, (res) => {
      // 跟随重定向（最多 5 次）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        try {
          doRequest(new URL(res.headers.location, urlObj), redirectsLeft - 1);
        } catch (_) {
          callback(new Error('bad redirect'));
        }
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        buf = decompress(buf, res.headers['content-encoding']);
        if (process.env.LX_DEBUG) {
          console.log(`[lx-debug] ${method} ${urlObj.href.slice(0, 120)} -> ${res.statusCode} (${buf.length}B)`);
        }
        const resp = { statusCode: res.statusCode, headers: res.headers };
        callback(null, resp, buf);
      });
      res.on('error', (err) => callback(err));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', (err) => callback(err));
    if (body) req.write(body);
    req.end();
  };

  doRequest(target, 5);
}

// ---------- crypto（对齐 LxSourceSandbox.kt NativeBridge 语义） ----------

function toBuf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(String(value), 'utf8');
}

function aesNormalizeKeyIv(key, iv) {
  // 与 maidong 沙箱一致：key/iv 若非 Buffer，按字符串原始字节处理
  const keyBuf = toBuf(key);
  const ivBuf = (iv == null || iv === '') ? null : toBuf(iv);
  return { keyBuf, ivBuf };
}

function aes(mode, key, iv, data, encrypt) {
  const normalized = String(mode || '').toLowerCase().replace(/-/g, '');
  const { keyBuf, ivBuf } = aesNormalizeKeyIv(key, iv);
  const dataBuf = toBuf(data);
  try {
    let algorithm;
    if (normalized.endsWith('ecb')) algorithm = `aes-${keyBuf.length * 8}-ecb`;
    else if (normalized.endsWith('gcm')) algorithm = `aes-${keyBuf.length * 8}-gcm`;
    else if (normalized.endsWith('ctr')) algorithm = `aes-${keyBuf.length * 8}-ctr`;
    else algorithm = `aes-${keyBuf.length * 8}-cbc`;

    if (algorithm.endsWith('gcm')) {
      const cipher = encrypt
        ? crypto.createCipheriv(algorithm, keyBuf, ivBuf || Buffer.alloc(12))
        : crypto.createDecipheriv(algorithm, keyBuf, ivBuf || Buffer.alloc(12));
      if (encrypt) {
        const enc = Buffer.concat([cipher.update(dataBuf), cipher.final()]);
        return Buffer.concat([enc, cipher.getAuthTag()]);
      }
      const tagLen = 16;
      if (dataBuf.length <= tagLen) return Buffer.alloc(0);
      const tag = dataBuf.subarray(dataBuf.length - tagLen);
      const payload = dataBuf.subarray(0, dataBuf.length - tagLen);
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(payload), cipher.final()]);
    }

    const cipher = encrypt
      ? crypto.createCipheriv(algorithm, keyBuf, algorithm.endsWith('ecb') ? null : (ivBuf || Buffer.alloc(16)))
      : crypto.createDecipheriv(algorithm, keyBuf, algorithm.endsWith('ecb') ? null : (ivBuf || Buffer.alloc(16)));
    return Buffer.concat([cipher.update(dataBuf), cipher.final()]);
  } catch (e) {
    throw new Error(`AES failed: ${e.message}`);
  }
}

function rsaEncrypt(data, keyPem) {
  let pem = String(keyPem || '');
  if (!pem.includes('BEGIN')) {
    const b64 = pem.replace(/\s/g, '');
    pem = `-----BEGIN PUBLIC KEY-----\n${b64.replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----`;
  }
  const out = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, toBuf(data));
  return out;
}

// ---------- 沙箱本体 ----------

function normalizeSources(raw) {
  const out = {};
  const sources = raw && typeof raw === 'object' ? raw : {};
  Object.keys(sources).forEach((key) => {
    const item = sources[key] || {};
    out[key] = {
      name: item.name || key,
      type: item.type || 'music',
      actions: item.actions || ['musicUrl'],
      qualitys: Array.isArray(item.qualitys) && item.qualitys.length ? item.qualitys : ['128k', '320k'],
    };
  });
  return out;
}

function parseScriptMeta(rawScript) {
  const meta = {};
  const fields = { name: '@name', description: '@description', version: '@version', author: '@author', homepage: '@homepage' };
  Object.keys(fields).forEach((k) => {
    const m = rawScript.match(new RegExp(`${fields[k]}\\s+(.+)`));
    if (m) meta[k] = m[1].trim();
  });
  meta.hash = crypto.createHash('sha256').update(rawScript).digest('hex').slice(0, 32);
  return meta;
}

class LxSandbox {
  constructor() {
    this.requestHandler = null;
    this.sources = {};
    this.scriptInfo = {};
    this.ready = false;
    this._resolveSeq = 0;
  }

  /** 加载并初始化脚本；resolve 一个 Promise<{ok,name,sources,error}>。 */
  load(scriptText) {
    this.ready = false;
    this.requestHandler = null;
    this.sources = {};
    this.scriptInfo = {};

    return new Promise((resolve) => {
      const finish = (ok, error) => {
        if (ok) this.ready = true;
        resolve({ ok, name: this.scriptInfo.name || '', sources: this.sources, error: error || null });
      };

      let sandbox;
      const initedData = { value: null };
      let sendInited = false;

      const lx = {
        version: '2.0.0',
        env: 'desktop',
        EVENT_NAMES,
        currentScriptInfo: null, // load 时补上 rawScript
        on: (name, handler) => {
          if (name === EVENT_NAMES.request && typeof handler === 'function') this.requestHandler = handler;
        },
        send: (name, data) => {
          if (name === EVENT_NAMES.inited) { initedData.value = data; sendInited = true; }
          // updateAlert 等事件忽略
        },
        request: (url, options, callback) => {
          if (typeof url === 'object' && url !== null) { callback = options; options = url; url = options.url; }
          if (typeof callback !== 'function') return () => {};
          httpRequest({ url, ...(options || {}) }, (err, resp, body) => callback(err, resp, body));
          return () => {};
        },
        utils: {
          buffer: {
            from: (data, encoding) => {
              if (typeof data === 'string') return Buffer.from(data, String(encoding || 'utf8'));
              return toBuf(data);
            },
            bufToString: (buf, format) => {
              if (typeof buf === 'string') return buf;
              if (!Buffer.isBuffer(buf)) return '';
              return buf.toString(String(format || 'utf8'));
            },
          },
          crypto: {
            md5: (value) => crypto.createHash('md5').update(toBuf(value)).digest('hex'),
            aesEncrypt: (buffer, mode, key, iv) => aes(mode, key, iv, buffer, true),
            aesDecrypt: (buffer, mode, key, iv) => aes(mode, key, iv, buffer, false),
            rsaEncrypt: (buffer, key) => rsaEncrypt(buffer, key),
            randomBytes: (size) => crypto.randomBytes(Number(size) || 0),
          },
          zlib: {
            inflate: (buf) => new Promise((res, rej) => {
              const data = toBuf(buf);
              zlib.inflate(data, (err, out) => {
                if (err) {
                  zlib.inflateRaw(data, (err2, out2) => (err2 ? rej(new Error('inflate failed')) : res(out2)));
                } else res(out);
              });
            }),
            deflate: (buf) => new Promise((res, rej) => {
              zlib.deflate(toBuf(buf), (err, out) => (err ? rej(new Error('deflate failed')) : res(out)));
            }),
          },
        },
      };

      const timer = setTimeout(() => finish(false, '音源脚本初始化超时'), INIT_TIMEOUT_MS);
      try {
        sandbox = {
          lx,
          Buffer,
          console,
          setTimeout,
          clearTimeout,
          setInterval,
          clearInterval,
          TextEncoder,
          TextDecoder,
          URL,
          URLSearchParams,
          Promise,
        };
        lx.currentScriptInfo = { name: '', description: '', version: '', author: '', homepage: '', rawScript: scriptText };
        vm.runInNewContext(scriptText, sandbox, { timeout: 15_000 });
      } catch (e) {
        clearTimeout(timer);
        return finish(false, `脚本执行失败: ${e.message}`);
      }

      // send(inited) 可能同步、微任务或异步（部分脚本先请求后端配置再上报），
      // 轮询等待直到收到有效 inited 或超时（对齐 Kotlin 侧 INIT_TIMEOUT_MS=20s）。
      const startedAt = Date.now();
      let finished = false;
      const finalize = (data) => {
        finished = true;
        clearTimeout(timer);
        if (!data || typeof data !== 'object') {
          return finish(false, '音源脚本初始化超时（未收到 inited 事件）');
        }
        if (data.status === false) {
          return finish(false, `脚本初始化失败: ${data.message || data.body || '未知原因'}`);
        }
        if (!data.sources || !Object.keys(data.sources).length) {
          return finish(false, '脚本未发送有效的 inited 事件（sources 为空）');
        }
        if (!this.requestHandler) {
          return finish(false, '脚本未注册 request 事件处理函数');
        }
        this.sources = normalizeSources(data.sources);
        this.scriptInfo = parseScriptMeta(scriptText);
        return finish(true, null);
      };
      const poll = () => {
        if (finished) return;
        if (sendInited && initedData.value != null) return finalize(initedData.value);
        if (Date.now() - startedAt >= INIT_TIMEOUT_MS) return finalize(null);
        setTimeout(poll, 250);
      };
      poll();
    });
  }

  /** 源 key：优先 musicInfo.source（脚本声明过），否则脚本第一个源。 */
  pickSourceKey(musicInfo) {
    const infoSource = musicInfo && musicInfo.source;
    if (infoSource && this.sources[infoSource]) return infoSource;
    return Object.keys(this.sources)[0] || '';
  }

  /**
   * 解析 musicUrl；按脚本声明的 qualitys 做质量降级重试（对齐 Kotlin attemptResolve）。
   * resolve 一个 Promise<url|null>。
   */
  resolveMusicUrl(musicInfo, preferQuality) {
    const sourceKey = this.pickSourceKey(musicInfo);
    const declared = (this.sources[sourceKey] && this.sources[sourceKey].qualitys) || [];
    const order = [preferQuality, ...declared, '128k']
      .filter((q) => q && String(q).trim())
      .map((q) => String(q))
      .filter((q, i, arr) => arr.indexOf(q) === i);

    const attempt = (index) => new Promise((resolve) => {
      if (!this.requestHandler) return resolve(null);
      if (index >= order.length) return resolve(null);
      let settled = false;
      const done = (url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (url && typeof url === 'string' && /^https?:/i.test(url)) return resolve(url);
        if (index + 1 < order.length) return resolve(attempt(index + 1));
        resolve(null);
      };
      const timer = setTimeout(() => done(null), RESOLVE_TIMEOUT_MS);
      try {
        Promise.resolve(this.requestHandler({
          source: sourceKey,
          action: 'musicUrl',
          info: { type: order[index], musicInfo },
        })).then((url) => {
          if (process.env.LX_DEBUG && url == null) {
            console.log(`[lx-debug] resolve 失败: source=${sourceKey} quality=${order[index]} songId=${musicInfo && (musicInfo.songmid || musicInfo.songId)}`);
          }
          done(url);
        }).catch((e) => {
          if (process.env.LX_DEBUG) console.log(`[lx-debug] resolve 异常: ${e && e.message || e}`);
          done(null);
        });
      } catch (_) {
        done(null);
      }
    });

    return attempt(0);
  }

  currentInfo() {
    return {
      ready: this.ready,
      name: this.scriptInfo.name || '',
      author: this.scriptInfo.author || '',
      version: this.scriptInfo.version || '',
      hash: this.scriptInfo.hash || '',
      sources: this.sources,
    };
  }
}

module.exports = { LxSandbox, httpRequest, EVENT_NAMES };
