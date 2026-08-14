"""Celldega App analysis worker.

A long-lived process that reads newline-delimited JSON requests on stdin and
writes newline-delimited JSON responses on stdout. Started by the Electron main
process; never talks to the renderer directly.

Python is for computation only. Nothing here draws anything, and nothing here is
required to open or view a DegaFiles dataset -- the app must stay fully usable
with no Python installed at all. Only analysis features start this worker.

Protocol
--------
Request   {"id": 1, "method": "ping", "params": {}}
Response  {"id": 1, "ok": true, "result": {...}}
          {"id": 1, "ok": false, "error": "..."}

One JSON object per line, in both directions. Requests are handled in order.
Anything written to stderr is diagnostics, never protocol -- the app forwards it
to its own log.

Large numeric results should be written to a temp file (Arrow/Parquet/npy) with
only the path returned, rather than serialised through JSON. Nothing here does
that yet; `ping` and `describe_anndata` are both small.
"""

import contextlib
import json
import os
import sys
import traceback

PROTOCOL_VERSION = 1


def log(message):
    """Diagnostics only. stdout is reserved for protocol."""
    print(f"[worker] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------- methods


def method_ping(_params):
    """Cheapest possible round trip: proves the process and pipes work."""
    import platform

    return {
        "protocol": PROTOCOL_VERSION,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": platform.platform(),
    }


def method_capabilities(_params):
    """Which optional libraries are importable, so the app can disable features
    with a specific reason rather than failing when the user clicks."""
    found = {}
    for name in ("numpy", "scipy", "pandas", "anndata", "h5py", "pyvips"):
        try:
            module = __import__(name)
            found[name] = getattr(module, "__version__", "unknown")
        except ImportError:
            found[name] = None
    return {"packages": found}


def method_describe_anndata(params):
    """Open an .h5ad and report its shape and obs columns.

    Deliberately the first real method: it is cheap, but it exercises the whole
    path -- spawn, protocol, a real dependency (anndata), and a real file --
    so a failure here is unambiguous before any heavier analysis is attempted.
    """
    import anndata

    path = params.get("path")
    if not path:
        raise ValueError("path is required")

    # backed='r' keeps the expression matrix on disk; these files run to
    # hundreds of MB and nothing here needs X.
    adata = anndata.read_h5ad(path, backed="r")
    try:
        categorical = []
        numeric = []
        for column in adata.obs.columns:
            series = adata.obs[column]
            if str(series.dtype) == "category":
                categorical.append(
                    {"name": column, "n_categories": int(len(series.cat.categories))}
                )
            else:
                numeric.append({"name": column, "dtype": str(series.dtype)})

        return {
            "n_obs": int(adata.n_obs),
            "n_vars": int(adata.n_vars),
            "obs_index_name": adata.obs.index.name,
            "has_cell_id": "cell_id" in adata.obs.columns,
            "categorical": categorical,
            "numeric": numeric,
            "obsm_keys": list(adata.obsm.keys()),
        }
    finally:
        if adata.isbacked:
            adata.file.close()


def method_cluster_signature(params):
    """Aggregate expression per category, cluster it, and write DegaFiles.

    The whole point of routing this through Python: celldega.py already does it.
    Matrix.write_dega_files produces a `cgm/<name>/` directory of parquet files
    that Celldega.js reads with matrix_from_dega_files -- its docstring says
    they are "the parquet files needed to load the Clustergram in JavaScript
    without a Python backend".

    So the result never crosses the IPC boundary as numbers. Python writes
    DegaFiles, the app serves that directory, and the renderer loads it exactly
    as it would any other dataset. No new format, no large JSON payload, and the
    output is a shareable artifact rather than a private blob -- it can be
    dropped into a DegaFiles directory and it will simply be there next time,
    with no Python needed to view it.
    """
    import celldega as dega
    import anndata

    path = params.get("path")
    category = params.get("category")
    out_dir = params.get("out_dir")
    if not path or not category or not out_dir:
        raise ValueError("path, category and out_dir are required")

    name = params.get("name") or category
    # Library-size normalisation of the signature itself, before any z-scoring
    normalization = params.get("normalization", "log1p_cpm")
    zscore = params.get("zscore", "row")  # 'row' | 'col' | None
    dot_plot = params.get("dot_plot", True)

    adata = anndata.read_h5ad(path)

    # SetCollection rather than Matrix.downsample_to. It aggregates through a
    # sparse sets x cells membership matrix instead of materialising the full
    # cell-by-gene frame, so it is several times faster on the same input -- and,
    # more importantly, `aggregate="fraction"` gives the percent-expressing
    # channel that drives a dot-plot Clustergram, which the downsample path
    # cannot produce.
    sets = dega.set.SetCollection(adata, set_col=category)
    sets.calc_signature(
        adata,
        modality_name="expression",
        aggregate="mean",
        normalization=normalization,
    )

    signature = sets.mod["expression"]
    mat = dega.clust.Matrix(signature)

    # Keep the most variable genes across sets. Order matters: this MUST run
    # before z-scoring, because z-scoring forces every gene to variance 1 and
    # "top N by variance" then selects an arbitrary N.
    top_genes = params.get("top_genes")
    if top_genes:
        n_rows_available = mat.to_df().shape[0]
        if top_genes < n_rows_available:
            mat.filter(axis="row", by=params.get("filter_by", "var"), num=int(top_genes))

    # Z-score after aggregation, so it is computed across sets rather than
    # across cells. 'row' is per gene, which is what makes clusters comparable.
    if zscore:
        mat.norm(axis=zscore, by="zscore")

    if dot_plot:
        # Colour from mean expression, dot size from percent expressing.
        # normalization is skipped for 'fraction' -- it is already in [0, 1].
        sets.calc_signature(
            adata,
            modality_name="fraction",
            aggregate="fraction",
        )
        mat.set_dot_matrix(sets.mod["fraction"])

    mat.clust()
    mat.write_dega_files(out_dir, name=name)

    df = mat.to_df()
    return {
        "name": name,
        "cgm_path": os.path.join(out_dir, "cgm", name),
        "n_rows": int(df.shape[0]),
        "n_cols": int(df.shape[1]),
        "row_names": [str(x) for x in df.index[:50]],
        "col_names": [str(x) for x in df.columns[:50]],
        "category": category,
        "normalization": normalization,
        "zscore": zscore,
        "dot_plot": bool(dot_plot),
    }


def method_signature_dataframe(params):
    """Write the signature matrix as CSV or parquet, for use outside the app.

    Same computation as cluster_signature, but the plain table rather than the
    Clustergram bundle -- so a result can leave the app and be used in a
    notebook or a paper figure.
    """
    import celldega as dega
    import anndata

    path = params.get("path")
    category = params.get("category")
    out_file = params.get("out_file")
    if not path or not category or not out_file:
        raise ValueError("path, category and out_file are required")

    adata = anndata.read_h5ad(path)
    mat = dega.clust.Matrix(adata)
    mat.downsample_to(category=category)
    if params.get("normalize", "zscore"):
        mat.norm(axis=params.get("axis", "row"), by=params.get("normalize", "zscore"))

    df = mat.to_df()
    if out_file.endswith(".parquet"):
        df.to_parquet(out_file)
    else:
        df.to_csv(out_file)

    return {"out_file": out_file, "n_rows": int(df.shape[0]), "n_cols": int(df.shape[1])}


METHODS = {
    "ping": method_ping,
    "capabilities": method_capabilities,
    "describe_anndata": method_describe_anndata,
    "cluster_signature": method_cluster_signature,
    "signature_dataframe": method_signature_dataframe,
}


# ------------------------------------------------------------------ loop


def main():
    log(f"ready on {sys.executable}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = request.get("method")
            handler = METHODS.get(method)
            if handler is None:
                raise ValueError(f"unknown method: {method}")
            # stdout is the protocol channel, so nothing else may write to it.
            # Libraries print freely -- celldega's write_dega_files announces
            # where it saved -- and a stray line that happened to parse as JSON
            # would be read as a response. Redirect anything a handler prints to
            # stderr, where it is treated as diagnostics.
            with contextlib.redirect_stdout(sys.stderr):
                result = handler(request.get("params") or {})
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as err:  # noqa: BLE001 - report every failure as protocol
            log(traceback.format_exc())
            response = {"id": request_id, "ok": False, "error": f"{type(err).__name__}: {err}"}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
