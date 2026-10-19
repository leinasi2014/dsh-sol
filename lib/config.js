/**
 * Configuration resolution for dsh-sol.
 *
 * Deliberately exports no Schemastery `Config`, mirroring dsh-ops
 * (`dsh-ops/lib/config.js:5-9`): the host half must load with no
 * `@deepseek-ai/*` value import, so validation is explicit and fails loud,
 * naming the offending key. A patch row replaces the whole `config`
 * (`report.md` 3.3), so every accepted key is listed here.
 *
 * Every mechanism is off by default (`report.md` 3.7, rule 5).
 *
 * @module dsh-sol/config
 */

/** The mechanisms this version actually wires up. */
export const MECHANISMS = ['meter', 'actionFusion', 'observationPack', 'reducer', 'occ']

/**
 * Keys reserved for mechanisms that are documented but not wired into
 * `index.js` yet. They are rejected like any other unknown key: accepting a
 * switch nobody reads would let a user enable a mechanism and see nothing
 * happen, which is worse than failing loud (`report.md` 3.3).
 *
 * Each entry moves into `TOP_LEVEL_KEYS` in the same change that mounts it.
 * Empty now: every documented mechanism is mounted.
 */
export const RESERVED_KEYS = Object.freeze([])

/** Accepted top-level keys of the row config. */
const TOP_LEVEL_KEYS = ['meter', 'actionFusion', 'observationPack', 'reducer', 'occ']

/** Accepted keys of `meter`. */
const METER_KEYS = ['enabled', 'home']

/**
 * Default size above which a tool result is archived and replaced.
 *
 * Duplicated from `lib/observation.js` rather than imported: `config.js` is the
 * leaf every other module may import, and importing `observation.js` here would
 * make the dependency graph two-way. A test asserts the two values agree.
 */
export const DEFAULT_THRESHOLD_BYTES = 10 * 1024

/** Accepted keys of `actionFusion`. */
const ACTION_FUSION_KEYS = ['enabled', 'shells']

/** Accepted keys of `observationPack`. */
const OBSERVATION_PACK_KEYS = ['enabled', 'thresholdBytes']

/** Accepted keys of `reducer`. */
const REDUCER_KEYS = ['enabled', 'provider', 'model', 'timeoutMs']

/** Accepted keys of `occ`. */
const OCC_KEYS = ['enabled', 'thresholdRatio', 'dryRun']

/** Default deadline for one reducer call, in milliseconds (`report.md` 3.3). */
export const DEFAULT_REDUCER_TIMEOUT_MS = 20000

/** Default share of the window at which OCC acts (`report.md` 2.4). */
export const DEFAULT_OCC_THRESHOLD_RATIO = 0.5

/**
 * Shell tools tried in order by `actionFusion`.
 *
 * The order is data, not code: nothing else in this plugin names a shell, so a
 * deployment without the first entry simply uses the next one (`report.md` 3.3,
 * 3.7). `ops_bash` is absent on a profile without dsh-ops; `bash` is disabled on
 * Windows by the base bundle (`asar:dsh-base/cordis.patch.yml:281-283`), so it
 * stays last.
 */
export const DEFAULT_SHELLS = Object.freeze(['ops_bash', 'pwsh', 'bash'])

/** Error raised for a configuration value this plugin cannot honour. */
export class ConfigError extends Error {
  /**
   * @param {string} message - what is wrong and what is accepted.
   */
  constructor(message) {
    super(`dsh-sol config: ${message}`)
    this.name = 'ConfigError'
  }
}

/**
 * Reject keys the plugin does not implement instead of silently ignoring them.
 *
 * A key reserved for a mechanism that is documented but not mounted yet gets a
 * distinct message: the user wrote a real setting from `report.md` 3.3, and
 * "unknown key" would send them looking for a typo.
 *
 * @param {Record<string, unknown>} raw - the object to check.
 * @param {string[]} known - accepted keys.
 * @param {string} where - the dotted path used in the message.
 * @returns {void}
 */
function rejectUnknownKeys(raw, known, where) {
  const unknown = Object.keys(raw).filter((key) => !known.includes(key))
  if (unknown.length === 0) return
  const reserved = unknown.filter((key) => RESERVED_KEYS.includes(key))
  const misspelled = unknown.filter((key) => !RESERVED_KEYS.includes(key))
  const parts = []
  if (reserved.length > 0) {
    parts.push(
      `${reserved.map((key) => JSON.stringify(key)).join(', ')} under ${where} `
      + 'is documented but not implemented in this build yet, so it is refused rather than '
      + 'accepted and ignored; remove it until the mechanism is mounted',
    )
  }
  if (misspelled.length > 0) {
    parts.push(
      `unknown key(s) ${misspelled.map((key) => JSON.stringify(key)).join(', ')} under ${where}; `
      + `accepted keys are ${known.map((key) => JSON.stringify(key)).join(', ')}`,
    )
  }
  throw new ConfigError(parts.join('; '))
}

/**
 * Read an object-valued section.
 * @param {Record<string, unknown>} raw - the parent object.
 * @param {string} key - the section key.
 * @param {string} where - the dotted path used in the message.
 * @returns {Record<string, unknown>} the section, or an empty object when absent.
 */
