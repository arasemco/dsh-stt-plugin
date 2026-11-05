/**
 * STT browser half: load the hand-authored bundle the way the shell does, render
 * the microphone in jsdom, and drive a whole recording → transcription →
 * insertion round with stubbed browser audio APIs.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import React from 'react'
import { createPortal } from 'react-dom'
import ReactDOMClient from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { JSDOM } from 'jsdom'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ------------------------------------------------------------------ harness */

/** The provider state the fake Host reports. */
const INFO = {
  servers: [{
    id: 'ollama',
    name: 'ollama',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: ['lfm3-audio:latest', 'llama3.1:8b', 'gemma4:26b'],
  }],
  defaults: { server: 'ollama', model: 'lfm3-audio:latest' },
  languages: ['auto', 'en', 'ja'],
}

/**
 * Load the bundle the way the shell does.
 * @param dom - jsdom window bound as the bundle's `window`.
 * @param env - browser API overrides.
 * @returns The plugin module exports.
 */
function loadBundle (dom, env) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const icon = (name) => (props) => React.createElement('svg', { ...props, 'data-icon': name })
  const modules = {
    react: React,
    'react-dom': { createPortal },
    '@deepseek-ai/dsh-client-ui-primitives': {
      IconMicrophoneOutlineRegular: icon('mic'),
      IconCloseOutlineRegular: icon('close'),
      IconCheckOutlineRegular: icon('check'),
      IconChevronDownOutlineRegular: icon('chevron'),
    },
  }
  const requireShim = (id) => {
    if (id in modules) return modules[id]
    throw new Error(`unexpected require: ${id}`)
  }
  dom.window.__ModuleLoader__ = { load: (value) => { dom.window.__ModuleLoader__.definition = value } }
  const evaluate = new Function(
    'window', 'document', 'Audio', 'fetch', 'URL', 'navigator', 'MediaRecorder', 'AudioContext', 'OfflineAudioContext', 'Blob',
    source,
  )
  evaluate(
    dom.window,
    dom.window.document,
    env.Audio,
    env.fetch,
    env.URL ?? { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    env.navigator,
    env.MediaRecorder,
    env.AudioContext,
    env.OfflineAudioContext,
    env.Blob,
  )
  const definition = dom.window.__ModuleLoader__.definition
  assert.ok(definition !== undefined)
  assert.equal(definition.id, 'dsh-plugin-stt')
  return definition.factory(requireShim)
}

/** Create a fresh jsdom document. */
function makeDom () {
  return new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
}

/** Publish one jsdom as the ambient browser for react-dom. */
function useDom (dom) {
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent']
  const saved = new Map()
  for (const name of names) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    const value = name === 'window' ? dom.window : dom.window[name]
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

/**
 * Fake browser audio APIs and transport.
 * @param options - `deny` rejects microphone permission.
 * @returns Environment plus recording buffers.
 */
function makeEnvironment (options = {}) {
  const requests = []
  const inserts = []
  const tracks = { stopped: 0 }
  class FakeRecorder {
    constructor (stream) {
      this.stream = stream
      this.state = 'inactive'
      this.mimeType = 'audio/webm'
      this.ondataavailable = null
      this.onstop = null
    }

    start () { this.state = 'recording' }

    stop () {
      this.state = 'inactive'
      if (this.ondataavailable !== null) this.ondataavailable({ data: new Blob(['recorded audio bytes']) })
      if (this.onstop !== null) this.onstop()
    }
  }
  return {
    requests,
    inserts,
    tracks,
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      if (String(url).includes('/stt/info')) {
        return { ok: true, status: 200, json: async () => options.info ?? INFO }
      }
      if (String(url).includes('/stt/log')) {
        return { ok: true, status: 204, json: async () => null }
      }
      if (String(url).includes('/stt/transcribe')) {
        if (options.failTranscribe === true) {
          return { ok: false, status: 502, json: async () => ({ error: { code: 'transcribe', message: 'provider exploded' } }) }
        }
        return { ok: true, status: 200, json: async () => ({ text: options.text ?? 'hello world' }) }
      }
      return { ok: false, status: 404, json: async () => null }
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          if (options.deny === true) {
            const error = new Error('denied')
            error.name = 'NotAllowedError'
            throw error
          }
          return { getTracks: () => [{ stop: () => { tracks.stopped += 1 } }] }
        },
      },
    },
    MediaRecorder: FakeRecorder,
    AudioContext: class {
      async decodeAudioData () {
        return {
          length: 16000,
          numberOfChannels: 1,
          sampleRate: 16000,
          getChannelData: () => new Float32Array(16000),
        }
      }

      async close () {}
    },
    OfflineAudioContext: class {
      createBuffer () { return { copyToChannel () {} } }
      createBufferSource () { return { connect () {}, start () {}, buffer: null } }
      get destination () { return {} }
      async startRendering () { return { getChannelData: () => new Float32Array(16000) } }
    },
    Blob,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  }
}

