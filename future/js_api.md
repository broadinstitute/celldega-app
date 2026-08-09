# Future: Celldega.js API notes

Requirements doc for the planned change of `landscape_ist` from positional
arguments to a single options object.

Celldega App is the first substantial **non-Python** consumer of Celldega.js, so
what it actually needs is useful evidence for that redesign. This file records
it.

---

## Proposed changes to Celldega.js, by how much they would simplify this app

Ordered by the amount of code and debugging they would remove here. Each is
expanded in the sections below.

### 1. Let a visualization size itself — *biggest win*

Accept `width: 'fill'` / `height: 'fill'`, or measure the container when they
are omitted. Celldega knows how tall its own control panel is and that it adds
`height_margin`; every caller currently has to rediscover both.

Today this app computes:

```js
height = window.innerHeight - toolbar_h - CONTROL_PANEL - CELLDEGA_MARGIN - SLACK
//                                        ^^^^^^^^^^^^^   ^^^^^^^^^^^^^^^
//                                        101, hardcoded  100, hardcoded
```

Both constants are internal Celldega values with no accessor. **If either
changes, the Clustergram silently clips** — the column dendrogram simply
disappears below the fold, with no error. Getting this right took many
iterations against a real window. `landscape_ist` already special-cases
`width === 0` into `'100%'`, so the idea is half-present.

**Would delete:** all of the sizing arithmetic, the two magic numbers, the
settle-and-remeasure dance, and the resize handler's re-derivation.

### 2. Don't write inline styles onto the caller's element

`set_constants` does `root.style.height/width = ...` on the element passed in.
Inline styles beat the caller's stylesheet, so `#clustergram { position:
absolute; inset: 0 }` silently did nothing and the element grew to 1660px
inside an 881px wrapper, taking the page's scroll height with it.

Render into a child element Celldega creates, or document loudly that the
passed element is owned and will be restyled. This app now works around it with
a wrapper element Celldega never sees.

**Would delete:** the `#cgm_scroll` wrapper and the comment explaining it.

### 3. Give the views one common controller interface

Every view already returns something useful for linking. No two agree on what,
and none of it is documented:

| View | Returns | Drive it from outside | Report back |
| --- | --- | --- | --- |
| `landscape_ist` | controller object | `update_matrix_gene`, `update_matrix_col`, `update_matrix_dendro_col` | `on_gene_select`, `on_cluster_select`, `on_clusters_select` |
| `yearbook` | `yearbook_api` | `update_gene`, `update_cluster`, `update_page`, `update_query` | `get_query` (pull, not push) |
| `matrix_viz` | `{ obs_store, finalize }` | the raw store — but see below | click callbacks passed *in* as arguments |

Three shapes and three naming conventions for the same two jobs. The same
operation is `update_matrix_gene` on a Landscape and `update_gene` on a
Yearbook. Reporting a selection is a registered callback on a Landscape, a
constructor argument on a Clustergram, and a pull-only getter on a Yearbook.

Every app that links views has to special-case all three. A shared shape —
`select_gene(genes)`, `select_clusters(ids)`, `on_select(cb)` — would let a
caller treat views uniformly, which is exactly what a linking layer wants.

`matrix_viz` is the odd one out in a second way: it returns `obs_store`, which
*looks* like the handle for driving it, but its re-render is triggered by
`model.on('change:selected_genes')` rather than by subscribing to its own store.
So writing to the returned store may well not redraw anything. Either make it
react to its own store, or return a controller like the other two.

### 3b. Return a controller from `matrix_viz`, as `landscape_ist` does

`landscape_ist` returns `update_matrix_gene` / `update_matrix_col` /
`update_matrix_dendro_col`, which is what makes Clustergram → Landscape linking
possible. `matrix_viz` takes click callbacks (out) but returns nothing to drive
it (in), so **linking is one-directional**: clicking a gene in the Clustergram
highlights it in the Landscape, but clicking a gene in the Landscape cannot
highlight it in the Clustergram.

Something like `matrix.select_genes([...])` / `matrix.select_cols([...])` would
close the loop, and the app would need no new concepts — it already routes both
directions through one channel.

### 4. Document the controller that `landscape_ist` returns

It is good API. Nothing announces it, and the parameter list implies the
function only renders. The wrong conclusion — "there is no way to drive a
rendered Landscape from outside" — was reached twice before reading the tail of
the function.

### 5. Take an options object instead of 33 positional arguments

