---
name: calm-verify
description: Use before you merge or report a calm change, including npm test, npm run test:browser, shots, the shot tools, long-journey, seed-sweep, frame-cost, load-time, world-map, the ?debug=1 review hooks, and any figure for frame time, draws, p99 or first frame.
---

# Verifying calm

There is no CI here, so these checks are the gate. A change is verified when the gate passed
on the PR's head commit, the tools for the changed area ran, and every figure names the machine
it came from. Software GL and plain Node numbers are never device numbers.

## The gate

- On the head commit, in a clean clone or worktree, with Node 24: `npm ci --ignore-scripts`,
  `npm run lint`, `npm test` and `npm run test:browser`. All must pass before merge. Never run
  them in a checkout that holds someone else's work.
- Run the gate on an idle machine. The hour-long swims have a 240 s limit and the smoke a
  streaming budget; a lint or build running beside them on a four-core machine pushes both over.
- `npm test` is Vitest in Node: unit tests, hour-long simulated swims, and a `vite build` with
  the `dist` allowlist and header checks in `tests/deploy.test.ts`. Tests allow 30 s each.
- `npm run test:browser` typechecks, builds, and runs `tools/smoke.ts` in headless system Chrome
  with software WebGL (SwiftShader) at the desktop (1440 by 900) and mobile (390 by 844 at 3x)
  profiles. It asserts under 200 draws, the birds budget (24 instances, 9 draws, 5,000
  triangles), and over 300 s at cruise: no hole in the land inside the haze, the navigation
  tile 3 s ahead built, at most 5 recentres, and under 10 percent of stream steps over 3 ms.
- Set `BROWSER_PATH` when Chrome is not at the default path in `tools/browser.ts`;
  `BROWSER_NO_SANDBOX=1` opts out of the sandbox. Without Chrome the smoke did not run: say so.
- Put each command and its result in the PR body. That is the only record.

## Focused checks

| You changed | Also run |
| --- | --- |
| Whale course or behavior, planet layout, regions, land, the navigation field | `npx tsx tools/seed-sweep.ts 1 50 60`: fails a seed under 0.5 net over path, or any ten minutes under 2 km |
| Streaming, caches, the worker, the origin, anything that holds memory | `npx tsx tools/long-journey.ts 2 42 7`: distance, stalls, tile counts and heap over two hours |
| Per-frame work: birds, wake, sky, weather, camera, land life | `npx tsx tools/frame-cost.ts`: CPU per call in Node, a guide and not a device figure |
| Anything on the first load: imports, shaders, assets, boot order | `npx tsx tools/load-time.ts BASE_DIST NEW_DIST`: fails when a median grows by 1 s or more |
| World layout or the lane | `npx tsx tools/world-map.ts 42 map.png`, and look at the map |
| Anything visible | `npm run shots` and the matching shot tool below, and look at every image |

- There is no byte cap; load time is the size bar. Build the base from main in its own clean
  clone, and run load-time on an idle machine: a busy one swings medians by a second.

## Looking at it

- `npm run shots` rebuilds and writes desktop and mobile shots for seeds 42, 7 and 1234, plus a
  mid-breach frame, into `shots/`. Commit refreshed shots only when the change means to alter them.
- After a build: `tools/feel-shots.ts DIR [seed]` (regions, times of day, weather, the route
  indicator), `tools/land-shots.ts DIR [seed]` (land by day, dusk and night, the highest range,
  a close coast with a town and a herd), `tools/world-shots.ts DIR [seed ...]` (open ocean, a
  coast, an archipelago) and `tools/journey-shots.ts DIR`, each run with `npx tsx`.
  `python3 tools/contact-sheet.py DIR` (needs Pillow) tiles a folder for review.
- Write ad hoc output to `shots/tmp/` (ignored) or a scratch directory.
- With `?debug=1`, `window.__calmReview` reaches a state on demand: `setDay`, `setWeather`
  (clear, hazy, overcast, rain, storm, fog), `setSea` (0 glassy to 1 rough, or null), `setRoute`,
  `jumpTo`, `travel`, `forceBreach`, `forceSpout`, `forceDeepDive`, `frame`, `view`, `life`,
  `peak`, and `stats()` for draws, triangles and stream counts. `README.md` lists them; keep it
  current when you add one.
- Check reduced motion with `prefers-reduced-motion: reduce` emulated: the whale, sea, clouds
  and day stand still, and only a drag moves the camera.

## Figures

- Name the source of every figure: the tool, the seed, the profile and software GL, plain Node
  or a named real device.
- Software GL links shaders slowly and runs the GPU on the CPU. Its frame times, p99s and first
  frames are not phone or desktop figures. Never mark a spec scenario that names a device as met
  from them: record the software GL figure and leave the device figure open in `FOLLOWUP.md`
  and the change's `tasks.md`.
