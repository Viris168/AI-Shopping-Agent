# Plan 21 · Voice input (mic in chat)

Components: `widget`, `agent-service` (config and metrics only), docs. No `commerce-api` change.
Reuses the PLAN-20 rollout pattern (own percentage, kill switch, dashboard row).

## Goal

Let a shopper speak a message instead of typing it. The mic turns speech into text in the input
box; the shopper checks or edits it and presses Send. From there it is an ordinary typed message.

**Done when:** supported browsers show a mic button; speech fills the input in English and
Vietnamese; nothing is ever sent without the shopper pressing Send; the widget stays under 40 KB
gzipped; we never receive or store audio.

## What exists today

| Area | Today |
|---|---|
| PRD | "Voice, email or social-media channels" is a v1 non-goal ([PRD.md](PRD.md)) |
| Widget | Text composer + photo button ([photo.ts](widget/src/photo.ts)); ~14.8 KB gzipped of a 40 KB budget |
| Languages | `en`, `vi` ([widget/src/i18n](widget/src/i18n)) |
| Chat request | JSON `{conversationId, message, locale, image?}`; 2,000 chars ([guardrails.py](agent-service/app/guardrails.py)) |
| Rollout | `/v1/config` sends `enabled`, `rolloutPercent`, `imagesEnabled`, `imagesRolloutPercent`; fixed per-browser bucket ([rollout.ts](widget/src/rollout.ts)) |
| Models | DeepSeek via the Anthropic SDK; neither does speech-to-text |

## Decisions

| Decision | Choice | Why |
|---|---|---|
| What voice is | **Dictation only:** speech fills the input box; the shopper sends it | No new trust level, no new agent path. The text goes through the same guardrails, limits and evals as typed text. Not a "voice channel" (no spoken replies) |
| Speech engine | **Browser Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition`) | No backend, no new provider, key or bill (PLAN-19), tiny bundle cost |
| Not chosen (yet): record + server STT | See [Later](#later--server-side-speech-to-text) | Needs a new vendor, an upload endpoint, caps and cost tracking. Only worth it if M0 or M5 shows browser accuracy or coverage isn't good enough |
| Auto-send | **Never** | Speech recognition makes mistakes (names, order numbers); the shopper must see and confirm the text |
| Unsupported browsers | Hide the button (Firefox today) | Progressive enhancement; typing still works |
| Language | From the widget's locale: `en` → `en-US`, `vi` → `vi-VN` | Setting the language improves accuracy a lot |
| Live text | **Yes:** words appear in the input as the shopper talks (`interimResults`), then settle; text-at-end where the browser can't (decided in M1) | Shows the mic is hearing them, and they can stop early if it's going wrong |
| Time limit | 60 s per recording, then stop automatically | Keeps the text under the 2,000-char cap and avoids a forgotten open mic |
| Audio storage | **None.** We never receive audio; the browser vendor may process it | Privacy notice must say so (M1) |
| Server signal | Chat request may carry `via: "voice"` (whitelisted, optional) | Lets us count voice messages and compare outcomes without storing anything new |
| Rollout | `VOICE_ENABLED` + Redis `flag:voice_enabled`, `VOICE_ROLLOUT_PERCENT` / `flag:voice_rollout_percent`; off by default | Same pattern as photos |

## Flow

```
widget: mic button (supported + flag on + bucket < voiceRolloutPercent)
  tap → browser asks for mic permission → SpeechRecognition(lang from locale)
  listening (pulsing button, aria-live "Listening…") → text into the input box
  stop: tap again, silence, or 60 s
  shopper edits → Send
  POST /v1/chat {conversationId, message, locale, via: "voice"}
