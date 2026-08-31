# Celldega-App

A small desktop application for viewing **DegaFiles / Landscape** datasets with
[Celldega.js](https://github.com/broadinstitute/celldega), on macOS, Windows,
and Linux.

Celldega-App is a **desktop shell around Celldega.js**:

> Open a local or remote DegaFiles / Landscape dataset and explore it — as a
> Landscape, a Clustergram, or a Yearbook — with selections linked across
> windows.

No visualization logic is duplicated here — all rendering is Celldega.js.
Viewing never needs Python; analysis (Clustergram signatures, converting raw
Xenium/MERSCOPE output into DegaFiles) uses a Python runtime the app
provisions for itself on request.

---

## Install

Get the latest build from the [**Releases page**](../../releases). What changed
in each version is in [CHANGELOG.md](CHANGELOG.md).

**You do not need Node.js, npm, or Python.** The download is fully
self-contained — Node is only needed to build from source.

| Platform | File |
| --- | --- |
| macOS (Apple Silicon *and* Intel) | `Celldega-App-<version>-universal.dmg` |
| Windows | `Celldega-Setup.exe` |
| Linux | *not yet available — see [Scope](#scope)* |

macOS ships a single **universal** DMG that runs natively on both Apple Silicon
and Intel, so there is nothing to choose between.

### macOS

1. Download `Celldega-App-<version>-universal.dmg`
2. **Double-click** the `.dmg`
3. **Drag the Celldega icon onto the Applications folder** in the window that opens
4. Open **Celldega** from Applications
5. You will see a security warning the first time — see below

### macOS: getting past the security warning

On first launch macOS shows:

> **"Apple could not verify 'celldega' is free of malware that may harm your Mac
> or compromise your privacy."**

This is expected. It appears because the app is not yet signed with a paid Apple
Developer certificate — **not** because anything is wrong with it. macOS shows
this for every unsigned app. You only need to do this once; afterwards Celldega
opens normally.

**macOS 15 (Sequoia) and newer** — right-click → Open no longer works here,
Apple removed that shortcut:

1. Click **Done** to dismiss the warning
2. Open  → **System Settings** → **Privacy & Security**
3. Scroll down to the **Security** section. You will see
   *"celldega was blocked to protect your Mac."*
4. Click **Open Anyway**
5. Authenticate with Touch ID or your password
6. Click **Open** on the final confirmation

**macOS 14 (Sonoma) and older:** right-click Celldega in Applications → **Open**
→ **Open**.

<details>
<summary>Terminal alternative (any macOS version)</summary>

If you are comfortable in a terminal, this clears the download flag directly and
skips the prompt entirely:

```sh
xattr -dr com.apple.quarantine /Applications/Celldega.app
```

</details>

### Windows

1. Download and run `Celldega-Setup.exe`
2. SmartScreen will warn that the publisher is unrecognised — click
   **More info** → **Run anyway**
3. The installer completes and launches Celldega

### Why the warnings appear

Both warnings mean the same thing: the app is not code-signed. Signing requires
a paid Apple Developer account ($99/year) and an equivalent certificate on
Windows. Once signed and notarized these prompts disappear for everyone — see
[Code signing](#code-signing).

## Python — only for analysis, never for viewing

**Opening and exploring a dataset needs no Python at all.** Landscapes, image
tiles, cell metadata, and colouring by an AnnData annotation are all handled in
JavaScript and WebAssembly.

Python is used for exactly two things today: computing cluster signatures for
a **Clustergram**, and converting raw Xenium/MERSCOPE output into DegaFiles
(**Make DegaFiles**). Nothing is installed until you ask for one of them.

### How the app finds a Python

In order of preference:

1. **`CELLDEGA_PYTHON`** — an explicit override, for developing against a local
   celldega.py checkout
2. **The app's managed environment**, if you have created one
3. **`uv python find`**, then `python3` / `python` on your `PATH` —
   *development builds only*; a packaged release never falls back to a system
   Python, so a release always computes against the celldega version it pins

A Python is only used if it has `numpy`, `scipy`, `pandas`, `anndata` and
`celldega`. If one is found but is missing packages, the app says so
specifically — *"Found Python 3.12 at …, but it is missing: celldega"* — rather
than reporting no Python at all.

### The managed environment

If nothing suitable is found, the app creates its own environment with
[uv](https://docs.astral.sh/uv/), installing **the same celldega version as the
pinned celldega.js** from a fully pinned lockfile
([python/requirements.lock](python/requirements.lock)), so the Python and
JavaScript halves cannot drift apart — and two installs of the same app release
always resolve identical package versions.

```
location   ~/Library/Application Support/Celldega/python/   (macOS)
size       ~1.3 GB on disk
time       ~30 seconds, plus download
```

That size is on disk only — it is **not** part of the app download, which stays
around 240 MB. It is created on request, never at install time, and deleting
the directory is a complete uninstall; the app will simply offer to recreate it.
The app also detects a **stale** runtime — one built from a different pinned
set than the running release expects — and offers a rebuild from
`File → Analysis Runtime…`.

`uv` itself is downloaded on demand (pinned version, checksum-verified) the
first time you set up the runtime, and cached alongside it. You do not need uv
installed.

### Using your own Python instead

If you already have an environment with celldega, point at it:

```sh
CELLDEGA_PYTHON=/path/to/your/python npm start
```

Or install celldega into a Python already on your `PATH`:

```sh
pip install celldega
```

### Why not bundle Python?

A bundled scientific stack would add hundreds of megabytes to every download,
including for the majority of users who only ever look at Landscapes — and every
native library in it would need signing for notarization. Discovering or
provisioning a Python keeps the base app small and the "just view my data" case
free of it entirely.

### Updating to a new version

There is no auto-update yet (it requires signing). To update: quit Celldega,
drag `/Applications/Celldega.app` to the Trash, then install the new `.dmg` as
above. Your recent-datasets list is preserved.

If the app keeps showing an old icon after updating, macOS has cached it — run
`killall Dock Finder`.

### Trying it without any data

The start screen lists example datasets streamed from the
[Celldega gallery](https://broadinstitute.github.io/celldega/gallery/). Click
one to confirm everything works — nothing local needed.

### Opening your own data

- **Local folder** — `File → Open Local Dataset…` (`Cmd/Ctrl+O`). Pick the
  directory containing `landscape_parameters.json`. If you select its parent,
  the app looks one level down for a `*_landscape_files` / `*_outs` directory,
  so pointing at the enclosing dataset folder works too.
- **Remote URL** — `File → Open Remote URL…` (`Cmd/Ctrl+L`). Paste the base URL
  of the directory containing `landscape_parameters.json`. Private S3 buckets
  can be reached by filling in the optional credentials section.

---

## Running from source

Requires [Node.js](https://nodejs.org/) 18 or newer. Only needed for
development — end users should use a [release build](#install).

```sh
git clone https://github.com/broadinstitute/celldega-app
cd celldega-app
npm install
npm start
```

## Development install

`npm start` **runs the app directly from the source tree** — that is the
development install. Nothing is copied or bundled, so any edit to `src/` shows
up on the next launch, and edits to the renderer (`src/renderer/*`) need only a
window reload with `Cmd/Ctrl+R`.

| You changed | To see it |
| --- | --- |
| `src/renderer/*` (HTML, CSS, app.js) | `Cmd/Ctrl+R` in the window |
| anything else in `src/` (main, preload, obs_app, server, workers) or `python/` | Restart `npm start` |

`View → Toggle Developer Tools` opens the usual Chromium inspector. Renderer
console output and load failures are also echoed to the terminal running
`npm start`, so a renderer error is visible without opening DevTools.

### Developing against a local Celldega.js

The app *serves* the Celldega bundle rather than compiling it in, so you can
point it at a local Celldega checkout instead of the pinned npm package:

```sh
# in your celldega checkout -- rebuilds src/celldega/static/celldega.js on change
npm run watch

# in celldega-app, in another terminal
CELLDEGA_JS=../celldega/src/celldega/static/celldega.js npm start
```

The file is read per request, so after a rebuild finishes you just reload the
window (`Cmd/Ctrl+R`) to pick up the new Celldega.js. No reinstall, no
repackaging. The app prints `[celldega] using local build: …` on startup so you
can confirm which bundle is being served.

To go back to the pinned release, drop the environment variable.

### Updating the pinned Celldega.js

`celldega` is pinned to an exact version (no caret) so the app never changes
underneath you:

```sh
npm install celldega@<version> --save-exact
```

---

## Building and publishing installers

```sh
npm run make
```

Artifacts land in `out/make/`: `.dmg` and `.zip` on macOS, a Squirrel `.exe` on
Windows, `.deb` / `.rpm` / `.zip` on Linux.

**Electron Forge only builds for the platform it runs on.** To produce all of
them, push a tag and let CI fan out across runners —
[`.github/workflows/release.yml`](.github/workflows/release.yml) builds macOS
(arm64 + x64), Windows, and Linux, then attaches everything to a GitHub Release:

```sh
npm version 0.1.0
git push --follow-tags
```

### Distribution

GitHub Releases is the distribution channel. The Mac App Store is not a good
fit: it requires sandboxing, which conflicts with reading arbitrary local
dataset folders and running a loopback HTTP server — both central to how this
app works.

### Code signing

Releases currently ship **unsigned**. On macOS, first launch therefore needs
right-click → Open (or *System Settings → Privacy & Security → Open Anyway*);
Windows will show a SmartScreen warning. To sign, add `osxSign` / `osxNotarize`
to `packagerConfig` in [forge.config.js](forge.config.js) and supply Apple
developer credentials.

---

## Architecture

```
┌─ main process ────────────────────────────────────────────────────┐
│  main.js         windows, menu, IPC, recents, session credentials │
│  local_server.js loopback HTTP: renderer, bundle, mounts, proxy   │
│  obs_app.js      cross-window state: windows + scoped channels    │
│  anndata_reader  .h5ad obs categoricals (h5wasm)                  │
│  python_worker   discover/provision Python, JSON-RPC daemon       │
│  analysis_jobs   one process per long job, progress + cancel      │
└──────────────┬────────────────────────────────────────────────────┘
               │ preload.js (contextBridge; the renderer's only surface)
┌──────────────┴────────────────────────────────────────────────────┐
│  renderer (one per window)                                        │
│  app.js: resolve a base URL, read the manifest, hand off to       │
│  Celldega.js — landscape_ist / matrix_viz / yearbook              │
└───────────────────────────────────────────────────────────────────┘
```

```
src/
  main.js                   window lifecycle, native menu, IPC handlers, recents,
                            session credential cache, demo dataset list
  preload.js                contextBridge API (contextIsolation on, nodeIntegration off)
  local_server.js           static serving + MIME + Range, local mounts, remote proxy
  obs_app.js                application-level reactive state shared across windows
  anndata_reader.js         reads .h5ad obs categoricals in main; compact result over IPC
  python_worker.js          Python discovery + managed runtime + JSON-RPC daemon
  uv_provision.js           downloads a pinned, checksum-verified uv on first setup
  analysis_jobs.js          long-running jobs (conversion): spawn, progress, cancel
  data_sources/
    local_source.js         folder -> validate -> mount -> base URL
    http_source.js          remote URL -> base URL (+ proxy URL for fallback)
    authenticated_source.js S3 credentials -> creds object for Celldega.js
  renderer/
    index.html  app.js  app.css   the entire UI: views, forms, cross-window linking
python/
  worker.py                 JSON-RPC daemon: clustergram signatures, capabilities
  preprocess.py             raw Xenium/MERSCOPE -> DegaFiles conversion job
```

### The loopback server

Celldega.js loads a dataset by fetching `landscape_parameters.json`,
`cell_metadata.parquet`, image pyramid tiles, and transcript tiles from a base
URL. Chromium blocks those fetches under `file://` and refuses Range requests,
so the app runs a small HTTP server bound to `127.0.0.1` on a random port and
serves everything through it — the renderer, the Celldega bundle, and any local
dataset folder.

That is the key design choice: once a local folder is mounted at
`/data/<id>/`, it looks exactly like a remote dataset. Both are just a base
URL. The Clustergram cache is served the same way, which is why a Clustergram
window can be reopened later with no Python at all.

### Views and windows

Every view opens in its own window: a **Landscape** (spatial view), a
**Clustergram** (aggregate expression per annotation group), a **Yearbook**
(gallery of individual cells), and the **dataset card** (one dataset's
components — DegaFiles, AnnData — and the views that can be opened from it).
A new window is told what to show through its `obs_app` per-window state, set
by main before the page loads; the window then re-resolves the dataset itself,
so it survives an app restart without holding stale mount URLs.

**Loading a dataset** is: fetch the manifest, read `technology`, and call
`landscape_ist` (or `landscape_h_e` for `h&e`). Camera position is left to
Celldega — passing `ini_x/ini_y/ini_z/ini_zoom` as `0` makes it auto-fit the
whole dataset. Attaching an AnnData swaps in its categorical annotation as the
cell metadata, in the exact positional shape Celldega's own parquet path
produces.

### Cross-window linking (obs_app)

`obs_app` holds application-level state that spans views and windows. The
authoritative copy lives in the **main process**; renderers read and write it
over IPC and receive every change as a broadcast, filtering for what they care
about. Two kinds of state:

- **per-window** — what each window is showing (title, view type, dataset)
- **per-scope channels** — state shared by windows over the same data, such as
  the current `selection`

Channels are **scoped by dataset identity** rather than global: clicking a gene
in a Clustergram publishes `{entity: 'gene', values: [...]}` to its scope's
`selection` channel, and exactly the windows showing the same dataset apply it
(the Landscape via its `update_matrix_gene` controller). Windows over different
data are untouched — linking is correct by construction and needs no linking
UI. `scope_id` is treated as an opaque key so a future cohort (one analysis
unit spanning several datasets) can link its windows the same way. This channel
layer is also the seam a Jupyter bridge would subscribe to; see
[docs/obs_app_and_multi_window.md](docs/obs_app_and_multi_window.md).

### Python: two execution models

- **`python_worker.js`** runs a persistent JSON-RPC daemon (`python/worker.py`)
  for requests of a few seconds — clustergram signatures, capability checks —
  where process start and cold imports would dominate the cost.
- **`analysis_jobs.js`** spawns **one process per long job** —
  `python/preprocess.py` converting raw instrument output for minutes to hours
  — so memory is reclaimed on exit and cancelling means killing the process.
  Each job directory (request, log, output) is a complete record of what was
  asked and what happened.

Clustergram signatures are cached in `userData` keyed by a hash of
`(file, mtime, size, options)`, so re-generating with the same settings is
instant and regenerating the `.h5ad` invalidates cleanly.

### Remote datasets and credentials

**Remote datasets** are fetched directly first. CORS is a browser restriction,
so the renderer is the only place that can tell whether a host is reachable; if
a direct fetch is refused it retries through the local proxy, and the viewer
shows a `proxied` pill. An HTTP error status is reported straight away rather
than retried, since the proxy would get the same answer.

**Credentials** for private S3 datasets are held in main-process memory for the
session only — so a dataset can be reopened from Recents without retyping them
— and are never written to disk; the recents file stores none. Celldega.js
signs its own requests with them (aws4fetch), and the renderer signs only its
two pre-flight fetches (manifest and `.dzi`).

---

## Scope

**Celldega-App renders 2D Landscape datasets**, plus Clustergrams and Yearbooks
over them. Point-cloud / 3D-orbit datasets (`technology: "point-cloud"`,
`"neighborhood-cloud"`, `"cell-cloud"`) are detected and reported rather than
rendered blank.

Not here yet: cohorts (linked windows spanning several datasets), a Jupyter
bridge, and multi-dataset comparison. See [future/](future/) for notes on what
comes next and why.

## License

Academic Software License — © 2024 The Broad Institute, Inc. See
[LICENSE.txt](LICENSE.txt), the same license used by
[Celldega](https://github.com/broadinstitute/celldega/blob/main/LICENSE.txt).

Free for academic and nonprofit research use. Commercial entities should contact
<OSAP@broadinstitute.org> for licensing.
