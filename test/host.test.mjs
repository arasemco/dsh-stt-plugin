/**
 * STT host half: provider discovery and transcription forwarding against a fake
 * OpenAI-compatible server, so the plugin's own code is exercised without a real
 * model.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'

import { apply, inject } from '../lib/index.js'

/** Provider profiles, as the profile stores them under llm-pi-ai. */
const PROVIDERS = {
  ollama: { api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1' },
  chatonly: { api: 'openai-completions', baseURL: 'http://127.0.0.1:2/v1' },
}

/** Bodies the fake provider received. */
const received = []

/**
 * A fake provider that implements the transcription API.
 * @param options - `transcribe: false` omits the audio routes.
 * @returns Endpoint plus a close handle.
 */
async function fakeProvider (options = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, '')
    if (path === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        object: 'list',
        data: [{ id: 'llama3.1:8b' }, { id: 'lfm3-audio:latest' }, { id: 'gemma4:26b' }],
      }))
      return
    }
    if (options.transcribe !== false && path === '/audio/transcriptions') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        received.push({ type: req.headers['content-type'] ?? '', body })
        if (!(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'expected multipart' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: '  transcribed by the fake provider  ' }))
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no such route' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Mount the plugin over a provider map.
 * @param providers - provider profiles keyed by provider id.
 * @returns Origin plus a close handle.
 */
