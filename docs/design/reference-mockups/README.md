# Board reference mockups

Non-normative design input. These three concept mockups describe the intended look of the logged-in
MoonWitness Board surfaces. They are stored here so the visual direction has a durable source instead
of loose files in `docs/`.

They are **not** implementation baselines: no test, screenshot comparison, or CI gate reads this
folder, and the docs portal does not publish it because `docs/guide/navigation.json` lists no target
here. Where a mockup and a normative document disagree, the normative document wins
(`docs/design/visual-direction.md`, `docs/design/tokens.md`, `docs/design/components.md`).

| File                                                               | Surface                  | What it shows                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`board-dashboard-the-empire.png`](board-dashboard-the-empire.png) | Dashboard (`The Empire`) | Post-login landing: five KPI tiles (active projects, creative queue, research signals, drafts ready, publishing status), active project cards with progress, recent activity, and three list panels below.                                                   |
| [`board-mission-control.png`](board-mission-control.png)           | Mission Control          | Command-center view: module entry cards (Story Forge, Poster Lab, Research Lab, World Monitor, Publishing Hub, Automation Center, Source Verification), a radial signal graph in the centre, plus project universe, active workflow, feed, and alert strips. |
| [`board-project-universe.png`](board-project-universe.png)         | Project Universe         | Project library: status filter tabs with counts, project cards carrying tags/progress/asset counts, a universe overview stat block, and a project tag cloud.                                                                                                 |

## How to read them against the current system

- Sidebar navigation, the notification bell, and the creator identity block match the Board shell
  already implemented in `apps/board`.
- Iconography in the mockups is illustrative. Any icon actually shipped must come from the canonical
  `@moonwitness/ui` icon set through the asset generator, which is the open item recorded in
  `todo-ui.md` section "SVG canonical dan React wrappers".
- Density, card chrome, and the hand-drawn surfaces are the maximal expression of the brand. The
  normative rule in `docs/design/visual-direction.md` keeps speed lines and brush marks as focus or
  brand accents rather than page-wide decoration.
- The auth-side sibling reference stays at `docs/Moonwitness_ Enter the Shadow-Login.png`; that path
  is cited by a closed backlog item in `todo-ui.md`, so it is intentionally not moved here.

## Provenance

Three local working files (`mission control.png`, `project board.png`, `empire board-after-login.png`)
sat unreferenced at the `docs/` root. They were renamed to kebab-case, stripped of spaces, and
collected in this folder on 2026-10-25. Original author and generation toolchain were not recorded by
the contributor, so treat them as internal concept references only and do not publish or redistribute
them as brand assets without a licensing review.
