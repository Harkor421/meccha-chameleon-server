// Owns all rooms: matchmaking (public auto-fill + private join-by-code), capacity,
// reaping empty rooms, and the SHARED master loops that tick every room. One set
// of intervals for the whole server (not per-room) keeps thousands of rooms cheap.
import { config } from './config.js'
import { Room } from './room.js'
import { roomCode } from './util.js'
import { log } from './log.js'

export class RoomManager {
  constructor() {
    this.rooms = new Map() // code -> Room
    this._timers = []
  }

  stats() {
    let players = 0
    for (const r of this.rooms.values()) players += r.size()
    return { rooms: this.rooms.size, players }
  }

  createRoom(code, isPublic) {
    const room = new Room(code, isPublic)
    this.rooms.set(code, room)
    log.info(`[room] + ${code} (${isPublic ? 'public' : 'private'})`)
    return room
  }

  // Pick the room a connecting client joins. Returns { room } or { full: true }.
  //  • room code given  → join it (if space) or create it private (if new)
  //  • no code          → fill the first public room with space, else open a new one
  assign(requestedCode) {
    if (requestedCode) {
      const code = String(requestedCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
      if (code) {
        const room = this.rooms.get(code)
        if (room) return room.size() >= config.maxPlayersPerRoom ? { full: true } : { room }
        if (this.rooms.size >= config.maxRooms) return { full: true }
        return { room: this.createRoom(code, false) }
      }
    }
    for (const room of this.rooms.values()) {
      if (room.isPublic && room.size() < config.maxPlayersPerRoom) return { room }
    }
    if (this.rooms.size >= config.maxRooms) return { full: true }
    let code
    do { code = roomCode() } while (this.rooms.has(code))
    return { room: this.createRoom(code, true) }
  }

  start() {
    const presenceMs = Math.max(10, Math.round(1000 / config.tickHz))
    this._timers.push(setInterval(() => { for (const r of this.rooms.values()) r.tickPresence() }, presenceMs))
    this._timers.push(setInterval(() => { const now = Date.now(); for (const r of this.rooms.values()) r.round.advance(now) }, 250))
    this._timers.push(setInterval(() => { for (const r of this.rooms.values()) r.round.broadcastPhase() }, 1000))
    this._timers.push(setInterval(() => this.reap(), 5000))
  }

  reap() {
    const now = Date.now()
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && room.emptySince && now - room.emptySince > config.roomEmptyGraceMs) {
        this.rooms.delete(code)
        log.info(`[room] - ${code} (reaped)`)
      }
    }
  }

  stop() { for (const t of this._timers) clearInterval(t); this._timers = [] }
}