Of 33 parameters this app needs 7. See [Suggested migration](#suggested-migration).

### 6. Correct the AnnData join key in the docs

`obs['cell_id']`, not `obs_names`. Joining as documented matches zero cells
*silently*. See [the section below](#anndata-join-key-use-obscell_id-not-obs_names).

### 7. Smaller things

- Rename `update_matrix_*` → `select_gene` / `select_cluster`: they are
  Landscape methods, and that a matrix calls them is context, not identity.
- Align `landscape_h_e`'s argument order with `landscape_ist` (`el` first).
- `meta.json` in `cgm/` is 2.8 MB against ~50 KB for all five parquet files
  combined; likely per-node metadata that could be slimmer.

---

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

## AnnData join key: use `obs['cell_id']`, not `obs_names`

**Worth fixing wherever this convention is written down — including Celldega.js
and the Python side.**

The documented convention is that DegaFiles `cell_id` joins to AnnData
`obs_names`. In real Xenium `.h5ad` files that is wrong.

Checked against
`Xenium_V1_human_Pancreas_FFPE_outs.h5ad` (122,678 cells), which pairs with the
Human Pancreas demo dataset:

| | value |
| --- | --- |
| `obs_names` (`obs.attrs['_index']`) | `'0'`, `'1'`, `'2'` — a positional range index |
| `obs['cell_id']` | `'aaaadnje-1'`, `'aaacalai-1'` — the actual Xenium ids |
| DegaFiles `cell_metadata.parquet` → `cell_id` | `'aaaadnje-1'`, `'aaacalai-1'` |

Joining on `obs_names` as documented matches **zero cells**, silently — every
cell simply goes unlabelled, which looks like "the annotation didn't work"
rather than "the join key was wrong".

Celldega App therefore prefers `obs['cell_id']` when present and falls back to
the index only when it is absent (`src/anndata_reader.js`). Anywhere else that
performs this join should do the same, and the convention should be documented
as **`obs['cell_id']`, falling back to `obs_names`** rather than the reverse.

Related: the two sides are not the same size. That file has 122,678 cells while
its DegaFiles has 140,702 — a ~12.8% gap — so a partial join is normal and
should be reported, not treated as an error.

## The controller API is good — it is just undiscoverable

`landscape_ist` does not only return a teardown handle. It returns a controller:

```js
landscape.on_gene_select(cb)          // Landscape -> outside
landscape.on_cluster_select(cb)
landscape.on_clusters_select(cb)
landscape.update_matrix_gene(gene)    // outside -> Landscape
landscape.update_matrix_col(cluster)
landscape.update_matrix_dendro_col(clusters)
landscape.update_view_state(...)
landscape.finalize()
```

This is exactly what linked views need, and Celldega App now uses it for
Landscape ↔ Clustergram linking with no upstream change at all.

**The problem is purely that nothing announces it.** The signature gives no hint
that the return value is useful — reading the parameter list suggests
`landscape_ist` renders and that is that. It cost real time to find, and the
wrong conclusion ("there is no public API to drive a rendered Landscape") was
reached twice before reading the tail of the function.

Suggestions, roughly in order of value:

1. **Document the return type.** A `@returns` block naming these methods would
   have removed the whole problem.
2. **Name it in the export.** `matrix_from_dega_files` is exported by name while
   the Landscape controller is only reachable by keeping the return value, which
   makes the two feel like different kinds of API.
3. **Give the Clustergram the same treatment.** `matrix_viz` takes click
   callbacks (out) but returns no controller (in), so a Clustergram cannot be
   driven from outside the way a Landscape can. Linking is therefore
   one-directional through the app: Clustergram clicks reach the Landscape,
   Landscape clicks cannot highlight in the Clustergram. A
   `matrix.update_selected_genes(...)` / `update_selected_cols(...)` would close
   the loop.
4. **The `update_matrix_*` prefix leaks the caller.** These are Landscape
   methods; that they exist for a matrix to call is context, not identity.
   `select_gene` / `select_cluster` / `select_clusters` would read better and
   would not imply a Clustergram must be involved.

## `width` / `height` size the matrix, not the container

Both `landscape_ist` and `matrix_from_dega_files` take `width` and `height`, and
in both cases they size the **visualization**, not the space it is drawn into.
Celldega then adds its own chrome — a control panel above, row labels to the
left — so passing a container's dimensions reliably overflows it, clipping the
right-hand columns and the bottom rows.

There is no way to ask for "fill this element". Callers must either know the
chrome's size in advance (which changes whenever the UI does) or, as this app
does, render once, measure where the matrix actually landed inside the
container, and redraw with the difference subtracted.

Worth either:

- documenting that these are visualization dimensions and listing what chrome is
  added, or better
- accepting `width: 'fill'` / `height: 'fill'`, or simply measuring the container
  when they are omitted. Celldega already knows how tall its own control panel
  is; every caller having to rediscover it by measurement is the wrong division
  of labour.

Note `landscape_ist` already special-cases `width === 0` into `'100%'`, so the
idea of a self-sizing mode is half-present.

## Linking without a widget: pass `{ on }`, not a stub

`landscape_ist` enables live model updates behind `if (viz_state.model?.on)`,
subscribing to `change:update_trigger`, `change:cell_clusters` and
`change:selected_cells`. The guard tests `.on`; the *standalone vs widget*
decision elsewhere tests `.get`.

Those two being separate is useful and worth keeping: it means a caller can pass
`{ on }` alone to get reactivity while still taking the standalone path. Worth
documenting explicitly, because the natural thing to reach for — a full no-op
stub with `get` — silently switches on the widget path and fails with
`Cannot convert undefined or null to object`.

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
