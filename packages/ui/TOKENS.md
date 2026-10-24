# MoonWitness UI token contract

`@moonwitness/ui/styles/tokens.css` is the source of truth for shared visual values. Import it once before component styles. App-specific theme files should map these tokens, not introduce another palette or spacing scale. The [`README.md`](./README.md) is the design Bible; this file documents the technical values and contrast contract.

## Color roles

| Role                    | Token                                                                          | Value / behavior                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Fixed brand paper       | `--mw-paper-cream`                                                             | `#f3efe4`; remains warm cream in either theme                                                      |
| Fixed brand ink         | `--mw-ink-black`                                                               | `#0d0d0d`; remains available on paper and accents                                                  |
| Dark panel              | `--mw-ink-panel`                                                               | `#17171a`                                                                                          |
| Semantic page           | `--mw-background` / `--mw-foreground`                                          | Theme-aware page surface and text                                                                  |
| Semantic raised surface | `--mw-surface` / `--mw-surface-foreground`                                     | Theme-aware panels and controls                                                                    |
| Brand yellow            | `--mw-yellow`                                                                  | `#ffe031`; use paired dark ink for text                                                            |
| Brand magenta           | `--mw-magenta`                                                                 | `#ff2e88`; use `--mw-on-pink` for text                                                             |
| Brand cyan              | `--mw-signal-blue`                                                             | `#00b8f0`; decorative accent unless paired contrast is checked                                     |
| Editorial accent text   | `--mw-magenta-readable`, `--mw-cyan-readable`, `--mw-yellow-readable`          | Darker palette-matched values on paper surfaces; bright brand accents on dark surfaces             |
| Semantic state          | `--mw-success`, `--mw-warning`, `--mw-info`, `--mw-error` / `--mw-destructive` | Status colors have distinct semantic tokens, separate from brand magenta, and pair with text/shape |

`--mw-lime` and `--mw-pink` are migration aliases. New UI must use semantic names. Remove aliases after app consumers have migrated. `--mw-paper` and `--mw-ink` are theme-aware surface tokens; use the fixed brand tokens when a design needs paper or ink to stay unchanged in dark mode.

## Contrast and state

Normal text pairs meet WCAG AA at 4.5:1. Non-text control boundaries and focus indicators target at least 3:1 against adjacent surfaces. The package contrast test calculates luminance from token values for both light and `.dark` mappings. Do not use white text on `#ff2e88`; use `--mw-on-pink` (`#0d0d0d`). Use `--mw-on-accent` for yellow. Error/destructive feedback uses the error semantic, not the brand magenta. Status and chart meaning must not depend on color alone; include labels, shapes, markers, line style, or an accessible data table.

## Typography

| Token               | Stack                              | Use                                     |
| ------------------- | ---------------------------------- | --------------------------------------- |
| `--mw-font-brush`   | Road Rage, Impact fallback         | Short expressive headings and ribbons   |
| `--mw-font-display` | Anton, Impact fallback             | Metrics, section titles, compact labels |
| `--mw-font-sans`    | Space Grotesk, system fallback     | Body, navigation, controls, tables      |
| `--mw-font-mono`    | JetBrains Mono, monospace fallback | Technical IDs, timestamps, code         |

Fonts are self-hosted by the consuming app from `@moonwitness/assets/fonts.css`; no remote font request belongs in this stylesheet. Road Rage is subsetted for short editorial headings. Do not fake unavailable font weights. Keep meaningful text readable if a font fails or loads late.

## Layout, material, depth, and motion

Use `--mw-space-*` for general spacing; `--mw-panel-gap-compact`, `--mw-panel-gap-comfortable`, and matching panel padding for dense editorial panels. `--mw-frame-width` and `--mw-torn-safe-inset` reserve room for textured edges; focus outlines must remain visible outside that inset. `--mw-decorative-rotation` is for notes, tape, stickers, or artwork only. Keep controls, body copy, tables, charts, and data panels aligned.

Use the shared radius, hard-shadow, layer, and motion tokens rather than introducing local scales. Motion uses `--mw-motion-fast` (120 ms) for control feedback, `--mw-motion-normal` (160 ms) for overlays and toast entry/dismissal, and `--mw-motion-slow` (220 ms) for a single decorative entrance. Use `--mw-motion-ease` for standard movement and `--mw-motion-ease-emphasis` only for brief decorative emphasis. `--mw-motion-draw`, `--mw-motion-delay`, and `--mw-motion-effect` define finite underline and speed-line accents. The `--mw-motion-pulse`, `--mw-motion-progress`, and `--mw-motion-spin` durations belong only to their matching loading/effect patterns. The fixed cream and ink tokens support paper scraps and dark ink against a Board dark theme. Halftone and speckle belong on a non-interactive decoration layer; they must not reduce text contrast or intercept pointer/focus.

The `.dark` class remaps semantic page/surface tokens while retaining fixed brand paper, ink, and accents. Theme persistence and selection are app-owned. Under `prefers-reduced-motion: reduce`, transition duration tokens become zero; components and app-specific effects must also disable keyframes and preserve state information without movement. Loading indicators may become static while their textual status remains visible.

The token stylesheet has no global element selectors, external font requests, framework dependencies, or application side effects.
