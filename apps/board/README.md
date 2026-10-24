# MoonWitness web app

`apps/board` is the primary Next.js App Router application. It serves the public homepage and the authenticated Board from the same app and origin.

## Run locally

From the repository root:

```sh
pnpm install
pnpm dev:board
```

The web app runs at `http://localhost:5173`. The API is a separate workspace app and must also be running for sign-in and Board data. Configure `DATABASE_URL` and start PostgreSQL/API using the repository [quickstart](../../docs/guide/tutorials/quickstart.md); the API does not create a missing PostgreSQL database for you.

To run both apps together, use `pnpm dev`. Set `NEXT_PUBLIC_API_URL` only when the API is hosted on a different origin; in the normal local and production setup, Next.js forwards API requests to the configured API target.

## Routes

| Route                                          | Purpose                          |
| ---------------------------------------------- | -------------------------------- |
| `/`                                            | Public, server-rendered homepage |
| `/login`, `/register`                          | Authentication                   |
| `/board`                                       | Protected dashboard              |
| `/board/profile`, `/board/settings`            | User profile and settings        |
| `/board/knowledge`, `/board/stories/workbench` | Knowledge and story workbench    |
| `/board/m/:model`, `/board/m/:model/:id`       | Model list and record detail     |

Old Board URLs such as `/profile`, `/settings`, and `/m/:model/:id` redirect to their `/board/...` routes. Login return paths are restricted to local Board routes.

## Shared UI and assets

Use `@moonwitness/ui` for shared controls, composition patterns, semantic tokens, visual effects, and sound controls. The package's [UI Bible](../../packages/ui/README.md) defines component boundaries, accessibility, motion, audio, and the visual direction. Token names and contrast guidance live in [TOKENS.md](../../packages/ui/TOKENS.md).

Use `@moonwitness/assets` for canonical brand marks, SVG icons, illustrations, fonts, and sound files. Add or change assets through its manifest and provenance workflow; do not copy a second editable icon source into this app.

Run the shared-UI gate at any time:

```sh
pnpm board:ui:check
```

The same check runs before push and in quality CI. It reports the file and line, a shared replacement, and the command to rerun when it finds native controls or an internal `@moonwitness/ui/dist` import.

## Build and deployment

```sh
pnpm --filter @moonwitness/board typecheck
pnpm --filter @moonwitness/board build
pnpm --filter @moonwitness/board start
pnpm board:budget
```

The production image runs the standalone Next.js Node server on port `8080`. It forwards `/api`, `/auth`, `/jsonrpc`, `/health`, `/livez`, `/readyz`, `/metrics`, `/notifications`, and `/workflows` to the API service. Set `NEXT_PUBLIC_SITE_URL` to the canonical public origin before building the production image; the build uses it for homepage metadata, sitemap, and robots output.
