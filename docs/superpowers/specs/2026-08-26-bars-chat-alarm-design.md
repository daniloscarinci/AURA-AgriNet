# Frosted bars, a chat that keeps what you send, and an alarm for critical traffic

2026-08-26

Three changes to the Android package, and the web app underneath it: two
translucent bars, three chat defects, and an audible warning for critical
messages.

## 1. The bars

The header and the mobile tab bar become light frosted glass, so page content
blurs beneath them instead of stopping at their edge.

### What was tried before

This is the third attempt. `index.html:585` and `index.html:598` record the
first two and why they were reverted: at 92% alpha the harvest card's 40px
"Normal" still read through the tab labels, "even in a browser doing the blur
properly". Both bars were made opaque.

That attempt leant on alpha and reused `--header-bg`, which is a flat 92% wash.
This one leans on the blur: `blur(22px) saturate(180%)` behind a lower alpha
spreads a 40px glyph across its own width and leaves a wash, not a ghost. Where
the filter is unavailable the bar falls back to today's opaque `--surface-1`, so
a WebView that cannot blur loses nothing rather than gaining a leak.

### Tokens

`--bar-glass` and `--bar-glass-line`, declared in all three palette blocks —
bare `:root`, `:root:not([data-theme="light"])`, and `:root[data-theme="dark"]`.
The suite rejects any raw colour in a rule below the palettes, and requires the
two dark blocks to declare identical tokens with identical values.

### Application

Both bars carry the glass only inside
`@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))`.
Outside it they keep `background:var(--surface-1)`, which is the current
shipped behaviour unchanged.

### Edge to edge on Android

`MainActivity` currently pads the WebView away from every system bar, so the
strip behind the status bar shows the window, and the page's `--safe-t` /
`--safe-b` resolve to zero. A bar that stops below the status bar is not the
bar being asked for.

So the padding splits: left and right stay native, top and bottom are handed to
the page as pixel values written onto `document.documentElement`, overriding the
`env()` defaults that Android never fills in. The header's existing
`padding-top:calc(var(--safe-t) + 10px)` and the tab bar's
`padding-bottom:calc(var(--safe-b) + 10px)` then do the work they were written
for, and the glass runs under the system bars.

The IME inset stays native and stays on the bottom padding: the composer must
not sit under the keyboard. While the keyboard is up the page's `--safe-b` goes
to zero, because the gesture bar is behind the keyboard and counting both would
double the gap.

`GROUND_LIGHT` / `GROUND_DARK` keep tracking `--plane`; the suite asserts it.

## 2. The chat

Three defects, each reproduced against the real app in the harness.

### 2a. A sent message can vanish

`Console.post` stamps a message with the *persona's* channel.
`Views.channelVisible` filters the transcript by the *tab*. The two are
independent controls, so 6 of 12 tab x persona combinations discard both the
line you typed and the reply to it — silently, with the message sitting in
state. The app boots persona `FARMER` / tab `ALL`, so one tap on Buyers or
Drivers reaches the broken state.

**Fix.** The tab and the persona become one selection, synced in both
directions. Choosing a channel tab sets the persona to that channel's speaker;
choosing a persona moves the tab to that channel. The `ALL` tab reads
everything and speaks as whoever was last chosen, and its messages are visible
under it regardless. The mismatch that loses messages becomes unreachable.

### 2b. Typing dots for a message that never lands

`Views.renderTyping` shows the indicator for any sender without asking whether
the message will be visible on the current tab. Watching Drivers while a farmer
thread plays gives dots, then nothing.

**Fix.** `renderTyping` resolves the sender to the channel the message will
carry and stays hidden when that channel is filtered out.

### 2c. The console claims to be Online

`index.html:1866` is static markup. Nothing updates it. It shows a green
"✓ Online" with no network at all, while the header chip says *Offline ·
cached*.

**Fix.** Give it an id and drive it from `Live.statusLine()`, the same source
the header chip reads, so the two can never disagree.

## 3. The alarm

A critical message gets a sound, a vibration, and nothing else new on screen.

**Synthesised, not a file.** Web Audio, built at call time. The repository ships
no binary audio and the service worker precaches by hand; a generated tone keeps
both facts true and works on a first launch with no network.

**The motif.** Short and its own: three pulses, each a fundamental with a fifth
above it, over a low body tone, fast attack and exponential decay. Not a stock
beep and not a system notification anyone else uses.

**When it fires.** Only on a posted message whose `severity` is `critical`, and
only live. A transcript restored from `localStorage` at launch replays nothing —
an alarm on every cold start teaches the reader to ignore it, which is the one
failure an alarm cannot survive.

**Vibration.** `navigator.vibrate` with a pattern matching the tone's rhythm.
No Android permission, and it still reaches a phone on silent in a pocket.

**Mute.** A toggle in the chat panel head, persisted with the rest of state. An
alarm that cannot be silenced is one the reader turns the phone off to escape.

**Unlocking.** Audio needs a gesture in most engines. The context is created and
resumed on the first interaction anywhere in the page, and a fire that finds it
suspended tries to resume before playing rather than throwing.

## 4. Strings and the pack

Every new English string ships with its Spanish, French and Portuguese in the
same commit. The catalogues are at 100% and the suite checks the declared
coverage against the real ratio.

`CACHE_VERSION` in `sw.js` is bumped; an installed copy otherwise keeps serving
the old cache and the change ships to nobody.

New tests cover each of the three chat defects, the token and `@supports`
structure of the bars, and the alarm's fire conditions. Then
`gradlew assembleDebug`, which copies the package to
`android/AURA-AgriNet-1.0-debug.apk`.
