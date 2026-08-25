# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Zoho CRM widget**: a single-page sales dashboard ("Lead Performance 360") built from a
whiteboard spec. Vanilla ES5-style JS, no build step, no framework, no npm dependencies —
three files (`index.html`, `style.css`, `script.js`) that also happen to be the deployable
artifact. It is designed to run as a **CRM Home page component**.

There is no test suite, no linter, and no package.json. Verification is done by rendering the
page and looking at it (see below).

## Commands

```bash
# Package for CRM. Produces two zips because the two uploaders want different layouts:
#   build/LeadPerformance360-widget.zip          flat, index.html at root
#                                                -> Setup > Developer Hub > Widgets
#                                                -> page path /index.html
#   build/LeadPerformance360/dist/*.zip          ZET layout, files under app/
#                                                -> Sigma extension flow
#                                                -> page path /app/index.html
./build-widget.sh

# Syntax check (the only "lint" available)
node --check script.js

# Render and inspect — this is the primary verification loop
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --no-sandbox --hide-scrollbars --force-color-profile=srgb --virtual-time-budget=9000 \
  --window-size=1440,1560 --screenshot=/tmp/out.png "file://$PWD/index.html"

# Assert the page actually rendered (12 tiles, 6 charts)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --no-sandbox --virtual-time-budget=8000 --dump-dom "file://$PWD/index.html" \
  | grep -o 'class="lp-tile"' | wc -l
```

To exercise interactions headlessly, write a temporary copy of `index.html` with an injected
`<script>` that dispatches real `PointerEvent`s / `.click()` after ~2.6s, screenshot that, then
delete it. Synthetic `pointerdown`+`pointermove`+`pointerup` drives brush-zoom; `pointerdown`+
`pointerup` without travel drives drill-through. `grep -c` counts *lines*, not occurrences —
use `grep -o ... | wc -l` for element counts.

## Delivery

- **GitHub Pages** — `https://sridhanalakshmi-k-22712.github.io/Lead-Performance-360/`
  redeploys automatically on push to `main`. Serves from the repo root, which is why the app
  files must stay at the root and `build-widget.sh` stages *copies* rather than restructuring.
- **CRM widget** — upload the flat zip. This is the real target.
- Catalyst was previously a delivery target and has been **abandoned**. Do not re-add it.

## Architecture

`script.js` is one IIFE with numbered sections; the header comment lists them. The important
structural facts, none of which are obvious from a single file read:

**Data flows one way: `fetchData` → a single fixed object shape → renderers.** That shape is
documented in `§ 4.1` and is the contract for the whole file. Renderers never learn where data
came from. `§ 4.3` provides seeded (deterministic) mock data; `CONFIG.useMockData` switches
between mock and live.

**Live data comes from Zoho Analytics via a CRM Connection**, never a token in this file. `§ 4.2`
holds `invokeAnalytics` (calls `ZOHO.CRM.CONNECTION.invoke` — CRM stores/refreshes the token
server-side) and `mapAnalyticsRows`. Config lives in `CONFIG.analytics` in `§ 1`, including a
`columns` map from the dashboard's measure names to the customer's Analytics column names.

**`mapAnalyticsRows` indexes rows by month value, not arrival order.** Analytics returns rows
unordered and omits months with no activity. Pushing in arrival order would shift every later
month one slot left and silently corrupt the trend. Rows sharing a month (several owners or
regions) accumulate for additive measures; measures listed in `POINT_IN_TIME` (pipeline,
overdue, forecast, the rates) take the latest month's value instead, because summing twelve
months of open pipeline is meaningless.

**The month axis is derived from the clock, never hardcoded.** `ytdMonths(year)` returns
Jan→current month for the current year, Jan→Dec for past years, so new months appear on their
own. Everything month-based reads from it. `VIEW.range` is a brush-zoom window into that axis
and is shared by every month chart, so zooming one chart zooms them all. Quarterly opts out
(`zoomable: false`) because quarters are not on the month axis.

**Chart type is per-card state that survives re-render.** `CHART_TYPE[spec.key]` (`§ 5.2`) is
keyed by card, so a filter change, zoom, or overlay toggle does not reset the reader's choice.
`draw()` dispatches on it to `drawOverlay` / `drawBars` / `drawPanels`.

**Which chart forms a card may offer is constrained by its units, not by taste:**
- Series sharing a unit → line / area / grouped bars.
- **Mixed units → faceted panels only** (`PANEL_TYPES`). Revenue/Customers/Leads have
  incompatible scales, so *no* option puts them on one axis. **There is no dual-axis code path
  in this file and adding one would be a regression.**
