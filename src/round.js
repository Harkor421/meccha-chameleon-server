// Authoritative round state machine for ONE room: LOBBY → PREP → HUNT → RESULTS,
// role assignment, server-validated tagging, and win detection. The server owns
// this entirely so clients can't cheat the outcome.
import { config } from './config.js'
import { S, ROLES } from './protocol.js'
import { shuffle } from './util.js'
import { inc } from './metrics.js'
import { log } from './log.js'

/**
 * Per-room round controller. Drives the phase loop, assigns roles, validates
 * tags/shots, and decides the winner. There is exactly one per {@link Room};
 * it reads/writes role state directly on the room's clients.
 */
export class RoundController {
  /** @param {import('./room.js').Room} room the room this controller governs */
  constructor(room) {
    this.room = room
    // start in LOBBY: a pregame warm-up where everyone roams/chats/paints (no hunting)
    this.phase = 'LOBBY'
    this.deadline = Date.now() + config.phase.LOBBY
    this.result = null
    this.lastWhistleAt = 0 // HUNT spatial-whistle hint cadence
  }

  /**
   * The phase snapshot sent to clients (in `welcome` and every `phase` message).
   * `host` is the id of the only player allowed to start a match (anti-grief).
   * @returns {{phase:string,deadline:number,roles:Object<string,string>,result:?string,host:?string}}
   */
  payload() {
    return {
      phase: this.phase,
      deadline: this.deadline,
      roles: this.room.rolesMap(),
      result: this.result,
      host: this.room.hostId,
    }
  }

  /** Broadcast the current phase snapshot to everyone in the room (no-op if empty). */
  broadcastPhase() {
    if (!this.room.isEmpty()) this.room.broadcast({ t: S.PHASE, ...this.payload() })
  }

  /** Count non-spectator players (the pool that can be dealt hider/seeker). */
  liveCount() {
    let n = 0
    for (const c of this.room.clients.values()) if (!c.spectator) n++
    return n
  }

  /**
   * Deal roles for a fresh round. Spectators sit out. Everyone else — including
   * players who joined mid-round as WAITING — is folded into the deal (so a
   * latecomer becomes a hider/seeker at the next PREP). ~1 seeker per
   * `config.seekerPer` players, min 1 once there are >= 2.
   */
  assignRoles() {
    // spectators sit out — they're never dealt a hider/seeker role
    for (const c of this.room.clients.values()) if (c.spectator) c.role = ROLES.SPECTATOR
    const ids = shuffle([...this.room.clients.keys()].filter((id) => !this.room.clients.get(id).spectator))
    const n = ids.length
    const seekers = n >= 2 ? Math.max(1, Math.floor(n / config.seekerPer)) : 0
    ids.forEach((id, i) => {
      const c = this.room.clients.get(id)
      if (c) c.role = i < seekers ? ROLES.SEEKER : ROLES.HIDER
    })
  }

  /**
   * Transition into a phase: reset per-phase state, (re)assign roles, clear paint
   * for fresh rounds, compute the RESULTS winner, then broadcast the new phase.
   * @param {'LOBBY'|'PREP'|'HUNT'|'RESULTS'} phase
   */
  enter(phase) {
    this.phase = phase
    this.deadline = Date.now() + (config.phase[phase] || config.phaseFallbackMs)
    if (phase === 'LOBBY') {
      // pregame warm-up: nobody hunts. Everyone is a hider so they can roam, talk, and
      // self-paint freely to learn the mechanics. Clear paint for a fresh practice canvas.
      this.result = null
      for (const c of this.room.clients.values()) {
        c.tex = null
        c.role = c.spectator ? ROLES.SPECTATOR : ROLES.HIDER
      }
      this.room.clearPersistedTex?.() // and the per-identity persisted copies
    } else if (phase === 'PREP') {
      this.result = null
      for (const c of this.room.clients.values()) c.tex = null // fresh round → drop painted bodies
      this.room.clearPersistedTex?.() // and the per-identity persisted copies
      this.assignRoles()
    } else if (phase === 'RESULTS') {
      const hiders = this._hiderCount()
      this.result = hiders > 0 ? 'hiders' : 'seekers'
    }
    if (phase === 'HUNT') this.lastWhistleAt = Date.now() // first whistle ~one cadence into the hunt
    // paint was just cleared server-side for a fresh round → tell clients to wipe every
    // peer's painted body (otherwise peers keep last round's camo until that player repaints).
    if (phase === 'LOBBY' || phase === 'PREP') this.room.broadcast({ t: S.CLEAR_PAINT })
    this.broadcastPhase()
    log.info(`[round] ${this.room.code ?? '?'} → ${phase}${this.result ? ` (${this.result} win)` : ''} [${this.room.size?.() ?? this.room.clients.size}]`)
  }

