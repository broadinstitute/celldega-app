# Future: Celldega.js API notes

Requirements doc for the planned change of `landscape_ist` from positional
arguments to a single options object.

Celldega App is the first substantial **non-Python** consumer of Celldega.js, so
what it actually needs is useful evidence for that redesign. This file records
it.

## Current call site

Exactly one, in [`src/renderer/app.js`](../src/renderer/app.js) — deliberately
isolated so the migration touches one function. `landscape_ist` currently takes
**33 positional parameters**.

## What the app actually passes

| Parameter | Value | Note |
| --- | --- | --- |
| `el` | container element | required |
| `ini_model` | `{}` | see below — must be a bare object |
| `token` | `''` | unused standalone |
| `ini_x`, `ini_y`, `ini_z`, `ini_zoom` | `0, 0, 0, 0` | triggers Celldega's own auto-fit |
| `base_url` | dataset base URL | required |
| `dataset_name` | `''` | |
| `trx_radius` | `0.25` | copied from the gallery embed; never varied |
| `width`, `height` | container pixels | |
| `creds` | `{}` or S3 credentials | only non-default arg after `height` |

## What the app never uses

Everything else defaults: `meta_cell`, `meta_cell_attr`, `meta_cluster`,
`meta_cluster_attr`, `umap`, `nbhd`, `nbhd_edit`, `landscape_state`,
`segmentation`, `view_change_custom_callback`, `rotation_orbit`, `rotation_x`,
`rotate`, `max_tiles_to_view`, `scale_bar_microns_per_pixel`, `base_urls`,
`cell_name_prefix`, `centroids`, `use_adata_3d_centroids`.

The `meta_*` / `umap` / `centroids` parameters exist so the Python widget can
push already-read Parquet bytes through the widget comm. Standalone, Celldega
fetches all of it from `base_url` itself. **They are widget-transport
parameters, not visualization parameters** — a good argument for separating them
from the options object proper, or dropping them from the public signature.

Practical result: of 33 parameters, a standalone viewer needs **7**
(`el`, `base_url`, `width`, `height`, and optionally `creds`, `dataset_name`,
`trx_radius`).

## The `ini_model` trap

`ini_model` must be a **bare `{}`**, not a stub object with a `get()` method.

Celldega branches on `typeof ini_model?.get === 'function'` to decide whether it
is running inside a widget. Passing a plausible-looking no-op stub makes that
check true, so it takes the widget path, reads `undefined` for every trait, and
fails with `Cannot convert undefined or null to object`.

This cost real debugging time and is worth fixing at the source. Options:

- Take an explicit `mode: 'standalone' | 'widget'` rather than inferring it from
  the shape of an argument.
- Or accept `model: null` for standalone and check `!= null` instead of duck
  typing.

Either is better than the current implicit contract, which has no error message
pointing at the actual mistake.

## Suggested migration

```js
landscape_ist({
  el,
  base_url,
  width,
  height,
  creds,          // optional
  view,           // optional; omit for auto-fit
})
```

Keeping the positional form working during the transition is easy — detect an
object in argument position 2 and branch. Given the app pins Celldega to an
exact version, there is no rush: it can migrate on its own schedule.

## Other observations

- **Auto-fit is undocumented.** `set_initial_view_state` falls back to
  `viz_state.spatial`'s center and zoom when `ini_x/ini_y/ini_z/ini_zoom` are
  all `0`. That is exactly what a general viewer wants and it is not obvious
  from the signature — the published embeds all hardcode per-dataset values
  instead. Worth documenting, or exposing as an explicit `view: 'fit'`.
- **`landscape_h_e` takes its arguments in a different order** (`model` first,
  then `el`; `landscape_ist` is `el` first). Worth aligning.
- **No public loader for the DegaFiles metadata.** `matrix_from_dega_files` is
  exported, but there is no `landscape_from_dega_files` equivalent, and
  `objects_from_parquet` is not exported. Fine for the app, since Celldega
  fetches internally — but it means consumers cannot read a dataset's cell
  metadata without rendering it.
