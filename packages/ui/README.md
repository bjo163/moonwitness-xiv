# MoonWitness UI Bible

This is the single design and implementation rulebook for `@moonwitness/ui`. `TOKENS.md` records the token contract and contrast requirements. `todo-ui.md` tracks implementation work; it is not a second source of design rules. Product copy and feature truth stay in the app.

## Art direction from the references

- **Reference 1** supplies detail language for the homepage: story cards, captions, notes, orbit paths, moon phases, arrows, and collage fragments.
- **Reference 2** is the homepage composition: narrow masthead, dominant manga city hero, three editorial panels, connection/map band, illustrated process strip, and a high contrast closing CTA.
- **Reference 3** guides the internal story workbench: navigator on the left, readable editor/preview in the center, and a compact inspector on the right.
- **Reference 4** guides the Board shell: brand masthead, persistent left navigation, metric strip, and dense operational panels.
- **The supplied “Enter the Shadow” login reference** guides the authentication composition: at desktop widths, keep the crown/brush header above a left-side ink form and right-side moon/city artwork; on mobile, show a deliberate artwork crop before the form without covering its controls. Use the canonical brand lockup and shared `Panel`, `Label`, `Input`, `Button`, and `LoadingSpinner`. Keep headline, labels, helper text, errors, and submit status as accessible HTML. While auth is pending, disable the submit action, set `aria-busy`, and keep an explicit “Entering the shadow…” or “Creating account…” label beside the decorative spinner. Treat “Remember me”, “Forgot password?”, and footer links as concepts to verify against real product behavior; never add unsupported auth features.

The shared visual vocabulary uses ink black, warm paper, brush lettering, manga/city artwork, rough frames, tape, halftone, hand marks, and deliberate magenta, cyan, and yellow accents. It should feel assembled and editorial rather than like a clean admin template with a dark background. Artwork creates atmosphere; HTML remains responsible for every heading, label, number, control, and status. Do not use a complete mockup screenshot as a page background.

Use `Road Rage` (`--mw-font-brush`) for short expressive headings, `Anton` (`--mw-font-display`) for compact section labels and large metrics, `Space Grotesk` (`--mw-font-sans`) for controls and prose, and `JetBrains Mono` (`--mw-font-mono`) for technical identifiers and timestamps. Brush lettering is not for paragraphs, long titles that must wrap predictably, or dense data. Check localized copy with Indonesian diacritics, long compound words, punctuation, and numeric formats at narrow widths; allow prose to wrap without forcing the page to overflow. Every local face must retain its system fallback stack so copy remains legible if a font request fails. Keep first viewport geometry flexible and validate delayed font swaps against the catalog layout-shift budget (`CLS < 0.1`). The logo is custom vector artwork and does not depend on a font at runtime.

## Brand and imagery

The crown and hand-drawn `MOONWITNESS` mark are the current primary identity. The editable canonical SVG source is `@moonwitness/assets/brand/source/moonwitness-master.svg`; generated symbol, wordmark, lockup, favicon, and social assets must be rebuilt from this source. Do not recreate the old crescent as a competing primary mark. Use a lockup where it fits, the crown symbol in compact rails, and the simplified favicon at tiny sizes. Keep clear space around the mark at least equal to the crown's central spike height; never stretch or rotate the logo. For digital use, keep the crown at least 16 px high and the wordmark at least 20 px high; below that, use the simplified crown favicon.

In the Board shell, pair the compact crown with a readable `MOONWITNESS` wordmark in the sidebar header. Mark the crown decorative when adjacent text already names the product. The active navigation item uses a straight magenta rail and a rectangular accent surface with `aria-current="page"`; preserve the readable dark foreground, keyboard focus, and a no-tilt treatment. Use the same compact lockup in the mobile navigation sheet.

