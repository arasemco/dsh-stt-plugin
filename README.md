---
description: "Talk instead of typing: dictation in the DSH Web GUI, transcribed by whichever configured model provider serves the OpenAI transcription API."
kind: "package-bundle"
---

# dsh-plugin-stt

Dictation for the DSH Web GUI, built the same way as the TTS plugin in reverse:
the page records, the Host forwards the clip to a **configured model provider**,
and the text that comes back is inserted into the draft where the caret was. The
plugin ships no recognizer and holds no model — it is a thin, discoverable proxy.

## What you get

- **A microphone beside the Listen chip**, with a caret for provider settings —
  click to record, click again to stop and transcribe.
- **A listening bar above the composer** (same slot and width as the TTS player):
  a live waveform of the last seconds, the elapsed time, a round cancel, and a
  round confirm. A bar on screen always means the microphone is open. The wave is
  painted straight onto its columns from a ring buffer, so a recording never
  re-renders React — only `phase`/`elapsed`/`error` ride the store.
- **Provider and model choice** — every provider that accepts transcriptions is
  offered, with all of its models; names that look like speech models lead the
  list, and the choice is remembered per browser.
- **Caret-safe insertion** — the insertion point and draft revision are captured
  when recording *starts*, so anything typed while speaking survives. If the draft
  moved too much the insert is retried at the current caret.
- **Language hint** — `auto` (send nothing, let the model detect) or an explicit
  tag; `auto` by default.

## Requirements

A model provider that implements `POST /audio/transcriptions`. In this deployment
Ollama already does, and `lfm3-audio:latest` / `lfm3-omni:latest` transcribe
correctly:

```sh
curl -s http://192.168.1.48:11434/v1/audio/transcriptions \
  -F model=lfm3-audio:latest -F file=@clip.wav
```

`audio-cpp` answers the same route with a multipart implementation too, but it
needs an ASR model configured in its `server.json` before it can transcribe.

The page needs a **secure origin** for the microphone: loopback
(`http://127.0.0.1:3080`) or HTTPS. A plain `http://192.168.1.48:3080` will refuse
`getUserMedia`.

## Install

```sh
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn /home/agent/workspace/dsh/stt-plugin \
        ~/.dsh/profiles/web/node_modules/dsh-plugin-stt

# profile manifest: "dsh-plugin-stt": "link:/home/agent/workspace/dsh/stt-plugin"

# ~/.dsh/profiles/web/cordis.patch.yml
```

```yaml
- insert:
    - id: stt
      name: dsh-plugin-stt
```

Verify from a shell:

```sh
curl -s http://127.0.0.1:3080/stt/info
```

## Discovery

`GET /stt/info` walks every model provider the **profile configures** (the
adapter's shipped catalog alone is not enough), resolves each endpoint from its
`baseURL` or the adapter's default, and probes the transcription route:

```
<llm.listConfigurableProviders()> + <settings.describe()>  →  configured providers
    → POST {baseURL}/audio/transcriptions   body {}    capability: route exists?
         404/405/501 → not a transcription server, dropped
    → GET  {baseURL}/models                           every model, none filtered
```

Declared capability is used for **ordering** only: providers whose model names
look like speech models (`audio`, `omni`, `whisper`, `asr`, …) lead the list, so a
fresh browser defaults to a provider that can actually transcribe. Failures are
cached for `failureTtlMs`, successes for `discoveryTtlMs`;
`GET /stt/info?refresh=1` re-probes.

`POST /stt/transcribe?server=&model=&language=` takes the WAV body and forwards
it as `multipart/form-data` with `model`, `file`, `response_format=json`, and
`language` when a hint is set. Provider errors are unwrapped from the OpenAI
error envelope and shown in the panel.

## Diagnostics

One bounded event log on the Host (last 200 entries, graded `debug` / `info` /
`warn` / `error`), fed by both halves:

```sh
curl -s 'http://127.0.0.1:3080/stt/log?tail=20'
curl -s 'http://127.0.0.1:3080/stt/log?level=error'
curl -s -X DELETE 'http://127.0.0.1:3080/stt/log'
```

| event | level | carries |
|---|---|---|
| `ready` | info | audio limit, timeout, discovery TTL |
| `provider-unusable` | debug | provider id, endpoint, and why the probe refused |
| `provider-slow` | debug | a probe that timed out; the previous row is kept |
| `no-speech-model` | warn | — nothing accepts transcriptions |
| `transcribed` | info | provider, model, characters, bytes, language, milliseconds |
| `transcription-failed` | error | provider, model, bytes, language, status, message |
| `microphone-denied` | warn | error name and message |
| `microphone-failed` | error | error name and message |
| `insecure-origin` | warn | why `getUserMedia` was unavailable |
| `recorder-failed` | error | why the recorder could not start |
| `transcribed-empty` | warn | bytes (nothing was recognised) |

Entries also go to the Host logger as `[stt] <event> <json>`, and the page
deduplicates repeats for five seconds.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `server` | first discovered | Preferred provider id (the provider key) |
| `model` | first discovered | Preferred model id |
| `language` | unset | Default language hint; unset sends none |
| `endpoints` | `[]` | Extra `{ id, name, baseURL }` providers |
| `discoveryTtlMs` | `15000` | How long a discovery result is reused |
| `failureTtlMs` | `300000` | How long a provider that failed the probe is left alone |
| `maxAudioBytes` | `32 MiB` | Largest accepted recording |
| `timeoutMs` | `300000` | One transcription may take a while on a cold model |

## How it works

```
getUserMedia → MediaRecorder → decodeAudioData → resample to 16 kHz → WAV
   → POST /stt/transcribe → <provider>/audio/transcriptions → text → insert at caret
```

- **The page does the audio work.** It decodes its own recording and resamples it,
  so the Host needs no ffmpeg and the provider receives exactly the 16 kHz mono
  WAV it expects.
- **The Host only forwards.** No model is stored, downloaded, or loaded here; the
  same provider that serves chat can serve speech.
- **Nothing is written to disk.** A clip lives in memory for the round trip.
- **Failure handling.** A refused `getUserMedia`, a `MediaRecorder` the browser
  cannot build, and a provider error all end with the microphone released and the
  panel opened with the reason.

## Tests

```sh
cd /home/agent/workspace/dsh/stt-plugin
npm i --no-save react@18 react-dom@18 jsdom
NODE_ENV=development node --test "test/*.test.mjs"
```

The host suite runs against a fake OpenAI-compatible provider (capability probe,
model listing, multipart shape, error paths). The browser suite stubs
`MediaRecorder`/`AudioContext` and drives a full record → transcribe → insert,
including the caret-retry path.

## Known limitations

- No streaming partial transcripts; the text arrives when you stop.
- The waveform is a level history sampled at 80 ms, not the raw samples, so it is
  an amplitude envelope rather than a true oscilloscope.
- The provider must accept WAV; the page always sends 16-bit mono 16 kHz.
- Which models actually transcribe is the provider's business: a chat model picked
  from the list fails with the provider's own error.
