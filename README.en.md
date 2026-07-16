# Daiza

A web app that analyzes the center of gravity of an acrylic figure from a PNG image and automatically calculates the **insert position** and **base size**. It exports the cutline (acrylic outline) and base drawings as an SVG in real-size (mm) coordinates.

**Live URL: https://mimaraka.github.io/daiza/**

Image analysis, geometric calculation, and SVG generation are all done inside the browser. **Loaded images and analysis data are never sent externally** (this is a static site with no server).

## Features

- **Center-of-gravity analysis** — Treats non-transparent regions (default: α>0; the alpha threshold changes the decision boundary) as a uniform-density area and calculates the area centroid of the region enclosed by the cutline.
- **Automatic insert placement** — Places a two-stage "neck + tab" structure directly under the center of gravity and merges it into the acrylic outline.
- **Base size inspection** — Using the support-polygon concept, checks whether the figure is self-standing at the specified base width and whether the slot fits within the specified base depth.
- **Tipping simulation** — Calculates the left/right/front/back tipping angles as `θ = atan(distance from support edge / center-of-gravity height)`.
- **Cutline generation** — Produces a smooth outline through margin offset, narrow-gap filling, smoothing, and curve completion (Bézier).
- **Multi-part joining** — Separated parts are not wrapped in a convex hull; instead, they are joined into one piece with bridges that follow the contours.
- **Real-time preview** — Overlay display, wheel zoom, drag pan, real-size ruler, and real-size grid (toggle, default OFF). Can switch to a **finish preview mode** that hides guides.
- **3D preview** — View the finished product in 3D (transparent acrylic, artwork / white layer on the back, base with through-slot). A tilt slider shows tipping, and an explode animation shows how the tab engages. The floor shows a real-size grid (10 mm squares, default ON) and can use the included wood sample texture or an uploaded image.
- **SVG / Illustrator (.ai) export** — Exports the outline (body + neck + tab), slot, and base slot in real mm. `.ai` always embeds the artwork image and separates layers. SVG exports line data by default; embed the artwork image only when the option is checked.

## Usage

1. Load a PNG image (RGBA) by drag-and-drop or file selection. By default, **α=0 is treated as transparent and α>0 as acrylic** (the boundary can be changed with the alpha threshold).
2. Enter the figure height (mm) in the left panel. This is the **total height from the ground plane (base bottom) to the top of the cutline**. From this, the "artwork height (mm)" is derived by subtracting the outside height of the artwork (cutline margin × 2 + lift + thickness), and `mm_per_pixel` is determined from the ratio of artwork height in mm to artwork height in px. Image height is not used, so the real size does not change depending on how much transparent padding the PNG has.
3. Adjust each parameter. Analysis and redraw run immediately on every change.
4. Check the analysis results and tipping angles in the right panel, then export the SVG.

### Parameters

| Parameter              | Default | Range              | Description                                                                                                          |
| ---------------------- | ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Alpha threshold        | 0       | 0–0.99             | Boundary for treating a pixel as acrylic (`α > threshold × 255`). Raising it ignores semi-transparent edges/shadows. |
| Figure height          | 160 mm  | 1–2000             | Total height from the ground plane to the top of the cutline. Used with the artwork height (px) to set the scale.    |
| Thickness              | 3 mm    | 0.1–20             | Acrylic plate thickness. Also becomes the tab depth.                                                                 |
| Cutline margin         | 3 mm    | 0–10               | Offset applied outward from the artwork to create the cutline.                                                       |
| Cutline smoothing      | 0       | 0–5                | Higher values produce a smoother outline.                                                                            |
| Gap fill threshold     | 3 mm    | 0–20               | Fills gaps or constrictions narrower than this width with acrylic (0 = disabled).                                    |
| Min bridge width       | 6 mm    | 0.5–20             | Minimum width of the bridges that join separated parts.                                                              |
| Slot width             | 20 mm   | 0.1–50             | Tab width (= base slot width).                                                                                       |
| Slot offset            | 0 mm    | -50–50             | Left/right fine adjustment from directly under the center of gravity (positive = right).                             |
| Slot front-back offset | 0 mm    | -150–150           | Front/back position of the slot relative to the base depth center (positive = front).                                |
| Neck width             | 40 mm   | 1–(no upper limit) | **Must be greater than the slot width** (see below).                                                                 |
| Plate lift             | 0 mm    | 0–50               | How far the acrylic plate is lifted above the base top. 0 means the plate bottom touches the base top.               |
| Base width             | 50 mm   | 1–300              | Specified value is the actual width (no doubling or addition).                                                       |
| Base depth             | 30 mm   | 1–300              | Specified value is the actual depth (not auto-calculated).                                                           |

### Insert structure (neck + tab)

The insert consists of two rectangles of different widths. The neck is wider than the tab, and the resulting **shoulders rest on the base top to stop insertion at the tab depth (= plate thickness)**.

