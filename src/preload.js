// Bridge between the sandboxed renderer and the main process.
// contextIsolation is on and nodeIntegration is off, so this is the only
// surface the renderer gets. Keep it small.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('celldega_app', {
  // Open the native folder picker and resolve the choice to a dataset source
  open_local_dataset: () => ipcRenderer.invoke('open_local_dataset'),

  // Resolve a remote https base URL (optionally with S3 credentials)
  resolve_remote_dataset: (url, creds) =>
    ipcRenderer.invoke('resolve_remote_dataset', { url, creds }),

  // Re-mount a recent local folder (mount ids are per-launch)
  reopen_local_path: (dir_path) => ipcRenderer.invoke('reopen_local_path', dir_path),

  // Session-only credential cache (memory in the main process, never on disk)
  has_session_creds: (url) => ipcRenderer.invoke('has_session_creds', url),
  forget_session_creds: (url) => ipcRenderer.invoke('forget_session_creds', url),
  clear_session_creds: () => ipcRenderer.invoke('clear_session_creds'),

  // Built-in demo datasets from the Celldega gallery
  get_demo_datasets: () => ipcRenderer.invoke('get_demo_datasets'),

  // Recently opened datasets, persisted in userData
  get_recents: () => ipcRenderer.invoke('get_recents'),
  add_recent: (entry) => ipcRenderer.invoke('add_recent', entry),
  clear_recents: () => ipcRenderer.invoke('clear_recents'),

  open_external: (url) => ipcRenderer.invoke('open_external', url),
  get_app_version: () => ipcRenderer.invoke('get_app_version'),
  get_versions: () => ipcRenderer.invoke('get_versions'),

  new_window: () => ipcRenderer.invoke('new_window'),

  // AnnData: pick a local .h5ad and read one categorical obs column from it.
  // The file is read in main; only the compact result crosses IPC.
  // Clustergram: computed by the Python worker, served as DegaFiles, and
  // rendered in a new window. Python is only touched from here.
  python_status: () => ipcRenderer.invoke('python_status'),
  setup_python_env: () => ipcRenderer.invoke('setup_python_env'),
  runtime_info: () => ipcRenderer.invoke('runtime_info'),
  remove_python_env: () => ipcRenderer.invoke('remove_python_env'),
  remove_legacy_python_env: () => ipcRenderer.invoke('remove_legacy_python_env'),
  on_python_setup_progress: (handler) => {
    ipcRenderer.on('python_setup_progress', (_event, progress) => handler(progress))
  },
  generate_clustergram: (options) => ipcRenderer.invoke('generate_clustergram', options),
  open_landscape: (options) => ipcRenderer.invoke('open_landscape', options),
  open_yearbook: (options) => ipcRenderer.invoke('open_yearbook', options),
  save_signature_table: (options) => ipcRenderer.invoke('save_signature_table', options),

  // Converting raw instrument output into DegaFiles. A long job, so it runs
  // as its own process and reports progress and completion through job_event.
  pick_raw_folder: () => ipcRenderer.invoke('pick_raw_folder'),
  pick_output_folder: (default_path) => ipcRenderer.invoke('pick_output_folder', default_path),
  inspect_raw_dataset: (dir_path) => ipcRenderer.invoke('inspect_raw_dataset', dir_path),
  convert_to_degafiles: (options) => ipcRenderer.invoke('convert_to_degafiles', options),
  cancel_job: (job_id) => ipcRenderer.invoke('cancel_job', job_id),
  job_status: (job_id) => ipcRenderer.invoke('job_status', job_id),
  on_job_event: (handler) => {
    ipcRenderer.on('job_event', (_event, job) => handler(job))
  },

  pick_dataset_folder: () => ipcRenderer.invoke('pick_dataset_folder'),
  validate_local_path: (dir_path) => ipcRenderer.invoke('validate_local_path', dir_path),
  pick_anndata_file: () => ipcRenderer.invoke('pick_anndata_file'),
  anndata_inspect: (file_path) => ipcRenderer.invoke('anndata_inspect', file_path),
  anndata_read_column: (file_path, column) =>
    ipcRenderer.invoke('anndata_read_column', { file_path, column }),

  // Menu-driven actions arrive here
  on_menu_action: (handler) => {
    ipcRenderer.on('menu_action', (_event, action) => handler(action))
  },

  // obs_app -- application state owned by the main process.
  // Per-window state is isolated; channels are shared across all windows.
  obs_app: {
    get_window: (window_id) => ipcRenderer.invoke('obs_app_get_window', window_id),
    set_window: (window_id, patch) =>
      ipcRenderer.invoke('obs_app_set_window', { window_id, patch }),

    // Channels are scoped: windows sharing a scope_id are linked, windows over
    // different data are not. scope_id is opaque -- one dataset today, a cohort
    // spanning several datasets later.
    get_channel: (scope_id, name) => ipcRenderer.invoke('obs_app_get_channel', { scope_id, name }),
    set_channel: (scope_id, name, value, window_id) =>
      ipcRenderer.invoke('obs_app_set_channel', { scope_id, name, value, window_id }),

    linked_windows: (scope_id, window_id) =>
      ipcRenderer.invoke('obs_app_linked_windows', { scope_id, window_id }),

    snapshot: () => ipcRenderer.invoke('obs_app_snapshot'),

    // Fires for every change in any window. Handlers get {type, window_id,
    // channel, value, origin_window_id} and filter for what they care about.
    on_change: (handler) => {
      ipcRenderer.on('obs_app_change', (_event, change) => handler(change))
    },
  },
})
