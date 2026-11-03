Desktop viewer for DegaFiles, single-cell Landscapes, and Clustergrams, powered
by Celldega.js.

## What's new in 0.7.0

- **Linked views in one window.** Landscape + Clustergram panels now share a
  window by default. Choose a separate Clustergram window when generating it,
  or use **Separate window** from the linked view. Selections remain scoped to
  the dataset in either layout.
- **Saved Clustergrams.** Generated matrices are stored as Matrix Zarr and
  appear under **Saved Clustergrams**, ready to reopen after quitting without
  rerunning Python. **Save Matrix…** and **Open Clustergram…** make the results
  portable, retaining values, dot sizes, metadata, colors, and clustering.
- **New gallery examples.** **Atera Kidney** is first, with **Tabula Sapiens**
  UMAP and linked UMAP + marker Clustergram examples at the end.
- **Celldega 0.28 alpha 4.** JavaScript is pinned to `0.28.0-alpha.4` and Python
  to the matching `0.28.0a4`. Existing managed analysis runtimes may need a
  rebuild through **File → Analysis Runtime…**. Viewing the gallery and saved
  results needs no Python; the app can provision the runtime for new analyses.
- **Development testing.** Source runs use a separate **Celldega Dev** profile,
  so development recents, saved results, and analysis runtimes are isolated
  from an installed release. See the [development instructions](https://github.com/broadinstitute/celldega-app#development-install).

This release also fixes selection feedback between windows and exports the
saved signature matrix's exact filtered and normalized values as CSV/Parquet.

### Alpha compatibility notes

The Celldega dependency is an alpha. Matrix Zarr saves the computed matrix and
clustering, rather than transient browser zoom, crops, or unsaved manual edits.
The bundled Zarr codecs require a renderer CSP `unsafe-eval` exception;
Node integration remains disabled and context isolation enabled.

## Install on macOS

Download **`Celldega-App-0.7.0-universal.dmg`** below. It runs natively on
Apple Silicon and Intel Macs.

1. Double-click the `.dmg`.
2. Drag **Celldega** onto **Applications**.
3. Open **Celldega** from Applications.

The app is unsigned. On **macOS 15 and newer**, dismiss the first-launch
warning, then go to **System Settings → Privacy & Security → Open Anyway**,
authenticate, and confirm **Open**. On **macOS 14 and older**, right-click
Celldega and choose **Open → Open**.

Terminal alternative:

```sh
xattr -dr com.apple.quarantine /Applications/Celldega.app
```

## Install on Windows

Run **`Celldega-Setup.exe`**. If SmartScreen warns about an unrecognized
publisher, choose **More info → Run anyway**.

## Linux

Linux packaging is best-effort. Any successfully built `.deb`, `.rpm`, and
`.zip` files are attached below.

Full installation and analysis-runtime instructions are in the
[README](https://github.com/broadinstitute/celldega-app#install).
