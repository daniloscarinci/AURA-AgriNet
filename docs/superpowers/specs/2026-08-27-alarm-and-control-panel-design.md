# An alarm that reports what it did, a second tone under it, and one panel for the controls

2026-08-27

Three changes. The alarm is audited and four defects in it are fixed; a second,
quieter tone is added under the critical one; and the controls, which are spread
across four surfaces today, gain a single panel that reaches all of them.

## 1. What the audit found

The alarm was booted headlessly with a recording Web Audio stub — the shipped
inline script, run through `tests/harness.js`, with `window.AudioContext` set to
a class that records every node, connection and scheduled parameter instead of
making a sound.

The motif itself is correct. Seven oscillators: a 146.8 Hz sine body plus three
triangle pulses each carrying its own fifth. All seven reach `destination`, no
`exponentialRampToValueAtTime` is handed a zero, the span is 0.66 s and the peak
summed gain is 0.846. Mute stops it, mute survives a restart, and a restored
transcript does not replay it. Those properties are kept.

Four things are wrong.

### 1.1 `fire()` reports success it cannot know

`fire()` returns `true` for every case that is not mute. On a backgrounded iOS
PWA the system suspends the context; `resume()` then rejects outside a user
gesture, `.catch(() => {})` at `index.html:3327` swallows the rejection, and
**zero oscillators are scheduled** — while the caller is told the alarm sounded.

The same `true` is returned by an engine with no Web Audio *and* no vibration
motor, where literally nothing happened.

### 1.2 Two criticals close together clip and cut each other

Two fires 100 ms apart schedule 14 oscillators against one `destination` with no
gain stage between them. Peak summed gain reaches **1.373** at t=0.460, which
clips. The second `navigator.vibrate` call also cancels the first pattern
mid-rhythm, so the buzz that was carrying the alarm's identity is truncated.

Reachable: two rules can arm from the Manual panel in the same interaction.

### 1.3 `unlock` is bound once and never re-arms

`index.html:9042` binds `Alarm.unlock` with `{ once: true }`. After the first
gesture the listener is gone. Once the system re-suspends the context — the app
backgrounded, the screen locked, another app taking audio — nothing revives it
except `fire()`, which runs outside a gesture, which is exactly where iOS
refuses. The alarm is then silent for the rest of the session.

### 1.4 The audio graph has never been executed by a test

`tests/harness.js:356` builds a sandbox with no `AudioContext`, so `context()`
returns `null` in every test and `play()` has never run. The six existing alarm
checks test the decision — which messages fire, whether mute holds — and none
test the sound.

The harness also ignores the options argument to `addEventListener`, so
`{ once: true }` behaves as a permanent listener under test. Defect 1.3 could
not have been observed even by a test that looked for it.

## 2. The alarm, fixed

### 2.1 A master gain

Every voice connects to `destination` directly today, so there is no single
place to scale a tone or duck an overlapping one. A `master` GainNode is built
with the context and every voice connects through it.

This is not decoration. It is what makes 2.3 expressible at all.

### 2.2 Two tones, one family

`critical` keeps its motif unchanged: D5, D5, A5 over the low body, 0.66 s.

`serious` gets a new one: **D5 → A4 — the same fifth, falling.** 0.34 s, peak
gain 0.40, no low body, vibration `[60, 60, 110]`.

Critical lifts to the fifth above; serious drops to the fifth below. One
interval, two directions: a relationship a listener learns once and then reads
without thinking about it. The serious tone is shorter, quieter and bodiless,
so it is audibly the subordinate of the two rather than a second emergency.

`warning` and `good` stay silent. The argument at `index.html:3237` still holds
— an alarm that fires for advisories is one the reader learns to ignore — and
two tones is the most that argument tolerates.

`Alarm.toneFor(msg)` returns `'critical'`, `'serious'` or `null`, and
`shouldFire(msg)` becomes `toneFor(msg) !== null`. A message the reader typed
(`mine`) still fires nothing.

### 2.3 Coalescing

The module tracks `busyUntil` in context time. A tone arriving while another is
sounding is scheduled at `busyUntil + 0.12` rather than on top of it. If that
start would fall more than 1.5 s ahead of now, the tone is dropped instead of
queued, so a burst of ten criticals does not commit ten motifs.

The buzz follows the same rule against a wall-clock `vibeUntil`: a vibration
that would land inside a running pattern is skipped rather than restarting it.

Peak summed gain for two fires 100 ms apart must then match the single-fire
figure, 0.846. That number is the regression test.

### 2.4 An honest return

`fire()` stops returning a boolean and returns what happened:

| Token | Meaning |
|---|---|
| `'muted'` | the reader silenced it |
| `'silent'` | no Web Audio and no motor — nothing happened at all |
| `'buzzed'` | vibration only; no audio engine |
| `'coalesced'` | dropped because a tone was already sounding |
| `'waking'` | a suspended context was asked to resume; the tone follows if it does |
| `'played'` | scheduled against a running context |

`'muted'` is the only value callers currently treat as failure, so the two
existing assertions become `equal(..., 'muted')` and `notEqual(..., 'muted')`.

