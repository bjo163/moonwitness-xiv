# `@moonwitness/assets`

Framework-independent visual assets for MoonWitness. The package has no runtime dependencies; React icon wrappers belong in `@moonwitness/ui`.

## Generate and export

The published package contains generated assets, the manifest, license provenance, and usage documentation. In the MoonWitness repository, maintainers can run `pnpm assets:generate` to regenerate SVG files, Road Rage's display subset, responsive artwork crops, original short interface cues, and the manifest; `pnpm assets:render` to render brand, artwork, icon, and illustration proofs with repository Playwright Chromium; `pnpm assets:validate` to check that files under the asset directories exactly match `manifest.json` (except the four separately listed OFL license texts), along with SVG integrity and sound provenance; and `pnpm assets:check:bounds` to verify rendered SVG geometry against each `viewBox`. Font subset source, license, and hashes are cross-checked against `licenses.json`. The social-card orbit rings are the only intentional bleed and are explicitly listed in that check. `sharp` and `subset-font` are build-only tools, not runtime dependencies.

Consumers can import a static asset through a package export, for example:

```text
@moonwitness/assets/brand/moonwitness-lockup-dark.svg
@moonwitness/assets/brand/favicon.svg
@moonwitness/assets/icons/partner.svg
@moonwitness/assets/illustrations/empty-light.svg
@moonwitness/assets/sounds/ui-success.wav
@moonwitness/assets/manifest.json
@moonwitness/assets/licenses.json
@moonwitness/assets/fonts.css
```

The crown and brush wordmark master is `brand/source/moonwitness-master.svg`. Brand variants and favicon are generated from its editable vector paths; they do not rely on live font rendering. Review the variants in `docs/design/assets/brand-contact-sheet-current.png`.

The icon inventory uses 24×24 SVG viewBoxes, a 1.8-unit rounded stroke, and `currentColor` for inline/themeable consumers. For standalone `<img>` usage the SVG uses the browser's default current color; use the React wrappers in `@moonwitness/ui` when it is necessary to inherit an element color. The scale/theme contact sheet is at `docs/design/assets/icon-contact-sheet-current.png` in the repository.

Illustration exports cover empty, no-results, no-activity, access-denied, not-found, offline, onboarding, and an orbit pattern in light and dark variants. Original manga artwork masters are retained in `source/artwork`; optimized desktop, mobile, and Board masthead WebP exports are generated into `illustrations/`. Review their focus and quality in `docs/design/assets/artwork-contact-sheet-current.png`. Keep user-facing instructions and actions as real text and controls; do not rely on the illustration alone to communicate a state.

Variant suffixes describe the intended foreground palette and assume a transparent background unless the SVG is a banner/card/icon with its own surface. `mono-light` is dark ink for light surfaces; `mono-dark` is paper ink for dark surfaces. Use a lockup when there is enough room, and the symbol/favicon for compact spaces. Do not recolor by string replacement; generate from the shared palette definitions.

The `sounds/` directory contains very short original PCM interface cues with project-authored provenance. The UI package owns their named catalog, interaction gate, mute preference, and lazy playback. Do not call audio files directly from product components.

SVG sources use built-in paths and have no external image/font references. The Board imports the package's local font stylesheet, so runtime rendering and visual tests do not depend on an external font CDN. Bundled fonts include Latin and Latin-ext subsets where available; Road Rage is retained as an upstream TTF source and subset to a small local WOFF2 for expressive headings. SIL Open Font License texts, file hashes, and source provenance are recorded in [`licenses.json`](./licenses.json).
