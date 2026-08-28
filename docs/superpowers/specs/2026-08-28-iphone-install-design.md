# Fields that do not zoom, a keyboard that does not cover the composer, and a channel iOS actually has

2026-08-28

Four changes finishing the iPhone install. Three are defects verified in a
browser; the fourth adds the one alert channel iOS offers that this app was not
using.

## What was already done

The install itself works: `apple-mobile-web-app-status-bar-style` swapped by
theme, twelve launch images, a `dvh` line under every `vh` rule, safe-area
insets, an install hint shown only in iOS Safari and never inside the installed
app. All of it is covered by tests.

What follows is what being *compatible* with iPhone still left wrong.

## 1. Every field zooms the page

WebKit zooms the page when it focuses an input whose computed `font-size` is
under 16px. In Safari a reader can pinch back out. In an installed app there is
no pinch-out, so the layout simply stays shifted for the rest of the session.

Measured in a browser at 390×844, **11 of 11 fields are under the threshold**:

| Field | Size |
|---|---|
| `chatInput`, `placeSearch`, `placeSearchM`, farm form (6 fields) | 12.5px |
| `placeSearchF` | 15px |
| `personaSel` | 11px |

### The fix

One block, after every rule that sets a field's size so source order settles the
equal-specificity cases:

```css
@media (pointer: coarse){
  .field, .search-input, .fr-search .search .field, #personaSel{ font-size:16px; }
}
```

`pointer: coarse` rather than a width query: this is a property of the input
method, not the screen. A touch laptop needs it at 1440px and a desktop does not
need it at 390px. The desktop density is the design and stays untouched.

`.fr-search .search .field` and `#personaSel` are repeated in the block because
they out-specify a bare `.field`; source order alone would not beat them.

`#personaSel` currently carries `font-size:11px` in a `style` attribute, which no
rule can override. It moves into the stylesheet.

## 2. Nothing handles the keyboard

`visualViewport` appears zero times in `index.html`. Android does not need it —
`MainActivity` reads the IME inset natively and pads the WebView — but iOS has
no equivalent, and in a standalone app the keyboard overlays the viewport without
resizing it.

### The fix

A `Keyboard` module reading `window.visualViewport`, writing `--kb` on the
document element and `data-kb` on the body when the inset exceeds 120px. The
threshold is not arbitrary: Safari's form accessory bar alone is roughly 44px and
is not a keyboard.

```
inset = window.innerHeight - visualViewport.height - visualViewport.offsetTop
```

`offsetTop` is in the expression because WebKit scrolls the visual viewport to
reveal the focused field, and without it the inset reads as zero exactly when the
keyboard is up.

While `data-kb` is set:

- **the tab bar hides.** It is `position:fixed; bottom:0`, so with the keyboard
  up it floats over the keys.
- **the FAB hides**, for the same reason.
- **`--safe-b` becomes 0.** The home indicator is behind the keyboard; counting
  both the inset and the keyboard doubles the gap.

These are the same three consequences `MainActivity` already produces on Android
from the same fact, which is the argument for handling it the same way rather
than inventing a second shape.

The focused field is scrolled into view once the inset has settled.

Everything is guarded on `window.visualViewport` existing. Where it does not, the
page behaves exactly as it does today.

## 3. On iPhone the alarm has one channel, not two

WebKit implements no Vibration API, so `navigator.vibrate` is undefined and the
buzz never happens. iOS also honours the hardware silent switch for Web Audio.
A farmer with the phone on silent gets nothing at all from the alarm.

### What a notification can and cannot do here

**It cannot wake a sleeping phone.** `visibilitychange` stops telemetry when the
page is hidden — a deliberate choice in the app — so no rule runs and no critical
message exists to notify about. There is no backend, so nothing can push one
either. Any claim otherwise would be false.

**What it does buy is a durable record.** When a frost line lands with the app
open but the phone face-down, on silent, or on a bench, the tone is over in 0.66
seconds and the bubble scrolls away. The notification is still on the lock screen
an hour later. On iPhone that is frequently the only channel that registered
anything at all.

The feature is built for that, and the README says so in those words.

### The shape

A `Notify` module.

**Critical only.** A notification outlives the moment it was raised. A lock
screen carrying four of them from one app is one a farmer swipes away without
reading, which costs the frost line the meaning the scarcity gave it. `serious`
keeps its quieter tone and stays off the lock screen.

**Through the service worker.** `new Notification()` does not exist on iOS. The
only path that works there is `ServiceWorkerRegistration.showNotification()`,
which also works everywhere else, so it is the only path used.

**Asked for from a tap.** iOS requires a user gesture for
`Notification.requestPermission()`, and asking on load is hostile regardless. The
request lives on a switch in the control panel's Alerts section, beside the sound
and vibration switches.

**Honest when it cannot.** iOS grants notifications only to an installed app, so
in iOS Safari the switch says the app has to be on the Home Screen first rather
than failing silently. A denied permission says it was denied and that the
browser's settings are the only way back — a second `requestPermission()` after a
denial resolves without ever prompting.

State gains `notify: false`. Opt-in, saved and restored beside `muted` and
`haptics`.

`sw.js` gains a `notificationclick` handler that focuses an open window or opens
one, so tapping the alert reaches the transcript it came from.

## 4. The hint says what installing buys

The hint names the two taps and two benefits — no Safari chrome, works offline.
It gains the third, which this work makes true:

> Tap Share, then "Add to Home Screen". It opens without Safari around it, keeps
> working offline, and can alert you when something critical happens.

Three strings across `es`, `fr` and `pt` land in the same commit, per the
coverage check.

## Tests

- **fields**: every rule setting a field's `font-size` has a `pointer: coarse`
  counterpart at 16px or more, and no `style` attribute sets one; a browser pass
  at coarse pointer measures all 11 fields at 16px.
- **keyboard**: the inset expression subtracts `offsetTop`; `data-kb` is not set
  by an accessory-bar-sized inset and is set by a keyboard-sized one; the tab
  bar, the FAB and `--safe-b` all respond; nothing throws where
  `visualViewport` is absent.
- **notify**: critical raises one and serious does not; it goes through the
  service worker registration rather than `new Notification`; the switch reports
  unavailable in iOS Safari before install, denied after a denial, and on after a
  grant; the state survives a restart; `sw.js` handles `notificationclick`.

## What none of this settles

The same limit the README already states, and it applies to every line above:
there is no Mac and no device here. All of it is driven in a desktop browser with
an iOS user agent and an emulated coarse pointer. Whether WebKit's keyboard inset
matches the model, whether an installed app is granted notifications on a given
iOS build, and whether the status-bar swap is honoured are settled by an iPhone
and nothing else.
