# Matchday Cards

Pick football player cards, build two squads by formation, and watch a simulated 90-minute match — passes, interceptions, shots and goals animated on a pitch.

## Run

No build step. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

Live: https://trustspirit.github.io/football/

Installable as a PWA (works offline after the first visit; tablet/touch friendly — add it to the home screen from Safari/Chrome).

Player photos are loaded at runtime from the Wikipedia / Wikimedia Commons API (internet required; initials are shown as a fallback).

## How it works

- **Squad builder** — build the home team, then the away team. Cards are grouped by position (GK / DEF / MID / FWD); tap a card, target a slot first, or drag a card onto the pitch (mouse or touch — long-press a card on touch screens). Any player can play any slot (out-of-position players get a stat penalty). Search accepts Korean or English names. Each team picks tactics (mentality, style, press), and up to 6 squads can be saved on the device and loaded again.
- **Players** — attack / passing / defending plus pace, physical (aerial, strength) and kicking (set pieces, long shots). Pace decides through balls and running speed on the pitch, physical decides aerial duels, kicking decides free kicks, corners and long-range shots.
- **Engine** (`js/sim.js`) — a pure, seeded function that turns two lineups into a list of events. Passes come in kinds (short, through ball, long ball, switch, cross, goalkeeper punt) and shots too (inside the box, long-range, header after a cross), each with its own success odds. Fouls bring free kicks (direct shots over a wall, or deliveries into the box), penalties, yellow and red cards (a sent-off player is gone for the rest of the match). Corners come from blocked shots, parries and cleared crosses. Formation line strength and tactics trade off against each other.
- **Playback** (`js/match.js`) — physics in pitch meters on a `requestAnimationFrame` loop. Players are steering agents (max speed, acceleration, separation) holding a team shape that follows the ball, pressing the carrier and making runs. The ball is dribbled, rolls with grass friction on ground passes, flies in an arc with a shadow on lofted ones, bounces and rolls after lofted balls, leaves a trail on hard shots, and keepers dive, catch or parry. Set pieces are staged (wall, penalty spot, crowded box), fouled players go down and the referee shows cards. The match screen fits a single viewport in landscape and portrait.

## Test

```sh
node --test
```

Ratings are rough illustrative numbers, not official data.
