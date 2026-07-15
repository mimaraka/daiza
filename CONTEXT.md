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