When a `'waking'` resume is refused, one line goes to the Event Log: *"Alert
sound blocked — tap the screen to allow it."* A grower whose phone silently
refused audio has no way to learn that today.

### 2.5 Re-arming

`unlock` binds to `pointerdown` and `keydown` permanently rather than once, and
additionally to `visibilitychange` when the page becomes visible. It returns
early when the context is already running, so the cost of the permanent binding
is one property read per gesture.

This is the fix that actually recovers a backgrounded iOS PWA: the reader's next
tap resumes the context, and the alarm works again for the rest of the session.

## 3. The control panel

### 3.1 What it replaces

Controls sit in four places today: the header (role, place, language, theme,
farm, manual), the Ops panel (pause, speed, triggers), the console head (mute,
channels, persona) and a mobile-only sheet behind the FAB.

The panel **replaces `#simSheet`**, which is mobile-only and framed as "Event
Simulation" — too narrow a name for the controls it already holds and far too
narrow for the ones being added. The header and console controls stay exactly
where they are: the panel reaches the same state, it does not move buttons that
readers have already learned.

The location search moves into the panel keeping its ids — `placeSearchM`,
`placeResultsM`, `placeGeoM` — so `Search` needs no change at all.

### 3.2 Getting to it

- `#btnPanel` in the header, beside the manual button.
- `#fabSim` on mobile, which stops opening the deleted sheet.
- `Ctrl/⌘ + K`, and never while the reader is typing into the chat.
- `?` is unchanged and still opens the manual.
- `Escape` closes the innermost layer: manual, then panel.

It reuses the existing `.sheet` machinery — scrim, bottom sheet, focus trap — so
on a phone it behaves exactly like the sheets already there. One desktop rule
centres it and caps its width, because a bottom sheet on a 1440px screen is a
sheet in the wrong place.

### 3.3 Sections

**Feed** — pause/resume, speed, sync now.

**Alerts** — alarm on/off (the same state `#btnMute` writes), vibration on/off,
and **Test it**, which plays the critical motif on demand.

Test it is the part that answers the question this work started from. The alarm
is verifiable by a person holding the phone, not only by a stub in a test
harness. It also doubles as the gesture that unlocks audio, so a reader who
presses it has armed the alarm for the session by pressing it.

**Simulate** — the trigger buttons, mounted through the existing
`Views.renderTriggers` list at `index.html:4944` so a third mount point cannot
drift from the other two, plus a Clear all that releases armed alerts.

**View** — theme, language, your farm, manual. Each opens the surface that
already exists.

**Data** — `Live.statusLine()`, refresh, clear transcript, reset everything.

### 3.4 Reset

Two-step, in place. The button becomes *"Really? this clears everything"* over
Yes and Cancel, and reverts on its own after 5 s. No dialog and no new markup
layer; the row states what it destroys at the moment that matters.

It clears the state snapshot, the transcript, the farm answers, the language and
the theme — `State.STORE_KEY`, `I18n.STORE_KEY`, `Theme.STORE_KEY` — then
reloads.

### 3.5 State

`State.data` gains `haptics: true`, saved and restored beside `muted`. Both are
read by the panel and by `Alarm.fire`.

## 4. Tests

`tests/harness.js` gains two things it lacks:

- a recording `AudioContext` on the sandbox, so `play()` executes under test for
  the first time;
- honouring of `{ once: true }` in `addEventListener`, so a listener bound once
  can be told apart from one bound permanently.

Neither is a convenience. Without the first, section 2 is unverifiable; without
the second, defect 1.3 is unobservable.

**`controls · the alarm sounds`** — every voice reaches `destination` through
the master gain; peak summed gain stays below 1.0 for one fire and equals it for
two fires 100 ms apart; the two tones differ in length, peak gain and direction;
a suspended context is resumed before anything is scheduled; `fire()` returns
each of its tokens in the condition that earns it; `unlock` survives a first
gesture and resumes a re-suspended context on a second; a vibration is not
restarted inside a running pattern.

**`controls · the control panel`** — every id the module references exists in
the markup; it opens from the header button, the FAB and the shortcut, and
closes on Escape; its toggles report restored state rather than the markup's
defaults; one click on reset does not clear the store; nothing in the file still
references the deleted sheet.

## 5. The pack

`sw.js` `CACHE_VERSION` moves `aura-v24` → `aura-v25`. An installed copy serves
the old cache until a new version activates, so without this the work ships
nothing.

`android/app/build.gradle.kts` moves `versionCode` 1 → 2 and `versionName`
`"1.0"` → `"1.1"`. `./gradlew assembleDebug` then writes
`android/AURA-AgriNet-1.1-debug.apk`; the stale 1.0 binary is deleted rather
than left beside it, for the reason the gradle file already gives about buried
outputs — a stale binary that looks current is worse than none.

README gains the panel and the two tones.

## 6. Constraints this work is written under

**Translations land with the string.** Every new English string carries its
`es`, `fr` and `pt` entries in the same commit. The i18n coverage check fails on
the commit that adds an untranslated string, not a later one.

**Tailwind is prebuilt.** There is no build step, so a new utility class does
nothing at all. The panel is styled with real CSS and the existing `.btn`,
`.toggle` and `.panel` classes.
