# MoonWitness UI component catalog

The catalog is an interactive consumer of the public
[`@moonwitness/ui`](../../packages/ui/README.md) API. It demonstrates all 21
public component modules, representative typed icons, theme tokens, long labels,
form errors, empty/loading/error states, and the real Radix keyboard flows.
Examples use fabricated data and do not contact the API or require credentials.

## Run and build

```sh
pnpm --filter @moonwitness/ui-catalog dev
pnpm --filter @moonwitness/ui-catalog build
pnpm --filter @moonwitness/ui-catalog test
```

The static preview base defaults to `/moonwitness-xiv/components/`, matching the
repository-name subpath used by GitHub Pages. Override it with
`MW_UI_CATALOG_BASE_PATH` when testing another mount path. Browser tests serve
the built output at that nested path and check responsive layout, theme
switching, filtering, fragment navigation, tabs, and dialog keyboard/focus
behavior.

`pnpm test:ui-catalog` also runs WCAG 2.1 A/AA scans in light and dark themes
and checks a representative layout/token baseline. Review a changed visual
contract JSON before updating it with `pnpm ui:visual:update`; desktop/mobile
screenshots are retained as CI artifacts. `pnpm test:ui-budget` checks that
bundled JavaScript stays below 512 KiB raw / 160 KiB gzip and CSS below 64 KiB
raw / 16 KiB gzip.

The build output is `apps/ui-catalog/dist`. The docs portal build includes this
output at `/components/` and links it from the Project navigation. GitHub Pages
publication and trusted-source activation are tracked separately in M6.07. See
[ADR 0002](../decisions/0002-ui-catalog.md) for the framework choice.
