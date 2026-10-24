# ADR 0002: Use a standalone Vite app for the UI catalog

- Status: accepted
- Date: 2026-10-05
- Decision owners: MoonWitness maintainers
- Related roadmap: M5.16, M5.17, M6.06, M6.07

## Context

The shared UI package needs an interactive reference that exercises its public
exports with real focus, keyboard, theme, and responsive behavior. The catalog
must build to static files below the repository Pages path and must not require
application credentials, API access, or test data. The documentation portal and
Pages publisher are separate roadmap work and have not been activated yet.

## Decision

Keep the catalog as the private workspace app `@moonwitness/ui-catalog` under
`apps/ui-catalog`. Use Vite and React already used by the Board, import only
public `@moonwitness/ui` component/icon subpaths, and load the package's shared
token and component stylesheets. Build by default with the repository Pages
subpath `/moonwitness-xiv/components/`; allow preview environments to override
that path with `MW_UI_CATALOG_BASE_PATH`.

Use Playwright against the built preview for deep-link, small-screen, theme,
keyboard, dialog focus-restoration, tabs, and sample interaction checks. The
catalog uses deterministic fabricated content and makes no API requests. Its
static output is `apps/ui-catalog/dist`, which the future docs/Pages artifact
workflow may consume. This decision does not configure Pages or publish the
catalog.

## Alternatives considered

- **Storybook:** offers a mature story authoring model, but this package does
  not need addon/plugin infrastructure or a second documentation framework yet.
  Its additional builder/configuration is not justified by the current catalog
  scope.
- **Board route:** would couple public package documentation to authenticated
  product navigation, API setup, and application styling.
- **Hand-written static HTML:** cannot exercise the actual React component
  exports or their accessible interaction behavior.

## Consequences

- The catalog stays a small, independently buildable static workspace app and
  proves package imports from a consumer context.
- Component examples and browser checks are explicit and easy to review. Add
  stories when a public component is introduced or its interaction contract
  changes.
- The catalog CSS may map utilities to shared tokens but may not define a
  second brand palette or copy package component implementations.
- CI visual regression, accessibility automation, and bundle budgets are
  tracked separately under M5.17. GitHub Pages artifact publication and
  settings remain M6.07.
