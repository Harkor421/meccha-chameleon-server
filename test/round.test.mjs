import { test } from 'node:test'
import assert from 'node:assert/strict'
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn' // keep round logs out of the test output
const { RoundController } = await import('../src/round.js')

// Unit tests for the authoritative round logic with a fake room (no sockets).
// Mirrors the real Room contract the RoundController depends on.
function fakeRoom(entries) {
  const clients = new Map(entries)
  // give each client its id so shoot()/broadcast can reference it
  for (const [id, c] of clients) c.id = id
  const room = {
    code: 'TEST',
    clients,
    hostId: clients.size ? [...clients.keys()][0] : null,
    sent: [],
    size() { return clients.size },
    broadcast(obj) { this.sent.push(obj) },
    clearPersistedTex() {},
    isEmpty() { return clients.size === 0 },
    rolesMap() { const m = {}; for (const [id, c] of clients) m[id] = c.role; return m },
  }
  return room
}
const mk = (role = 'hider', x = 0, z = 0, y = 0) => ({ role, spectator: false, state: { x, y, z } })

test('assignRoles: ~1 seeker per 4 players, min 1 once there are >=2', () => {
  for (const n of [2, 3, 4, 5, 8, 12]) {
    const room = fakeRoom(Array.from({ length: n }, (_, i) => [`p${i}`, mk()]))
    new RoundController(room).assignRoles()
    const seekers = [...room.clients.values()].filter((c) => c.role === 'seeker').length
    assert.equal(seekers, Math.max(1, Math.floor(n / 4)), `n=${n}`)
    assert.ok(seekers >= 1 && seekers < n, `n=${n} leaves hiders`)
  }
})

test('assignRoles: a solo player has no seeker', () => {
  const room = fakeRoom([['p0', mk()]])
  new RoundController(room).assignRoles()
  assert.equal([...room.clients.values()].filter((c) => c.role === 'seeker').length, 0)
})

test('tag: only a seeker, in range, during HUNT, against a hider', () => {
  const seeker = mk('seeker', 0, 0)
  const near = mk('hider', 1, 0)   // 1u away  (< tagRadius)
  const far = mk('hider', 50, 0)   // 50u away (> tagRadius)
  const room = fakeRoom([['s', seeker], ['n', near], ['f', far]])
  const rc = new RoundController(room)

  rc.phase = 'PREP'
  assert.equal(rc.tag(seeker, 'n'), false, 'no tagging outside HUNT')
  rc.phase = 'HUNT'
  assert.equal(rc.tag(near, 'f'), false, 'a hider cannot tag')
  assert.equal(rc.tag(seeker, 'f'), false, 'out of range is rejected')
  assert.equal(rc.tag(seeker, 'n'), true, 'in range lands')
  assert.equal(near.role, 'out')
  assert.equal(rc.tag(seeker, 'n'), false, 'cannot re-tag someone already out')
})

test('assignRoles: spectators never get hider/seeker and stay spectator', () => {
  const a = mk(); const b = mk(); const c = mk(); const spec = mk()
  spec.spectator = true
  const room = fakeRoom([['a', a], ['b', b], ['c', c], ['spec', spec]])
  new RoundController(room).assignRoles()
  assert.equal(spec.role, 'spectator', 'spectator is left out of the deal')
  const playing = [a, b, c]
  assert.ok(playing.some((p) => p.role === 'seeker'), 'a seeker is dealt among the 3 players')
  assert.ok(playing.every((p) => p.role === 'seeker' || p.role === 'hider'), 'players are only hider/seeker')
})

test('shoot: only a seeker, during HUNT, validates 3D range, relays the SFX', () => {
  const seeker = mk('seeker', 0, 0, 0)
  const near = mk('hider', 3, 0, 2)    // within shootRange (50)
  const far = mk('hider', 0, 0, 0)     // out of range via Y axis
  far.state.y = 999
  const room = fakeRoom([['s', seeker], ['n', near], ['f', far]])
  const rc = new RoundController(room)

  rc.phase = 'PREP'
  assert.equal(rc.shoot(seeker, 'n'), false, 'no shooting outside HUNT')
  rc.phase = 'HUNT'
  assert.equal(rc.shoot(near, 'f'), false, 'a hider cannot shoot')

  room.sent.length = 0
  assert.equal(rc.shoot(seeker, 'f'), false, 'out of (3D) range is rejected')
  assert.ok(room.sent.some((m) => m.t === 'shot' && m.id === 's'), 'a miss still relays the gunshot SFX')

  room.sent.length = 0
  assert.equal(rc.shoot(seeker, 'n'), true, 'in range downs the hider')
  assert.equal(near.role, 'out')
  assert.ok(room.sent.some((m) => m.t === 'shot'), 'a hit relays the gunshot SFX')
  assert.ok(room.sent.some((m) => m.t === 'tagged' && m.id === 'n'), 'a hit broadcasts tagged')
})

