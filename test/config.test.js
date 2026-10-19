import assert from 'node:assert/strict'
import test from 'node:test'

import {
  anyMechanismEnabled,
  ConfigError,
  DEFAULT_OCC_THRESHOLD_RATIO,
  DEFAULT_REDUCER_TIMEOUT_MS,
  DEFAULT_SHELLS,
  MECHANISMS,
  RESERVED_KEYS,
  resolveConfig,
} from '../lib/config.js'

test('every mechanism is off when the row config is empty', () => {
  const config = resolveConfig({})
  assert.equal(config.meter.enabled, false)
  assert.equal(config.actionFusion.enabled, false)
  assert.equal(anyMechanismEnabled(config), false)
})

test('every mechanism is off when the whole config is absent', () => {
  for (const raw of [undefined, null]) {
    const config = resolveConfig(raw)
    assert.equal(config.meter.enabled, false, String(raw))
    assert.equal(config.actionFusion.enabled, false, String(raw))
    assert.equal(anyMechanismEnabled(config), false, String(raw))
  }
})

test('each mechanism switch is honoured on its own', () => {
  const meterOnly = resolveConfig({ meter: { enabled: true } })
  assert.equal(meterOnly.meter.enabled, true)
  assert.equal(meterOnly.actionFusion.enabled, false)
  assert.equal(anyMechanismEnabled(meterOnly), true)

  const fusionOnly = resolveConfig({ actionFusion: { enabled: true } })
  assert.equal(fusionOnly.meter.enabled, false)
  assert.equal(fusionOnly.actionFusion.enabled, true)
  assert.equal(anyMechanismEnabled(fusionOnly), true)
})

test('the shell candidates default to the documented order', () => {
  assert.deepEqual(resolveConfig({}).actionFusion.shells, DEFAULT_SHELLS)
  assert.deepEqual(DEFAULT_SHELLS, ['ops_bash', 'pwsh', 'bash'])
})

test('the shell candidates are configurable and copied', () => {
  const config = resolveConfig({ actionFusion: { shells: ['pwsh', 'bash'] } })
  assert.deepEqual(config.actionFusion.shells, ['pwsh', 'bash'])
  // Mutating the resolved list must not reach DEFAULT_SHELLS.
  config.actionFusion.shells.push('nope')
  assert.deepEqual(DEFAULT_SHELLS, ['ops_bash', 'pwsh', 'bash'])
  assert.deepEqual(resolveConfig({}).actionFusion.shells, ['ops_bash', 'pwsh', 'bash'])
})

test('an empty or malformed shell list is rejected', () => {
  for (const shells of [[], ['ok', ''], ['ok', 3], 'ops_bash', {}]) {
    assert.throws(() => resolveConfig({ actionFusion: { shells } }), ConfigError, JSON.stringify(shells))
  }
})

test('every documented mechanism is mounted, so nothing is reserved any more', () => {
  // The reserved list exists to refuse a switch nobody reads. Now that all five
  // mechanisms are wired, it must be empty: a leftover entry would refuse a key
  // that actually works (`report.md` 3.3).
  assert.deepEqual([...RESERVED_KEYS], [])
  for (const key of MECHANISMS) {
    assert.equal(key in resolveConfig({}), true, key)
  }
  assert.deepEqual(MECHANISMS, ['meter', 'actionFusion', 'observationPack', 'reducer', 'occ'])
})

test('an adjacentUsers key is refused as unknown', () => {
  // The mechanism was removed outright, not reserved: it never worked (the loop
  // re-appends the runtime context after `agent/pre-step`), and the gateway quirk
  // it aimed at lives in the gateway. A profile still carrying the key must fail
  // loud rather than be silently ignored.
  try {
    resolveConfig({ adjacentUsers: { enabled: true } })
    assert.fail('expected a ConfigError')
  } catch (error) {
    assert.match(error.message, /unknown key/u)
    assert.doesNotMatch(error.message, /not implemented/u)
  }
})

test('a misspelled key still reports unknown, not reserved', () => {
  try {
    resolveConfig({ meter: { enable: true } })
    assert.fail('expected a ConfigError')
  } catch (error) {
    assert.match(error.message, /unknown key/u)
    assert.doesNotMatch(error.message, /not implemented/u)
  }
})

test('an explicit home override survives resolution', () => {
  assert.equal(resolveConfig({ meter: { home: 'D:/tmp/dsh-home' } }).meter.home, 'D:/tmp/dsh-home')
})