  /**
   * Auto-advance the phase loop when the current phase's deadline passes. Gates
   * the LOBBY → PREP start on `config.minPlayers` live players: with too few the
   * room keeps warming up in LOBBY rather than running a seeker-less HUNT.
   * @param {number} now epoch ms
   */
  advance(now) {
    if (now < this.deadline) return
    if (this.phase === 'LOBBY') {
      if (this.liveCount() >= config.minPlayers) this.enter('PREP')
      else this.deadline = now + config.phase.LOBBY // not enough players → keep warming up
    } else if (this.phase === 'PREP') this.enter('HUNT')
    else if (this.phase === 'HUNT') this.enter('RESULTS')
    else this.enter('LOBBY')
  }

  /**
   * Start a match on demand (host pressed "start"): LOBBY/RESULTS → fresh PREP,
   * gated on `config.minPlayers`. Ignored mid-PREP/HUNT so a live round can't be
   * restarted. Host-authorization is enforced by the caller (room.handleMessage).
   * @returns {boolean} true if a match was started
   */
  startMatch() {
    if (this.phase !== 'LOBBY' && this.phase !== 'RESULTS') return false
    if (this.liveCount() < config.minPlayers) return false
    this.enter('PREP')
    return true
  }

  /**
   * HUNT spatial-whistle hint: every `config.whistleMs` the server pings all clients
   * so seekers play a positional whistle at each hider (and hiders hear they've been
   * pinged). Driven by the RoomManager's shared tick loop (no per-room timer).
   * @param {number} now epoch ms
   */
  tickWhistle(now) {
    if (this.phase !== 'HUNT') return
    if (now - this.lastWhistleAt < config.whistleMs) return
    this.lastWhistleAt = now
    this.room.broadcast({ t: S.WHISTLE })
  }

  _hiderCount() {
    let n = 0
    for (const c of this.room.clients.values()) if (c.role === ROLES.HIDER) n++
    return n
  }
  _seekerCount() {
    let n = 0
    for (const c of this.room.clients.values()) if (c.role === ROLES.SEEKER) n++
    return n
  }

  /**
   * End the HUNT early when there's no one left to resolve it normally:
   *   • all hiders caught       → seekers win
   *   • no live seekers remain  → hiders win (e.g. every seeker disconnected)
   * In both cases enter('RESULTS') computes the winner from the surviving hider
   * count, so each resolves to the correct outcome. Safe to call any time.
   */
  endHuntIfDone() {
    if (this.phase !== 'HUNT') return
    if (this._hiderCount() === 0 || this._seekerCount() === 0) this.enter('RESULTS')
  }

  /**
   * Validate and apply a melee tag. Server-authoritative: requires HUNT, a live
   * seeker sender, and a live hider target within `config.tagRadius` (2D).
   * @param {object} seeker the tagging client
   * @param {string} targetId id of the hider being tagged
   * @returns {boolean} true if the tag landed
   */
  tag(seeker, targetId) {
    if (this.phase !== 'HUNT' || seeker.role !== ROLES.SEEKER) return false
    const tgt = this.room.clients.get(targetId)
    if (!tgt || tgt.role !== ROLES.HIDER || !tgt.state || !seeker.state) return false
    const dx = tgt.state.x - seeker.state.x
    const dz = tgt.state.z - seeker.state.z
    if (dx * dx + dz * dz > config.tagRadius * config.tagRadius) return false
    tgt.role = ROLES.OUT
    inc('tags_total')
    this.room.broadcast({ t: S.TAGGED, id: targetId })
    this.endHuntIfDone()
    return true
  }

  /**
   * A seeker fires their gun. The shot SFX is relayed to everyone else (hit OR
   * miss) for positional audio; the hit is then validated by 3D distance.
   * @param {object} seeker the firing client
   * @param {?string} targetId id of the hider hit (or null/empty for a miss)
   * @returns {boolean} true if a hider was downed
   */
  shoot(seeker, targetId) {
    if (this.phase !== 'HUNT' || seeker.role !== ROLES.SEEKER || !seeker.state) return false
    // relay the gunshot to everyone else for positional SFX (hit or miss)
    this.room.broadcast({ t: S.SHOT, id: seeker.id, x: seeker.state.x, y: seeker.state.y, z: seeker.state.z }, seeker.id)
    inc('shots_total')
    // validate the hit: target must be a live hider within gun range (3D)
    const tgt = targetId ? this.room.clients.get(targetId) : null
    if (!tgt || tgt.role !== ROLES.HIDER || !tgt.state) return false
    const dx = tgt.state.x - seeker.state.x
    const dy = tgt.state.y - seeker.state.y
    const dz = tgt.state.z - seeker.state.z
    if (dx * dx + dy * dy + dz * dz > config.shootRange * config.shootRange) return false
    tgt.role = ROLES.OUT
    inc('tags_total')
    this.room.broadcast({ t: S.TAGGED, id: targetId })
    this.endHuntIfDone()
    return true
  }
}
