// 和中转服务器的 WebSocket 连接，带自动重连
const { EventEmitter } = require('events');
const WebSocket = require('ws');

class RelayClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.cfg = null;
    this.state = 'idle'; // idle | connecting | online | error
    this.lastError = '';
    this.retry = 0;
    this._timer = null;
    this._fatal = false;
  }

  connect(cfg) {
    this.cfg = cfg;
    this._fatal = false;
    this.retry = 0;
    this._open();
  }

  close() {
    clearTimeout(this._timer);
    this._fatal = true;
    if (this.ws) this.ws.terminate();
    this.ws = null;
    this._set('idle');
  }

  _set(state, err = '') {
    this.state = state;
    this.lastError = err;
    this.emit('state', { state, error: err });
  }

  _open() {
    clearTimeout(this._timer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
    }
    const { serverUrl, room, secret, name } = this.cfg;
    if (!serverUrl || !room || !secret || !name) return this._set('error', '请先在设置里填写服务器、房间和昵称');
    this._set('connecting');
    let ws;
    try {
      ws = new WebSocket(serverUrl, { handshakeTimeout: 10_000 });
    } catch (e) {
      return this._scheduleRetry('服务器地址无效：' + e.message);
    }
    this.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', room, secret, name })));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.retry = 0;
        this._set('online');
      }
      if (msg.type === 'error') {
        // 密码错 / 房间满 / 被顶下线 → 不自动重连，等用户改设置
        if (['bad_secret', 'room_full', 'bad_hello', 'replaced'].includes(msg.code)) this._fatal = true;
        this._set('error', msg.message || msg.code);
      }
      this.emit('message', msg);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this._fatal) this._scheduleRetry(this.state === 'online' ? '连接断开，重连中…' : this.lastError || '连不上服务器');
    });
    ws.on('error', (e) => {
      this.lastError = e.message;
    });
  }

  _scheduleRetry(err) {
    this._set('error', err);
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this._timer = setTimeout(() => this._open(), delay);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.state === 'online') {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }
}

module.exports = { RelayClient };
