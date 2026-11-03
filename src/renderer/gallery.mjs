// The same published stores and initial view as Celldega's Tabula gallery.
// Pin the data revision so future data changes cannot alter this app release.
const DATA = 'https://huggingface.co/datasets/broadinstitute/Celldega_Supporting_Data/resolve/df537e04ad0e51a91f3d68a53b788efb61552913/Tabula_Sapiens'

export const tabula_landscape = {
  zarr_url: `${DATA}/tabula_sapiens.zarr`,
  zarr_layer: 'log1p_csc',
  gene_signature_url: `${DATA}/tabula_sapiens_cell_type_signatures.zarr`,
  cell_attr: ['cell_type', 'tissue_in_publication', 'compartment'],
  cluster_attr: 'cell_type',
  landscape_state: 'umap',
  dataset_name: 'Tabula Sapiens · All Cells',
  ini_zoom: -4.6, ini_x: 5000, ini_y: 5000,
}

export const tabula_clustergram = {
  url: `${DATA}/tabula_sapiens_cell_type_markers.zarr`,
  label: 'Tabula Sapiens', category: 'cell_type', dot_plot: true, rank_dim: 3,
  scope_id: tabula_landscape.zarr_url,
  dataset: {
    kind: 'remote', detail: tabula_landscape.zarr_url, label: 'Tabula Sapiens',
    landscape_options: tabula_landscape,
  },
}
