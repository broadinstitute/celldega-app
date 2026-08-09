# Changelog

Notable changes to Celldega-App. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[Semantic Versioning](https://semver.org/) — pre-1.0, so the minor number marks
features and the patch number fixes.

Downloads for every release are on the
[Releases page](https://github.com/broadinstitute/celldega-app/releases).

## [Unreleased]

## [0.4.0] — 2026-08-08

Cluster signatures and a Clustergram, computed with celldega.py and linked to
the Landscape. **Viewing still needs no Python** — it is used only when you ask
for a Clustergram.

### Added

- **Clustergram.** Aggregates expression per categorical annotation, optionally
  z-scores, keeps the top N genes by variance, and clusters it — rendered in its
  own window. Uses `SetCollection.calc_signature`, which also provides the
  percent-expressing channel for a **dot plot** (colour by mean, size by
  fraction). 122,678 cells × 377 genes reduces to 377 × 11 in a few seconds.
- **Linked views.** Clicking a gene row, a group column, or a dendrogram branch
  in a Clustergram drives the Landscape in another window. Selections publish to
  a shared channel scoped by dataset, so windows over the same data follow along
  and windows over other data are untouched. No window addresses another
  directly.
- **Dataset card.** One dataset's components (DegaFiles, AnnData) and the views
  that can be opened from it, reached by a link on a recent — clicking a recent
  still opens its Landscape directly. Reports which categorical columns are
  actually usable rather than merely that a file is attached, and a Clustergram
  can be generated without opening the Landscape first.
- **Managed Python environment**, created with `uv` on request, with celldega
  pinned to the same version as the pinned celldega.js so the two cannot drift.
  Never at install time, never for viewing. A discovered Python is still used if
  it has what is needed, and `CELLDEGA_PYTHON` overrides everything.
- **Save signatures** as CSV or parquet, for use outside the app.
- Results are cached by a hash of (file, mtime, column, options), since
  re-clustering is iterative and toggling z-score should not recompute.

### Changed

- The Cervical Cancer demo dataset is now labelled "Atera Cervical Cancer", to
  match how it is usually referred to.

### Notes for Celldega maintainers

[`future/js_api.md`](future/js_api.md) now opens with a prioritised list of
changes that would simplify this app, with what each would let us delete. The
top three:

1. **Let a visualization size itself.** The app hardcodes two internal Celldega
   values it cannot query — the control panel height and `height_margin` — and
   if either changes, the Clustergram silently clips.
2. **Do not write inline styles onto the caller's element.** They beat the
   caller's stylesheet, which cost a wrapper element to work around.
3. **Return a controller from `matrix_viz`**, as `landscape_ist` does. Linking is
   one-directional today for exactly this reason.

Also still standing: the AnnData join key is `obs['cell_id']`, not `obs_names` —
joining as documented matches zero cells *silently*.

## [0.3.0] — 2026-08-08

Colour a Landscape by a categorical annotation from a local AnnData file. **No
Python required** — the `.h5ad` is read with h5wasm (WebAssembly HDF5).

### Added

- **Attach a local `.h5ad` when opening a dataset**, for local *and* remote
  DegaFiles. Categorical `obs` columns are enumerated from the file and offered
  in a **COLOR BY** menu, so a column is chosen from what exists rather than
  typed. Of 16 `obs` columns in a typical Xenium file exactly one is a usable
  categorical, which is why enumerating matters.
- `uns['<column>_colors']` is used when present, so colours match Scanpy. A
  palette whose length disagrees with the categories is ignored rather than
  risking silently mis-coloured clusters.
- Recents remember the attached `.h5ad` and column, and reattach on reopen, so
  a remembered dataset comes back already coloured. A moved file or a vanished
  column warns instead of blocking the dataset from opening.

### Changed

- **One "Open Dataset…" form** replaces the separate "Open Local Folder" and
  "Open Remote URL" actions. It takes a local folder *or* a URL in one field,
  validated as you type, with optional S3 credentials and an optional `.h5ad`.
  The old actions duplicated each other and neither could carry an AnnData.

## [0.2.0] — 2026-08-08

### Added

- **Multiple windows.** Each window is an independent viewer with its own
  dataset. `File → New Window` (`Cmd/Ctrl+N`), plus buttons on the start screen
  and in the viewer toolbar.
- `obs_app`, an application state layer owned by the main process, tracking
  which window shows what. Channels are **scoped by dataset**: windows over the
  same data are linked automatically, windows over different data are not —
  because a selection is only meaningful within the data it refers to. Nothing
  subscribes yet; this is the seam for linked views later.
- Atera Cervical Cancer demo dataset (Atera Preview, FFPE).

## [0.1.4] — 2026-08-07

### Added

- Credentials are remembered **for the session** so a private dataset can be
  reopened from Recents without retyping them. Memory only, never written to
  disk, and clearable from `File → Forget Stored Credentials`. A 401/403 with
  cached credentials discards them and reports expiry rather than retrying dead
  ones — the expected path for temporary STS tokens.

## [0.1.3] — 2026-08-07

### Fixed

- **Private S3 datasets could never load.** Credentials were collected and
  passed to Celldega.js, but the app's own two pre-flight requests
  (`landscape_parameters.json` and the `.dzi`) used an unsigned fetch, so a
  private bucket returned 403 and the dataset was abandoned before Celldega was
  ever called. Those requests are now signed with the same client Celldega uses
  internally. Signing engages only when credentials are present; public and
  local datasets are untouched.
- 401/403 is reported as an access problem rather than telling the user to
  check a URL that was correct.

## [0.1.2] — 2026-08-07

### Changed

- App icon now has a transparent background.
- **Corrected the macOS first-launch instructions.** They said right-click →
  Open, but Apple removed that bypass for un-notarized apps in macOS 15
  (Sequoia), so the documented workaround did not work on current systems. The
  README and the release notes now give the Privacy & Security route and the
  `xattr` command, and keep the old instructions for Sonoma and earlier.

## [0.1.1] — 2026-08-07

### Added

- The Celldega logo as the application icon.

## [0.1.0] — 2026-08-07

First release. A desktop shell around Celldega.js for viewing DegaFiles /
Landscape datasets. **No Node, npm, or Python needed to run it.**

### Added

- Open a **local folder** or a **remote URL** and render it with Celldega.js.
- **Authenticated S3** datasets via credentials held in memory for the session.
- Five example datasets from the Celldega gallery on the start screen, and a
  recents list.
- macOS **universal** DMG (Apple Silicon and Intel) and a Windows installer,
  built and published by CI on a tag.

### Known limitations

- **Unsigned**, so macOS and Windows warn on first launch — see the
  [README](README.md#install). This also blocks auto-update, so each release is
  a manual download.
- **Linux builds fail** and no release carries Linux assets. Low priority; the
  job is non-blocking so it cannot hold up a macOS release.
- 2D Landscape datasets only. Point-cloud / 3D-orbit datasets are detected and
  reported rather than rendered blank.

[Unreleased]: https://github.com/broadinstitute/celldega-app/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/broadinstitute/celldega-app/releases/tag/v0.3.0
[0.2.0]: https://github.com/broadinstitute/celldega-app/releases/tag/v0.2.0
[0.1.4]: https://github.com/broadinstitute/celldega-app/releases/tag/v0.1.4
[0.1.3]: https://github.com/broadinstitute/celldega-app/releases/tag/v0.1.3
[0.1.2]: https://github.com/broadinstitute/celldega-app/releases/tag/v0.1.2
[0.1.1]: https://github.com/broadinstitute/celldega-app/releases/tag/v0.1.1
[0.1.0]: https://github.com/broadinstitute/celldega-app/releases/tag/v0.1.0
