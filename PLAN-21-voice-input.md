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

#### How to run M0

Spike page: [widget/spike/voice.html](widget/spike/voice.html) (dev only, not in `widget.js`).
Phrases and key terms in [phrases.ts](widget/spike/phrases.ts), grading in
[score.ts](widget/spike/score.ts) (tested in `widget/test/voice-spike.test.ts`).

1. `cd widget && npm run dev`, then open `http://localhost:5173/spike/voice.html`.
2. Enter a device label, allow the mic, press Record on each phrase and read it once, normally.
   The page grades each result (exact / close / wrong, see `score.ts`); fix a grade by hand if
   it's clearly off.
3. Download results (JSON) per browser and keep the files for the findings below.

The mic needs a secure page (localhost or HTTPS), so a phone can't use `http://<laptop-ip>:5173`:
- **Android Chrome:** USB debugging on, `adb reverse tcp:5173 tcp:5173`, then open
  `http://localhost:5173/spike/voice.html` on the phone.
- **iPhone Safari:** needs HTTPS, e.g. an HTTPS tunnel to port 5173. Vite refuses unknown hosts,
  so add the tunnel's host to `server.allowedHosts` locally for the test (don't commit it).
  Siri & Dictation must be on.
- The Claude desktop app's built-in browser blocks the mic, so it can't be used for this test.

Grades rate the key terms only (names, codes, sizes); a wrong filler word doesn't matter because
the shopper sees and edits the text before sending.

**Go if:** in each target browser, at least 8/10 per language are exact or close, and no order
number or coupon code comes out wrong in more than 1 phrase. Otherwise look at server STT.

### M1 · Scope and decisions
- [PRD.md](PRD.md): move dictation out of Non-goals ("speech fills the text box; the shopper
  sends it"); spoken replies stay a non-goal.
- Privacy-notice wording: the browser may send audio to its vendor (Google, Apple) to turn it
  into text; the store never receives or keeps audio. Needs sign-off.
- Decide: live text while speaking (`interimResults`) or only when stopped.

### M2 · Widget: mic button
- `widget/src/voice.ts` next to `photo.ts`: detect support, map locale to language, start/stop,
  60 s limit, silence stop, errors as i18n keys (`errMicDenied`, `errMicNoSpeech`,
  `errMicUnavailable`).
- UI: mic button only when supported and enabled; pulsing state while listening; text appended
  to whatever is already in the input; respect the 2,000-char cap; never auto-send. Stopping
  when the panel closes or the page is hidden.
- Accessibility: keyboard toggle, `aria-pressed`, `aria-label`, `aria-live` status
  ("Listening…", "Stopped"), visible focus, no reliance on colour alone.
- Shadow DOM only; text set as text, never `innerHTML`; no globals beyond `window.ShopChat`.
- Strings in `en.json` and `vi.json`.
- Tests with a fake `SpeechRecognition`: support detection, language, time limit, errors, no
  auto-send, char cap. Check the gzipped bundle stays under 40 KB.

### M3 · Rollout flag
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

1. Live text while speaking, or only after stop?
2. Is "no mic in Firefox" acceptable for v1?
3. Who signs off the privacy wording?
4. Should mic-permission denials and recognition errors be counted too? That needs a small
   widget event, which the widget doesn't send today.
