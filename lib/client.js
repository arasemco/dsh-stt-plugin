/**
 * dsh-plugin-stt — browser half.
 *
 * Dictation for the Web GUI, built the same way as the TTS plugin: the page
 * records with MediaRecorder, converts the clip to 16 kHz mono WAV, and posts it
 * to the Host, which forwards it to a configured model provider. The text that
 * comes back is inserted into the draft at the caret it had when recording
 * started, so edits made while speaking survive.
 *
 * While the microphone is live, a bar above the composer shows a level meter, the
 * elapsed time, and Stop / Cancel — the same place and width as the TTS player,
 * so `the bar is up` always means `something is running`.
 *
 * Hand-authored bundle: `window.__ModuleLoader__.load` registers one factory; the
 * factory receives the shell's baseline `require` (react, react-dom, and the
 * client primitives are baseline modules).
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-stt',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createPortal } = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'stt'
    /** Routes owned by the host half. */
    const ROUTES = { info: '/stt/info', transcribe: '/stt/transcribe' }
    /** Persisted browser preferences. */
    const SETTINGS_KEY = 'dsh.stt.settings.v1'
    /** Rate the transcription endpoints expect. */
    const SAMPLE_RATE = 16000
    /** Most waveform columns kept in the recording bar; the bar shows as many as fit. */
    const WAVE_BARS = 520
    /** Level sampling period; the wave repaints at the same cadence. */
    const LEVEL_INTERVAL_MS = 80

    /* ------------------------------------------------------------------ locale */

    const zh = {
      'trigger': '听写',
      'trigger.start': '开始听写',
      'trigger.stop': '停止并转写',
      'panel.aria': '听写设置',
      'panel.title': '语音输入',
      'recording': '正在录音 {time}',
      'working': '正在转写…',
      'stop': '停止',
      'cancel': '取消',
      'server': '服务',
      'model': '模型',
      'language': '语言',
      'status.ready': '使用 {server} / {model}',
      'status.none': '没有可用的转写服务 — 请先配置一个模型提供方。',
      'status.denied': '麦克风权限被拒绝。',
      'status.insecure': '麦克风需要安全上下文（回环地址或 HTTPS）。',
      'status.empty': '没有识别到语音。',
      'hint': '录音在浏览器内完成，音频发送到本地模型服务。',
    }

    const en = {
      'trigger': 'Dictate',
      'trigger.start': 'Start dictating',
      'trigger.stop': 'Stop and transcribe',
      'panel.aria': 'Dictation settings',
      'panel.title': 'Voice input',
      'recording': 'Listening {time}',
      'working': 'Transcribing…',
      'stop': 'Stop',
      'cancel': 'Cancel',
      'server': 'Server',
      'model': 'Model',
      'language': 'Language',
      'status.ready': 'Using {server} / {model}',
      'status.none': 'No transcription provider — configure one as a model provider.',
      'status.denied': 'Microphone permission was refused.',
      'status.insecure': 'The microphone needs a secure origin (loopback or HTTPS).',
      'status.empty': 'Nothing was recognised.',
      'hint': 'Recording happens in the page; the audio goes to your local model server.',
    }

    /* --------------------------------------------------------------------- css */

    const STYLES = [
      '.dsh-stt-group{display:inline-flex;align-items:center;gap:0}',
      '.dsh-stt-caret{border-radius:var(--dsw-radius-sm);height:28px;width:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:0 0;color:var(--dsw-alias-label-caption);cursor:pointer}',
      '.dsh-stt-caret:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dsh-stt-caret svg{width:12px;height:12px}',
      '.dsh-stt-trigger{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:0 6px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
      '.dsh-stt-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-stt-trigger svg{width:14px;height:14px}',
      '.dsh-stt-trigger[data-recording]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsh-stt-dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;animation:dsh-stt-pulse 1s ease-in-out infinite}',
      '@keyframes dsh-stt-pulse{0%,100%{opacity:1}50%{opacity:.25}}',
      '.dsh-stt-panel{position:fixed;z-index:90;width:352px;max-height:min(72vh,560px);overflow-y:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);box-shadow:0 12px 40px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary);font-size:13px;text-align:left}',
      '.dsh-stt-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-stt-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsh-stt-field{display:flex;flex-direction:column;gap:6px}',
      '.dsh-stt-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-stt-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:148px;overflow-y:auto;padding-right:2px}',
      '.dsh-stt-chip{box-sizing:border-box;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);height:26px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;padding:0 9px}',
      '.dsh-stt-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-stt-chip[data-active]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-stt-action{border-radius:var(--dsw-radius-sm);height:30px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-stt-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-stt-status{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '.dsh-stt-status[data-tone=warn]{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-stt-bar{display:flex;align-items:center;gap:10px;box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));max-width:var(--dsh-composer-card-max-width,952px);margin-inline:auto;padding:6px 10px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;flex:none}',
      '.dsh-stt-bar-spin{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);animation:dsh-stt-spin .8s linear infinite}',
      '@keyframes dsh-stt-spin{to{transform:rotate(360deg)}}',
      '.dsh-stt-bar-label{flex:1;color:var(--dsw-alias-label-secondary);padding-left:2px}',
      '.dsh-stt-wave-host{flex:1;min-width:0;display:flex;align-items:center}',
      '.dsh-stt-wave{display:flex;align-items:center;gap:2px;flex:1;min-width:0;height:24px;overflow:hidden}',
      '.dsh-stt-wave-bar{flex:0 0 2px;min-height:2px;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:height .09s ease-out}',
      '.dsh-stt-time{flex:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:11px;padding:0 4px}',
      '.dsh-stt-round{width:26px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:50%;border:none;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-stt-round:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-stt-round svg{width:13px;height:13px}',
      '.dsh-stt-round[data-primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-stt-round[data-primary]:hover{filter:brightness(1.08)}',
    ].join('')

    /** Inject the plugin stylesheet once per page. */
    function installCss () {
      if (typeof document === 'undefined') return
      const id = 'dsh-plugin-stt/stt.css'
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-stt'
      tag.dataset.pluginCss = id
      tag.textContent = STYLES
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------- store */

    /** Minimal observable store: the shape injected hooks read. */
    function createStore (initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe (listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set (next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Browser preferences for dictation. */
    function createSettingsStore () {
      const fallback = { server: null, model: null, language: 'auto' }
      let initial = fallback
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') {
          initial = {
            server: typeof parsed.server === 'string' ? parsed.server : null,
            model: typeof parsed.model === 'string' ? parsed.model : null,
            language: typeof parsed.language === 'string' ? parsed.language : 'auto',
          }
        }
      } catch { /* session-only preferences */ }
      const store = createStore(initial)
      return {
        ...store,
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        save (patch) {
          store.set({ ...store.getSnapshot(), ...patch })
          try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.getSnapshot()))
          } catch { /* ignore quota/denied storage */ }
        },
      }
    }

    /* -------------------------------------------------------------- selection */

    /**
     * Resolve the provider and model a preference set means against discovery.
     * @param preferences - settings snapshot.
     * @param discovered - `/stt/info` value, or null before it loads.
     * @returns The resolved pair plus the rosters the panel offers.
     */
    function selectionOf (preferences, discovered) {
      const servers = Array.isArray(discovered?.servers) ? discovered.servers : []
      const defaults = discovered?.defaults ?? {}
      const server = servers.find((row) => row.id === preferences.server) ??
        servers.find((row) => row.id === defaults.server) ??
        servers[0] ?? null
      const models = Array.isArray(server?.models) ? server.models : []
      const model = models.find((id) => id === preferences.model) ??
        (typeof defaults.model === 'string' && server?.id === defaults.server ? defaults.model : undefined) ??
        models[0] ?? null
      return { server, model, servers, models, language: preferences.language ?? 'auto' }
    }

    /* ------------------------------------------------------------------- audio */

    /** Format seconds as `m:ss`. */
    function clockOf (seconds) {
      const whole = Math.max(0, Math.round(Number(seconds) || 0))
      return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
    }

    /**
     * Resample mono samples in the page, so the provider receives exactly 16 kHz.
     * @param samples - source samples.
     * @param from - source rate.
     * @param to - target rate.
     * @returns Resampled samples.
     */
    async function resample (samples, from, to) {
      if (from === to) return samples
      const length = Math.max(1, Math.round(samples.length * to / from))
      const offline = new OfflineAudioContext(1, length, to)
      const buffer = offline.createBuffer(1, samples.length, from)
      buffer.copyToChannel(samples, 0)
      const source = offline.createBufferSource()
      source.buffer = buffer
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      return rendered.getChannelData(0)
    }

    /**
     * Wrap mono samples as a 16-bit PCM WAV blob.
     * @param samples - mono samples in [-1, 1].
     * @param rate - sample rate.
     * @returns WAV blob.
     */
    function wavBlob (samples, rate) {
      const bytes = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(bytes)
      const write = (offset, text) => {
        for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
      }
      write(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      write(8, 'WAVE')
      write(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, rate, true)
      view.setUint32(28, rate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      write(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      let offset = 44
      for (let index = 0; index < samples.length; index++, offset += 2) {
        const sample = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      }
      return new Blob([bytes], { type: 'audio/wav' })
    }

    /**
     * Decode one recorded clip into 16 kHz mono WAV.
     * @param blob - whatever MediaRecorder produced.
     * @returns WAV blob ready for the Host.
     */
    async function toWav (blob) {
      const context = new AudioContext()
      let decoded
      try {
        decoded = await context.decodeAudioData(await blob.arrayBuffer())
      } finally {
        void context.close().catch(() => {})
      }
      const mono = new Float32Array(decoded.length)
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel)
        for (let index = 0; index < data.length; index++) mono[index] += data[index] / decoded.numberOfChannels
      }
      const resampled = await resample(mono, decoded.sampleRate, SAMPLE_RATE)
      return wavBlob(resampled, SAMPLE_RATE)
    }

    /* ----------------------------------------------------------------- recorder */

    /* --------------------------------------------------------------- waveform */

    /**
     * Level history shared with the wave without going through React: a fixed
     * ring buffer, written by the microphone loop and read by the paint loop.
     * @param size - capacity in samples.
     * @returns Ring with `push`, `at`, and `reset`.
     */
    function createWave (size) {
      const values = new Float32Array(size)
      let written = 0
      return {
        size,
        /** Append one smoothed level, overwriting the oldest. */
        push (value) {
          values[written % size] = value
          written += 1
        },
        /**
         * Read one column, oldest first.
         * @param index - column position, 0 = oldest visible.
         * @param columns - columns currently drawn.
         * @returns Level in [0, 1]; 0 before enough samples exist.
         */
        at (index, columns) {
          const position = written - columns + index
          if (position < 0) return 0
          return values[position % size]
        },
        /** Forget the history. */
        reset () {
          values.fill(0)
          written = 0
        },
      }
    }

    /* ----------------------------------------------------------------- recorder */

    /**
     * One page-wide microphone: it owns the stream, the recorder, the level
     * history, and the request pipeline, so the composer control and the bar
     * share a single source of truth. Only coarse state (phase, elapsed, error)
     * rides the React store; levels go through {@link createWave} so a recording
     * never re-renders the transcript UI.
     * @param settings - preference store (language).
     * @param info - provider state.
     * @returns Recorder with `start`, `stop`, `cancel`, `state`, `wave`, and `dispose`.
     */
    function createRecorder (settings, info, report) {
      const state = createStore({ phase: 'idle', elapsed: 0, error: null })
      const wave = createWave(WAVE_BARS)
      let stream = null
      let recorder = null
      let chunks = []
      let actions = null
      let span = null
      let draft = ''
      let target = null
      let commit = true
      let startedAt = 0
      let elapsedTimer = null
      let levelTimer = null
      let audioContext = null
      let analyser = null
      let buffer = null
      let smoothed = 0

      /** Publish a patch onto the current state. */
      function publish (patch) {
        const current = state.getSnapshot()
        let changed = false
        for (const [key, value] of Object.entries(patch)) {
          if (current[key] !== value) {
            changed = true
            break
          }
        }
        if (!changed) return
        state.set({ ...current, ...patch })
      }

      /** Release the microphone, the meter, and the timers. */
      function teardown () {
        window.clearInterval(elapsedTimer)
        window.clearInterval(levelTimer)
        elapsedTimer = null
        levelTimer = null
        for (const track of stream?.getTracks?.() ?? []) {
          try { track.stop() } catch { /* already stopped */ }
        }
        stream = null
        analyser = null
        buffer = null
        if (audioContext !== null) void audioContext.close().catch(() => {})
        audioContext = null
        recorder = null
      }

      /** Put the transcript where the caret was when recording began. */
      function insert (text) {
        if (actions === null) return
        const payload = (draft ?? '').trim() === '' || (draft ?? '').endsWith(' ') ? text : ` ${text}`
        if (actions.insertText(payload, span) === false) {
          actions.insertText(payload, actions.captureInsertion())
        }
      }

      /** Transcribe the finished clip and insert its text. */
      async function finish (mime) {
        const blob = new Blob(chunks, { type: mime === '' ? 'audio/webm' : mime })
        const captured = { actions, span, draft, target, commit }
        chunks = []
        teardown()
        wave.reset()
        if (!captured.commit) {
          publish({ phase: 'idle', elapsed: 0 })
          return
        }
        if (blob.size === 0) {
          publish({ phase: 'idle', elapsed: 0, error: 'empty' })
          return
        }
        publish({ phase: 'working' })
        const startedAt = Date.now()
        try {
          const wav = await toWav(blob)
          const ms = Date.now() - startedAt
          const query = new URLSearchParams({ language: captured.target?.language ?? 'auto' })
          if (captured.target?.server) query.set('server', captured.target.server.id)
          if (captured.target?.model) query.set('model', captured.target.model)
          const response = await fetch(`${ROUTES.transcribe}?${query.toString()}`, {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: wav,
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok) throw new Error(payload?.error?.message ?? `transcription failed (${response.status})`)
          const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
          actions = captured.actions
          span = captured.span
          draft = captured.draft
          if (text === '') {
            report?.('warn', 'transcribed-empty', { bytes: wav.size })
            publish({ phase: 'idle', elapsed: 0, error: 'empty' })
          } else {
            report?.('info', 'transcribed', { chars: text.length, bytes: wav.size, ms })
            insert(text)
            publish({ phase: 'idle', elapsed: 0, error: null })
          }
        } catch (error) {
          report?.('error', 'transcription-failed', { message: String(error?.message ?? error).slice(0, 240) })
          publish({ phase: 'idle', elapsed: 0, error: String(error?.message ?? error) })
        }
      }

      /**
       * Open the microphone and start recording.
       * @param options - draft actions, the resolved provider, and the current draft.
       */
      async function start (options) {
        if (state.getSnapshot().phase !== 'idle') return
        publish({ error: null })
        if (navigator.mediaDevices?.getUserMedia === undefined) {
          report?.('warn', 'insecure-origin', { reason: 'getUserMedia is unavailable' })
          publish({ error: 'insecure' })
          return
        }
        let media
        try {
          media = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (error) {
          const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
          report?.(denied ? 'warn' : 'error', denied ? 'microphone-denied' : 'microphone-failed', {
            name: String(error?.name ?? 'Error'),
            message: String(error?.message ?? error).slice(0, 240),
          })
          publish({ error: denied ? 'denied' : String(error?.message ?? error) })
          return
        }
        stream = media
        try {
          audioContext = new AudioContext()
          analyser = audioContext.createAnalyser()
          analyser.fftSize = 1024
          audioContext.createMediaStreamSource(media).connect(analyser)
          buffer = new Float32Array(analyser.fftSize)
        } catch {
          audioContext = null
          analyser = null
        }
        let element
        try {
          element = new MediaRecorder(media)
        } catch (error) {
          for (const track of media.getTracks?.() ?? []) {
            try { track.stop() } catch { /* already stopped */ }
          }
          stream = null
          if (audioContext !== null) void audioContext.close().catch(() => {})
          audioContext = null
          report?.('error', 'recorder-failed', { message: String(error?.message ?? error).slice(0, 240) })
          publish({ error: String(error?.message ?? error) })
          return
        }
        chunks = []
        element.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data)
        }
        element.onstop = () => { void finish(element.mimeType) }
        recorder = element
        actions = options?.actions ?? null
        target = options?.selection ?? null
        draft = options?.draft ?? ''
        span = actions?.captureInsertion?.() ?? null
        commit = true
        startedAt = Date.now()
        smoothed = 0
        wave.reset()
        try {
          element.start()
        } catch (error) {
          teardown()
          wave.reset()
          report?.('error', 'recorder-failed', { message: String(error?.message ?? error).slice(0, 240) })
          publish({ phase: 'idle', elapsed: 0, error: String(error?.message ?? error) })
          return
        }
        publish({ phase: 'recording', elapsed: 0 })
        elapsedTimer = window.setInterval(() => publish({ elapsed: (Date.now() - startedAt) / 1000 }), 250)
        if (analyser !== null && buffer !== null) {
          levelTimer = window.setInterval(() => {
            if (analyser === null || buffer === null) return
            analyser.getFloatTimeDomainData(buffer)
            let sum = 0
            for (let index = 0; index < buffer.length; index++) sum += buffer[index] * buffer[index]
            const level = Math.min(1, Math.max(0, Math.sqrt(sum / buffer.length) * 6))
            /* Smooth towards the sample so single frames do not flicker. */
            smoothed += (level - smoothed) * 0.45
            wave.push(smoothed)
          }, LEVEL_INTERVAL_MS)
        }
      }

      /** Stop and transcribe. */
      function stop () {
        if (recorder === null) return
        commit = true
        if (recorder.state !== 'inactive') recorder.stop()
        else void finish(recorder.mimeType)
      }

      /** Stop and discard. */
      function cancel () {
        if (recorder === null) return
        commit = false
        if (recorder.state !== 'inactive') recorder.stop()
        else {
          teardown()
          wave.reset()
          publish({ phase: 'idle', elapsed: 0 })
        }
      }

      return { state, wave, start, stop, cancel, dispose: () => { commit = false; stop() } }
    }

    /* -------------------------------------------------------------- components */

    /** Subscriber hook over one injected observable. */
    function useValue (useSnapshot) {
      return useSnapshot((value) => value)
    }

    /**
     * The waveform itself: a stable set of two-pixel columns whose heights are
     * written directly, so a recording never re-renders React. It repaints at the
     * sampling cadence (not per frame) and only writes heights that changed.
     * @param props - `columns` to draw, the shared `wave`, and whether it is live.
     * @returns The wave row.
     */
    function Wave ({ columns, wave, live }) {
      const rowRef = React.useRef(null)

      React.useEffect(() => {
        const row = rowRef.current
        if (row === null || !live) return undefined
        let timer = null
        let painted = false
        const paint = () => {
          timer = window.setTimeout(paint, LEVEL_INTERVAL_MS)
          if (document.visibilityState === 'hidden') return
          const bars = row.children
          const count = bars.length
          for (let index = 0; index < count; index++) {
            const height = `${Math.round(6 + Math.min(1, Math.max(0, wave.at(index, count))) * 94)}%`
            const bar = bars[index]
            if (bar.style.height !== height) bar.style.height = height
          }
          painted = true
        }
        paint()
        return () => {
          if (timer !== null) window.clearTimeout(timer)
          if (painted) for (const bar of row.children) bar.style.height = ''
        }
      }, [live, wave, columns])

      return h('div', { ref: rowRef, className: 'dsh-stt-wave', 'aria-hidden': true },
        Array.from({ length: columns }, (_, index) => h('span', { key: index, className: 'dsh-stt-wave-bar' })))
    }

    /**
     * The bar above the composer: cancel, a live waveform of the last few
     * seconds, the elapsed time, and a confirm button that transcribes.
     * @param props - composed slot props.
     * @returns The bar, or null when nothing is running.
     */
    function ListeningBar ({ useSttRecorder, t, wave, stop, cancel }) {
      const state = useValue(useSttRecorder)
      const [columns, setColumns] = React.useState(120)
      const waveRef = React.useRef(null)
      const live = state.phase === 'recording'

      /* One column per ~4px, measured whenever the bar appears or the row resizes. */
      React.useEffect(() => {
        const element = waveRef.current
        if (element === null) return undefined
        const measure = () => {
          const width = element.clientWidth
          if (width > 0) setColumns(Math.max(24, Math.min(WAVE_BARS, Math.floor((width + 2) / 4))))
        }
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [state.phase])

      /* The wave subtree survives elapsed ticks: same element, same props. */
      const waveNode = React.useMemo(
        () => h(Wave, { columns, wave, live }),
        [columns, wave, live],
      )

      if (state.phase === 'idle') return null
      return h('div', {
        className: 'dsh-stt-bar',
        'data-phase': state.phase,
        'data-dsh-tts-ignore': '',
        role: 'status',
        'aria-live': 'polite',
      }, [
        live
          ? h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dsh-stt-round',
            'aria-label': t('cancel'),
            title: t('cancel'),
            onClick: cancel,
          }, h(primitives.IconCloseOutlineRegular, {}))
          : null,
        h('div', { key: 'wave-host', ref: waveRef, className: 'dsh-stt-wave-host' },
          live ? waveNode : h('span', { className: 'dsh-stt-bar-label' }, t('working'))),
        live ? h('span', { key: 'time', className: 'dsh-stt-time' }, clockOf(state.elapsed)) : null,
        live
          ? h('button', {
            key: 'stop',
            type: 'button',
            className: 'dsh-stt-round',
            'data-primary': '',
            'aria-label': t('stop'),
            title: t('trigger.stop'),
            onClick: stop,
          }, h(primitives.IconCheckOutlineRegular, {}))
          : h('span', { key: 'spin', className: 'dsh-stt-bar-spin', 'aria-hidden': true }),
      ])
    }

    /**
     * Composer microphone: opens the recorder, and hosts provider/model choices.
     * @param props - composed slot props.
     * @returns The trigger plus, while open, the dictation panel.
     */
    function DictateControl (props) {
      const { t, inputActions, useInput, useSttRecorder, updateSettings, useSttSettings, refresh, useSttInfo, start, stop } = props
      const recorder = useValue(useSttRecorder)
      const settings = useValue(useSttSettings)
      const info = useValue(useSttInfo)
      const draft = useInput((state) => state.draft)
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const panelId = React.useId()
      const selection = selectionOf(settings, info)
      const liveRef = React.useRef({ selection, draft, inputActions, info })
      liveRef.current = { selection, draft, inputActions, info }
      const refreshRef = React.useRef(refresh)
      refreshRef.current = refresh

      React.useEffect(() => {
        if (open) refreshRef.current()
      }, [open])

      /* A failed take has no bar to report in, so open the panel for it. */
      React.useEffect(() => {
        if (recorder.error !== null && recorder.error !== undefined) setOpen(true)
      }, [recorder.error])

      React.useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const anchor = triggerRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const width = 352
          const margin = 12
          const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin))
          setPosition({ left, bottom: Math.max(margin, window.innerHeight - rect.top + 8) })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return
          if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const errorText = (() => {
        const error = recorder.error
        if (error === null || error === undefined) return null
        if (error === 'denied') return t('status.denied')
        if (error === 'insecure') return t('status.insecure')
        if (error === 'empty') return t('status.empty')
        return String(error)
      })()

      const summary = selection.server !== null && selection.model !== null
        ? t('status.ready', { server: selection.server.name ?? selection.server.id, model: selection.model })
        : t('status.none')

      const chip = (label, active, onClick, key) => h('button', {
        key,
        type: 'button',
        className: 'dsh-stt-chip',
        title: label,
        'aria-pressed': active,
        'data-active': active ? '' : undefined,
        onClick,
      }, label)

      const panel = open && position !== null
        ? createPortal(h('div', {
          ref: panelRef,
          id: panelId,
          className: 'dsh-stt-panel',
          style: position,
          role: 'dialog',
          'aria-label': t('panel.aria'),
        }, [
          h('div', { key: 'title', className: 'dsh-stt-title' }, t('panel.title')),
          h('div', { key: 'state', className: 'dsh-stt-label' }, summary),
          selection.servers.length > 1
            ? h('div', { key: 'servers', className: 'dsh-stt-field' }, [
              h('span', { key: 'label', className: 'dsh-stt-label' }, t('server')),
              h('div', { key: 'chips', className: 'dsh-stt-chips' }, selection.servers.map((server) =>
                chip(server.name ?? server.id, server.id === selection.server?.id, () => updateSettings({ server: server.id, model: null }), server.id))),
            ])
            : null,
          selection.models.length > 0
            ? h('div', { key: 'models', className: 'dsh-stt-field' }, [
              h('span', { key: 'label', className: 'dsh-stt-label' }, t('model')),
              h('div', { key: 'chips', className: 'dsh-stt-chips' }, selection.models.map((model) =>
                chip(model, model === selection.model, () => updateSettings({ model }), model))),
            ])
            : null,
          h('div', { key: 'language', className: 'dsh-stt-field' }, [
            h('span', { key: 'label', className: 'dsh-stt-label' }, t('language')),
            h('div', { key: 'chips', className: 'dsh-stt-chips' }, (info.languages ?? ['auto']).map((language) =>
              chip(language, language === selection.language, () => updateSettings({ language }), language))),
          ]),
          h('div', { key: 'status', className: 'dsh-stt-status', 'data-tone': errorText === null ? undefined : 'warn' },
            errorText ?? summary),
          h('div', { key: 'hint', className: 'dsh-stt-status' }, t('hint')),
        ]), document.body)
        : null

      const recording = recorder.phase === 'recording'
      return h('div', { key: 'group', className: 'dsh-stt-group' }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'dsh-stt-trigger',
          'data-recording': recording ? '' : undefined,
          title: recording ? t('trigger.stop') : t('trigger.start'),
          onClick: () => {
            if (recording) {
              stop()
              return
            }
            const live = liveRef.current
            if (live.selection.server === null || live.selection.model === null) {
              setOpen(true)
              return
            }
            void start({ actions: live.inputActions, selection: live.selection, draft: live.draft })
          },
        }, [
          recording
            ? h('span', { key: 'dot', className: 'dsh-stt-dot' })
            : h(primitives.IconMicrophoneOutlineRegular, { key: 'icon' }),
          h('span', { key: 'label' }, recording ? clockOf(recorder.elapsed) : t('trigger')),
        ]),
        h('button', {
          key: 'caret',
          type: 'button',
          className: 'dsh-stt-caret',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': open ? panelId : undefined,
          'aria-label': t('panel.title'),
          title: t('panel.title'),
          onClick: () => setOpen(!open),
        }, h(primitives.IconChevronDownOutlineRegular, {})),
        panel,
      ])
    }

    /* ------------------------------------------------------------------ plugin */

    /** Required client services: slots and dictionaries. */
    const inject = ['slots', 'locale']

    /**
     * Mount the dictation surfaces.
     * @param ctx - client root context.
     */
    function apply (ctx) {
      installCss()
      const settings = createSettingsStore()
      const info = createStore({ servers: [], defaults: { server: null, model: null }, languages: ['auto'] })
      /** Repeat suppression for noisy events. */
      const recent = new Map()
      const report = (level, event, detail) => {
        const key = `${event}|${JSON.stringify(detail ?? {}).slice(0, 96)}`
        const now = Date.now()
        const seen = recent.get(key)
        if (seen !== undefined && now - seen < 5000) return
        recent.set(key, now)
        if (recent.size > 64) recent.clear()
        if (level === 'error') console.warn('[stt]', event, detail)
        else console.debug('[stt]', event, detail)
        void fetch('/stt/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level, event, detail }),
        }).catch(() => {})
      }
      const recorder = createRecorder(settings, info, report)

      /**
       * Read provider state from the Host.
       * @param force - ask the Host to re-probe its providers, not serve its cache.
       */
      const refresh = async (force = false) => {
        try {
          const response = await fetch(force ? `${ROUTES.info}?refresh=1` : ROUTES.info, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`/stt/info answered ${response.status}`)
          info.set(await response.json())
        } catch (error) {
          info.set({ ...info.getSnapshot(), error: String(error?.message ?? error) })
        }
      }

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-plugin-stt: dictionaries')
      ctx.effect(() => () => recorder.dispose(), 'dsh-plugin-stt: microphone lifetime')
      /* A page load is a hard refresh: probe the providers again. */
      void refresh(true)

      const sttInfo = { getSnapshot: info.getSnapshot, subscribe: info.subscribe }
      const sttSettings = { getSnapshot: settings.getSnapshot, subscribe: settings.subscribe }
      const sttRecorder = { getSnapshot: recorder.state.getSnapshot, subscribe: recorder.state.subscribe }

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'stt-listening',
        order: 30,
        locale: NS,
        inject: () => ({
          hooks: { sttRecorder },
          wave: recorder.wave,
          stop: () => recorder.stop(),
          cancel: () => recorder.cancel(),
        }),
      }, ListeningBar), 'dsh-plugin-stt: listening bar')

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'stt-dictate',
        order: 55,
        locale: NS,
        inject: () => ({
          hooks: { sttInfo, sttSettings, sttRecorder },
          updateSettings: (patch) => settings.save(patch),
          refresh,
          start: (options) => recorder.start(options),
          stop: () => recorder.stop(),
        }),
      }, DictateControl), 'dsh-plugin-stt: dictation control')
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      apply,
      clockOf,
      createRecorder,
      createSettingsStore,
      createStore,
      selectionOf,
      toWav,
      wavBlob,
    }
    return module.exports
  },
})
