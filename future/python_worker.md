# Future: Python worker

Deferred out of v0.1.0. Notes for when we pick it up.

## What it would be for

Not visualization — Celldega.js covers that without Python. The motivating
cases are compute:

- **Clustering** (e.g. Leiden) over cell-by-gene data
- **Aggregate cell-cluster signatures**
- Possibly AnnData reading, though that may not need Python at all — see
  [anndata.md](anndata.md)

## Why it is deferred

Adding Python to an Electron app is the single biggest change we could make to
its installation story:

- A bundled interpreter plus scientific stack (numpy/scipy/scanpy) is hundreds
  of MB, against a current app of ~10 MB plus Electron.
- It has to be built and signed per platform.
- It introduces a second runtime to launch, supervise, and shut down cleanly.

None of that is justified until there is a compute feature that genuinely needs
it. v0.1.0 has none.

## Likely shape when we do it

A sidecar process rather than an embedded interpreter:

- Main process spawns Python, talks to it over stdio JSON-RPC or a loopback
  HTTP port (the app already runs a loopback server, so the second is close to
  free).
- Python never touches the UI. It reads DegaFiles, computes, writes DegaFiles.
  The renderer then reloads the dataset — no new rendering path.
- Ship it as an optional download rather than bundling it into the base
  installer, so the "just view my data" case stays small.

## Alternatives worth checking first

- **Pyodide** — Python in WASM, no native install. Scanpy support is the open
  question.
- **JS-native implementations** for the specific algorithms needed. Leiden and
  cluster-mean signatures are not large amounts of code; a full scientific
  Python stack is a heavy dependency to carry for two functions.

## Constraint to preserve

Whatever we do, the core principle should hold: opening and viewing a dataset
must never require Python. Compute is additive.
