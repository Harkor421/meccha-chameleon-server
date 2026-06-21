// GameServer wires together: an HTTP server (health + metrics), a WebSocketServer
// sharing the same port, connection routing into rooms, per-connection identity +
// rate limits, heartbeat, and graceful shutdown.
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { config } from './config.js'
import { RoomManager } from './roomManager.js'
import { sanitizeName, rateLimiter, nextId } from './util.js'
import { S } from './protocol.js'
import * as metrics from './metrics.js'
import { log } from './log.js'

export class GameServer {
  constructor() {
    this.manager = new RoomManager()
    this.keys = new Map() // clientKey -> ws  (one live connection per identity)
    this.http = http.createServer((req, res) => this._http(req, res))
    this.wss = new WebSocketServer({
      server: this.http,
      maxPayload: config.maxPayloadBytes,
      verifyClient: (info, cb) => this._verify(info, cb),
    })
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req))
    this.wss.on('error', (e) => log.error('[wss]', e?.message || e))
    metrics.setLiveSource(() => this.manager.stats())
    this._hb = null
  }

  _verify(info, cb) {
    if (config.allowOrigins.length === 0) return cb(true)
    const origin = info.origin || info.req.headers.origin || ''
    cb(config.allowOrigins.includes(origin))
  }

  _http(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const url = (req.url || '/').split('?')[0]
    if (url === '/health' || url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(metrics.snapshot()))
    }
    if (url === '/metrics') {
      if ((req.headers.accept || '').includes('application/json')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(metrics.snapshot()))
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      return res.end(metrics.prometheus())
    }
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ name: 'meccha-chameleon-server', ...this.manager.stats() }))
    }
    res.writeHead(404); res.end('not found')
  }

  _onConnection(ws, req) {
    metrics.inc('connections_total')
    const q = new URL(req.url, 'http://x').searchParams
    const key = (String(q.get('key') || '').slice(0, 64)) || nextId('k')
    const name = sanitizeName(q.get('name'))
    const requestedRoom = q.get('room')

    // one live connection per identity key (refresh / 2nd tab replaces the old)
    const prev = this.keys.get(key)
    if (prev && prev.readyState === 1) { try { prev.terminate() } catch {} }

    const res = this.manager.assign(requestedRoom)
    if (res.full || !res.room) {
      metrics.inc('rejected_full_total')
      try { ws.send(JSON.stringify({ t: S.SERVER_FULL })) } catch {}
      return ws.close()
    }
    const room = res.room
    const client = {
      id: nextId('p'), ws, key, name, state: null, tex: null, role: 'out', room: room.code,
      rl: rateLimiter(config.msgMaxPerSec),
      vrl: rateLimiter(config.voice.maxPerSec),
      prl: rateLimiter(config.paintMaxPerSec),
      chatRl: rateLimiter(3),
      lastVoiceAt: 0, lastProfileAt: 0,
    }
    this.keys.set(key, ws)
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    ws.on('error', (e) => log.warn(`[ws] ${client.id}`, e?.message || e))

    room.add(client)
    log.info(`[ws] ${client.name} (${client.id}) → ${room.code} [${room.size()}]`)

    ws.on('message', (raw, isBinary) => {
      if (isBinary) { room.handleVoice(client, raw); return } // relayed Opus voice
      if (!client.rl()) return // json flood guard
      let msg; try { msg = JSON.parse(raw.toString()) } catch { return }
      metrics.inc('messages_in_total')
      room.handleMessage(client, msg)
    })
    ws.on('close', () => {
      metrics.inc('disconnections_total')
      room.remove(client)
      if (this.keys.get(key) === ws) this.keys.delete(key)
      log.info(`[ws] ${client.name} (${client.id}) left ${room.code} [${room.size()}]`)
    })
  }

  start() {
    this.manager.start()
    this._hb = setInterval(() => {
      for (const room of this.manager.rooms.values()) {
        for (const c of room.clients.values()) {
          if (c.ws.isAlive === false) { try { c.ws.terminate() } catch {} ; continue }
          c.ws.isAlive = false
          try { c.ws.ping() } catch {}
        }
      }
    }, config.heartbeatMs)
    return new Promise((resolve) => this.http.listen(config.port, config.host, () => {
      log.info(`MECCHA CHAMELEON server listening on ${config.host}:${config.port}`)
      resolve()
    }))
  }

  async stop() {
    clearInterval(this._hb)
    this.manager.stop()
    for (const room of this.manager.rooms.values()) {
      for (const c of room.clients.values()) { try { c.ws.close(1001, 'server shutdown') } catch {} }
    }
    await new Promise((r) => this.wss.close(() => r()))
    await new Promise((r) => this.http.close(() => r()))
  }
}
