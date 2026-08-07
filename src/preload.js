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

  // Menu-driven actions arrive here
  on_menu_action: (handler) => {
    ipcRenderer.on('menu_action', (_event, action) => handler(action))
  },
})
