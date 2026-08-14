"""Convert raw Xenium/MERSCOPE output into DegaFiles.

A ONE-SHOT job, not the long-lived worker: it is invoked with a request file,
runs a single conversion, and exits. Preprocessing takes minutes to hours and
holds a lot of memory, so a process per job is the right shape here -- unlike
the few-second signature jobs the daemon handles.

    python preprocess.py request.json

stdout carries newline-delimited JSON protocol events and nothing else.
Everything celldega.pre prints goes to stderr, where it is treated as a log --
except that it is also scanned for stage banners, which is where progress comes
from. Those are real stage transitions rather than an invented percentage.
"""

import json
import os
import re
import sys
import traceback

PROTOCOL_VERSION = 1


def emit(event):
    """Protocol events are the only thing allowed on stdout."""
    sys.__stdout__.write(json.dumps(event) + "\n")
    sys.__stdout__.flush()


# Stage banners printed by celldega.pre, in the order they occur, with the
# fraction complete once that stage *starts*. Approximate by design: the point
# is to show which component is being built, not to promise a timing.
STAGES = [
    (r"Starting preprocessing", "Reading input", 0.02),
    (r"transform file|Skipping transform", "Coordinate transform", 0.05),
    (r"meta cell|Make meta cells", "Cell metadata", 0.12),
    (r"cluster gene expression|df_sig", "Cluster signatures", 0.20),
    (r"meta gene", "Gene metadata", 0.26),
    (r"CBG|cell-by-gene|gene parquets", "Cell-by-gene matrix", 0.32),
    (r"={4,}\s*Image Tiles", "Image pyramid", 0.40),
    (r"Packing Image Tiles", "Packing image tiles", 0.62),
    (r"={4,}\s*Transcript Tiles", "Transcript tiles", 0.72),
    (r"={4,}\s*Cell Boundary Tiles", "Cell boundary tiles", 0.88),
    (r"landscape parameters", "Writing manifest", 0.96),
]

COMPILED = [(re.compile(pattern, re.I), label, fraction) for pattern, label, fraction in STAGES]


class StageWatcher:
    """Stands in for stdout while celldega.pre runs.

    Forwards everything to stderr so nothing is lost from the log, and turns
    recognised stage banners into protocol events. Without this, celldega's
    prints would land on stdout and be read as protocol.
    """

    def __init__(self, job_id):
        self.job_id = job_id
        self.buffer = ""
        self.furthest = -1

    def write(self, text):
        sys.stderr.write(text)
        self.buffer += text
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            self._scan(line)

    def _scan(self, line):
        for index, (pattern, label, fraction) in enumerate(COMPILED):
            if not pattern.search(line):
                continue
            # Only ever move forwards. Several banners can match loosely, and a
            # progress bar that goes backwards reads as a bug.
            if index <= self.furthest:
                return
            self.furthest = index
            emit(
                {
                    "type": "progress",
                    "job_id": self.job_id,
                    "stage": label,
                    "fraction": fraction,
                }
            )
            return

    def flush(self):
        sys.stderr.flush()


def main():
    if len(sys.argv) < 2:
        emit({"type": "error", "error": "no request file given"})
        return 2

    with open(sys.argv[1]) as handle:
        request = json.load(handle)

    job_id = request.get("job_id", "unknown")
    source = request["source"]
    output = request["output"]
    tile_size = int(request.get("tile_size", 250))
    image_tile_layer = request.get("image_tile_layer", "all")
    max_workers = int(request.get("max_workers", 1))
    use_int_index = bool(request.get("use_int_index", True))

    emit({"type": "started", "job_id": job_id, "protocol": PROTOCOL_VERSION})

    watcher = StageWatcher(job_id)
    original_stdout = sys.stdout
    sys.stdout = watcher

    try:
        import celldega as dega

        # celldega.pre takes a parent directory plus a sample name rather than a
        # path to the sample itself.
        data_root_dir = os.path.dirname(source.rstrip(os.sep))
        sample = os.path.basename(source.rstrip(os.sep))

        dega.pre.main(
            sample=sample,
            data_root_dir=data_root_dir,
            tile_size=tile_size,
            image_tile_layer=image_tile_layer,
            path_dega_files=output,
            use_int_index=use_int_index,
            max_workers=max_workers,
        )
    except BaseException as err:  # noqa: BLE001 - a cancelled job lands here too
        sys.stdout = original_stdout
        sys.stderr.write(traceback.format_exc())
        emit({"type": "error", "job_id": job_id, "error": f"{type(err).__name__}: {err}"})
        return 1
    finally:
        sys.stdout = original_stdout

    manifest = os.path.join(output, "landscape_parameters.json")
    if not os.path.exists(manifest):
        emit(
            {
                "type": "error",
                "job_id": job_id,
                "error": "Finished without writing landscape_parameters.json",
            }
        )
        return 1

    emit({"type": "progress", "job_id": job_id, "stage": "Done", "fraction": 1.0})
    emit({"type": "complete", "job_id": job_id, "output": output})
    return 0


if __name__ == "__main__":
    sys.exit(main())
