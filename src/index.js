import './env.js' // load .env into process.env BEFORE config is read
import { GameServer } from './server.js'
import { log } from './log.js'

const server = new GameServer()
await server.start()

let stopping = false
async function shutdown(sig) {
  if (stopping) return
  stopping = true
  log.info(`[sys] ${sig} → graceful shutdown`)
  try { await server.stop() } catch (e) { log.error('[sys] shutdown error', e) }
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (e) => log.error('[sys] uncaughtException', e))
process.on('unhandledRejection', (e) => log.error('[sys] unhandledRejection', e))
