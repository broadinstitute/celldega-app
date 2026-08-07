# Future: AnnData support

Deferred out of v0.1.0. Notes for when we pick it up.

## Why it is not here yet

v0.1.0 opens datasets that have already been converted to DegaFiles. Opening a
raw `.h5ad` is a different job: it means reading the file, deriving what
Celldega.js needs (cell metadata, clusters, spatial coordinates, optionally an
image pyramid), and either converting to DegaFiles or feeding Celldega.js
in-memory.

## Key question: does this need Python?

Probably not, and that is worth confirming before adding a Python runtime — a
bundled interpreter would be by far the largest thing in the app and would
change its installation story on all three platforms.

`.h5ad` is HDF5. There are pure-JS/WASM options:

- **h5wasm** — HDF5 via WASM, reads `.h5ad` group structure directly.
- Celldega.js already bundles **parquet-wasm** and **apache-arrow**, so the
  Arrow-shaped half of the problem is already solved in-process.

The realistic shape is: read `.h5ad` with h5wasm in the renderer (or a worker),
pull out `obs`, `obsm['spatial']`, `var`, and write DegaFiles-shaped Parquet.

## Open questions

- Where does conversion output go — a temp dir, next to the source file, or a
  user-chosen location? It needs to be served by `local_server.js` either way.
- How large can `.h5ad` files get before in-renderer reading is a bad idea and
  this has to move to a worker or the main process?
- Is there an existing conversion path in the Celldega Python package we should
  match exactly, so the app and the notebook workflow produce identical
  DegaFiles?
- Chromium/`h5wasm` memory limits for multi-GB files.

## Related

Clustering and cluster-signature computation is a separate question — see
[python_worker.md](python_worker.md).
