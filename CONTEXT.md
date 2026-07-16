# Domain Glossary — Daiza

## Locale

A language setting that controls the language of the user interface. In this app it is represented by a simple language code.

## Available Locales

- `en` — English
- `th` — Thai
- `ja` — Japanese

## Locale Switcher

The control placed in the top-right of the application header that lets the user choose one of the available locales.

## Translation Scope

All user-facing strings rendered by React components, including panel labels, button text, tooltips, error messages, and result labels. Documentation files such as `README.md` and `docs/SPEC.md` are out of scope unless explicitly included later.

## Locale Persistence

The active locale is stored in `localStorage` so the choice survives reloads.

## Default Locale Rule

On first visit, the app uses the browser’s preferred language if it is one of the available locales; otherwise it falls back to `en`.

## Translation Mechanism

A custom React `Context` provides the active locale and a `t(key)` function. Components read translations from a static, per-locale dictionary. No external i18n library is used.

## Locale Switcher UI

A shadcn `Select` dropdown placed in the header actions. Each option is labelled in the locale’s own script (`English`, `ไทย`, `日本語`). Flag icons are not used.

## Translation Content

The implementation includes best-effort translations for all three locales. The user will review and correct them after the switcher is wired up.

## Translation File Organization

Each locale has its own file under `src/locales/` (e.g., `en.ts`, `th.ts`, `ja.ts`). Dictionaries are flat objects keyed by dot-notation strings such as `leftPanel.figureHeight`.

## HTML Language Attribute

When the active locale changes, the document element’s `lang` attribute is updated to match (`en`, `th`, or `ja`). The text direction remains LTR for all supported locales.

## Error Message Translation

`AnalysisError` carries only a `kind` code. The UI maps each code to a translation key. The analysis layer no longer contains user-facing text.

## Charm

The acrylic plate cutline plus a ring hole, used as the keychain body in **Keychain Mode**. It is the keychain-mode equivalent of the `Acrylic Plate`/`Cutline` in base-figure mode.

## Design Mode

A UI-only toggle that switches between two layouts of the same source artwork: `baseFigure` (stand on a base with neck, claw, and footprint) and `keychain` (hang from a ring hole with keychain hardware preview). The active mode is not persisted in design state, URL, or export.

## Ring Hole

A circular through-hole added to the **Charm** in keychain mode. It is cut through the front acrylic plate, the artwork layer, and the back plate when the back-plate toggle is on.

Default diameter is 4 mm, adjustable from 1 mm to 10 mm in 0.5 mm steps. The hole edge must stay at least 1.5 mm inside the cutline; if the top of the cutline is too narrow to satisfy this, analysis fails with `holePlacementFailed`.

## Ring Hole Placement

The default Ring Hole center is at the top of the cutline bounding box, horizontally aligned with the artwork's center of mass: `(centerOfMass.x, cutlineBoundingBox.top)`. The user may drag the hole horizontally along that top line, but it is clamped to keep the 1.5 mm margin. Free 2D placement is not supported.

## Artwork Hole Mask

The circular area under the Ring Hole is removed from the printed artwork layer so that no image is printed where the laser will cut the hole.

## Keychain Hardware

The purely visual assembly shown in the 3D preview: a jump ring through the hole (inner diameter 5 mm, wire 0.8 mm), a 20 mm chain segment, and a small lobster clasp. It is not part of the cutline, not included in mass analysis, and not exported.

## Hang Test

The keychain-mode replacement for the Drop Test. A visual-only pendulum preview: the charm hangs from the clasp with its center of mass below the Ring Hole, then receives a small angular impulse so the user can see it swing. There is no pass/fail result.

## Keychain Export

The SVG exported in keychain mode is print-ready: it contains the rotated outer cutline path plus a separate inner circular path for the Ring Hole. The Keychain Hardware is not included in the export.

## Automatic Charm Rotation

In keychain mode, the charm rotates in-plane around the **Ring Hole** so that the artwork's center of mass lies directly below the hole. The rotated orientation is reflected in the preview, the 3D view, and the exported SVG.

## Keychain Hardware

The purely visual assembly of jump ring, chain segment, and clasp shown in the 3D preview. It is not part of the cutline, not included in mass analysis, and not exported.

## Hang Test

The keychain-mode replacement for the Drop Test. The charm is suspended from the **Keychain Hardware** clasp, an impulse is applied, and the resulting swing is simulated. The pass/fail criteria and impulse magnitude are still to be defined.

## Brand Text Translation

The product name “Daiza” is kept unchanged across locales. Descriptive text such as the header subtitle and the HTML `<title>` are translated.

## Drop Test

A 3D-preview visualization that lowers the figure from a user-adjustable height straight down onto the floor. After landing, the figure stays in the settled or fallen pose until the user resets it. The test fails when the figure’s center-of-mass projection lies outside the base footprint’s support polygon, and succeeds when it lies inside. The height control and trigger live inside the 3D preview control panel. It is a visual interpretation of the existing static stability check, not a new physical analysis.

## Acrylic Back Plate

A second clear acrylic plate shown in the 3D preview. It shares the same cutline as the front plate (including the neck-and-claw assembly) and sits flush behind the front plate, sandwiching the artwork and white print layers. Its thickness is the same as the front plate. It is controlled by a toggle in a new 'Preview / 表示' category in the left parameter panel and defaults to off. It is visual-only — it does not affect the image analysis, center of mass, stability angles, or drop test.

## URL Reflection

If the active locale does not contain a requested key, the translation function returns the English value. English is therefore the implicit fallback language at runtime.

## Locale Switcher Label

The switcher has no visible external label. It relies on the selected locale name and an `aria-label` for accessibility.
