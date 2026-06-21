// Authoritative round state machine for ONE room: PREP → HUNT → RESULTS, role
// assignment, server-validated tagging, and win detection. The server owns this
// entirely so clients can't cheat the outcome.
import { config } from './config.js'
import { S, ROLES } from './protocol.js'
import { shuffle } from './util.js'
import { inc } from './metrics.js'

export class RoundController {
  constructor(room) {
    this.room = room
    this.phase = 'PREP'
    this.deadline = Date.now() + config.phase.PREP
    this.result = null
  }

  payload() {
    return { phase: this.phase, deadline: this.deadline, roles: this.room.rolesMap(), result: this.result }
  }
  broadcastPhase() {
    if (!this.room.isEmpty()) this.room.broadcast({ t: S.PHASE, ...this.payload() })
  }

  assignRoles() {
    const ids = shuffle([...this.room.clients.keys()])
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
    if (phase === 'PREP') {
      this.result = null
      for (const c of this.room.clients.values()) c.tex = null // fresh round → drop painted bodies
      this.assignRoles()
    } else if (phase === 'RESULTS') {
      const hiders = this._hiderCount()
      this.result = hiders > 0 ? 'hiders' : 'seekers'
    }
    this.broadcastPhase()
  }

  advance(now) {
    if (now < this.deadline) return
    if (this.phase === 'PREP') this.enter('HUNT')
    else if (this.phase === 'HUNT') this.enter('RESULTS')
    else this.enter('PREP')
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
}