Canonical interface icons live in `@moonwitness/assets/icons` on a 24×24 grid and are generated as individually imported typed React wrappers by the UI package. Interactive icons must have a recognizable action and accessible name via their control; decorative marks are separate, hidden from assistive technology, and cannot take focus or pointer input. Never paste inline SVG paths into app screens or substitute Unicode glyphs for a canonical icon.

Application code imports icons from the public `@moonwitness/ui/icons/*` subpaths; it does not import third-party icon libraries directly. When an action or concept has no matching canonical symbol, add a provenance-recorded SVG to the assets package and generate its typed wrapper before migrating the consumer. Reuse an existing icon only when both its meaning and silhouette fit the call site. Loading feedback belongs to a shared loading component/effect, not an unrelated icon glyph.

Complex manga scenes and collage art are optimized raster assets. Keep editable high-quality masters and provenance in the assets package; export WebP crops for desktop, mobile, and masthead use. Every image has an intentional focal crop and is marked decorative or given accurate alt text. Never generate embedded UI copy, statistics, logos, or fake product controls into artwork.

Material assets include torn edges, ink frames, paper notes, tape, halftone, speckle, and hand-drawn arrows. Keep texture on a decorative layer with `pointer-events: none`; it must not lower text contrast, cover a focus ring, or make a control's click target irregular. Prefer deterministic SVG/CSS pattern assets and restrained opacity over repeated expensive filters. Rendered brand marks, interface icons, and other SVG content must remain inside their `viewBox`; intentional decorative bleed must be named and documented, as with the orbit rings on the social card.

Interaction icons have one canonical vector source in `@moonwitness/assets/icons`; `@moonwitness/ui/icons/*` wrappers are generated from those SVGs and must never be hand-maintained copies. Choose an icon by meaning and silhouette, use a public typed export, and add a canonical source only when the existing set has no appropriate symbol. Icons are decorative by default; controls still need visible text or an accessible name. Keep decorative doodles out of interaction icon slots. Review the icon contact sheet at 16, 20, 24, and 32 px on both light and dark surfaces before accepting a new symbol.

## Decoration intensity

| Surface                             | Intensity        | Allowed treatment                                                             |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| Public hero / closing CTA           | Expressive       | Large art, layered brush headings, torn color strips, a few notes and doodles |
| Editorial cards / catalog specimens | Balanced         | One image, one accent, light frame texture, concise caption                   |
| Board table / workbench / forms     | Restrained       | Strong hierarchy, small accent marks, mostly square readable panels           |
| Errors / access / empty / loading   | Functional first | Clear state text and action; illustration or motion stays secondary           |

Do not rotate tables, forms, paragraphs, dashboard figures, or interactive panels. Tiny rotation belongs only to non-interactive paper notes, tape, and artwork. A motif that decorates a hero should not be repeated behind every row of a dense dashboard.

## Component layers and ownership

Build upward only where repeated behavior requires it:

1. **Foundation** — semantic color, typography, spacing, shape, depth, layer, and motion tokens in `styles/tokens.css`.
2. **Primitive** — one accessible behavior: `Button`, `Input`, `Checkbox`, `SelectField`, `Textarea`, `Badge`, `Avatar`, `Switch`, and `Skeleton`.
3. **Composition** — reusable arrangements: `Field`, `Panel`, `Toolbar`, `Table`, `Pagination`, `PageHeader`, `Dialog`, and `EmptyState`.
4. **Pattern/effect** — reusable editorial frame, ribbon, note, artwork frame, signal motif, progress state, compact `LoadingSpinner`, and sound behavior. Use the spinner only while its associated action is pending; keep an accessible action label on the control and honor reduced motion.

`@moonwitness/ui` owns presentation and reusable interaction mechanics. `@moonwitness/assets` owns source and generated media, fonts, sounds, inventory, and provenance. Neither package owns app routes, auth, API access, permission, persisted product data, analytics meaning, or workflow rules. A component belongs in the shared package when multiple surfaces need it, or one surface needs an accessibility primitive that cannot safely be duplicated.

