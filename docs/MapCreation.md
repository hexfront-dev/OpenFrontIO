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
(red/green are ignored). Before writing any metadata, convert your source image
into the encoding the generator understands:

| Pixel you want    | Encode as                         |
| ----------------- | --------------------------------- |
| Water (sea/lakes) | fully transparent (alpha < 20)    |
| Impassable void   | pure black `#000000` (alpha ≥ 20) |
| Land              | blue value encodes elevation      |

Land elevation → blue mapping (higher blue = higher terrain):

| Blue value  | Terrain  | Magnitude |
| ----------- | -------- | --------- |
| `< 140`     | plains   | 0         |
| `140 – 158` | plains   | 0 – 9     |
| `159 – 178` | highland | 10 – 19   |
| `179 – 200` | mountain | 20 – 30   |
| `> 200`     | mountain | 30        |

### Converting a hypsometric source (green = low, red = high, white = outside)

Typical topographic images (e.g. from topographic-map.com) colour low land
**green**, high land **red**, lakes **blue/cyan**, and the area outside the
country **white**. Convert with a script like this (Pillow):

```python
import colorsys
from PIL import Image

SRC, OUT, SCALE = "source.jpg", "map-generator/assets/maps/<map>/image.png", 4

im = Image.open(SRC).convert("RGB")
w, h = im.size
px = im.load()
out = Image.new("RGBA", (w * SCALE, h * SCALE))
opx = out.load()

def blue(r, g, b):
    # elevation = green(120deg) -> red(0deg) hue ramp
    H = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[0] * 360
    if H >= 150: return 100                          # dark green (lowest)
    if H >= 120: return 100 + (150 - H) / 30 * 40
    if H >= 80:  return 140 + (120 - H) / 40 * 18
    if H >= 55:  return 158 + (80 - H) / 25 * 20
    if H >= 30:  return 178 + (55 - H) / 25 * 22
    return 200 + (30 - H) / 30 * 55                   # red (highest)

for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r > 240 and g > 240 and b > 240: c = (0, 0, 0, 0)      # white -> water
        elif b > r and b > g:                c = (0, 0, 0, 0)      # lakes -> water
        else:
            v = max(0, min(255, round(blue(r, g, b))))
            c = (v, v, v, 255)
        for dy in range(SCALE):
            for dx in range(SCALE):
                opx[x * SCALE + dx, y * SCALE + dy] = c
out.save(OUT)
```

Notes:

- **Upscale** (`SCALE`, nearest-neighbour) so the map lands in the recommended
  range: ~2–3 M total pixels, 1–2 M land tiles. A `272×540` source at `SCALE=4`
  gives `1088×2160`.
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

**Nation coordinates must be land.** Easiest way: after generating, scan the
land mask for each region's position (origin is top-left) and verify the tile
is land (`map.bin` byte at `y*width + x` has bit 7 set and magnitude ≠ 31).
Flags must already exist in `resources/flags/<iso>.svg` (e.g. `se`).

## Step 3 — Generate

```bash
cd map-generator
go run . --maps=<mapname>     # or: go run . for all maps
cd ..
```

This writes `resources/maps/<mapname>/` (`manifest.json`, `map.bin`,
`map4x.bin`, `map16x.bin`, `thumbnail.webp`) and regenerates
`src/core/game/Maps.gen.ts` and the `map` section of `resources/lang/en.json`
for **all** maps (do not hand-edit any of these).

## Step 4 — Format the generated files (only)

`npm run format` rewrites the whole repo and can churn unrelated files. Format
just what changed:

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
npx vitest run tests/MapConsistency.test.ts tests/MapManifestFlags.test.ts tests/EnJsonSorted.test.ts --run
```

`MapConsistency.test.ts` compares every map's `info.json` against its generated
`manifest.json`. If it reports unrelated maps (stale manifests committed before
your change), fix only those you touched; your new map must pass.

## Step 6 — Attribution (required)

Add the map's data source and license to `CREDITS.md` (see
[`map-generator/README.md`](../map-generator/README.md) → "Update CREDITS.md").
