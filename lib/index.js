/**
 * dsh-plugin-stt — host half.
 *
 * Same shape as the TTS plugin, in the other direction: nothing is transcribed
 * here. The Host discovers which configured model providers implement the OpenAI
 * transcription API, forwards recorded audio to one of them, and returns the
 * text the provider produced.
 *
 *   GET  /stt/info       → providers that can transcribe, and every model they list
 *   POST /stt/transcribe → WAV in, { text } out, via <provider>/audio/transcriptions
 *
 * Discovery is capability-based, not name-based: a provider is offered when
 * `POST {baseURL}/audio/transcriptions` answers at all, which is true for Ollama
 * and audio.cpp alike. No model is filtered out — engines name their speech
 * models however they like — but names that look audio-capable lead the list.
 */

/** Behaviour defaults; no server, model, or language is assumed. */
const DEFAULTS = {
  /** Extra providers that are not configured as model providers. */
  endpoints: [],
  /** Preferred provider/model; unset means "first discovered". */
  server: null,
  model: null,
  /** Language hint; unset sends none and lets the model detect it. */
  language: null,
  /** How long a discovery result is reused before probing the providers again. */
  discoveryTtlMs: 15000,
  /** How long a provider that failed its probe is left alone. */
  failureTtlMs: 300000,
  /** Largest accepted recording. */
  maxAudioBytes: 32 * 1024 * 1024,
  /** One transcription may take a while on a cold model. */
  timeoutMs: 300000,
}