test('every mechanism name is a resolved section', () => {
  const config = resolveConfig({})
  for (const name of MECHANISMS) assert.ok(config[name] !== undefined, name)
})

test('an unknown top-level key is rejected, not ignored', () => {
  assert.throws(() => resolveConfig({ nonsense: { enabled: true } }), ConfigError)
})

test('an unknown nested key is rejected', () => {
  assert.throws(() => resolveConfig({ meter: { enable: true } }), ConfigError)
})

test('a wrong-typed switch is rejected', () => {
  assert.throws(() => resolveConfig({ meter: { enabled: 'yes' } }), ConfigError)
})

test('a non-object section is rejected', () => {
  assert.throws(() => resolveConfig({ meter: [] }), ConfigError)
  assert.throws(() => resolveConfig({ meter: 'on' }), ConfigError)
})

test('a non-object config is rejected', () => {
  assert.throws(() => resolveConfig([]), ConfigError)
  assert.throws(() => resolveConfig('meter'), ConfigError)
})

test('an empty home string is rejected rather than silently ignored', () => {
  assert.throws(() => resolveConfig({ meter: { home: '   ' } }), ConfigError)
})

test('the error message names the offending key and the accepted ones', () => {
  try {
    resolveConfig({ meter: { nope: 1 } })
    assert.fail('expected a ConfigError')
  } catch (error) {
    assert.ok(error instanceof ConfigError)
    assert.match(error.message, /"nope"/u)
    assert.match(error.message, /"enabled"/u)
  }
})

test('the reducer defaults to off with no provider or model', () => {
  // Nothing may leave the machine until a user names both (`report.md` 3.5).
  const config = resolveConfig({})
  assert.equal(config.reducer.enabled, false)
  assert.equal(config.reducer.provider, undefined)
  assert.equal(config.reducer.model, undefined)
  assert.equal(config.reducer.timeoutMs, DEFAULT_REDUCER_TIMEOUT_MS)
  assert.equal(DEFAULT_REDUCER_TIMEOUT_MS, 20000)
})

test('the reducer accepts a provider and a model', () => {
  const config = resolveConfig({ reducer: { enabled: true, provider: 'p', model: 'm', timeoutMs: 5000 } })
  assert.equal(config.reducer.enabled, true)
  assert.equal(config.reducer.provider, 'p')
  assert.equal(config.reducer.model, 'm')
  assert.equal(config.reducer.timeoutMs, 5000)
})

test('an empty provider or model is rejected, not treated as unset', () => {
  assert.throws(() => resolveConfig({ reducer: { provider: '' } }), /non-empty string/u)
  assert.throws(() => resolveConfig({ reducer: { model: '  ' } }), /non-empty string/u)
})

test('the reducer timeout must be a positive integer', () => {
  for (const timeoutMs of [0, -1, 1.5, '20s']) {
    assert.throws(() => resolveConfig({ reducer: { timeoutMs } }), /positive integer/u, String(timeoutMs))
  }
})

test('the reducer section rejects an unknown key', () => {
  assert.throws(() => resolveConfig({ reducer: { shell: 'pwsh' } }), /unknown key/u)
})

test('the occ section defaults to recording only', () => {
  const config = resolveConfig({})
  assert.equal(config.occ.enabled, false)
  assert.equal(config.occ.thresholdRatio, DEFAULT_OCC_THRESHOLD_RATIO)
  assert.equal(config.occ.dryRun, true, 'a guess must not compact anything until it is measured')
  assert.equal(DEFAULT_OCC_THRESHOLD_RATIO, 0.5)
})

test('the occ threshold ratio must be a fraction in (0, 1]', () => {
  assert.equal(resolveConfig({ occ: { thresholdRatio: 0.7 } }).occ.thresholdRatio, 0.7)
  assert.equal(resolveConfig({ occ: { thresholdRatio: 1 } }).occ.thresholdRatio, 1)
  for (const thresholdRatio of [0, -0.1, 1.5, 'half', Number.NaN]) {
    assert.throws(() => resolveConfig({ occ: { thresholdRatio } }), /number in \(0, 1\]/u, String(thresholdRatio))
  }
})

test('the occ section rejects an unknown key', () => {
  assert.throws(() => resolveConfig({ occ: { cooldown: 2 } }), /unknown key/u)
})

test('the occ dryRun switch must be a boolean', () => {
  assert.equal(resolveConfig({ occ: { dryRun: false } }).occ.dryRun, false)
  assert.throws(() => resolveConfig({ occ: { dryRun: 'no' } }), /must be a boolean/u)
})
