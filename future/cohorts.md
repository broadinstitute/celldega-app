# Cohorts

A design sketch, not an implementation. The purpose is to agree the shape
before writing code, because cohorts touch **identity**, and identity is the
one thing that is expensive to change once views, windows and saved projects
depend on it.

## What a cohort is

Several DegaFiles datasets analysed together, usually with one AnnData spanning
all of them. A small cohort — a handful of samples — is where this app could be
most useful, since comparing samples side by side is exactly what windows are
good at.

## What already supports it

Encouragingly, both halves are prepared and neither is being used yet:

**Upstream.** `landscape_ist` takes `base_urls` (plural) and `cell_name_prefix`.
With the prefix enabled, cells are named `<dataset>_<cell_id>`, and
`get_meta_cell_attrs` looks up **both** the prefixed and the stripped name. So a
single Landscape spanning several DegaFiles is an existing upstream concept, and
a cohort AnnData keyed by prefixed names would already join.

**Here.** `obs_app` channels are scoped by an opaque `scope_id` that is never
parsed, and a window may change scope during its lifetime. That was deliberate:
a cohort is just several windows over different datasets declaring the *same*
scope, and linking then works with no change.

celldega.py also has `DatasetCollection` and `SetCollection`, both with
`calc_signature`, so cohort-level signatures have an upstream home too.

## The one real problem: identity

Today `scope_id` is a dataset's stable location — `dataset_dir` or `base_url`.
That cannot be a cohort's identity, because a cohort has several. So:

- A cohort needs its **own stable id**, independent of any member dataset.
- Cell ids must be **namespaced** across datasets. `aaaadnje-1` may exist in two
  samples and mean different cells. `cell_name_prefix` is the upstream answer;
  the app must apply it consistently everywhere it builds `meta_cell`.
- A selection published to a cohort scope must therefore carry namespaced ids,
  or a Landscape showing one sample cannot tell whether a cell belongs to it.

**This is the part to get right.** Everything else is UI.

### Where the id comes from

Three options, roughly in increasing order of effort:

1. **Implicit** — hash the sorted member dataset ids. No user input, but the
   cohort's identity changes the moment a dataset is added, which breaks saved
   state and any Clustergram cached against it.
2. **User-named** — the user creates a cohort and names it; the id is a UUID
   stored with it. Stable across membership changes. Requires somewhere to
   persist it, which is the project file we want anyway.
3. **Manifest file** — a `cohort.json` the user points at, listing datasets and
   a shared AnnData. Good for sharing and for reproducibility, bad as the *only*
   route because it must be authored before anything can be tried.

**Suggested:** (2) as the primary path, with (3) as import/export. A cohort is
created by clicking, and can be saved to or opened from a manifest — which is
the same file as project save/load, not a second format.

## Cohort card, or dataset card?

**Extend the dataset card. Do not add a second card type.**

A cohort card would repeat every row of a dataset card — components, views,
actions — and force a "which card am I looking at?" distinction that buys
nothing. The difference is only ever *how many* DegaFiles are listed:

```
┌ Pancreas cohort ─────────────────────────────┐
│ DegaFiles   3 datasets            [Manage…]  │
│               sample_A                        │
│               sample_B                        │
│               sample_C                        │
│ AnnData     cohort.h5ad                       │
│               leiden (11)  ·  sample (3)      │
│                                               │
│ Views                                         │
│  Landscape     [Open ▾]   ← which sample      │
│  Yearbook      [Open ▾]                       │
│  Clustergram   [Generate…]  across the cohort │
└───────────────────────────────────────────────┘
```

Two things genuinely change, and both are small:

- **Views need a dataset selector**, since a Landscape shows one sample at a
  time. That is a dropdown on the button, not a new concept — and it is the same
  mechanism as swapping datasets in an open window.
- **A Clustergram is cohort-wide.** Grouping by `sample` rather than `leiden`
  is exactly the comparison a cohort exists for, and `SetCollection` already
  does it: the group-by menu simply offers cohort-level `obs` columns.

A single dataset is then just a cohort of one, which is a nice property: one
card, one code path, no special case.

## What this would need, in order

1. **Cohort identity and persistence** — create, name, add/remove datasets.
   Naturally the same store as project save/load, so build them together.
2. **Namespaced cell ids** — apply `cell_name_prefix` when building `meta_cell`
   from a cohort AnnData, and make sure published selections carry prefixed ids.
3. **Dataset selector on views** — open a Landscape/Yearbook for member *n*.
4. **Cohort-level Clustergram** — group by a cohort `obs` column such as
   `sample`; no new Python, `SetCollection` already covers it.
5. **Manifest import/export** — the project file, reused.

## Open questions

- Does a selection in one sample's Landscape mean anything in another's? For
  clusters and genes, yes — that is the point. For individual cells, no. The
  channel already distinguishes `entity`, so this may need nothing, but it is
  worth confirming before assuming.
- Should two windows over *different members* of one cohort be linked? Under
  cohort scoping they would be, which seems right for gene and cluster
  selections and is exactly the side-by-side comparison case.
- Is a cohort AnnData required, or can a cohort exist with only DegaFiles? The
  latter is a weaker but still useful thing — comparing samples visually — and
  probably worth allowing rather than blocking.
