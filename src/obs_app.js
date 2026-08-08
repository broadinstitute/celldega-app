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
// Two kinds of state, deliberately separated:
//
//   per-window  windows[window_id]  -- isolated; one window never disturbs another
//   shared      channels[name]      -- broadcast to every window; opt-in
//
// Windows are independent by default. Linking views (Landscape <-> Clustergram,
// Landscape <-> Yearbook) is then "both subscribe to the same channel" rather
// than one window holding a reference to another.

const listeners = new Set()

const state = {
  // window_id -> arbitrary per-window state ({ source, technology, ... })
  windows: {},
  // channel name -> value, shared across all windows
  channels: {
    selection: null,
    annotations: {},
  },
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
  delete state.windows[window_id]
  emit({ type: 'window_removed', window_id })
}

const list_windows = () => Object.keys(state.windows)

// ---------------------------------------------------------------- shared

const get_channel = (name) => (name in state.channels ? state.channels[name] : null)

// `origin_window_id` is passed through to subscribers so a window can ignore
// the echo of its own change instead of reacting to itself.
const set_channel = (name, value, origin_window_id = null) => {
  if (!name) return null
  state.channels[name] = value
  emit({ type: 'channel', channel: name, value, origin_window_id })
  return value
}

const snapshot = () => ({
  windows: { ...state.windows },
  channels: { ...state.channels },
})

module.exports = {
  subscribe,
  get_window,
  set_window,
  remove_window,
  list_windows,
  get_channel,
  set_channel,
  snapshot,
}
