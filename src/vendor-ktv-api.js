/**
 * KTV Song API - JS Hot Update Module
 * ====================================
 * 从 Gitee 热更新, App 无需发版即可修复 API 变更
 *
 * 用法:
 *   const api = new KtvApi({proxy: 'http://127.0.0.1:7897'})
 *   const url = await api.getSongUrl('7678785')
 *   // → http://download.origjoy.com/E/ts/.../7678785.ts?sign=...
 */

(function(global) {
  'use strict';

  // KTV_BRIDGE_API: 3 (Android 缓存校验标记，请勿删除)

  // ─── 配置 ──────────────────────────────────────────
  const CONFIG = {
    APP_ID:  'd4eeacc6cec3434fbc8c41608a3056a0',
    APP_KEY: '024210cba40d4385a93e6c2d3249bfb5',
    SDK_KEY: '19042303a8374f67ae3fe1e25c97936f',
    VN:      '4.1.3.03161025',
    VER:     '2.0',
    // 当前线路优先级：mm.kk456.top 为主节点，gz.ac16.vip 为备用节点。
    HOSTS:   ['http://mm.kk456.top', 'http://gz.ac16.vip'],
    HOST:    'http://mm.kk456.top',
    MWS:     'https://mws.cherryonline.cn',
    RSA_PUBKEY: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAucL0oFErd7REM6TSNa3EZdN1YaOs4J1eCybLPyoQ9ru3q1HU67agC9FzhrCG/RvAQUya5iPmQ8Caed05vqcCVcyJChmkSOGQ7DVShe2rGuTMNlpoRV6UzfcraaVS++7m2K/+kSZJ8OAhhhVuqPruMjsFYpdtstAwvyZT28b+eENwzpp9UHqsooZc7FZ0H8kTbs6XMkw4nIWo+4HoPAhNLEY+xdHvwY6drF/3WDTvsaoMrs73TVQCEEHzZNIz2H/is9VLMnIyOfnfcJi9br78Fj2xHzxu3sAySBOTVLmUMxqYh/g1ox5OXGcW93HJkQLkBi42tFAEkWYlYyl93+jbbQIDAQAB'
  };

  // ─── 工具函数 ──────────────────────────────────────
  function randomHex(n) {
    var s = ''; while (n--) s += '0123456789abcdef'[Math.random()*16|0]; return s;
  }

  // ─── MD5 ───────────────────────────────────────────
  function md5(input) {
    function add(a, b) {
      var low = (a & 0xffff) + (b & 0xffff);
      var high = (a >>> 16) + (b >>> 16) + (low >>> 16);
      return (high << 16) | (low & 0xffff);
    }
    function rol(value, shift) { return (value << shift) | (value >>> (32 - shift)); }
    function wordHex(value) {
      var out = '';
      for (var i = 0; i < 4; i++) out += ('0' + ((value >>> (i * 8)) & 255).toString(16)).slice(-2);
      return out;
    }

    // MD5 works on UTF-8 bytes, then appends 0x80 and the original bit length.
    var utf8 = unescape(encodeURIComponent(input));
    var bytes = [];
    for (var i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
    var bitLengthLow = (bytes.length << 3) >>> 0;
    var bitLengthHigh = (bytes.length >>> 29) >>> 0;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    for (i = 0; i < 4; i++) bytes.push((bitLengthLow >>> (i * 8)) & 255);
    for (i = 0; i < 4; i++) bytes.push((bitLengthHigh >>> (i * 8)) & 255);

    var shifts = [
      7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
      5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
      4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
      6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
    ];
    var constants = [];
    for (i = 0; i < 64; i++) constants[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;

    for (var offset = 0; offset < bytes.length; offset += 64) {
      var words = [];
      for (i = 0; i < 16; i++) {
        var at = offset + i * 4;
        words[i] = bytes[at] | (bytes[at+1] << 8) | (bytes[at+2] << 16) | (bytes[at+3] << 24);
      }
      var a = a0, b = b0, c = c0, d = d0;
      for (i = 0; i < 64; i++) {
        var f, g;
        if (i < 16) { f = (b & c) | ((~b) & d); g = i; }
        else if (i < 32) { f = (d & b) | ((~d) & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | (~d)); g = (7 * i) % 16; }
        var oldD = d;
        d = c;
        c = b;
        b = add(b, rol(add(add(a, f), add(constants[i], words[g])), shifts[i]));
        a = oldD;
      }
      a0 = add(a0, a); b0 = add(b0, b); c0 = add(c0, c); d0 = add(d0, d);
    }
    return wordHex(a0) + wordHex(b0) + wordHex(c0) + wordHex(d0);
  }

  // ─── RSA Encrypt ───────────────────────────────────
  async function rsaEncrypt(plaintext) {
    if (global.android && typeof global.android.rsaEncryptPkcs1 === 'function') {
      var encrypted = global.android.rsaEncryptPkcs1(CONFIG.RSA_PUBKEY, plaintext);
      if (!encrypted) throw new Error('native RSA encryption failed');
      return encrypted;
    }
    throw new Error('RSA/PKCS1 bridge is unavailable');
  }

  // ─── HTTP ──────────────────────────────────────────
  function nativeResponse(raw) {
    var value = JSON.parse(raw || '{}');
    if (value.error) throw new Error(value.error);
    return {body: value.body || '', status: Number(value.status || 0)};
  }

  // 部分节点会在 JSON 前输出 PHP Deprecated HTML，从第一个 "{" 开始容错解析。
  function parseJsonBody(body) {
    body = String(body || '');
    var start = body.indexOf('{');
    if (start < 0) throw new Error('JSON object not found');
    return JSON.parse(body.slice(start));
  }

  // 匹配 demo/测试资源 URL 的多种模式:
  //   1) wb66 / demo 关键字
  //   2) IPv4 地址 (如 http://154.222.26.244:656/722.ts)
  //   3) Cloudflare R2 demo bucket (pub-*.r2.dev/ss/ 通用测试文件)
  //   4) 文件名与 musicno 不匹配的短数字通用文件 (如 /722.ts, /689.ts)
  function isDemoUrl(url, musicno) {
    var s = String(url || '');
    if (/(?:wb66|demo)/i.test(s)) return true;
    if (/^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\//i.test(s)) return true;
    // R2 demo bucket: pub-*.r2.dev/ss/ 通用测试资源
    if (/pub-[a-z0-9]+\.r2\.dev\/ss\//i.test(s)) return true;
    // 文件名是纯短数字但不对应 musicno (如 /722.ts、/689.ts)
    if (musicno) {
      var m = s.match(/\/(\d{1,6})\.ts(?:\?|$)/);
      if (m && m[1] !== String(musicno)) return true;
    }
    return false;
  }

  async function httpGet(url, timeout) {
    timeout = timeout || 8000;
    // 原 APK 的 native GET 抓包只带 Accept: */*，不伪造来源 IP。
    var headers = {'Accept': '*/*'};
    if (global.android && typeof global.android.httpGet === 'function') {
      return nativeResponse(global.android.httpGet(url, JSON.stringify(headers), timeout));
    }
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = timeout;
      xhr.onload = function() { resolve({body:xhr.responseText, status:xhr.status}); };
      xhr.onerror = function() { reject(new Error('network error')); };
      xhr.ontimeout = function() { reject(new Error('timeout')); };
      xhr.send();
    });
  }

  async function httpPost(url, body, timeout) {
    timeout = timeout || 8000;
    var headers = {'Content-Type':'application/json', 'Accept':'*/*', 'User-Agent':'Dalvik/2.1.0'};
    if (global.android && typeof global.android.httpPost === 'function') {
      return nativeResponse(global.android.httpPost(url, body, JSON.stringify(headers), timeout));
    }
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.timeout = timeout;
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function() { resolve({body:xhr.responseText, status:xhr.status}); };
      xhr.onerror = function() { reject(new Error('network error')); };
      xhr.ontimeout = function() { reject(new Error('timeout')); };
      xhr.send(body);
    });
  }

  // ─── KtvApi Class ──────────────────────────────────
  function KtvApi(options) {
    options = options || {};
    this.proxy = options.proxy || '';
    this.mac = options.mac || randomHex(16);
    this.sn = options.sn || randomHex(16);
    this.tokens = {};
    // 与 test_ktv_unified.py 一致：首次设备加最多 3 次换设备重试。
    this.maxDeviceRetries = Number.isFinite(Number(options.maxDeviceRetries))
      ? Math.max(0, Number(options.maxDeviceRetries) | 0) : 3;
    // 兼容旧远程脚本/调试代码读取单 token 的行为。
    this.token = '';
    this.debug = options.debug || false;
  }

  KtvApi.prototype = {
    _log: function(msg) { if (this.debug) console.log('[KtvApi]', msg); },

    regenerateDevice: function() {
      this.mac = randomHex(16);
      this.sn = randomHex(16);
      this.tokens = {};
      this.token = '';
      this._log('Device regenerated: ' + this.mac + '_' + this.sn);
    },

    // 1. MWS Login
    mwsLogin: async function() {
      var self = this;
      var plaintext = JSON.stringify({device_id: self.mac});
      self._log('MWS login...');
      try {
        var encrypted = await rsaEncrypt(plaintext);
        var body = JSON.stringify({
          encrypted_data: encrypted, ip: '172.16.32.15', dns: '', router: '',
          subnet_mask: '255.255.255.0', channel: 'common', mode: 'ott'
        });
        var resp = await httpPost(CONFIG.MWS + '/mls-api/v1/login', body);
        if (resp.status === 200) {
          var data = parseJsonBody(resp.body);
          if (data.authorized) {
            self.mac = data.device_id || self.mac;
            self.sn = self.mac;
            self.tokens = {};
            self.token = '';
            self._log('MWS login OK: ' + self.mac);
            return true;
          }
        }
        self._log('MWS login FAIL: ' + resp.status);
        return false;
      } catch(e) {
        self._log('MWS login error: ' + e.message);
        return false;
      }
    },

    // 2. Get Auth Token
    getToken: async function(host, forceRefresh) {
      var self = this;
      host = host || CONFIG.HOSTS[0];
      if (!forceRefresh && self.tokens[host]) {
        self.token = self.tokens[host];
        return self.token;
      }
      var ts = Math.floor(Date.now() / 1000);
      var params = 'appid=' + CONFIG.APP_ID +
        '&mac=' + self.mac + '_' + self.sn +
        '&sn=' + self.sn +
        '&time=' + ts +
        '&ver=' + CONFIG.VER + '&vn=' + CONFIG.VN;
      var sign = md5(params + CONFIG.APP_KEY);
      var url = host + '/i.php?' + params + '&sign=' + sign;
      self._log('Getting token: ' + host);
      try {
        var resp = await httpGet(url);
        if (resp.status === 200) {
          var data = parseJsonBody(resp.body);
          if (data.code === 200) {
            self.tokens[host] = data.token;
            self.token = data.token;
            self._log('Token OK: ' + host);
            return self.token;
          }
        }
        delete self.tokens[host];
        self._log('Token FAIL: ' + host + ', HTTP ' + resp.status);
        return null;
      } catch(e) {
        delete self.tokens[host];
        self._log('Token error: ' + host + ', ' + e.message);
        return null;
      }
    },

    clearToken: function(host) {
      delete this.tokens[host];
      this.token = '';
    },

    _fetchSongUrl: async function(host, musicno, token, ls, resolution, h265) {
      var ts = Math.floor(Date.now() / 1000);
      // 参数顺序、原始 token 中的 "=" 以及签名拼接必须与原 APK 保持一致。
      var params = 'appid=' + CONFIG.APP_ID +
        '&device=' + this.mac + '_' + this.sn +
        '&ish265=' + (h265 ? '1' : '0') +
        '&ls=' + ls +
        '&musicno=' + musicno +
        '&resolution=' + resolution +
        '&sn=' + this.sn +
        '&time=' + ts +
        '&token=' + token;
      var sign = md5(params + CONFIG.SDK_KEY);
      var resp = await httpGet(host + '/music/do.php?' + params + '&sign=' + sign);
      if (resp.status !== 200) {
        return {code: null, data: '', httpStatus: resp.status};
      }
      return parseJsonBody(resp.body);
    },

    // 3. Get Song Download URL
    // mm.kk456.top 代理有多个上游节点, (musicno+ls+device) 的哈希决定路由;
    // 部分节点有真源, 部分返回 demo。这里对每个 host/device 组合尝试 ls=0/1/2,
    // 只要命中真源就立即返回, 避免做事后 demo 检测再丢弃。
    getSongUrl: async function(musicno, resolution, h265, _preferredLs) {
      resolution = resolution || '720';
      h265 = !!h265;
      var preferredLs = String(_preferredLs == null ? '1' : _preferredLs);
      var self = this;
      for (var deviceRound = 0; deviceRound <= self.maxDeviceRetries; deviceRound++) {
        if (deviceRound > 0) self.regenerateDevice();
        for (var hostIndex = 0; hostIndex < CONFIG.HOSTS.length; hostIndex++) {
          var host = CONFIG.HOSTS[hostIndex];
          self._log((hostIndex === 0 ? 'Primary' : 'Fallback') +
            ' host, device round ' + (deviceRound + 1) + ': ' + host);

          var token = await self.getToken(host, false);
          if (!token) continue;

          // 尝试所有 ls 值, 优先用传入的, 然后轮询其他值
          var lsValues = [preferredLs];
          if (preferredLs !== '0') lsValues.push('0');
          if (preferredLs !== '1') lsValues.push('1');
          if (preferredLs !== '2') lsValues.push('2');

          for (var lsi = 0; lsi < lsValues.length; lsi++) {
            var ls = lsValues[lsi];
            try {
              var data = await self._fetchSongUrl(host, musicno, token, ls, resolution, h265);
              if (data.code === 20002) {
                self._log('Token expired, refreshing once: ' + host);
                self.clearToken(host);
                token = await self.getToken(host, true);
                if (!token) continue;
                data = await self._fetchSongUrl(host, musicno, token, ls, resolution, h265);
              }

              if (data.code === 200) {
                var songUrl = data.data || '';
                if (songUrl && !isDemoUrl(songUrl, musicno) && /^https?:\/\//i.test(songUrl)) {
                  self._log('URL OK: ' + musicno + ' ls=' + ls + ' via ' + host);
                  return songUrl;
                }
                if (isDemoUrl(songUrl, musicno))
                  self._log('Demo (ls=' + ls + '): retry next ls value');
                // 不是 demo 但也无效 (空/格式不对) → 继续试下一个 ls
              }
            } catch(e) {
              self._log('Failed ls=' + ls + ': ' + host + ', ' + e.message);
            }
          }
          self._log('All ls values exhausted for ' + host);
        }
      }
      return null;
    },

    // 4. Full init sequence
    init: async function() {
      // token 获取属于每个主/备节点请求的一部分；这里不提前绑定单一节点。
      return true;
    }
  };

  // ─── 导出 ──────────────────────────────────────────
  global.KtvApi = KtvApi;
  global.KtvApiConfig = CONFIG;
  global.KtvBridgeApiVersion = 3;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {KtvApi: KtvApi, CONFIG: CONFIG};
  }

})(typeof window !== 'undefined' ? window : this);
