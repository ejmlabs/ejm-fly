## Why

The owner wants calm to look hand-made at a high level: a scene people leave open because it is beautiful. On main the frame is drawn straight to the canvas with no antialiasing, so masts, rigging, sails and coastlines stair-step; nothing is brighter than white, so the sun, its path on the water and lightning look flat; and the land, its haze, the wakes, foam, stars, rain and splashes are drawn in display colours outside the tone curve that the sky, water, whale and ships go through, which forces hand-tuned gains (the water's `reflectionGain` of 0.8 / exposure) and leaves the land a saturated lime green beside a filmic sea. The shallows draw a hard turquoise band at the horizon and storm foam lies in flat grey sheets.

## What Changes

- **A finished frame**: three's HDR output (`outputBufferType: HalfFloatType`, `setEffects`) draws the scene into a 4x multisampled half-float target, blooms what is brighter than the screen can show (the sun, its glitter on the water, lightning, sunlit spray), grades it (a touch more colour, warm light and cool shade, a soft vignette, a dither so gradients never band) and applies the tone curve once. A browser without multisampled half-float targets keeps today's direct path.
- **One tone curve**: every material draws scene radiance. Materials authored in display colours (land, walkers, wakes, ship foam and lamps, stars, rain, spray, the whale's splash, the underwater rays and overlay) end with an exact inverse of the curve, so they still draw as authored and now bloom and grade with the rest. The water's exposure-based reflection gain goes.
- **Water**: sun glitter, a sharp HDR sparkle of ripple facets toward the sun that blooms; shallows that fade before the horizon instead of drawing a band; storm whitecaps broken into world-anchored lace and downwind streaks, and swell faces that catch light and shade instead of one flat grey.
- **Whale**: dark slate skin with pale mottling instead of a glassy blue capsule: no clear coat, the reflection held down (`specularIntensity` 0.3, a faint grey sheen), a greyer palette under the scene's blue light, and a rougher standard material on phones.
- **Land**: a natural palette (sage and olive grass, straw, deep forest, grey-brown rock) in place of lime; ambient light tinted by the sky and the sun's own colour on lit slopes, so a sunset lights the ranges warm; tiles that fade in cross-fade by sample coverage instead of a cross-hatched dither; ranges from 512 m tiles up built on a grid twice as fine, so skylines show ridges and peaks instead of straight segments and cones.
- **Sky**: golden hour and dusk read as sunsets instead of a murky green-teal: a warm horizon belt driven by the existing low-sun glow, clearer air for those presets, and their land haze re-measured with a new tool (`tools/haze-measure.ts`). The sun disc and its glow bloom.
- **Streaming**: the finer land stays inside the frame's streaming budget: ships sway their sails only within 400 m of the whale, where the cloth's motion shows, and the streaming loops stop before a slice that would pass the budget.

Out of scope: shadows, the whale's model and motion, the camera's framing, weather timing.

## Capabilities

### New Capabilities

- `frame-finish`: the HDR output, antialiasing, bloom, grade and the single tone curve, with its fallback.

### Modified Capabilities

None (no archived capabilities in the repository).

## Impact

- Code: new `src/finish.ts` and `src/tone.ts` (three's ACES curve moved from `src/underwater-optics.ts`, with its exact inverse); `src/main.ts` (renderer options, the finish, the exposure each frame); `src/landmesh.ts`, `src/walkers.ts`, `src/wake.ts`, `src/ship-fx.ts`, `src/sky.ts`, `src/whale.ts`, `src/weather-fx.ts`, `src/underwater.ts` (display-authored materials); `src/ocean.ts` (glitter, shallows, foam, reflection gain); `src/world-tiles.ts` (palette and grid); `src/slice-cost.ts`, `src/world.ts`, `src/world-nav.ts`, `src/ships.ts`, `src/world-ships.ts` (the streaming budget).
- Every seed's look changes on purpose: shots are refreshed.
- No new dependency (three's own addons), no new origin, CSP unchanged.
