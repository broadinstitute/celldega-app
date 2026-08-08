# AnnData support

**Partly implemented as of v0.3.0** — see `src/anndata_reader.js`.

Working today: attach a local `.h5ad` when opening a dataset, enumerate its
categorical `obs` columns, and colour the Landscape by one of them using
`uns['<column>_colors']` when present. No Python. h5wasm reads it in the main
process; only cell ids, category codes and the palette cross IPC.

Two findings from doing it, both documented in [js_api.md](js_api.md):

- **The join key is `obs['cell_id']`, not `obs_names`.** Joining on `obs_names`
  as originally specified matches zero cells in real Xenium files.
- **Columns must be enumerated, not typed.** Of 16 obs columns in the pancreas
  file exactly one is a usable categorical.

Still open: continuous (numeric) colouring with a ramp, the expression matrix,
`obsm` embeddings, and reporting the DegaFiles-vs-AnnData overlap to the user.

The notes below are the original planning, kept for the parts not yet built.

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
