import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoundController } from '../src/round.js'

// Unit tests for the authoritative round logic with a fake room (no sockets).
function fakeRoom(entries) {
  const clients = new Map(entries)
  return {
    clients,
    broadcast() {},
    isEmpty() { return clients.size === 0 },
    rolesMap() { const m = {}; for (const [id, c] of clients) m[id] = c.role; return m },
  }
}
const mk = (role = 'hider', x = 0, z = 0) => ({ role, state: { x, y: 0, z } })

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