async function mount (providers, config = {}) {
  const routes = new Map()
  const ctx = {
    effect (fn) { fn() },
    webServer: {
      register (route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers } }] },
    llm: {
      listConfigurableProviders: () => Object.keys(providers).map((provider) => ({
        provider,
        displayName: provider,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider],
      })),
    },
  }
  apply(ctx, { discoveryTtlMs: 0, ...config })
  const server = createServer((req, res) => {
    const route = routes.get('/stt')
    if (route === undefined) return res.writeHead(500).end()
    route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A tiny valid WAV: 0.2 s of 16 kHz mono silence. */
function wavBytes (seconds = 0.2) {
  const frames = Math.round(16000 * seconds)
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(frames * 2, 40)
  return buffer
}

let provider
let chat
let plugin

before(async () => {
  provider = await fakeProvider()
  chat = await fakeProvider({ transcribe: false })
  plugin = await mount({
    ollama: { baseURL: provider.baseURL },
    chatonly: { baseURL: chat.baseURL },
  })
})

after(async () => {
  await plugin?.close()
  await provider?.close()
  await chat?.close()
})

test('requires the web server, settings, and the provider directory', () => {
  assert.deepEqual(inject, ['webServer', 'settings', 'llm'])
})

test('offers only providers that accept transcriptions', async () => {
  const body = await (await fetch(`${plugin.origin}/stt/info`)).json()
  assert.deepEqual(body.servers.map((server) => server.id), ['ollama'], 'a provider without the audio route is dropped')
  assert.equal(body.servers[0].baseURL, provider.baseURL)
  assert.ok(body.servers[0].models.includes('lfm3-audio:latest'))
  assert.ok(body.servers[0].models.includes('llama3.1:8b'), 'no model is filtered out')
  assert.ok(body.languages.includes('auto'))
})

test('leads with models whose names look like speech models', async () => {
  const body = await (await fetch(`${plugin.origin}/stt/info`)).json()
  assert.equal(body.servers[0].models[0], 'lfm3-audio:latest', 'audio-looking names sort first')
  assert.deepEqual(body.defaults, { server: 'ollama', model: 'lfm3-audio:latest' })
})

test('forwards the recording as multipart and returns the provider text', async () => {
  received.length = 0
  const response = await fetch(`${plugin.origin}/stt/transcribe?server=ollama&model=lfm3-audio:latest&language=en`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wavBytes(),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.text, 'transcribed by the fake provider')
  assert.equal(body.server, 'ollama')
  assert.equal(body.model, 'lfm3-audio:latest')
  const log = await (await fetch(`${plugin.origin}/stt/log?level=info`)).json()
  assert.ok(log.entries.some((entry) => entry.event === 'transcribed'), 'a take is logged')
  /* The capability probe also hits this route, so count only the real upload. */
  const uploads = received.filter((row) => row.type.startsWith('multipart/form-data'))
  assert.equal(uploads.length, 1)
  assert.match(uploads[0].type, /^multipart\/form-data; boundary=/)
  const text = uploads[0].body.toString('latin1')
  assert.match(text, /name="model"[\s\S]*lfm3-audio:latest/)
  assert.match(text, /name="file"; filename="recording.wav"/)
  assert.match(text, /name="language"[\s\S]*en/)
  assert.match(text, /name="response_format"[\s\S]*json/)
})

test('omits the language hint when it is auto', async () => {
  received.length = 0
  const response = await fetch(`${plugin.origin}/stt/transcribe?language=auto`, { method: 'POST', body: wavBytes() })
  assert.equal(response.status, 200)
  const upload = received.filter((row) => row.type.startsWith('multipart/form-data')).at(-1)
  assert.doesNotMatch(upload.body.toString('latin1'), /name="language"/)
})

test('rejects an empty body, a tiny body, and the wrong method', async () => {
  const empty = await fetch(`${plugin.origin}/stt/transcribe`, { method: 'POST', body: Buffer.alloc(0) })
  assert.equal(empty.status, 400)

  const tiny = await fetch(`${plugin.origin}/stt/transcribe`, { method: 'POST', body: wavBytes(0.01) })
  assert.equal(tiny.status, 400)
  assert.equal((await tiny.json()).error.code, 'audio')

  assert.equal((await fetch(`${plugin.origin}/stt/transcribe`)).status, 405)
  assert.equal((await fetch(`${plugin.origin}/stt/nope`)).status, 404)
})

test('refuses to transcribe when no provider can', async () => {
  const lonely = await mount({ chatonly: { baseURL: chat.baseURL } })
  try {
    const response = await fetch(`${lonely.origin}/stt/transcribe`, { method: 'POST', body: wavBytes() })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'no-speech-model')
    const info = await (await fetch(`${lonely.origin}/stt/info`)).json()
    assert.deepEqual(info.servers, [])
    assert.deepEqual(info.defaults, { server: null, model: null })
  } finally {
    await lonely.close()
  }
})

test('keeps an event log that can be filtered, read, and cleared', async () => {
  const posted = await fetch(`${plugin.origin}/stt/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'error', event: 'transcription-failed', detail: { message: 'boom' } }),
  })
  assert.equal(posted.status, 204)

  const body = await (await fetch(`${plugin.origin}/stt/log?tail=50`)).json()
  const failure = body.entries.find((entry) => entry.event === 'transcription-failed')
  assert.ok(failure !== undefined)
  assert.equal(failure.detail.message, 'boom')
  assert.ok(body.entries.some((entry) => entry.event === 'ready'), 'the host logs its own startup')
  assert.ok((await (await fetch(`${plugin.origin}/stt/log?level=info`)).json()).entries.every((entry) => entry.level === 'info'))
  assert.equal((await fetch(`${plugin.origin}/stt/log?level=nope`)).status, 400)
  assert.ok((await (await fetch(`${plugin.origin}/stt/log`, { method: 'DELETE' })).json()).cleared >= 1)
})

test('routes a model named without its provider across providers', async () => {
  const second = await fakeProvider()
  const both = await mount({ ollama: { baseURL: provider.baseURL }, other: { baseURL: second.baseURL } })
  try {
    const response = await fetch(`${both.origin}/stt/transcribe?model=lfm3-audio:latest`, { method: 'POST', body: wavBytes() })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.model, 'lfm3-audio:latest')
  } finally {
    await both.close()
    await second.close()
  }
})