agent-service: normal turn (unchanged); counts agent.voice_messages
```

## Milestones

### M0 · Spike: is browser speech good enough?
- About 20 test phrases in English and Vietnamese, including product names, order numbers
  (`ORD-1001`) and coupon codes (`SAVE20`, `WELCOME10`).
- Try them in desktop Chrome and Edge, Safari on iPhone, and Chrome on Android. Record accuracy
  (exact / close / wrong), delay, and support (`interimResults`, `continuous`).
- **Result:** go or no-go on the browser approach. If Vietnamese or codes are poor, plan the
  [server version](#later--server-side-speech-to-text) instead.

### M1 · Scope and decisions
- [PRD.md](PRD.md): move dictation out of Non-goals ("speech fills the text box; the shopper
  sends it"); spoken replies stay a non-goal.
- Privacy-notice wording: the browser may send audio to its vendor (Google, Apple) to turn it
  into text; the store never receives or keeps audio. Needs sign-off.
- Decide: live text while speaking (`interimResults`) or only when stopped.

**Status (2026-11-14, branch `voice-m1-scope`): done except sign-off.**
- PRD: the non-goal is now "spoken replies, phone, email or social-media channels"; new user
  story (*Input*), requirement F16 (Could) and a Privacy line for dictation.
- Live text: **yes**, falling back to text-at-end where `interimResults` isn't supported.
- Draft wording below, for the privacy notice and the widget. It covers the browser engine only;
  if we move to [server STT](#later--server-side-speech-to-text) it must name that provider.

Privacy notice (storefront privacy page, new paragraph):

> **Voice input in chat.** If you use the microphone button in the chat assistant, your browser
> turns your speech into text. Depending on your browser, the browser maker (for example Google
> or Apple) may do this under its own privacy terms. We never receive or store your recordings.
> We only receive the text you choose to send, which we handle like any message you type.

Widget, shown once under the input the first time the shopper presses the mic (`voiceHint`):

| Locale | Text |
|---|---|
| `en` | Your browser turns speech into text. We never get the audio. |
| `vi` | Trình duyệt của bạn chuyển giọng nói thành chữ. Chúng tôi không nhận bản ghi âm. |

**Left for the user:**
1. Sign-off on the privacy-notice paragraph (with the rest of the notice; PRD §7).
2. A native speaker checks the Vietnamese hint.

### M2 · Widget: mic button
- `widget/src/voice.ts` next to `photo.ts`: detect support, map locale to language, start/stop,
  60 s limit, silence stop, errors as i18n keys (`errMicDenied`, `errMicNoSpeech`,
  `errMicUnavailable`).
- UI: mic button only when supported and enabled; pulsing state while listening; live text in
  the input as the shopper talks (the input is read-only while listening, so typing can't clash
  with it), editable again on stop; text appended to whatever is already in the input; the
  `voiceHint` line (M1) the first time; respect the 2,000-char cap; never auto-send. Stopping
  when the panel closes or the page is hidden.
- Accessibility: keyboard toggle, `aria-pressed`, `aria-label`, `aria-live` status
  ("Listening…", "Stopped"), visible focus, no reliance on colour alone.
- Shadow DOM only; text set as text, never `innerHTML`; no globals beyond `window.ShopChat`.
- Strings in `en.json` and `vi.json`.
- Tests with a fake `SpeechRecognition`: support detection, language, time limit, errors, no
  auto-send, char cap. Check the gzipped bundle stays under 40 KB.

**Status (2026-11-14, branch `voice-m2-widget`, on top of the photo work in #52): done.**
- [voice.ts](widget/src/voice.ts): finds the recognizer (`SpeechRecognition` or the `webkit`
  one; none → no button), `en` → `en-US`, `vi` → `vi-VN`, live text, 60 s limit, browser errors
  → `errMicDenied` / `errMicNoSpeech` / `errMicUnavailable`. The text is rebuilt from the whole
  result list on every update, because Chrome on Android can send finished results again and
  adding them up would double the text.
- [composer.ts](widget/src/ui/composer.ts): mic between the input and Send (after the photo
  button when photos are on). Toggle with `aria-pressed`; one status line for photo and voice;
  input read-only while listening; Enter while listening stops instead of sending; typed text is
  kept and dictation goes after it; `voiceHint` the first time (remembered in `localStorage`, shown
  every time if storage is blocked). Stops without moving focus when the panel closes or the tab
  is hidden.
- Styles: filled, outlined button while listening (not colour alone); the pulse stops under
  reduced motion; read-only input greyed.
- 7 strings in `en.json` / `vi.json`. The Vietnamese is a draft: native check, with M1's hint.
- Also the **widget half of M3**: `RolloutConfig` reads `voiceEnabled` / `voiceRolloutPercent`,
  and `voiceOn` uses the same bucket and staff opt-in as photos (shared `featureOn`). agent-service
  doesn't send these yet, so the mic stays hidden everywhere until M3's server side lands.
- Tests: `widget/test/voice.test.ts` (14, fake recognizer) and `voiceOn` in `rollout.test.ts`;
  72 widget tests pass. Bundle 15.8 KB gzipped (+~1 KB).
- Checked in the browser pane with a stubbed `/v1/config`: mic placement with and without photos,
  live text, stop, phone width, and the real recognizer with the mic blocked (shows
  `errMicDenied`). A real spoken test still needs a person (M0 page or the demo store).

### M3 · Rollout flag
The widget side was done in M2; what's left is agent-service and deploy.

**Status (2026-11-14, branch `voice-m3-flag`): done.** `VOICE_ENABLED` (default `false`) and
`VOICE_ROLLOUT_PERCENT` (default `100`) in [config.py](agent-service/app/config.py); Redis
`flag:voice_enabled` (off only) and `flag:voice_rollout_percent` (moves it), read through
`feature_active` / `feature_rollout` in [main.py](agent-service/app/main.py), now shared with
photos. `/v1/config` sends `voiceEnabled` and `voiceRolloutPercent` (0 when off; the whole
assistant off wins). No `/v1/chat` change: dictated text is ordinary text. Deploy passes both
(production `0`, staging `100`); `.env.example`, `infra/README.md`, ARCHITECTURE env table and
the ARCHITECTURE-ESSENTIAL limits line updated. Tests in `tests/test_telemetry.py`; 270 pass,
ruff and mypy clean. The runbook section (`infra/monitoring/README.md#voice`) is M5.
- agent-service: `voice_enabled`, `voice_rollout_percent` in config and Redis flags; send
  `voiceEnabled`, `voiceRolloutPercent` in `GET /v1/config`.