Use the shared `SignalOrbit` for a quiet, decorative connection motif around content such as the homepage relationship band. Keep orbit rings and nodes outside interactive targets, hide them from assistive technology, and do not use them to imply live locations, counts, or product data. Keep opacity low enough that orbit lines never compete with text.

Import through public subpaths such as `@moonwitness/ui/components/button`, `@moonwitness/ui/icons/search`, and `@moonwitness/ui/components.css`. Never import `dist` or package internals. Import styles once with tokens before component styles. Board pages must use shared buttons, inputs, selects, textareas, checkboxes, and shared table compositions; do not add new raw native JSX controls. Preserve the existing controlled state, labels, validation, disabled behavior, keyboard use, file input behavior, indeterminate checkboxes, sorting, and row propagation.

`Button asChild` preserves the child link's navigation semantics. When disabled, it sets `aria-disabled`, removes the child from sequential keyboard focus, and suppresses click/Enter/Space activation—including child click handlers. Prefer a real button with `disabled` when the action does not navigate.

Use `Table`'s optional `scrollLabel` when a table can overflow horizontally. It makes the overflow wrapper a named, keyboard-focusable region while leaving the nested native table semantics intact. When the region itself is focused, Arrow Left/Right pans and Home/End moves to either edge; controls inside the table retain their normal key behavior. The whole page must not acquire horizontal overflow.

Consumers that compile Tailwind utilities must include both the UI package source and built `dist` files in Tailwind's source scan. Otherwise utility-based shared primitives such as Sheet and Dialog can render in the DOM without their required position, overlay, or responsive styles. The Board and UI Catalog stylesheets show the required source paths.

When adding a component: first record its behavior and accessibility contract; build it from existing tokens and helpers; expose a narrow public subpath; add a catalog specimen and relevant package checks; then use it from the product surface. Do not add a duplicate “manga” component when an existing primitive can accept a visual treatment.

## Accessibility, responsive behavior, and states

Dialog centering must be defined in one place. `DialogContent` already applies Tailwind's individual `translate` utilities; shared CSS must not apply a second `transform: translate(...)`, which compounds the offset and can move mobile dialogs outside the viewport. Verify dialog bounds at narrow widths and preserve visible truncation for long metadata inside command items.

- Body text, data, and control labels stay high contrast. Normal text pairs meet WCAG AA (4.5:1); focus and non-text boundaries target at least 3:1 against adjacent surfaces. Saturated pink, cyan, and yellow are accents; use their paired dark foreground for text.
- `SectionRibbon` declares `surface="paper|ink"`; its accent number chooses a theme- and surface-readable color rather than relying on the bright accent over every background.
- Every keyboard-operable control has a visible `:focus-visible` treatment that remains above rough frames and texture. Headings retain semantic order; decorative art is ignored by screen readers.
- Status uses text and shape as well as color. Charts keep labels, markers or an accessible table.
- Desktop composition may be dense; mobile must be deliberately reordered. Navigation collapses into an operable menu/sheet, side inspectors become sheets or accordions, card rows stack, and tables own their horizontal scroll region. At 200% zoom content must remain reachable without whole-page horizontal overflow.
- A horizontally scrolling editorial filmstrip has a named, keyboard-focusable region, visible focus, Arrow Left/Right movement, and Home/End navigation. Include concise screen reader instructions; keep the scroll inside the strip, and use instant movement when reduced motion is requested.
- Controls retain a stable hit area behind brush-shaped visuals. Do not let torn edges create inaccessible click targets.
- Distinguish loading, refreshing, empty, zero, unavailable, and failed data. Loading UI appears only while a real operation is pending, always describes it in text, and stops when it settles. Keep user work and a retry action after recoverable failure.

## Motion and sound

