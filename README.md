# Matchday Cards

Pick football player cards, build two squads by formation, and watch a simulated 90-minute match — passes, interceptions, shots and goals animated on a pitch.

## Run

No build step. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

Player photos are loaded at runtime from the Wikipedia / Wikimedia Commons API (internet required; initials are shown as a fallback).

## How it works

- **Squad builder** — build the home team, then the away team. Cards are grouped by position (GK / DEF / MID / FWD); click a card, target a slot first, or drag a card onto the pitch. Any player can play any slot (out-of-position players get a stat penalty). Search accepts Korean or English names.
- **Engine** (`js/sim.js`) — a pure, seeded function that turns two lineups into a list of events. Pass success depends on passing vs. the opposing line's defending; shots depend on finishing vs. the keeper.
- **Playback** (`js/match.js`) — a `requestAnimationFrame` loop eases players toward their shape/pressing targets and moves the ball with friction-like easing and arcs.

## Test

```sh
node --test
```

Ratings are rough illustrative numbers, not official data.
