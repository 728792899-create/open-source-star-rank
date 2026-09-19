# Prototype Instructions

## Selected design, 2026-09-19

The user selected option 1's sidebar/search/filter/ranking layout combined with option 3's warm ivory background, orange accent, rounded surfaces and friendly visual style. Recreate `evidence/visual-target.png`, the Image Gen fusion of those exact two options. This directory is a standalone React UI prototype within the main repository. The production Astro site remains in `../../site`. Keep demo snapshots explicitly labeled, and do not claim that prototype changes modify the production data or authentication. Source synchronization to GitHub is authorized; deployment and real-account operations are separate tasks.

## Authorized audit improvements, 2026-09-19

The user requested fixes and optimization after the UI audit. Preserve the selected desktop visual language while improving narrow-screen readability, comparison feedback, data semantics, and load weight. Mobile layout and panel contents may depart from the original image to address these findings.

- Start with empty favorites and comparison selections. Favorites persist only in this browser using a versioned localStorage record; do not imply cloud synchronization. Handle unavailable storage without crashing.
- Filters, detail panels and comparison choices use validated URL state. Preserve navigation and provide a way back from detail to comparison. A shared panel must close to its list in one action.
- Show at most three compared projects, an explicit limit message, official source links, and a differences-only mode. Qualitative summaries have a check date; numerical snapshots and activity remain demonstrative. Do not infer commercial usage rights from license names.
- Include cancellable snapshot loading and clearly marked error/stale/missing/zero/negative/empty examples. Keep timestamps and aggregates consistent.
- Keep the responsive WebP illustration and lazily load expanded panels/charts. The original generated image is retained for provenance.
- Run `npm run build` before `npm test` on a clean checkout, then browser interaction checks and independent review for material UI changes. Record current evidence in `design-qa.md`.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