/** Language hints offered by the GUI; the provider decides what it supports. */
const LANGUAGES = ['auto', 'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'zh', 'ja', 'ko', 'yue']

/** Required Host services: routes, provider configuration, and the provider directory. */
export const inject = ['webServer', 'settings', 'llm']

/** Clamp a numeric config value. */
function number (value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Strip trailing slashes so endpoint building is predictable. */
function baseUrl (value) {
  return String(value).replace(/\/+$/, '')
}

/**
 * Walk one path through a settings value.
 * @param value - section root.
 * @param path - path segments from the provider directory.
 * @returns The value at that path, or undefined.
 */
function follow (value, path) {
  let current = value
  for (const key of path ?? []) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** How long one capability probe may take before it is called inconclusive. */
const PROBE_TIMEOUT_MS = 8000

/** Log levels a reader can filter by. */
const LEVELS = ['debug', 'info', 'warn', 'error']

/**
 * Bounded in-memory event log: the last `limit` entries, newest last.
 * @param limit - maximum retained entries.
 * @returns Log with `add`, `tail`, `clear`, and `counts`.
 */
function createLog (limit = 200) {
  const entries = []
  return {
    add (level, event, detail) {
      const entry = { at: Date.now(), level, event }
      if (detail !== undefined && detail !== null) entry.detail = detail
      entries.push(entry)
      if (entries.length > limit) entries.shift()
      return entry
    },
    tail (count = 20, level) {
      const filtered = level === undefined ? entries : entries.filter((entry) => entry.level === level)
      return filtered.slice(-count)
    },
    clear () {
      const total = entries.length
      entries.length = 0
      return total
    },
    counts () {
      const counts = { debug: 0, info: 0, warn: 0, error: 0 }
      for (const entry of entries) counts[entry.level] = (counts[entry.level] ?? 0) + 1
      return counts
    },
  }
}

/** One JSON response, always closing the response. */
function json (res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read a request body under a hard byte limit. */
async function readBody (req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('recording is too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Whether one model name looks like a speech model. Ordering only. */
function looksAudio (id) {
  return /(audio|omni|whisper|transcri|speech|asr|parakeet|sensevoice|canary)/i.test(id)
}

/**
 * Mount the transcription proxy and its provider discovery.
 * @param ctx - Host context carrying the web server, settings, and the provider directory.
 * @param config - Optional endpoint overrides, preferences, and limits.
 */
export function apply (ctx, config = {}) {
  const options = {
    ...DEFAULTS,
    ...config,
    endpoints: Array.isArray(config.endpoints) ? config.endpoints : [],
    maxAudioBytes: number(config.maxAudioBytes, DEFAULTS.maxAudioBytes, 1024, 512 * 1024 * 1024),
    discoveryTtlMs: number(config.discoveryTtlMs, DEFAULTS.discoveryTtlMs, 0, 600000),
    failureTtlMs: number(config.failureTtlMs, DEFAULTS.failureTtlMs, 0, 3600000),
    timeoutMs: number(config.timeoutMs, DEFAULTS.timeoutMs, 1000, 3600000),
  }

  /** Last discovery result and when it was taken. */
  let discoveredAt = 0
  let discovered = null
  /** Endpoints that failed a probe, and when. */
  const failures = new Map()
  /** Credential variable per endpoint, so transcribing authenticates like discovery. */
  const authByEndpoint = new Map()
  /** Host and browser events, bounded. */
  const log = createLog(200)

  /** Write one event to the log and, when available, the Host logger. */
  function note (level, event, detail) {
    log.add(level, event, detail)
    const writer = level === 'error' ? ctx.logger?.error : level === 'warn' ? ctx.logger?.warn : ctx.logger?.debug
    try {
      writer?.call(ctx.logger, `[stt] ${event}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
    } catch { /* logging must never break a request */ }
  }

  /**
   * Every provider this Host can reach over HTTP, plus any endpoint in this
   * plugin's own config.
   * @returns Unique candidates in provider order.
   */
  function candidates () {
    const found = []
    const seen = new Set()
    const add = (id, name, endpoint, apiKeyEnv) => {
      const normalized = baseUrl(endpoint ?? '')
      if (normalized === '' || seen.has(normalized)) return
      seen.add(normalized)
      authByEndpoint.set(normalized, typeof apiKeyEnv === 'string' ? apiKeyEnv : undefined)
      found.push({ id, name: name ?? id, baseURL: normalized, apiKeyEnv })
    }
    let entries = []
    try {
      entries = ctx.llm.listConfigurableProviders()
    } catch {
      entries = []
    }
    let descriptors = []
    try {
      descriptors = ctx.settings.describe()
    } catch {
      descriptors = []
    }
    const values = new Map(descriptors.map((descriptor) => [descriptor.ns, descriptor.value]))
    for (const entry of entries) {
      const path = entry.settingsPath ?? []
      /* Configured, not merely known: the catalog lists every route an adapter
         ships, and probing those would offer cloud models nobody asked for. */
      const section = follow(values.get(entry.settingsNs), path.slice(0, -1))
      const key = path[path.length - 1]
      if (section === null || typeof section !== 'object' || key === undefined || !Object.hasOwn(section, key)) continue
      const profile = section[key]
      const endpoint = profile !== null && typeof profile === 'object' && typeof profile.baseURL === 'string'
        ? profile.baseURL
        : entry.defaultBaseURL
      const apiKeyEnv = profile !== null && typeof profile === 'object' && typeof profile.apiKeyEnv === 'string'
        ? profile.apiKeyEnv
        : undefined
      add(entry.provider, entry.displayName, endpoint, apiKeyEnv)
    }
    for (const extra of options.endpoints) {
      if (extra !== null && typeof extra === 'object' && typeof extra.baseURL === 'string') {
        add(extra.id ?? extra.baseURL, extra.name, extra.baseURL, extra.apiKeyEnv)
      }
    }
    return found
  }

  /**
   * Request headers for one endpoint, including its credential when configured.
   * @param endpoint - provider base URL.
   * @returns Headers for every request to that provider.
   */
  function headersOf (endpoint) {
    const headers = {}
    const variable = authByEndpoint.get(endpoint)
    const value = variable === undefined ? undefined : process.env[variable]
    if (typeof value === 'string' && value !== '') headers.authorization = `Bearer ${value}`
    return headers
  }

  /**
   * Fetch one provider's model list.
   * @param endpoint - OpenAI-compatible base URL.
   * @returns Model ids, or null when the list cannot be read.
   */
  async function fetchModels (endpoint) {
    try {
      const response = await fetch(`${endpoint}/models`, {
        headers: { accept: 'application/json', ...headersOf(endpoint) },
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) return null
      const body = await response.json().catch(() => null)
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
      return rows
        .map((row) => (typeof row?.id === 'string' ? row.id : typeof row === 'string' ? row : undefined))
        .filter((id) => id !== undefined)
    } catch {
      return null
    }
  }

  /**
   * The OpenAI transcription capability test: does this provider serve
   * `POST /audio/transcriptions`? A malformed request is sent on purpose — a
   * handler rejects it, a non-speech server answers 404/405/501.
   * @param endpoint - OpenAI-compatible base URL.
   * @returns True when the transcription route exists.
   */
  async function acceptsTranscriptions (endpoint) {
    try {
      const response = await fetch(`${endpoint}/audio/transcriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headersOf(endpoint) },
        body: '{}',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (response.body !== null) await response.body.cancel().catch(() => {})
      return response.status !== 404 && response.status !== 405 && response.status !== 501 ? 'yes' : 'no'
    } catch {
      /* Busy, slow, or unreachable: unknown, not a refusal. */
      return 'unknown'
    }
  }

  /**
   * Probe one candidate: offered when it accepts transcriptions.
   * @param candidate - id, name, and endpoint.
   * @returns Server row, or null.
   */
  async function probe (candidate) {
    const audio = await acceptsTranscriptions(candidate.baseURL)
    if (audio === 'no') return { server: null, reason: 'no-speech' }
    const models = await fetchModels(candidate.baseURL)
    if (models === null) return { server: null, reason: audio === 'unknown' ? 'timeout' : 'no-models' }
    const ordered = [...models].sort((left, right) => Number(looksAudio(right)) - Number(looksAudio(left)))
    return {
      server: {
        id: candidate.id,
        name: candidate.name,
        baseURL: candidate.baseURL,
        declaresAudio: ordered.some(looksAudio),
        models: ordered,
      },
      reason: null,
    }
  }

  /**
   * Discover transcription providers, reusing the last result until it expires.
   * @param force - probe again even when the cached result is fresh.
   * @returns Server rows, speech-looking providers first.
   */
  async function discover (force = false) {
    if (!force && discovered !== null && Date.now() - discoveredAt < options.discoveryTtlMs) return discovered
    const probes = candidates().filter((candidate) => {
      /* An explicit refresh probes everything; a cached failure only delays the rest. */
      if (force) return true
      const failedAt = failures.get(candidate.baseURL)
      return failedAt === undefined || Date.now() - failedAt > options.failureTtlMs
    })
    const lastGood = new Map((discovered ?? []).map((server) => [server.baseURL, server]))
    const probed = await Promise.all(probes.map(async (candidate) => {
      const result = await probe(candidate)
      if (result.server !== null) {
        failures.delete(candidate.baseURL)
        return result.server
      }
      if (result.reason === 'timeout') {
        /* Still loading a model, or too busy to answer: keep the last good row. */
        const kept = lastGood.get(candidate.baseURL)
        if (kept !== undefined) {
          note('debug', 'provider-slow', { provider: candidate.id, endpoint: candidate.baseURL })
          return kept
        }
        return null
      }
      failures.set(candidate.baseURL, Date.now())
      note('debug', 'provider-unusable', { provider: candidate.id, endpoint: candidate.baseURL, reason: result.reason })
      return null
    }))
    discovered = probed
      .filter((server) => server !== null)
      .sort((left, right) => Number(right.declaresAudio) - Number(left.declaresAudio))
    discoveredAt = Date.now()
    return discovered
  }

  /**
   * Resolve the provider and model a request means.
   * @param servers - current discovery result.
   * @param wanted - explicitly requested provider and model.
   * @returns The resolved pair, or null when nothing corresponds.
   */
  function select (servers, wanted) {
    let server = servers.find((row) => row.id === wanted.server) ??
      servers.find((row) => row.id === options.server) ??
      servers[0]
    if (server === undefined) return null
    let model = wanted.model === undefined ? undefined : server.models.find((id) => id === wanted.model)
    if (model === undefined && wanted.model !== undefined && wanted.server === undefined) {
      const owner = servers.find((row) => row.models.includes(wanted.model))
      if (owner !== undefined) {
        server = owner
        model = wanted.model
      }
    }
    model = model ?? server.models.find((id) => id === options.model) ?? server.models[0]
    if (model === undefined) return null
    return { server, model }
  }

  /**
   * Forward one recording to a provider's transcription endpoint.
   * @param endpoint - provider base URL.
   * @param model - provider model id.
   * @param audio - WAV bytes.
   * @param language - language hint, or null to let the model detect it.
   * @returns The provider's text.
   */
  async function transcribe (endpoint, model, audio, language) {
    const form = new FormData()
    form.set('model', model)
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
    form.set('response_format', 'json')
    if (language !== null) form.set('language', language)
    const response = await fetch(`${endpoint}/audio/transcriptions`, {
      method: 'POST',
      headers: headersOf(endpoint),
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    const raw = await response.text().catch(() => '')
    if (!response.ok) {
      let message = raw.trim().slice(0, 400) || `transcription failed (${response.status})`
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.error?.message === 'string') message = parsed.error.message.slice(0, 400)
      } catch { /* not a JSON error body */ }
      const error = new Error(message)
      error.status = response.status >= 500 ? 502 : 400
      throw error
    }
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed?.text === 'string' ? parsed.text : ''
    } catch {
      /* Providers without response_format support may answer plain text. */
      return raw.trim()
    }
  }

  /** Route dispatcher: every unmatched path under /stt answers JSON, never HTML. */
  async function handler (req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/stt/info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: { code: 'method', message: 'GET /stt/info' } })
      }
      const servers = await discover(url.searchParams.get('refresh') === '1')
      const fallback = select(servers, {})
      return json(res, 200, {
        servers: servers.map(({ id, name, baseURL, models }) => ({ id, name, baseURL, models })),
        defaults: { server: fallback?.server.id ?? null, model: fallback?.model ?? null },
        languages: LANGUAGES,
      })
    }
    if (url.pathname === '/stt/log') {
      if (req.method === 'POST') {
        let entry
        try {
          entry = await readBody(req, 8192)
        } catch (error) {
          return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
        }
        let parsed
        try {
          parsed = JSON.parse(entry.toString('utf8'))
        } catch {
          return json(res, 400, { error: { code: 'body', message: 'log entry is not valid JSON' } })
        }
        const level = LEVELS.includes(parsed?.level) ? parsed.level : 'warn'
        const event = typeof parsed?.event === 'string' ? parsed.event.slice(0, 40) : 'client-event'
        const detail = parsed?.detail !== null && typeof parsed?.detail === 'object' ? parsed.detail : undefined
        note(level, event, detail === undefined ? undefined : JSON.parse(JSON.stringify(detail).slice(0, 2000)))
        res.writeHead(204, { 'cache-control': 'no-store' })
        return res.end()
      }
      if (req.method === 'GET') {
        const tail = number(url.searchParams.get('tail'), 20, 1, 200)
        const level = url.searchParams.get('level') ?? undefined
        if (level !== undefined && !LEVELS.includes(level)) {
          return json(res, 400, { error: { code: 'level', message: `unknown level: ${level}` } })
        }
        const entries = level === undefined
          ? log.tail(tail).filter((entry) => entry.level !== 'debug')
          : log.tail(tail, level)
        return json(res, 200, { entries, counts: log.counts() })
      }
      if (req.method === 'DELETE') {
        return json(res, 200, { cleared: log.clear() })
      }
      return json(res, 405, { error: { code: 'method', message: 'GET, POST, or DELETE /stt/log' } })
    }
    if (url.pathname === '/stt/transcribe') {
      if (req.method !== 'POST') return json(res, 405, { error: { code: 'method', message: 'POST /stt/transcribe' } })
      const servers = await discover()
      const chosen = select(servers, {
        server: url.searchParams.get('server') ?? undefined,
        model: url.searchParams.get('model') ?? undefined,
      })
      if (chosen === null) {
        note('warn', 'no-speech-model', { providers: 0 })
        return json(res, 409, { error: { code: 'no-speech-model', message: 'no provider accepts transcriptions' } })
      }
      const requested = url.searchParams.get('language') ?? options.language
      const language = requested === null || requested === '' || requested === 'auto' ? null : requested
      let body
      try {
        body = await readBody(req, options.maxAudioBytes)
      } catch (error) {
        return json(res, error.status ?? 400, { error: { code: 'body', message: error.message } })
      }
      if (body.length === 0) return json(res, 400, { error: { code: 'body', message: 'no audio received' } })
      if (body.length < 1600) return json(res, 400, { error: { code: 'audio', message: 'recording is too short' } })
      try {
        const started = Date.now()
        const text = await transcribe(chosen.server.baseURL, chosen.model, body, language)
        const ms = Date.now() - started
        note('info', 'transcribed', {
          provider: chosen.server.id,
          model: chosen.model,
          chars: text.trim().length,
          bytes: body.length,
          language: language ?? 'auto',
          ms,
        })
        return json(res, 200, { text: text.trim(), server: chosen.server.id, model: chosen.model, ms })
      } catch (error) {
        note('error', 'transcription-failed', {
          provider: chosen.server.id,
          model: chosen.model,
          bytes: body.length,
          language: language ?? 'auto',
          status: error.status ?? 502,
          message: String(error.message ?? error).slice(0, 240),
        })
        return json(res, error.status ?? 502, { error: { code: 'transcribe', message: error.message } })
      }
    }
    return json(res, 404, { error: { code: 'route', message: `unknown stt route: ${url.pathname}` } })
  }

  note('info', 'ready', {
    maxAudioBytes: options.maxAudioBytes,
    timeoutMs: options.timeoutMs,
    discoveryTtlMs: options.discoveryTtlMs,
  })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/stt', handler }), 'dsh-plugin-stt: /stt routes')
}
