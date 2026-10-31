## ADDED Requirements

### Requirement: Finished frame
Where the browser can render multisampled half-float targets on a GPU, the scene SHALL draw into a 4x multisampled half-float target, light brighter than the display can show SHALL bloom, a grade SHALL apply (a touch more colour, warm light and cool shade, a soft vignette, a dither of about half an output step), and the output SHALL apply the tone curve once. On any other GPU the scene SHALL draw straight to a multisampled canvas, and on a CPU renderer to a plain canvas unless review asks for another mode, with the same curve per material.

#### Scenario: Finish on
- **WHEN** the page opens with `?debug=1&frame=finish` at the desktop and mobile profiles, and with `?debug=1&frame=multisampled` at desktop, in the browser smoke (software GL)
- **THEN** `stats().frame` is the mode asked for, the frame shows the scene without errors, and peak draws stay under 200

#### Scenario: CPU renderer
- **WHEN** the page opens on software GL without the override
- **THEN** `stats().frame` is `plain` and the scene draws directly

#### Scenario: Bloom follows the exposure
- **WHEN** the output's exposure changes through the day or a lightning flash
- **THEN** the bloom starts at the same display brightness (`BLOOM_FROM`), not at a fixed radiance

### Requirement: One tone curve
Every material SHALL draw scene radiance. A material authored in display colours SHALL convert at the end of its shader with the exact inverse of the curve (`DRAW_AS_AUTHORED_GLSL` or `drawAsAuthored`), so it draws as authored on either path. No material SHALL set `toneMapped: false`.

#### Scenario: Exact inverse
- **WHEN** a palette colour is converted to radiance and tone-mapped back at exposures 0.2, 0.42 and 0.55
- **THEN** each channel returns within 1e-4 of the colour

#### Scenario: Guard
- **WHEN** the unit suite scans `src/`
- **THEN** no module sets `toneMapped: false`

### Requirement: Water light
The water SHALL reflect land in scene light with no exposure-based gain, SHALL glitter where ripple facets mirror the sun (taken away by cloud over the sun and by night), SHALL show near-shore shallows that fade before the horizon, and SHALL break storm foam into lace and streaks.

#### Scenario: Night and overcast
- **WHEN** the sun's strength is 0 (night, or cloud over the sun)
- **THEN** the glitter term is 0

### Requirement: Low-sun sky
At golden hour and dusk the sky SHALL warm toward the horizon away from the sun, with no green cast, and each preset's land haze SHALL be the sky's own colour at the haze angles as `tools/haze-measure.ts` measures it.

#### Scenario: Measured haze
- **WHEN** `tools/haze-measure.ts` runs on a build
- **THEN** the golden and dusk haze arrays in `src/sky.ts` match the measured sky within a few sRGB levels

### Requirement: Land light
The land SHALL take a natural palette, shade tinted by the sky's own hue at the same brightness, and sunlight in the sun's own hue, so a low sun lights the slopes warm.

#### Scenario: Smooth dissolve
- **WHEN** the frame multisamples (`finish` or `multisampled`) and a land tile fades in
- **THEN** it fades by sample coverage, not by a screen-space dither

#### Scenario: Palette roles
- **WHEN** the biome colours are read for a beach, a lowland, a cliff and a high flat
- **THEN** sand is warm and light, lowlands green, cliffs grey rock and peaks snow
