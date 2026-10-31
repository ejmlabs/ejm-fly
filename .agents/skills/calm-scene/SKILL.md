---
name: calm-scene
description: Use before you change the calm scene in src/, such as seeds and random streams, world layout, land streaming and its worker, the floating origin, LOD and quality tiers, the whale, ships, birds, weather, sky, the camera, reduced motion, audio, saved settings, or anything that could reach the network.
---

# The calm scene

One seed makes one sea, the same on every device and at every frame rate. The page streams an
endless world around the whale without stalling a frame, and fetches nothing but its own files.

## Principles

KISS, YAGNI, DRY and Clean Code: the simplest code that solves the whole problem, only what a
task needs now, one authoritative home for each rule, and clear names, small functions and
structure.

## Code

- Types extend `@tsconfig/strictest` and lint is the synced strict layer (`eslint.strict.mjs`)
  with zero warnings. No `any`, no `!`, and no `as` that quiets the checker; an `as` that widens
  a library's too-narrow type (three's `mergeGeometries` can return null) says why beside it.
- Reading arrays: a numeric array read inside its own loop bounds uses `values[i] ?? 0`, which
  keeps hot loops free of calls. Any other list or keyed lookup uses `item(list, index)` or
  `last(list)` from `src/item.ts`, which throw on a miss.
- Every cache drops its oldest entries with `trimOldest` (`src/bounded.ts`); a 2D canvas comes
  from `context2d` (`src/canvas.ts`).
- Shader uniforms the code sets each frame are typed objects the module keeps and assigns into
  the material (as `src/ocean.ts` and `src/sky.ts` do), never `material.uniforms['x'].value`.
- Every material draws scene light; the output applies three's ACES curve once, after the bloom
  and grade (`src/finish.ts`). A material authored in display colours ends its shader with
  `DRAW_AS_AUTHORED_GLSL` or goes through `drawAsAuthored` (`src/tone.ts`), never
  `toneMapped: false`; `tests/tone.test.ts` checks. CPU colours convert with `radianceFor`.
- A material without its own `envMap` reflects `scene.environment` at `scene.environmentIntensity`;
  its `envMapIntensity` does nothing, so do not set it. Hold a reflection down with roughness or
  `specularIntensity` (as the whale does).

## Seeded determinism

- Everything a visitor sees is a pure function of the seed, and for streamed parts of the seed
  and the cell or tile key. `Math.random` appears only in `src/seed.ts`, to pick a new seed.
- Draw random numbers from `src/rng.ts`. `fork(seed, 'channel')` gives each consumer its own
  stream; a new consumer gets a new channel name, so it never shifts another stream.
- Time budgets (`performance.now()`) may change when a piece is built, never what is built.
  Land tiles, navigation tiles and ship cells never depend on visit order, speed or route.
- Steps are frame-rate independent: springs step in closed form (`src/spring.ts`), and a
  journey at 30 and at 60 fps lands in the same place.
- A change that alters what an existing seed shows changes every shared link. Make it on
  purpose, say so in the PR, and refresh `shots/`.
- `tests/world.test.ts`, `tests/core.test.ts` and `tests/camera.test.ts` hold these
  properties. Extend them when you add a seeded or streamed thing.

## The world

- World coordinates are fixed simulation metres. Render coordinates are world minus the
  floating origin (`src/seams.ts`, `src/world-origin.ts`), which recentres on the whale in fixed
  steps so drawing stays near zero. Anything placed in the world follows recentres, and shader
  patterns stay periodic in render space (`src/underwater-glsl.ts`).
- `src/planet.ts` and `src/terrain.ts` lay out continents, islands and the migration lane from
  the seed. Regions blend their looks by weight (`src/regions.ts`, `src/region-look.ts`).
- One swell (`src/swell.ts`) carries everything that floats: water, ships, whale and wakes.
- Collisions are kinematic capsules in a spatial hash over the height field
  (`src/obstacles.ts`). There is no physics engine; do not add one.

## Streaming, LOD and budgets

- Land tiles are built in the land worker (`src/world-worker.ts`), with the main thread as the
  fallback. Modules the worker loads (`src/world-tiles.ts`, `src/land-life.ts`) never import
  three.js, so the worker stays small.
- The finest land tile is 128 m and each coarser level doubles it (`src/chunks.ts`). Cells load
  nearest first, ties broken on coordinates, and unload beyond a wider ring so a boundary never
  thrashes.
- Tiles of 512 m and more are built by the worker on a grid twice as fine as the tier's, so ridgelines
  and peaks keep their shape against the sky (`tileCells` in `src/world-tiles.ts`). The main thread builds
  the tier's own grid (first frame, no worker), which it can afford inside its frame budget. Keep the
  first fine level on the lattice of the last plain one, so their seam has no step.
- Streaming spends at most `BUDGET_MS` (2.5 ms) a frame in `src/world.ts`. Tiles ahead are built
  before the view needs them at the top speed (28 m/s), and the view never shows a hole in the
  land inside the haze.
- Every cache and stream has a cap. An hour of travel stays inside them with no heap growth
  (`tests/streaming.test.ts`).
- Choose detail levels with `selectLod` (`src/lod.ts`). Its hysteresis keeps an object on a
  boundary from flickering.
- `src/quality.ts` picks the tier: phones and software GL get `low`, small machines `medium`.
  `detailFor` holds the per-tier budgets for birds, ships, land objects and walkers. A new kind
  of detail gets a budget there and an assertion in `tools/smoke.ts`.

## Whale, ships and camera

- `src/whale-size.ts` holds the whale's size; everything sized by the animal derives from it.
- The course (`src/whale-course.ts`) caps the turn rate and keeps a hard clearance from land.
  The whale never beaches.
- Ships live in 1024 m cells of 0 to 2 ships (`src/world-ships.ts`), appear beyond the fade
  and stay in open water.
- The chase camera (`src/camera.ts`) is locked to the whale's heading. A drag looks around and
  eases back. The eye never rests in the surface band, and it follows dives unless the viewer
  or reduced motion keeps it at the surface.

## Reduced motion

- Under `prefers-reduced-motion: reduce` the simulation step is zero: the whale, sea, clouds
  and day stand still, and the camera moves only with the viewer's drag, with no field of view
  lift, lean or lightning. Tiles swap at once instead of fading.
- Every new moving thing takes the frozen step and stays still. Add it to the reduced motion
  checks in `tests/camera.test.ts` or beside its own tests.

## No network, no tracking

- `index.html`, `styles.css` and `src/` hold no address that loads anything from another
  origin; `tests/hygiene.test.ts` checks it. The CSP allows only `'self'` (see `calm-deploy`).
- No analytics, accounts, external fonts or assets, import maps or runtime package resolution.
- Sound is off by default. Audio files are fetched from this origin only while sound is on, and
  never before the visit's first tap or key. A new sound comes from an openly licensed
  recording listed in `assets/audio/SOURCES.md` and is built by `tools/build-audio.py`.
- Settings and the last seed live only in `localStorage` under `ejm-calm:v1`, checked by
  `validateMemory` (`src/persistence.ts`). Bump `VERSION` when the shape changes. The page
  works when storage is missing or throws.
- Review hooks exist only with `?debug=1`. Never make the page depend on them.
