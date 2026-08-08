// obs_app -- application-level reactive state.
//
// Distinct from Celldega.js's stores (obs_store, clustergram_store,
// enrich_store, manual_category_store), which hold the internal reactive state
// of a single visualization. obs_app holds state that spans views and windows:
// which dataset a window shows, and any selection shared between them.
//
// Authoritative copy lives in the MAIN process, not a renderer. Two reasons:
//
//   1. With several windows there has to be one owner. Electing a renderer
//      would mean the state dies when that particular window closes.
//   2. A future Jupyter bridge can subscribe here directly -- the loopback
//      server already runs in main, so a WebSocket endpoint on it would
//      publish these same channels without changing this design.
//
// Three kinds of state:
//
//   per-window   windows[window_id]              isolated
//   per-scope    scopes[scope_id].channels[name] shared by windows in that scope
//   (global)     deliberately absent -- see below
//
// ---------------------------------------------------------------------------
// Why channels are scoped rather than global
//
// A selection is only meaningful within the data it refers to. Cell
// "aaaadnje-1" or "cluster 7" means nothing in a different sample, so
// broadcasting a pancreas selection to a mouse-brain Landscape would not just
// be useless, it would be wrong. Scoping is therefore the correct semantics,
// and the fact that it needs no linking UI is a bonus: windows over the same
// data are linked automatically, windows over different data are not.
//
// ---------------------------------------------------------------------------
// Why scope_id is opaque rather than "the dataset URL"
//
// Today a scope is one dataset, and callers pass the dataset's stable id.
// But Celldega.js already supports a Landscape spanning several DegaFiles
// (`base_urls` plural, with `cell_name_prefix` so cells are named
// "<dataset>_<cell_id>"), which is how a cohort will work. A cohort AnnData
// spanning several datasets is then one analysis unit whose windows should be
// linked to each other but not to unrelated datasets.
//
// So scope_id is treated as an arbitrary key, never parsed and never assumed to
// be a URL. When cohorts arrive, several windows over different datasets simply
// declare the same cohort scope_id and linking works unchanged. A window may
// also change scope during its lifetime -- that is what swapping datasets in
// place will do -- so nothing may cache a window's scope.

const listeners = new Set()

const state = {
  // window_id -> { scope_id, view_type, label, detail, ... }
  windows: {},
  // scope_id -> { channels: { [name]: value } }
  scopes: {},
}

const emit = (event) => {
  for (const fn of listeners) {
    try {
      fn(event)
    } catch {
      // A broken subscriber must not stop the others
    }
  }
}

const subscribe = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ------------------------------------------------------------ per-window

const get_window = (window_id) => state.windows[window_id] || null

const set_window = (window_id, patch) => {
  if (!window_id) return null
  const next = { ...(state.windows[window_id] || {}), ...(patch || {}) }
  state.windows[window_id] = next
  emit({ type: 'window', window_id, value: next })
  return next
}

const remove_window = (window_id) => {
  if (!window_id || !(window_id in state.windows)) return
  const { scope_id } = state.windows[window_id]
  delete state.windows[window_id]
  emit({ type: 'window_removed', window_id, scope_id })
  prune_scopes()
}

const list_windows = () => Object.keys(state.windows)

// Windows sharing a scope are exactly the ones linked to each other
const windows_in_scope = (scope_id) =>
  Object.entries(state.windows)
    .filter(([, w]) => w && w.scope_id === scope_id)
    .map(([id]) => id)

// ------------------------------------------------------------- per-scope

const ensure_scope = (scope_id) => {
  if (!state.scopes[scope_id]) state.scopes[scope_id] = { channels: {} }
  return state.scopes[scope_id]
}

const get_channel = (scope_id, name) => {
  const scope = state.scopes[scope_id]
  if (!scope) return null
  return name in scope.channels ? scope.channels[name] : null
}

// `origin_window_id` rides along so a window can ignore the echo of its own
// change instead of reacting to itself.
const set_channel = (scope_id, name, value, origin_window_id = null) => {
  if (!scope_id || !name) return null
  ensure_scope(scope_id).channels[name] = value
  emit({ type: 'channel', scope_id, channel: name, value, origin_window_id })
  return value
}

const get_scope = (scope_id) => state.scopes[scope_id] || null

// Drop scopes no window refers to any more, so closing every window over a
// dataset does not leave its selection lying around to be resurrected later.
const prune_scopes = () => {
  const live = new Set(Object.values(state.windows).map((w) => w && w.scope_id))
  for (const scope_id of Object.keys(state.scopes)) {
    if (!live.has(scope_id)) delete state.scopes[scope_id]
  }
}

const snapshot = () => ({
  windows: { ...state.windows },
  scopes: JSON.parse(JSON.stringify(state.scopes)),
})

module.exports = {
  subscribe,
  get_window,
  set_window,
  remove_window,
  list_windows,
  windows_in_scope,
  get_channel,
  set_channel,
  get_scope,
  snapshot,
}
