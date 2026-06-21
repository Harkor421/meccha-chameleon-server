// A single room: its players, presence broadcast, chat, painted-body relay, and
// the server-relayed voice bus — all scoped to this room. The round state machine
// lives in RoundController. Rooms are driven by the RoomManager's shared tick
// loops (no per-room timers), so thousands of rooms cost only their data, not
// thousands of intervals.
import { config } from './config.js'
import { S, C, ROLES } from './protocol.js'
import { RoundController } from './round.js'
import { sanitizeName, clampNum } from './util.js'
import { inc } from './metrics.js'

function spawnFor(i) {
  const a = (i * 2.39996) % (Math.PI * 2)
  const r = 2 + (i % 5)
  return [Math.cos(a) * r, 3, Math.sin(a) * r]
}

export class Room {
  constructor(code, isPublic) {
    this.code = code
    this.isPublic = isPublic
    this.clients = new Map()
    this.round = new RoundController(this)
    this.emptySince = Date.now()
    this._spawnCount = 0
    inc('rooms_created_total')
  }

  size() { return this.clients.size }
  isEmpty() { return this.clients.size === 0 }
  rolesMap() { const m = {}; for (const [id, c] of this.clients) m[id] = c.role; return m }

  sendTo(client, obj) { if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj)) }
  broadcast(obj, exceptId) {
    const p = JSON.stringify(obj)
    for (const [pid, c] of this.clients) if (pid !== exceptId && c.ws.readyState === 1) c.ws.send(p)
  }

  add(client) {
    const spawn = spawnFor(this._spawnCount++)
    client.state = { x: spawn[0], y: spawn[1], z: spawn[2], ry: 0, anim: 'idle' }
    // joining mid-round → spectate ('out') until the next PREP reshuffles roles
    client.role = this.round.phase === 'PREP' ? ROLES.HIDER : ROLES.OUT
    client.tex = null
    client.room = this.code
    this.clients.set(client.id, client)
    this.emptySince = 0

    const peers = {}
    for (const [pid, c] of this.clients) {
      if (pid === client.id) continue
      peers[pid] = { ...c.state, name: c.name, role: c.role, tex: c.tex }
    }
    this.sendTo(client, { t: S.WELCOME, id: client.id, room: this.code, spawn, peers, phase: this.round.payload() })
    this.broadcast({ t: S.PEER_JOIN, id: client.id, name: client.name, role: client.role, state: client.state }, client.id)
  }

  remove(client) {
    if (!this.clients.delete(client.id)) return
    this.broadcast({ t: S.PEER_LEAVE, id: client.id })
    this.round.endHuntIfDone()
    if (this.isEmpty()) this.emptySince = Date.now()
  }

  // 20Hz positions-only snapshot (name/role/tex are pushed separately on change).
  tickPresence() {
    if (this.isEmpty()) return
    const peers = {}
    for (const [id, c] of this.clients) peers[id] = c.state
    this.broadcast({ t: S.STATE, peers })
  }

  handleMessage(client, msg) {
    switch (msg.t) {
      case C.STATE: {
        client.state = {
          x: clampNum(msg.x, config.arenaBound),
          y: clampNum(msg.y, 200),
          z: clampNum(msg.z, config.arenaBound),
          ry: Number.isFinite(+msg.ry) ? +msg.ry : 0,
          anim: String(msg.anim || 'idle').slice(0, 12),
        }
        break
      }
      case C.SET_PROFILE: {
        if (!msg.name) break
        client.name = sanitizeName(msg.name)
        const now = Date.now()
        if (now - client.lastProfileAt < 1500) break // throttle room-wide rename broadcast
        client.lastProfileAt = now
        this.broadcast({ t: S.PEER_JOIN, id: client.id, name: client.name, role: client.role, state: client.state }, client.id)
        break
      }
      case C.PAINT: {
        // only a live hider, a valid capped image data URL, rate-limited → no DoS
        if (client.role !== ROLES.HIDER) break
        if (typeof msg.tex !== 'string' || msg.tex.length > config.paintMaxLen || !msg.tex.startsWith('data:image/')) break
        if (!client.prl()) break
        client.tex = msg.tex
        inc('paint_syncs_total')
        this.broadcast({ t: S.PEER_PAINT, id: client.id, tex: client.tex }, client.id)
        break
      }
      case C.TAG: { this.round.tag(client, String(msg.target)); break }
      case C.CHAT: {
        const text = String(msg.text || '').slice(0, 140)
        if (text.trim() && client.chatRl()) this.broadcast({ t: S.CHAT, id: client.id, name: client.name, text })
        break
      }
      case C.PING: { this.sendTo(client, { t: S.PONG, t0: msg.t0 }); break }
      default: break
    }
  }

  // Relay one Opus packet to everyone else in the room. VAD happens client-side
  // (silent clients send nothing); here we rate-limit, cap concurrent speakers,
  // and skip clients whose socket is backed up (so one slow peer can't stall us).
  handleVoice(client, raw) {
    if (!client.vrl()) return
    const now = Date.now()
    const wasActive = now - client.lastVoiceAt < config.voice.activeWindowMs
    if (!wasActive) {
      let active = 0
      for (const c of this.clients.values()) if (now - c.lastVoiceAt < config.voice.activeWindowMs) active++
      if (active >= config.voice.maxSpeakers) return
    }
    client.lastVoiceAt = now
    const idBuf = Buffer.from(client.id, 'ascii')
    const payload = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    const out = Buffer.allocUnsafe(1 + idBuf.length + payload.length)
    out[0] = idBuf.length
    idBuf.copy(out, 1)
    payload.copy(out, 1 + idBuf.length)
    let relayed = 0
    for (const [pid, c] of this.clients) {
      if (pid === client.id || c.ws.readyState !== 1) continue
      if (c.ws.bufferedAmount > config.maxWsBuffered) continue // backpressure guard
      c.ws.send(out)
      relayed++
    }
    if (relayed) inc('voice_packets_relayed_total', relayed)
  }
}
