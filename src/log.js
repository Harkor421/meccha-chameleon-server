// Tiny leveled logger. Structured-ish, dependency-free.
import { config } from './config.js'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[config.logLevel] ?? 20

function emit(level, args) {
  if (LEVELS[level] < threshold) return
  const ts = new Date().toISOString()
  const line = `${ts} ${level.toUpperCase().padEnd(5)}`
  // eslint-disable-next-line no-console
  ;(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line, ...args)
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
}