Motion is brief, purposeful, and never required to understand a state. Use shared motion tokens for hover/press feedback, active navigation markers, overlays, and status transitions. For a card that contains a real action, opt into the shared `mw-ui-interactive-surface`, `mw-ui-interactive-marker`, and `mw-ui-interactive-title` classes; set `--mw-interactive-accent` to a semantic brand accent. Hover motion is available only to hover-capable pointers when reduced motion is not requested. Keep keyboard focus visible and preserve a static focus-within border. Toast entry/dismissal uses the normal motion token; the shared host provides a visible close action and semantic success/error colors. The homepage hero may reveal its HTML copy once over the 220 ms slow-motion token; do not animate the headline as artwork or delay its content under reduced motion. LoadingSpinner and progress indicators animate only while a real operation is pending; their text labels carry the state. Animated UI primitives use the internal `useAnimationVisibility` observer to pause CSS animation while offscreen and resume it when visible; keep this behavior on spinners, progress, skeletons, and decorative effects. Respect `prefers-reduced-motion` in CSS and JavaScript by stopping nonessential movement and leaving a legible static state. Avoid perpetual parallax, animated texture, or hidden/off-screen work. Effects never intercept input. Keep focus rings and hit areas stable through transitions. Prefer CSS/SVG; add canvas/WebGL only for a measured need with an explicit performance budget. Screenshot checks should use deterministic content and avoid capturing midway through unrelated transitions.

Use `SoundProvider`, `useSfx`, and `SoundToggle` from the audio public subpath. Default to muted. Sound is available only after a user interaction and an explicit unmuted preference, stored locally. Load a named short cue only when an approved success, important alert, or explicit media action occurs. Never sound on hover, scrolling, or every click. Allow one cue to play at a time; drop new cues while the current cue is active. Release the playback slot after completion or failure. Audio failure cannot affect the product action, and visual/text status remains complete when sound is unavailable.

## Quick visual examples

| Prefer                                                                           | Avoid                                                                               |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A short brush heading such as “FOLLOW THE SIGNAL”, with body copy in the UI font | Brush lettering for a paragraph, long record title, or dense table                  |
| Dark ink text on yellow and a visible focus ring outside the rough frame         | White text on saturated pink, or a torn edge that hides keyboard focus              |
| Halftone on a separate decorative layer with `pointer-events: none`              | Texture baked over labels, controls, or information that needs to remain selectable |
| Explicit “No data available” or an error message with retry                      | Replacing missing, zero, or failed values with an invented metric                   |
| A chart with labels and a text/table alternative                                 | A chart that communicates meaning through color alone                               |

## Review against the mockups

Before calling a visual change complete, compare an implementation screenshot with the supplied reference at the same viewport. Check, in order: overall silhouette and density; hero/artwork scale and focal point; type scale and wrapping; paper/ink material; section spacing; then icons, captions, badges, arrows, notes, focus and responsive details. Record remaining visible gaps and review them again after corrections. A green build, a neon palette, or added noise alone does not establish visual similarity. Do not report a numeric “similarity score” for AI mockups.

Use real product copy and data on production pages. Dashboard percentage trends require historical comparison data; otherwise show the current value and its label without an invented change. The mockups are visual direction, not evidence that public stories, crew directories, a publishing pipeline, audience metrics, or live location maps exist. Fictional examples are allowed only in the UI Catalog and must say “contoh desain”.

## Checks

- `pnpm board:ui:check` enforces shared native controls and public package paths across Home and Board. It catches structural rules, not subjective visual quality.
- `pnpm test:ui`, `pnpm test:assets`, and the existing UI Catalog screenshot tests check reusable behavior and generated sources.
- Visual acceptance uses reviewed screenshots and responsive specimens. The same deterministically rendered catalog examples are the visual regression surface.

See [`TOKENS.md`](./TOKENS.md) for semantic token values, theme behavior, typography, and contrast targets. See repository [`todo-ui.md`](../../todo-ui.md) for the phased execution checklist and its current evidence.
