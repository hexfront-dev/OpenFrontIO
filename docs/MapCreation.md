# Creating a New Map

End-to-end guide for adding a new map to OpenFront. All paths are relative to
the repository root. This is the self-contained recipe — the map generator's
full documentation lives in [`map-generator/README.md`](../map-generator/README.md).

## Step 0 — Prerequisites

- **Go** `1.24.4+` (the generator is a Go CLI; `go.mod` pins `go 1.24.4`).
- **Node/npm** (for the final format/lint/verify steps).
- **Python 3 + Pillow** (only needed to pre-process the source image in Step 1).

## Step 1 — Create the source image (`image.png`)

The generator turns **one pixel = one tile**, using **only the blue channel**
(red/green are ignored). Convert your source so that:

| Pixel you want    | Encode as                         |
| ----------------- | --------------------------------- |
| Water (sea/lakes) | fully transparent (alpha < 20)    |
| Impassable void   | pure black `#000000` (alpha ≥ 20) |
| Land              | blue value encodes elevation      |

Land elevation → blue mapping (higher blue = higher terrain):

| Blue value  | Terrain  |
| ----------- | -------- |
| `< 140`     | plains   |
| `140 – 158` | plains   |
| `159 – 178` | highland |
| `179 – 200` | mountain |
| `> 200`     | mountain |

### 1a. Inspect your source first

The conversion depends entirely on your source's colour scheme, so look at its
histogram before writing any code:

```python
from collections import Counter
from PIL import Image
im = Image.open("source.jpg").convert("RGB")
print(Counter(im.getdata()).most_common(12))
```

Determine (a) which colours are **water** vs **land** (water is usually
blue/cyan-dominant) and (b) how **elevation** is encoded (a brightness ramp, a
green→red hue ramp, …).

### 1b. Convert

Map water to transparent and land to a grayscale whose blue channel holds the
elevation, filling in the two `# TODO` spots to match your source:

```python
from PIL import Image

SRC, OUT, SCALE = "source.jpg", "map-generator/assets/maps/<map>/image.png", 2

im = Image.open(SRC).convert("RGB")
w, h = im.size
px = im.load()
out = Image.new("RGBA", (w * SCALE, h * SCALE))
opx = out.load()

for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if b > r + 8:                    # TODO: your water rule
            c = (0, 0, 0, 0)             # transparent = water
        else:
            L = (r + g + b) / 3.0        # TODO: your elevation signal
            mag = max(0.0, min(30.0, (L - 160.0) * 30.0 / 96.0))  # 0..30
            blue = int(round(140.0 + 2.0 * mag))                 # 140..200
            c = (blue, blue, blue, 255)
        for dy in range(SCALE):
            for dx in range(SCALE):
                opx[x * SCALE + dx, y * SCALE + dy] = c
out.save(OUT)
```

For a green→red hypsometric source, elevation follows **hue** rather than
brightness, so compute `mag` from the hue instead:

```python
import colorsys
H = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[0] * 360
mag = max(0.0, min(30.0, (120.0 - H) * 30.0 / 120.0))  # green(120)=0, red(0)=30
```

Notes:

- **Upscale** (`SCALE`, nearest-neighbour) so the map lands in the recommended
  range: ~2–3 M total pixels, 1–2 M land tiles. A `1273×580` source at
  `SCALE=2` gives ~2.95 M pixels.
- Dimensions are normalized down to multiples of 4; islands < 30 tiles and
  lakes < 200 tiles are removed automatically.

## Step 2 — Create `info.json`

Create `map-generator/assets/maps/<mapname>/info.json`. Required fields:

- `id` — UpperCamelCase, **must equal the folder name**.
- `name` — canonical name (the enum value). **Never change after shipping.**
- `translation_key` — must be `"map.<folder>"`.
- `categories` — ≥1 of: `featured`, `new`, `world`, `continental`, `europe`,
  `asia`, `north_america`, `africa`, `south_america`, `oceania`, `antarctica`,
  `countries`, `cosmic`, `fictional`, `arcade`, `tournament`.

Common optional fields: `multiplayer_frequency`, `themes`, `nations`,
`custom_tribes`, `layers`, `disabled_modifiers`, `forced_modifiers`,
`special_team_count`. A nation is `{ "name", "flag" (ISO 3166), "coordinates": [x, y] }`.

Flags must already exist in `resources/flags/<iso>.svg` and be listed in
`resources/countries.json` (e.g. `se`).

### Nation coordinates must be land

Coordinates are in the **generated** map space (after cropping to a multiple of
4), origin top-left. A coordinate that looks right can still fall on water or a
tiny island, so verify and snap each one against the source `image.png` before
committing:

```python
from collections import deque
from PIL import Image
im = Image.open("map-generator/assets/maps/<map>/image.png").convert("RGBA")
w = im.size[0] - im.size[0] % 4
h = im.size[1] - im.size[1] % 4
px = im.load()

def is_land(x, y): return 0 <= x < w and 0 <= y < h and px[x, y][3] >= 20

def snap(x, y):
    if is_land(x, y): return (x, y)
    q, seen = deque([(x, y)]), {(x, y)}
    while q:
        cx, cy = q.popleft()
        for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
            if (nx, ny) not in seen:
                if is_land(nx, ny): return (nx, ny)
                seen.add((nx, ny)); q.append((nx, ny))

for name, x, y in [("Norrmalm", 1350, 415), ("Sodermalm", 1350, 604)]:
    print(name, snap(x, y))
```

A nation on an island smaller than 30 tiles is wiped out by the generator's
island removal — keep spawns on the mainland or a larger island.

## Step 3 — Generate

```bash
cd map-generator
go run . --maps=<mapname>     # or: go run . for all maps
cd ..
```

The first run downloads the generator's dependencies (needs network). Outputs:

- `resources/maps/<mapname>/` — `manifest.json`, `map.bin`, `map4x.bin`,
  `map16x.bin`, `thumbnail.webp`.
- `src/core/game/Maps.gen.ts` and the `map` section of
  `resources/lang/en.json` — regenerated for **all** maps (do not hand-edit).

## Step 4 — Format the generated files (only)

The generator emits long `customTribes` arrays collapsed onto one line, which
shows up as a huge diff until prettier reflows them. Format just the generated
files (not `npm run format`, which rewrites the whole repo):

```bash
npx prettier --write \
  "src/core/game/Maps.gen.ts" \
  "resources/lang/en.json" \
  "map-generator/assets/maps/<mapname>/info.json" \
  "resources/maps/<mapname>/manifest.json"
```

Then lint (repo-wide, fast):

```bash
npm run lint
```

## Step 5 — Verify

```bash
npx vitest run tests/MapConsistency.test.ts tests/MapManifestFlags.test.ts tests/EnJsonSorted.test.ts
```

`MapConsistency.test.ts` compares every map's `info.json` against its generated
`manifest.json`. Other maps' manifests can be stale in the repo and will fail
(e.g. `EightIslands`, `FourIslands`, `SixIslands`) — those are pre-existing and
not yours to fix; just confirm **your** map is not among the failures.
`MapManifestFlags.test.ts` catches bad flag codes, and `EnJsonSorted.test.ts`
guards the `en.json` sort order.

## Step 6 — Attribution (required)

Add the map's data source and license under `## Map Data` in `CREDITS.md`. For a
topographic source this is typically:

```markdown
### <Map> Map

[<Map> Topographic Map](https://en-gb.topographic-map.com/map-<map>/)
Licensed under [Open Data Commons Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/summary/)
```