/** Fake client context with hook binding, like the renderer's. */
function fakeContext (registrations) {
  return {
    effect (fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    locale: { register: () => () => {} },
    slots: {
      inject: (name, callback) => {
        callback()
        return () => {}
      },
      register: (spec, component) => {
        const injected = spec.inject === undefined ? {} : spec.inject('s1')
        const { hooks, ...rest } = injected
        const props = { ...rest }
        for (const [key, observable] of Object.entries(hooks ?? {})) {
          props[`use${key.charAt(0).toUpperCase()}${key.slice(1)}`] = (selector) => React.useSyncExternalStore(
            (listener) => observable.subscribe(listener),
            () => selector(observable.getSnapshot()),
            () => selector(observable.getSnapshot()),
          )
        }
        registrations.push({ spec, component, injected: props })
        return () => {}
      },
    },
  }
}

/** Mount the dictation control and the listening bar, as the shell does. */
async function mountControl (environment, options = {}) {
  const dom = makeDom()
  const mod = loadBundle(dom, environment)
  const registrations = []
  mod.apply(fakeContext(registrations))
  const control = registrations.find((row) => row.spec.id === 'stt-dictate')
  const bar = registrations.find((row) => row.spec.id === 'stt-listening')
  const restore = useDom(dom)
  const container = dom.window.document.getElementById('root')
  const barHost = dom.window.document.createElement('div')
  barHost.id = 'bar-host'
  dom.window.document.body.appendChild(barHost)
  const root = ReactDOMClient.createRoot(container)
  const barRoot = ReactDOMClient.createRoot(barHost)
  const t = (key, params) => {
    if (params === undefined) return key
    if (typeof params === 'object') return `${key} ${JSON.stringify(params)}`
    return `${key} ${params}`
  }
  const inputActions = {
    captureInsertion: () => ({ rev: 1, from: 0, to: 0 }),
    insertText: (text, span) => {
      environment.inserts.push({ text, span })
      return options.rejectFirstInsert === true && environment.inserts.length === 1 ? false : true
    },
    setDraft: () => {},
    persistDraft: () => {},
  }
  await act(async () => {
    root.render(React.createElement(control.component, {
      ...control.injected,
      sessionId: 's1',
      inputActions,
      useInput: (selector) => selector({ draft: options.draft ?? '' }),
      t,
    }))
    barRoot.render(React.createElement(bar.component, { ...bar.injected, sessionId: 's1', t }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  return { dom, container, barHost, root, barRoot, restore, environment, mod, t }
}

/** One click on an element inside act(). */
async function click (dom, element, wait = 20) {
  assert.ok(element !== null && element !== undefined, 'the element to click exists')
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, wait))
  })
}

/** End any capture a test left running, so its timers stop. */
async function cancelCapture (dom, container) {
  const cancel = container.querySelector('.dsh-stt-round[aria-label=cancel]')
  if (cancel !== null) await click(dom, cancel, 20)
}

/* --------------------------------------------------------------------- tests */


test('registers the dictation control and the listening bar', () => {
  const dom = makeDom()
  const environment = makeEnvironment()
  const mod = loadBundle(dom, environment)
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  const registrations = []
  mod.apply(fakeContext(registrations))
  assert.deepEqual(registrations.map((row) => row.spec.id), ['stt-listening', 'stt-dictate'])
  assert.deepEqual(registrations.map((row) => row.spec.name), ['conversation.input.dock', 'conversation.input.right'])
  assert.ok(dom.window.document.head.querySelector('style[data-plugin-css]') !== null)
  dom.window.close()
})

test('writes a valid 16-bit mono WAV', () => {
  const dom = makeDom()
  const mod = loadBundle(dom, makeEnvironment())
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
  const blob = mod.__internals.wavBlob(samples, 16000)
  assert.equal(blob.type, 'audio/wav')
  return blob.arrayBuffer().then((buffer) => {
    const view = new DataView(buffer)
    const text = (offset, length) => String.fromCharCode(...new Uint8Array(buffer, offset, length))
    assert.equal(text(0, 4), 'RIFF')
    assert.equal(text(8, 4), 'WAVE')
    assert.equal(text(12, 4), 'fmt ')
    assert.equal(view.getUint16(20, true), 1, 'PCM')
    assert.equal(view.getUint16(22, true), 1, 'mono')
    assert.equal(view.getUint32(24, true), 16000, 'rate')
    assert.equal(view.getUint16(34, true), 16, 'bits')
    assert.equal(text(36, 4), 'data')
    assert.equal(view.getUint32(40, true), samples.length * 2)
    assert.equal(view.getInt16(44 + 2 * 3, true), 0x7fff, 'full positive clamps')
    assert.equal(view.getInt16(44 + 2 * 4, true), -0x8000, 'full negative clamps')
    dom.window.close()
  })
})

test('records, transcribes, and inserts at the captured caret', async () => {
  const environment = makeEnvironment()
  const { container, root, restore, dom } = await mountControl(environment)

  const trigger = container.querySelector('.dsh-stt-trigger')
  assert.ok(trigger !== null)
  assert.match(trigger.textContent, /trigger/, 'the trigger is labelled')

  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(container.querySelector('.dsh-stt-trigger[data-recording]') !== null, true, 'recording state')

  await act(async () => {
    container.querySelector('.dsh-stt-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })

  assert.equal(environment.inserts.length, 1, 'the transcript is inserted once')
  assert.equal(environment.inserts[0].text, 'hello world')
  assert.deepEqual(environment.inserts[0].span, { rev: 1, from: 0, to: 0 }, 'insertion uses the captured caret')
  const upload = environment.requests.find((row) => row.url.includes('/stt/transcribe'))
  assert.ok(upload !== undefined, 'audio was uploaded')
  assert.match(upload.url, /language=auto/)
  assert.match(upload.url, /server=ollama/)
  assert.match(upload.url, /model=lfm3-audio/)
  assert.ok(environment.tracks.stopped >= 1, 'the microphone is released')

  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('retries the insertion at the current caret when the draft moved', async () => {
  const environment = makeEnvironment()
  const { root, restore, dom } = await mountControl(environment, { rejectFirstInsert: true })
  const trigger = dom.window.document.querySelector('.dsh-stt-trigger')
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await act(async () => {
    dom.window.document.querySelector('.dsh-stt-trigger').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.equal(environment.inserts.length, 2, 'the insert is retried once')
  assert.deepEqual(environment.inserts[1].span, { rev: 1, from: 0, to: 0 })
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('reports a failed transcription to the host log', async () => {
  const environment = makeEnvironment({ failTranscribe: true })
  const { container, root, restore, dom } = await mountControl(environment)
  await click(dom, container.querySelector('.dsh-stt-trigger'), 20)
  const bar = dom.window.document.querySelector('.dsh-stt-bar')
  await click(dom, bar.querySelector('.dsh-stt-round[data-primary]'), 40)
  assert.equal(environment.inserts.length, 0, 'nothing is inserted on failure')
  const posted = environment.requests.filter((row) => row.url.includes('/stt/log'))
  assert.ok(posted.length >= 1, 'the failure is reported')
  const payload = JSON.parse(posted.at(-1).body)
  assert.equal(payload.level, 'error')
  assert.equal(payload.event, 'transcription-failed')
  assert.match(payload.detail.message, /provider exploded/)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('explains itself instead of recording when no provider exists', async () => {
  const environment = makeEnvironment({ info: { servers: [], defaults: { server: null, model: null }, languages: ['auto'] } })
  const { container, root, restore, dom } = await mountControl(environment)
  const trigger = container.querySelector('.dsh-stt-trigger')
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.equal(container.querySelector('.dsh-stt-trigger[data-recording]'), null, 'no recording without a provider')
  const panel = dom.window.document.querySelector('.dsh-stt-panel')
  assert.ok(panel !== null, 'the panel opens')
  assert.match(panel.textContent, /status\.none/)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('offers the provider model roster and remembers the choice', async () => {
  const environment = makeEnvironment()
  const { container, root, restore, dom } = await mountControl(environment)
  await click(dom, container.querySelector('.dsh-stt-caret'), 60)
  const panel = dom.window.document.querySelector('.dsh-stt-panel')
  assert.ok(panel !== null, 'the caret opens the panel')
  const labels = [...panel.querySelectorAll('.dsh-stt-chip')].map((chip) => chip.textContent)
  assert.ok(labels.includes('lfm3-audio:latest'), 'every model the provider lists is offered')
  assert.ok(labels.includes('llama3.1:8b'))
  const chosen = [...panel.querySelectorAll('.dsh-stt-chip')].find((chip) => chip.textContent === 'llama3.1:8b')
  await click(dom, chosen)
  assert.match(dom.window.localStorage.getItem('dsh.stt.settings.v1') ?? '', /llama3\.1:8b/)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})

test('persists the chosen language and sends it', async () => {
  const environment = makeEnvironment()
  const { container, root, restore, dom } = await mountControl(environment)
  await click(dom, container.querySelector('.dsh-stt-caret'), 60)
  const panel = dom.window.document.querySelector('.dsh-stt-panel')
  assert.ok(panel !== null, 'the caret opens the panel')
  const japanese = [...panel.querySelectorAll('.dsh-stt-chip')].find((chip) => chip.textContent === 'ja')
  assert.ok(japanese !== undefined, 'languages are offered')
  await click(dom, japanese)
  assert.match(dom.window.localStorage.getItem('dsh.stt.settings.v1') ?? '', /"ja"/)
  await click(dom, container.querySelector('.dsh-stt-caret'), 40)
  assert.equal(dom.window.document.querySelector('.dsh-stt-panel'), null, 'the caret toggles the panel shut')

  await click(dom, container.querySelector('.dsh-stt-trigger'), 60)
  const bar = dom.window.document.querySelector('.dsh-stt-bar')
  if (bar === null) {
    const debug = { root: container.innerHTML.slice(0, 200), body: dom.window.document.body.innerHTML.slice(0, 600), bars: dom.window.document.querySelectorAll('.dsh-stt-bar').length }
    assert.fail(`no bar: ${JSON.stringify(debug)}`)
  }
  await click(dom, bar.querySelector('.dsh-stt-round[data-primary]'), 40)
  const upload = environment.requests.filter((row) => row.url.includes('/stt/transcribe')).at(-1)
  assert.match(upload.url, /language=ja/)
  assert.equal(environment.inserts.length, 1)
  await act(async () => { root.unmount() })
  restore()
  dom.window.close()
})