function objectSection(raw, key, where) {
  const value = raw[key]
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${where} must be an object, got ${JSON.stringify(value)}`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Read an optional boolean.
 * @param {Record<string, unknown>} raw - the section.
 * @param {string} key - the key to read.
 * @param {boolean} fallback - the value when the key is absent.
 * @param {string} where - the dotted path used in the message.
 * @returns {boolean} the value.
 */
function optionalBoolean(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${where}.${key} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional non-empty string.
 * @param {Record<string, unknown>} raw - the section.
 * @param {string} key - the key to read.
 * @param {string} where - the dotted path used in the message.
 * @returns {string|undefined} the value, or undefined when absent.
 */
function optionalString(raw, key, where) {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${where}.${key} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional list of non-empty strings.
 * @param {Record<string, unknown>} raw - the section.
 * @param {string} key - the key to read.
 * @param {readonly string[]} fallback - the value when the key is absent.
 * @param {string} where - the dotted path used in the message.
 * @returns {string[]} a fresh copy of the list.
 */
function optionalStringList(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value) || value.length === 0
    || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new ConfigError(
      `${where}.${key} must be a non-empty array of non-empty strings, got ${JSON.stringify(value)}`,
    )
  }
  return [...value]
}

/**
 * Read an optional positive integer.
 * @param {Record<string, unknown>} raw - the section.
 * @param {string} key - the key to read.
 * @param {number} fallback - the value when the key is absent.
 * @param {string} where - the dotted path used in the message.
 * @returns {number} the value.
 */
function optionalPositiveInteger(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${where}.${key} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read an optional fraction between 0 and 1.
 * @param {Record<string, unknown>} raw - the section.
 * @param {string} key - the key to read.
 * @param {number} fallback - the value when the key is absent.
 * @param {string} where - the dotted path used in the message.
 * @returns {number} the value.
 */
function optionalRatio(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConfigError(`${where}.${key} must be a number in (0, 1], got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The resolved configuration, with every default applied.
 * @typedef {object} ResolvedConfig
 * @property {{enabled: boolean, home: string|undefined}} meter - the metering
 *   mechanism: off unless enabled, and an optional `$DSH_HOME` override.
 * @property {{enabled: boolean, shells: string[]}} actionFusion - the
 *   edit-then-run tools: off unless enabled, and the shell candidates in order.
 * @property {{enabled: boolean, thresholdBytes: number}} observationPack - the
 *   large-result replacement: off unless enabled, and the size above which a
 *   result is archived and replaced by a handle.
 * @property {{enabled: boolean, provider: string|undefined, model: string|undefined,
 *   timeoutMs: number}} reducer - the log compressor: off unless enabled, and
 *   it sends nothing anywhere until both `provider` and `model` are set.
 * @property {{enabled: boolean, thresholdRatio: number, dryRun: boolean}} occ -
 *   proactive compaction: off unless enabled, the share of the window it acts
 *   at, and whether it only records.
 */

/**
 * Validate one plugin row's config.
 * @param {unknown} rawConfig - the `config` value from the loader row.
 * @returns {ResolvedConfig} the resolved configuration.
 * @throws {ConfigError} for an unknown key or a value of the wrong type.
 */
export function resolveConfig(rawConfig) {
  if (rawConfig === undefined || rawConfig === null) rawConfig = {}
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new ConfigError(`config must be an object, got ${JSON.stringify(rawConfig)}`)
  }
  const raw = /** @type {Record<string, unknown>} */ (rawConfig)
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, 'config')

  const meter = objectSection(raw, 'meter', 'meter')
  rejectUnknownKeys(meter, METER_KEYS, 'meter')

  const actionFusion = objectSection(raw, 'actionFusion', 'actionFusion')
  rejectUnknownKeys(actionFusion, ACTION_FUSION_KEYS, 'actionFusion')

  const observationPack = objectSection(raw, 'observationPack', 'observationPack')
  rejectUnknownKeys(observationPack, OBSERVATION_PACK_KEYS, 'observationPack')

  const reducer = objectSection(raw, 'reducer', 'reducer')
  rejectUnknownKeys(reducer, REDUCER_KEYS, 'reducer')

  const occ = objectSection(raw, 'occ', 'occ')
  rejectUnknownKeys(occ, OCC_KEYS, 'occ')

  return {
    meter: {
      enabled: optionalBoolean(meter, 'enabled', false, 'meter'),
      home: optionalString(meter, 'home', 'meter'),
    },
    actionFusion: {
      enabled: optionalBoolean(actionFusion, 'enabled', false, 'actionFusion'),
      shells: optionalStringList(actionFusion, 'shells', DEFAULT_SHELLS, 'actionFusion'),
    },
    observationPack: {
      enabled: optionalBoolean(observationPack, 'enabled', false, 'observationPack'),
      thresholdBytes: optionalPositiveInteger(
        observationPack,
        'thresholdBytes',
        DEFAULT_THRESHOLD_BYTES,
        'observationPack',
      ),
    },
    reducer: {
      enabled: optionalBoolean(reducer, 'enabled', false, 'reducer'),
      // No default model: nothing leaves the machine unless a user names both
      // (`report.md` 3.5).
      provider: optionalString(reducer, 'provider', 'reducer'),
      model: optionalString(reducer, 'model', 'reducer'),
      timeoutMs: optionalPositiveInteger(reducer, 'timeoutMs', DEFAULT_REDUCER_TIMEOUT_MS, 'reducer'),
    },
    occ: {
      enabled: optionalBoolean(occ, 'enabled', false, 'occ'),
      thresholdRatio: optionalRatio(occ, 'thresholdRatio', DEFAULT_OCC_THRESHOLD_RATIO, 'occ'),
      // Recording only unless a user says otherwise: the thresholds are guesses
      // until dry-run data calibrates them (`report.md` 2.4 rule 3).
      dryRun: optionalBoolean(occ, 'dryRun', true, 'occ'),
    },
  }
}

/**
 * Whether any mechanism is switched on.
 * @param {ResolvedConfig} config - the resolved configuration.
 * @returns {boolean} true when at least one mechanism is enabled.
 */
export function anyMechanismEnabled(config) {
  return MECHANISMS.some((name) => config[name]?.enabled === true)
}