test('shoot: downing the last hider ends the hunt (seekers win)', () => {
  const seeker = mk('seeker', 0, 0, 0)
  const h1 = mk('hider', 1, 0, 0)
  const room = fakeRoom([['s', seeker], ['h1', h1]])
  const rc = new RoundController(room)
  rc.phase = 'HUNT'
  rc.shoot(seeker, 'h1')
  assert.equal(rc.phase, 'RESULTS')
  assert.equal(rc.result, 'seekers')
})

test('win: hiders win if any survive; seekers win when all hiders are tagged', () => {
  const seeker = mk('seeker', 0, 0)
  const h1 = mk('hider', 1, 0)
  const room = fakeRoom([['s', seeker], ['h1', h1]])
  const rc = new RoundController(room)

  rc.enter('RESULTS')
  assert.equal(rc.result, 'hiders', 'a surviving hider means hiders win')

  h1.role = 'hider'
  rc.phase = 'HUNT'
  rc.tag(seeker, 'h1') // last hider caught → endHuntIfDone → RESULTS
  assert.equal(rc.phase, 'RESULTS')
  assert.equal(rc.result, 'seekers')
})

// --- FIX 1: STUCK HUNT (ends both ways) ----------------------------------------
test('endHuntIfDone: all hiders caught → seekers win', () => {
  const seeker = mk('seeker', 0, 0)
  const h1 = mk('out', 1, 0) // already tagged out
  const room = fakeRoom([['s', seeker], ['h1', h1]])
  const rc = new RoundController(room)
  rc.phase = 'HUNT'
  rc.endHuntIfDone()
  assert.equal(rc.phase, 'RESULTS')
  assert.equal(rc.result, 'seekers', 'no hiders remain → seekers win')
})

test('endHuntIfDone: no live seekers left (all disconnected) → hiders win', () => {
  // a hider remains but every seeker is gone (the seeker was removed from the room)
  const h1 = mk('hider', 1, 0)
  const room = fakeRoom([['h1', h1]])
  const rc = new RoundController(room)
  rc.phase = 'HUNT'
  rc.endHuntIfDone()
  assert.equal(rc.phase, 'RESULTS', 'no seekers → the stuck hunt ends')
  assert.equal(rc.result, 'hiders', 'surviving hider → hiders win')
})

test('endHuntIfDone: with both a live hider AND seeker, HUNT keeps running', () => {
  const seeker = mk('seeker', 0, 0)
  const h1 = mk('hider', 1, 0)
  const room = fakeRoom([['s', seeker], ['h1', h1]])
  const rc = new RoundController(room)
  rc.phase = 'HUNT'
  rc.endHuntIfDone()
  assert.equal(rc.phase, 'HUNT', 'a normal hunt is not ended early')
})

// --- FIX 2: MIN-PLAYERS GATE ---------------------------------------------------
test('advance: a lone player never enters PREP (stays warming up in LOBBY)', () => {
  const room = fakeRoom([['solo', mk()]])
  const rc = new RoundController(room)
  rc.phase = 'LOBBY'
  rc.deadline = Date.now() - 1 // deadline already passed
  rc.advance(Date.now())
  assert.equal(rc.phase, 'LOBBY', 'too few players → no PREP')
  assert.ok(rc.deadline > Date.now(), 'LOBBY deadline is pushed back')
})

test('advance: with >= minPlayers the LOBBY advances to PREP', () => {
  const room = fakeRoom([['a', mk()], ['b', mk()]])
  const rc = new RoundController(room)
  rc.phase = 'LOBBY'
  rc.deadline = Date.now() - 1
  rc.advance(Date.now())
  assert.equal(rc.phase, 'PREP', '>= 2 players → start the round')
})

test('startMatch: gated on minPlayers, only from LOBBY/RESULTS', () => {
  const solo = fakeRoom([['solo', mk()]])
  const rcSolo = new RoundController(solo)
  assert.equal(rcSolo.startMatch(), false, 'a lone host cannot start')
  assert.equal(rcSolo.phase, 'LOBBY')

  const duo = fakeRoom([['a', mk()], ['b', mk()]])
  const rc = new RoundController(duo)
  assert.equal(rc.startMatch(), true, 'two players can start')
  assert.equal(rc.phase, 'PREP')
  assert.equal(rc.startMatch(), false, 'cannot restart a live PREP')
})

// --- FIX 4: WAITING role folds in at the next PREP -----------------------------
test('assignRoles: a WAITING (mid-round joiner) is dealt a real role', () => {
  const a = mk('hider'); const b = mk('seeker'); const late = mk('waiting')
  const room = fakeRoom([['a', a], ['b', b], ['late', late]])
  new RoundController(room).assignRoles()
  assert.ok(['hider', 'seeker'].includes(late.role), 'the latecomer is folded into the deal')
})
