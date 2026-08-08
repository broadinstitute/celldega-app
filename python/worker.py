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

import json
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
    for name in ("numpy", "scipy", "pandas", "anndata", "h5py"):
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


METHODS = {
    "ping": method_ping,
    "capabilities": method_capabilities,
    "describe_anndata": method_describe_anndata,
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
            result = handler(request.get("params") or {})
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as err:  # noqa: BLE001 - report every failure as protocol
            log(traceback.format_exc())
            response = {"id": request_id, "ok": False, "error": f"{type(err).__name__}: {err}"}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
