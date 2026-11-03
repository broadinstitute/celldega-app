"""Run with a Python environment containing the pinned celldega alpha."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

import anndata as ad
import celldega as dega
import numpy as np
import pandas as pd

spec = importlib.util.spec_from_file_location("app_worker", Path(__file__).parents[1] / "python/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class MatrixStorageTest(unittest.TestCase):
    def test_generated_matrix_roundtrip_and_exact_csv_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            adata = ad.AnnData(
                np.random.default_rng(2).poisson(2, (24, 8)).astype("float32"),
                obs=pd.DataFrame({"cell_type": pd.Categorical(["A", "B", "C"] * 8)},
                                 index=[f"cell{i}" for i in range(24)]),
                var=pd.DataFrame(index=[f"GENE{i}" for i in range(8)]),
            )
            adata.write_h5ad(root / "input.h5ad")
            result = worker.method_cluster_signature({
                "path": str(root / "input.h5ad"), "category": "cell_type",
                "out_dir": str(root), "top_genes": 5, "zscore": "row", "dot_plot": True,
            })
            matrix = dega.clust.Matrix.read_zarr(result["matrix_path"])
            self.assertEqual(matrix.to_df().shape, (5, 3))
            self.assertEqual(matrix.col_entity, {"entity": "cell", "attr": "cell_type"})
            self.assertIsNotNone(matrix.size_matrix)
            self.assertIn("cell_type", matrix.meta_col)
            # Source data can disappear: exporting the saved matrix still works.
            (root / "input.h5ad").unlink()
            worker.method_signature_dataframe({"matrix_path": result["matrix_path"],
                                               "out_file": str(root / "matrix.csv")})
            exported = pd.read_csv(root / "matrix.csv", index_col=0)
            np.testing.assert_allclose(exported.values, matrix.to_df().values, atol=1e-6)


if __name__ == "__main__":
    unittest.main()
