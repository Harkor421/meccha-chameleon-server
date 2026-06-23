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

/**
 * One game room. Owns its players, presence/chat/paint/voice fan-out, and the
 * per-room host (the only player allowed to start a match). The round state
 * machine lives in {@link RoundController}; timers are driven externally by the
 * {@link RoomManager}.
 */
export class Room {
  /**
   * @param {string} code  the room code (matchmaking key)
   * @param {boolean} isPublic  true for auto-fill public rooms, false for join-by-code
   */
  constructor(code, isPublic) {
    this.code = code
    this.isPublic = isPublic
    this.clients = new Map()
    // HOST = the one player allowed to start matches (anti-grief). First non-spectator
    // to join; reassigned when they leave. Included in every phase payload as `host`.
    this.hostId = null
    // Per-IDENTITY persisted state (survives reconnect/refresh within this room):
    // painted body + spectator choice, keyed by the client's identity key.
    this.persisted = new Map() // key -> { tex, spectator }
    this.round = new RoundController(this)
    this.emptySince = Date.now()
    this._spawnCount = 0
    inc('rooms_created_total')
  }

  size() { return this.clients.size }
  isEmpty() { return this.clients.size === 0 }
  rolesMap() { const m = {}; for (const [id, c] of this.clients) m[id] = c.role; return m }
  // Wipe persisted painted bodies at the start of a fresh round (called by the round).
  clearPersistedTex() { for (const v of this.persisted.values()) v.tex = null }

  /**
   * Make sure the room has a valid host: the current one if still present and not
   * a spectator, otherwise the first non-spectator player (anti-grief hand-off).
   * @returns {boolean} true if the host changed (caller can re-broadcast the phase)
   */
  ensureHost() {
    const cur = this.hostId && this.clients.get(this.hostId)
    if (cur && !cur.spectator) return false
    const prev = this.hostId
    this.hostId = null
    for (const [pid, c] of this.clients) if (!c.spectator) { this.hostId = pid; break }
    return this.hostId !== prev
  }

