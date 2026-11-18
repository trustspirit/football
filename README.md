# Matchday Cards

Pick football player cards, build two squads by formation, and watch a simulated 90-minute match — passes, interceptions, shots and goals animated on a pitch.

## Run

No build step. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

Live: https://trustspirit.github.io/football/

Player photos are loaded at runtime from the Wikipedia / Wikimedia Commons API (internet required; initials are shown as a fallback).

## How it works

- **Squad builder** — build the home team, then the away team. Cards are grouped by position (GK / DEF / MID / FWD); click a card, target a slot first, or drag a card onto the pitch. Any player can play any slot (out-of-position players get a stat penalty). Search accepts Korean or English names.
- **Engine** (`js/sim.js`) — a pure, seeded function that turns two lineups into a list of events. Passes come in kinds (short, through ball, long ball, switch, cross, goalkeeper punt) and shots too (inside the box, long-range, header after a cross), each with its own success odds.
- **Playback** (`js/match.js`) — physics in pitch meters on a `requestAnimationFrame` loop. Players are steering agents (max speed, acceleration, separation) holding a team shape that follows the ball, pressing the carrier and making runs. The ball is dribbled, rolls with grass friction on ground passes, flies in an arc with a shadow on lofted ones, and keepers dive, catch or parry.

## Test

```sh
node --test
```

Ratings are rough illustrative numbers, not official data.