```
         ┌─────────────────┐
         │   Acrylic plate │   ← Cutline (body)
         └────┬───────┬────┘
              │  Neck │           width = neck width (mm) > slot width
              │       │
   ═══════┌───┴──┐┌───┴───┐═════   ← Shoulders rest on base top
   Base    │Shoulder│ Shoulder│  Base
   ───────┴───┐  └┘  ┌───┴──────  Base top
              │  Tab  │           width = slot width (mm)
              │       │           depth = plate thickness (mm)
              └───────┘
```

By design, `neck width ≥ slot width + 2 × min shoulder width (0.5 mm per side)` must always hold. If widening the slot would push the neck width below this limit, the neck width is automatically raised to the minimum.

### Error cases

No exceptions crash the app; messages are shown in the UI.

- **No acrylic region** — The image is fully transparent, or the alpha threshold is so high that no opaque pixels remain.
- **Scale calculation impossible** — Figure height is less than or equal to the outside height of the artwork (cutline margin × 2 + lift + thickness), so the artwork height cannot be obtained.
- **Insert placement impossible** — Offset is too large, or the neck extends beyond the plate.
- **Base calculation impossible** — The specified base width is smaller than required (`max(2 × |centroid X − slot center X|, slot width)`), or the specified base depth is smaller than required (`thickness + 2 × |front-back offset|`). The base is not auto-widened; review the parameters.

## Development

```bash
npm install
npm run dev          # dev server
npm run build        # production build (creates dist/)
npm run preview      # preview the build locally
npm run lint         # ESLint (zero warnings is required)
npm run format       # Prettier
```

Because the app is served under the repository name on GitHub Pages, Vite's `base` is fixed to `/daiza/`. Pushing to `main` runs `.github/workflows/deploy.yml`, which lints, builds, and deploys.

### Tech stack

React 19 / TypeScript (strict) / Vite / Tailwind CSS v4 / shadcn/ui / polygon-clipping / pdf-lib (`.ai`) / Three.js + React Three Fiber (3D preview). State management uses React Hooks only; no global state library like Redux is used.

pdf-lib and the 3D dependencies are kept in **dynamic import** chunks, so they are not downloaded until needed.

### Architecture

UI, image analysis, physics calculation, rendering, and export are strictly separated. Code under `analysis/` is pure function logic that does not depend on React; failures are returned as `null`.

```
src/
  components/   LeftPanel / Preview / ResultPanel / ExportPanel / Ruler / Grid … UI (3-pane layout)
                preview3d/                                  … 3D view (R3F, lazy-loaded)
  analysis/     imageLoader, contour, centroid, distance, slot, base, stability,
                scale, pipeline, analysis.worker            … pure logic
  render/       overlay, simulation, ruler, scene3d         … rendering model (pure)
                texture3d                                   … textures for artwork / white layer / floor (DOM)
  assets/       textures/wood.png                           … sample wood texture (referenced only by 3D chunk)
  export/       geometry, svg, ai, raster                   … SVG / Illustrator generation in real mm
  model/        state.ts, types.ts, errors.ts, pixelStore.ts
  hooks/        useAnalysis, useAppState, useViewport
  utils/        geometry.ts, image.ts, curve.ts
```

The 3D scene geometry (cutline → extruded shape, conversion to mm coordinates) lives in `render/scene3d.ts` as pure functions, with no dependency on Three.js or React. The origin is the **base center on the ground plane**, Y up, Z front, with the tab bottom at Y=0 (flush with the base bottom).

### Analysis pipeline

To avoid freezing even with 3000 px-class images, the pipeline is split into two phases and driven on a Web Worker.

- **Phase 1 `analyzeImage`** — Image-dependent preprocessing (alpha plane extraction), O(W×H). Runs only when the image changes; the alpha plane is kept inside the Worker and not sent to the main thread. Binarization is not done here because it depends on the alpha threshold parameter.
- **Phase 2 `runAnalysis`** — Parameter-dependent calculation (binarization → cutline → centroid → insert → base → tipping angle). Heavy stages (binarization, EDT dilation, cutline generation, insert merge) are memoized by their dependency keys, so unrelated changes like base width do not trigger recalculation.

The cutline is finalized in the following order, and all subsequent centroid, insert, base, overlay, and SVG output follow this outline.

**Contour extraction → margin offset (EDT dilation) → gap filling (disc closing) → self-intersection removal → smoothing → curve completion → insert merge**

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — Specification (canonical)
- [`docs/TODO.md`](docs/TODO.md) — Remaining tasks
- [`docs/I18N.md`](docs/I18N.md) — Internationalization guide

## Future extensions

Multiple inserts, circular / elliptical / arbitrary base shapes, metal stand support, density maps, multi-PNG simultaneous calculation, PWA / WebAssembly replacement, etc. are anticipated; the analysis logic is kept separate from the UI to support these.
