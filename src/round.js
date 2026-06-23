// Authoritative round state machine for ONE room: LOBBY → PREP → HUNT → RESULTS,
// role assignment, server-validated tagging, and win detection. The server owns
// this entirely so clients can't cheat the outcome.
import { config } from './config.js'
import { S, ROLES } from './protocol.js'
import { shuffle } from './util.js'
import { inc } from './metrics.js'

export class RoundController {
  constructor(room) {
    this.room = room
    // start in LOBBY: a pregame warm-up where everyone roams/chats/paints (no hunting)
    this.phase = 'LOBBY'
    this.deadline = Date.now() + config.phase.LOBBY
    this.result = null
    this.lastWhistleAt = 0 // HUNT spatial-whistle hint cadence
  }

  payload() {
    return { phase: this.phase, deadline: this.deadline, roles: this.room.rolesMap(), result: this.result }
  }
  broadcastPhase() {
    if (!this.room.isEmpty()) this.room.broadcast({ t: S.PHASE, ...this.payload() })
  }

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

  enter(phase) {
    this.phase = phase
    this.deadline = Date.now() + (config.phase[phase] || 10000)
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
    this.broadcastPhase()
  }

  advance(now) {
    if (now < this.deadline) return
    if (this.phase === 'LOBBY') this.enter('PREP')
    else if (this.phase === 'PREP') this.enter('HUNT')
    else if (this.phase === 'HUNT') this.enter('RESULTS')
    else this.enter('LOBBY')
  }

  // HUNT spatial-whistle hint: every config.whistleMs the server pings all clients so
  // seekers play a positional whistle at each hider (and hiders hear they've been pinged).
  // Driven by the RoomManager's shared tick loop (no per-room timer).
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
  endHuntIfDone() {
    if (this.phase === 'HUNT' && this._hiderCount() === 0) this.enter('RESULTS')
  }

  // Returns true if the tag landed. Validated entirely server-side.
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

  // A seeker fires their gun. The shot SFX is relayed to everyone else (hit OR
  // miss) for positional audio; the hit is then validated by 3D distance. Returns
  // true if a hider was downed.
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