- Part-to-whole forms (`stacked`, `share`, `stack-area`) are offered *only* where the parts sum
  to a meaningful whole — channel mix. Booked + churned is not a total.

**Analysis overlays adapt per form.** `VIEW.compare` / `.target` / `.trend` are global toggles.
On lines they draw as dashed strokes; on bars as ghost columns behind and bullet-style ticks
across the caps. `supportsOverlays()` suppresses them on stacked forms where they'd be
meaningless. Each active overlay adds a legend key so its encoding is decodable.

**Rendering is measured, not assumed.** Charts read `host.clientWidth`, so `mount()` only
registers a chart and `drawAll()` draws after the cards are in the document — drawing at mount
time yields width 0 and renders nothing. `redrawAll()` re-draws on resize.

**Colours come from CSS custom properties**, read at draw time via `cssVar()`. The categorical
ramp is CVD-validated: only slots 1–3 (`blue`, `orange`, `aqua`) are used, and slot 4 (violet)
is deliberately never placed beside slot 1 (blue) — that pair measures ΔE 2.1 under
deuteranopia. Colour follows the *entity* (see `HUE`), so muting a series never repaints the
others. Light mode only.

## Boot sequence (subtle, previously a bug)

`boot()` runs straight from `DOMContentLoaded`. **Nothing in the first render may depend on the
CRM SDK.** The SDK is loaded `async` and `whenSdkReady()` polls for it; `PageLoad` then only
*refines* things — org currency (`adoptOrgCurrency`, re-renders only if different), the
signed-in user, and `resizeWidget()`. An earlier version gated `boot()` behind `PageLoad` with a
1.5s fallback, which meant every load outside CRM sat blank for the full 1.5s, since `PageLoad`
only fires inside CRM.

`detectEmbedded()` sets `.lp-embedded` on `<html>` *before* first paint when the page is framed.
In that mode the padding tightens and the `<h1>` is hidden, because the CRM host component
already draws a padded card with its own title bar.

## User scoping

The Scope filter resolves against the live CRM session, not a literal value: `loadCurrentUser()`
and `loadTeam()` (direct reports via `Reporting_To`) populate `CRM`, and `buildCriteria()` turns
"mine"/"team" into owner-email clauses. A dimension set to `"all"` contributes **no clause** —
never a clause matching the literal string `"all"`.

## Conventions

- Match the surrounding ES5 style: `var`, `function`, no arrow functions or template literals.
- Series/category names may come from an API — insert them with `textContent`, never
  `innerHTML`.
- A missing value is `null` and renders as a gap or `–`; it must never become `0`.
- An author `display` beats the UA's `[hidden] { display: none }`, so `[hidden]` is forced
  globally in `style.css`. Any new flex/grid element that relies on `hidden` needs that rule.
- `getComputedTextLength()` returns 0 on a detached SVG. Reserve a fixed gutter instead of
  measuring text before the SVG is in the document.
- `CONFIG.regions` / `CONFIG.businessUnits` / `CONFIG.services` are placeholder dimension
  values awaiting the customer's real ones.
- **Filters travel as one object.** `state` *is* the filter set and is passed straight to
  `fetchData(f)` / `buildCriteria(f, yearOverride)` / `mockData(f)`. It used to be positional
  args, which hit five parameters and was collapsed; do not go back to adding parameters.
  Adding a flat dimension now means: the `CONFIG` value list, the `analytics.columns` entry,
  one row in `buildCriteria`'s pair list, a `mockData` multiplier, a `state` key, the
  filter-wiring array in `§ 8`, and the header slice line. Grep `service` for the set.
- **The people filters are a tree, not a list.** `buildHierarchy()` indexes CRM users by
  `Reporting_To` and sorts them into BU heads / managers / reps. Tiers come from
  `CONFIG.hierarchy` role names when set; otherwise they are derived — no reports is a rep,
  all-individual reports is a manager, at least one report who manages people is a BU head.
  That last rule is deliberate: keying off "sits at the top of the tree" instead misclassified
  every front-line manager as a BU head.
- **`resolveOwnerEmails()` collapses all people filters to one owner set, most-specific-wins**
  (rep > manager > BU head > Scope). Intersecting them instead can yield an empty result that
  reads as "no business" rather than "contradictory filters".
- Outside CRM there are no users, so `mockPeople()` synthesises an org (2 heads, 4 managers,
  12 reps) and the people filters stay live rather than becoming dead controls.