  sendTo(client, obj) { if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj)) }
  /**
   * Send a JSON message to everyone in the room (optionally excluding one id).
   * @param {object} obj  the message
   * @param {string} [exceptId]  id to skip (e.g. the sender)
   */
  broadcast(obj, exceptId) {
    const p = JSON.stringify(obj)
    for (const [pid, c] of this.clients) if (pid !== exceptId && c.ws.readyState === 1) c.ws.send(p)
  }

  /**
   * Add a connected client: spawn it, restore persisted state, assign a join-time
   * role, (re)assign the host, then send `welcome` and announce the join.
   * @param {object} client
   */
  add(client) {
    const spawn = spawnFor(this._spawnCount++)
    client.state = { x: spawn[0], y: spawn[1], z: spawn[2], ry: 0, anim: 'idle' }
    // restore any per-identity persisted state (reconnect/refresh): painted body + spectator choice
    const saved = (client.key && this.persisted.get(client.key)) || {}
    client.spectator = !!saved.spectator
    client.tex = saved.tex || null
    // spectators sit out; LOBBY/PREP joiners are hiders; a mid-round (HUNT/RESULTS) joiner
    // WAITS for the next round (WAITING — NOT eliminated; assignRoles folds it in at PREP).
    client.role = client.spectator
      ? ROLES.SPECTATOR
      : ((this.round.phase === 'LOBBY' || this.round.phase === 'PREP') ? ROLES.HIDER : ROLES.WAITING)
    client.room = this.code
    this.clients.set(client.id, client)
    if (client.key) this.persisted.set(client.key, { tex: client.tex, spectator: client.spectator })
    this.emptySince = 0
    this.ensureHost() // first non-spectator becomes the match host

    const peers = {}
    for (const [pid, c] of this.clients) {
      if (pid === client.id) continue
      peers[pid] = { ...c.state, name: c.name, role: c.role, tex: c.tex }
    }
    this.sendTo(client, { t: S.WELCOME, id: client.id, room: this.code, spawn, peers, phase: this.round.payload() })
    this.broadcast({ t: S.PEER_JOIN, id: client.id, name: client.name, role: client.role, state: client.state }, client.id)
    // a reconnecting hider keeps their painted body — re-relay it so peers see it too
    if (client.tex) this.broadcast({ t: S.PEER_PAINT, id: client.id, tex: client.tex }, client.id)
    // push the (possibly new) host + this joiner's role to everyone
    this.round.broadcastPhase()
  }

  /**
   * Remove a client (disconnect): announce the leave, hand off the host if it was
   * them, and end the HUNT if their departure left no one to resolve it.
   * @param {object} client
   */
  remove(client) {
    if (!this.clients.delete(client.id)) return
    this.broadcast({ t: S.PEER_LEAVE, id: client.id })
    this.ensureHost()        // host left → hand off to the next player
    this.round.endHuntIfDone() // last seeker (or last hider) left → end the round
    if (!this.isEmpty()) this.round.broadcastPhase() // push updated host/roles
    if (this.isEmpty()) this.emptySince = Date.now()
  }

  // 20Hz positions-only snapshot (name/role/tex are pushed separately on change).
  tickPresence() {
    if (this.isEmpty()) return
    const peers = {}
    for (const [id, c] of this.clients) peers[id] = c.state
    this.broadcast({ t: S.STATE, peers })
  }

  /**
   * Dispatch one inbound JSON message from a client. Every branch validates its
   * own input and never throws on malformed/oversized payloads (the caller has
   * already JSON-parsed and flood-gated). Unknown types are ignored.
   * @param {object} client  the sending client
   * @param {object} msg  the parsed message ({ t, ...fields })
   */
  handleMessage(client, msg) {
    if (!msg || typeof msg.t !== 'string') return
    switch (msg.t) {
      case C.STATE: {
        // optional full orientation quaternion (for pose surface-tilt / wall-adhere); validated then passed through to peers
        const q = Array.isArray(msg.q) && msg.q.length === 4 && msg.q.every((n) => Number.isFinite(+n)) ? msg.q.map(Number) : undefined
        client.state = {
          x: clampNum(msg.x, config.arenaBound),
          y: clampNum(msg.y, config.yClamp),
          z: clampNum(msg.z, config.arenaBound),
          ry: Number.isFinite(+msg.ry) ? +msg.ry : 0,
          anim: String(msg.anim || 'idle').slice(0, 12),
          q,
        }
        break
      }
      case C.SET_PROFILE: {
        if (typeof msg.name !== 'string' || !msg.name) break
        client.name = sanitizeName(msg.name)
        const now = Date.now()
        if (now - client.lastProfileAt < config.profileBroadcastMs) break // throttle room-wide rename broadcast
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
        const ps = client.key && this.persisted.get(client.key); if (ps) ps.tex = client.tex // persist for reconnect/late-join
        inc('paint_syncs_total')
        this.broadcast({ t: S.PEER_PAINT, id: client.id, tex: client.tex }, client.id)
        break
      }
      case C.TAG: { if (msg.target != null) this.round.tag(client, String(msg.target)); break }
      case C.SHOOT: { this.round.shoot(client, msg.target != null ? String(msg.target) : null); break }
      case C.SPECTATE: {
        // /spectate or /play — sit out of the match (or rejoin)
        client.spectator = !!msg.on
        const ps = client.key && this.persisted.get(client.key); if (ps) ps.spectator = client.spectator
        if (client.spectator) {
          client.role = ROLES.SPECTATOR
          this.round.endHuntIfDone() // a seeker bailing to spectate may end the hunt
        } else {
          // /play: rejoin this LOBBY/PREP as a hider, else WAIT for the next round
          client.role = (this.round.phase === 'LOBBY' || this.round.phase === 'PREP') ? ROLES.HIDER : ROLES.WAITING
        }
        this.ensureHost() // toggling spectate may change who can be host
        this.round.broadcastPhase() // push updated host + roles to everyone
        break
      }
      case C.CHAT: {
        if (typeof msg.text !== 'string') break
        const text = msg.text.slice(0, 140)
        if (text.trim() && client.chatRl()) this.broadcast({ t: S.CHAT, id: client.id, name: client.name, text })
        break
      }
      case C.PING: { this.sendTo(client, { t: S.PONG, t0: msg.t0 }); break }
      // Start the match NOW (window.__mc.startMatch()) so friends skip the lobby countdown.
      // ONLY the host may start (anti-grief), needs >= config.minPlayers live players, and
      // only from LOBBY/RESULTS (a live round can't be restarted).
      case C.START_MATCH: {
        if (client.id !== this.hostId) break
        this.round.startMatch()
        break
      }
      // relay a footstep so nearby players HEAR you walk/run. Position is the server's
      // authoritative last state (the client just reports walk vs run); rate-capped so it
      // can't be used to spam. Spectators have no footsteps.
      case C.FOOTSTEP: {
        if (client.spectator || !client.state) break
        const now = Date.now()
        if (now - (client.lastFootAt || 0) < config.footstepMinMs) break
        client.lastFootAt = now
        this.broadcast({ t: S.FOOTSTEP, id: client.id, x: client.state.x, y: client.state.y, z: client.state.z, run: !!msg.run }, client.id)
        break
      }
      // anti-mesh-clip: a client reports it's been stuck buried inside the map. Broadcast its
      // authoritative position so seekers get a loud positional give-away. Only meaningful for a
      // live player during HUNT; rate-limited by the normal per-client msg flood guard.
      case C.REVEAL: {
        if (this.round.phase !== 'HUNT' || (client.role !== ROLES.HIDER && client.role !== ROLES.SEEKER) || !client.state) break
        this.broadcast({ t: S.REVEAL, id: client.id, x: client.state.x, y: client.state.y, z: client.state.z })
        break
      }
      default: break
    }
  }

  /**
   * Relay one Opus voice packet to everyone else in the room. VAD happens
   * client-side (silent clients send nothing); here we rate-limit, cap concurrent
   * speakers, and skip clients whose socket is backed up (so one slow peer can't
   * stall the room). Out frame = [u8 idLen][id ascii][opus bytes].
   * @param {object} client  the speaking client
   * @param {Buffer|Uint8Array} raw  the raw Opus packet
   */
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
