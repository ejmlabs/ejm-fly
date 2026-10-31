## 1. Frame

- [x] 1.1 `src/tone.ts`: three's ACES fit on the CPU and its exact inverse (CPU and GLSL), `displayExposure`, `drawAsAuthored`, `DRAW_AS_AUTHORED_GLSL`; the underwater view's tone code moves here
- [x] 1.2 `src/finish.ts`: probe, bloom from a display brightness, grade
- [x] 1.3 `src/main.ts`: the frame mode (`finish`, `multisampled`, `plain`; `?debug=1&frame=` for review), the exposure each frame, `stats().frame`, draws counted per frame

## 2. Materials

- [x] 2.1 Land and walkers, wakes, ship foam and lamps, stars, rain and spray, the whale's splash, underwater rays and waterline: converted; no `toneMapped: false` left
- [x] 2.2 Water: constant reflection gain, haze in scene light, glitter, shallows, storm foam
- [x] 2.3 Land: palette, sky-hued shade, sun-coloured light, a stronger key, softer cliff bands
- [x] 2.4 Land tiles dissolve by coverage wherever the frame multisamples
- [x] 2.5 Sky: a warm horizon belt at low sun, clearer golden and dusk presets, their haze re-measured by `tools/haze-measure.ts`; the belt kept off the environment's underside, and out of the environment phones keep, which dims at night
- [x] 2.6 Storm foam: a world-anchored lattice in the wind's frame, octaves fading by footprint; swell faces tinted by tilt
- [x] 2.7 Whale: slate skin, no clear coat, reflection held down, rougher on phones; review `setDay` refreshes the reflections; the sky's environment fades with depth under water
- [x] 2.8 Land grid: twice the cells from 512 m tiles up, unused vertices dropped, land triangles budgeted per tier in the smoke
- [x] 2.9 Streaming: sails sway only within 400 m; the prefetch and the bakes stop before a slice that would pass the budget (`SliceCost`). The smoke's 300 s cruise on an idle four-core machine in software GL, three alternating runs: 7.6, 7.3 and 6.9 percent of steps over 3 ms, against 12.5, 11.2 and 12.0 at 513a04e (bar: under 10). Not device figures

## 3. Checks

- [x] 3.1 `tests/tone.test.ts`: exact inverse, finite white, the shader writes the same curve, no material opts out
- [x] 3.2 `tools/smoke.ts`: software GL draws a plain canvas by default; asked for, the finish (desktop and mobile) and the multisampled canvas (desktop) show the scene and stay under 200 draws
- [x] 3.3 Shots refreshed and reviewed at desktop and mobile, by day, dusk, night, storm, breach and under water
- [ ] 3.4 Frame time of the finish on a real phone and desktop GPU (software GL only here)
- [x] 3.5 Load time against main (981938a), software GL, `tools/load-time.ts`: five alternating cold loads each gave a first sea frame of 6,016 to 6,006 ms on desktop and 11,457 to 12,508 ms (+1,051, over the 1 s bar) on the mobile profile; nine each gave 6,186 to 6,305 (+119) and 11,885 to 12,426 (+540). A CPU profile of the mobile boot found no new hotspot: main's own runs differ by up to 270 ms. Transfer 262 to 269 KB
- [x] 3.6 Frame cost against main, plain Node, two runs each (`tools/frame-cost.ts`, whose stand-in renderer now has a pixel ratio): birds, wake and the day under 0.01 ms more a step; a near tile build 3.4 to 4.6 ms against 3.8 to 4.1; a far tile with shading maps, in the worker, 58 and 62 ms against 49 and 49 (the finer grid)
