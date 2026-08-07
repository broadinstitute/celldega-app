# Celldega-App

A small desktop application for viewing **DegaFiles / Landscape** datasets with
[Celldega.js](https://github.com/broadinstitute/celldega), on macOS, Windows,
and Linux.

Celldega-App is a **desktop shell around Celldega.js**. It does one thing:

> Open a local or remote Dega/Landscape dataset and display it with Celldega.js.

No visualization logic is duplicated here — all rendering is Celldega.js. There
is no Python in v0.1.0.

---

## Install

Download the build for your platform from the
[**Releases page**](../../releases) and run it:

| Platform | File | Install |
| --- | --- | --- |
| macOS (Apple Silicon) | `*macos-arm64*.dmg` | Open the `.dmg`, drag to Applications |
| macOS (Intel) | `*macos-x64*.dmg` | Open the `.dmg`, drag to Applications |
| Windows | `Celldega-Setup.exe` | Run the installer |
| Linux | `.deb` / `.rpm` / `.zip` | `sudo apt install ./*.deb`, or unzip and run |

**You do not need Node.js, npm, or Python to run the app.** Electron bundles its
own runtime, so the download is fully self-contained. Node is only required if
you want to build the app from source yourself.

### First launch on macOS and Windows

The app is **unsigned**, so the OS blocks it on first launch:

> "Apple could not verify 'celldega' is free of malware that may harm your Mac…"

**macOS 15 (Sequoia) and later.** Right-click → Open **no longer works** — Apple
removed that bypass for un-notarized apps. Use one of:

- *System Settings → Privacy & Security*, scroll to **Security**, then click
  **Open Anyway** next to the blocked-app message, and confirm. Only needed once.
- Or clear the download quarantine flag directly:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Celldega.app
  ```

**macOS 14 (Sonoma) and earlier.** Right-click the app → **Open** → **Open**.

**Windows.** SmartScreen → **More info** → **Run anyway**.

Signing removes all of this; see [Code signing](#code-signing).

### Trying it without any data

The start screen lists five example datasets streamed from the
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
| `src/main.js`, `src/preload.js`, `src/local_server.js`, `src/data_sources/*` | Restart `npm start` |

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

v0.1.0 ships **unsigned**. On macOS, first launch therefore needs
right-click → Open (or *System Settings → Privacy & Security → Open Anyway*);
Windows will show a SmartScreen warning. To sign, add `osxSign` / `osxNotarize`
to `packagerConfig` in [forge.config.js](forge.config.js) and supply Apple
developer credentials.

---

## How it works

Celldega.js loads a dataset by fetching `landscape_parameters.json`,
`cell_metadata.parquet`, image pyramid tiles, and transcript tiles from a base
URL. Chromium blocks those fetches under `file://` and refuses Range requests,
so the app runs a small HTTP server bound to `127.0.0.1` on a random port and
serves everything through it — the renderer, the Celldega bundle, and any local
dataset folder.

That is the key design choice: once a local folder is mounted at
`/data/<id>/`, it looks exactly like a remote dataset. Both are just a base URL,
which keeps the app small.

```
src/
  main.js              window, menu, folder picker, recents, IPC
  preload.js           contextBridge API (contextIsolation on, nodeIntegration off)
  local_server.js      static serving + MIME + Range, local mounts, remote proxy
  data_sources/
    local_source.js          folder -> validate -> mount -> base URL
    http_source.js           remote URL -> base URL (+ proxy URL for fallback)
    authenticated_source.js  S3 credentials -> creds object for Celldega.js
  renderer/
    index.html  app.js  app.css
```

**Loading a dataset** is: fetch the manifest, read `technology`, and call
`landscape_ist` (or `landscape_h_e` for `h&e`). Camera position is left to
Celldega — passing `ini_x/ini_y/ini_z/ini_zoom` as `0` makes it auto-fit the
whole dataset.

**Remote datasets** are fetched directly first. CORS is a browser restriction,
so the renderer is the only place that can tell whether a host is reachable; if
a direct fetch is refused it retries through the local proxy, and the viewer
shows a `proxied` pill. An HTTP error status is reported straight away rather
than retried, since the proxy would get the same answer.

**Credentials** are held in renderer memory for the session only and are
stripped before the recents list is written to disk.

---

## Scope

**v0.1.0 renders 2D Landscape datasets.** Point-cloud / 3D-orbit datasets
(`technology: "point-cloud"`, `"neighborhood-cloud"`, `"cell-cloud"`) are
detected and reported rather than rendered blank.

Deliberately out of scope for now: Python, AnnData, Clustergram/Matrix,
Yearbook, and multi-dataset comparison. See [future/](future/) for notes on
what comes next and why.

## License

Academic Software License — © 2024 The Broad Institute, Inc. See
[LICENSE.txt](LICENSE.txt), the same license used by
[Celldega](https://github.com/broadinstitute/celldega/blob/main/LICENSE.txt).

Free for academic and nonprofit research use. Commercial entities should contact
<OSAP@broadinstitute.org> for licensing.