- Widget: extend `RolloutConfig` in [rollout.ts](widget/src/rollout.ts); same bucket as photos;
  opted-in staff (`?shopchat=on`) always see the button; the kill switch wins.
- Deploy: `compose.yml` and `_deploy.yml` pass `VOICE_ENABLED` (default `false`) and
  `VOICE_ROLLOUT_PERCENT` (production `0`, staging `100`).

### M4 · Measuring use
- Chat request accepts optional `via: "voice"` (whitelisted enum; anything else refused).
  agent-service counts `agent.voice_messages`. The text is handled exactly like typed text.
- Dashboard row *Voice*: voice messages vs. all, and turn outcomes (handoff, feedback) for voice
  vs. typed, to spot recognition problems.

### M5 · Rollout
- Staging with `VOICE_ENABLED=true`, then staff preview, then production at 5 / 25 / 100%.
- Watch the voice share and whether voice turns get more thumbs-down or "didn't understand"
  replies than typed ones.
- Runbook section in `infra/monitoring/README.md#voice`: steps and kill switch.

## Order

M0 → M1 → M2 → M3 → M4 → M5. M3 and M4 can be built alongside M2. M0 decides whether the
browser approach goes ahead.

## Later · Server-side speech-to-text

Only if M0 or M5 shows browser accuracy or coverage isn't good enough. If it goes ahead:

1. Widget records with `MediaRecorder` (adds Firefox), max 60 s, and uploads after stop.
2. `POST /v1/transcribe` in agent-service: chat token required; size and duration limits; rate
   limit and daily cap (like photos); returns text only, which goes into the input box.
3. Audio lives only for the request: never written to Redis, Postgres, logs or traces.
4. Provider called asynchronously through a client module with timeouts; model and key from
   config; cost tracked with a `purpose=transcribe` label (PLAN-19).
5. Language hint from the locale; product names and codes as a vocabulary hint if supported.

Needs: a provider choice and account, a new secret, privacy wording updated to name it.

## Docs to update

- [PRD.md](PRD.md): dictation in scope; privacy-notice wording.
- [ARCHITECTURE-ESSENTIAL.md](ARCHITECTURE-ESSENTIAL.md): voice limit (60 s) and the flag.
- [ARCHITECTURE.md](ARCHITECTURE.md): `via` field, `/v1/config` fields, rollout.
- `widget` README: mic button, browser support.

## Open questions

1. ~~Live text while speaking, or only after stop?~~ Live text (M1).
2. Is "no mic in Firefox" acceptable for v1?
3. Who signs off the privacy wording?
4. Should mic-permission denials and recognition errors be counted too? That needs a small
   widget event, which the widget doesn't send today.
