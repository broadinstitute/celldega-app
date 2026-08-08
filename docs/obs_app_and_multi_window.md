# obs_app and multiple windows

Review notes for the `multi-window` branch.

---

## What actually changed, in one line

The app can open more than one window, each showing its own dataset, and there
is now one place in the main process that knows which window is showing what.

---

## What obs_app is doing *today* — honestly, not much

It is worth being blunt, because the name suggests more than currently exists.

**The only user-visible behaviour obs_app produces today is the window title.**

Here is the complete list of writes:

| Where | When | What it writes |
| --- | --- | --- |
| `main.js` | window created | `{ title: 'Celldega' }` |
| `app.js` | dataset loaded | `{ title, view_type: 'landscape', label, detail, technology }` |
| `app.js` | dataset closed | `{ title: 'Celldega', view_type: null, label: null }` |

And the complete list of reads:

| Where | What it does |
| --- | --- |
| `main.js` | sets the OS window title when `title` changes |
| `app.js` | subscribes to channel changes — **and currently does nothing with them** |

The shared channels (`selection`, `annotations`) are declared and broadcast
correctly, but **nothing writes them and nothing reacts to them**. There is only
one view type, so there is nothing to link yet.

So roughly 90% of this file is scaffolding. That is intentional, but it should
be reviewed as scaffolding rather than as working feature code.

### Why add it now rather than later

Because the alternative is worse. The one thing that is genuinely hard to
retrofit is **who owns the state**. If window state starts life inside a
renderer, moving it to the main process later means touching every read and
write in the app at exactly the point when there are several views and windows
depending on it. Establishing main-process ownership while there is one view
type and three writes costs almost nothing.

---

## The design decision worth reviewing

**Authoritative state lives in the main process, not in a renderer.**

Two reasons:

1. With several windows there has to be a single owner. Electing one renderer
   means the state dies when that particular window is closed.
2. A future Jupyter bridge can subscribe directly. The loopback HTTP server
   already runs in main, so a WebSocket endpoint on it would publish these same
   channels without changing this design.

**Two kinds of state, deliberately separated:**

```
windows[window_id]   per-window   isolated; one window never disturbs another
channels[name]       shared       broadcast to every window; opt-in
```

This is the part that matters. Windows are **independent by default** — two
Landscapes can show different datasets without interfering. Linking views later
(Landscape ↔ Clustergram, Landscape ↔ Yearbook) becomes *"both views subscribe
to the same channel"* rather than one window holding a reference to another.

Changes carry `origin_window_id` so a window can ignore the echo of its own
update instead of reacting to itself.

### Relationship to Celldega.js

Celldega.js already has a store family: `obs_store`, `clustergram_store`,
`enrich_store`, `manual_category_store`. Those hold the internal reactive state
of a *single visualization*.

`obs_app` holds state that spans *views and windows*. It is named to sit
alongside that family rather than compete with it, and it must not accumulate
anything that belongs in a visualization's own store.

> Note for a later milestone: `manual_category_store.js` upstream already
> implements manual category labelling (attribute, `node_name → value` map,
> per-category colours, listeners). Manual annotation should wire to that and add
> only persistence/export, rather than being rebuilt here.

---

## Multiple windows

- Windows tracked in a `Map` of `window_id → BrowserWindow`; ids also key
  `obs_app.windows`.
- The single `main_window` global is gone. Menu actions and dialogs now target
  **whichever window has focus**, falling back to the most recent.
- Each renderer learns its own id from a `?window_id=` query parameter on the
  URL main loads.
- Closing a window removes it from both the map and `obs_app`.
- New windows cascade by 32px so they don't land exactly on top of each other.
- Renderer console output is prefixed with the window id, so multi-window logs
  are readable.

**Entry points:** `File → New Window` (`Cmd/Ctrl+N`), a button on the start
screen, and a button in the viewer toolbar. The toolbar one matters — wanting a
second window usually happens while already looking at something, and requiring
a trip to the menu bar for that was the awkward part of the first attempt.

---

## What is deliberately *not* here

- No linked views. Nothing subscribes to a channel yet.
- No split pane. Windows are separate OS windows, not panes.
- No persistence. `obs_app` is memory only and dies with the app.
- No Python, no AnnData. Unchanged.

---

## How this was verified

Automated, driven through the Chrome DevTools Protocol against a running app:

```
windows:            ["window_1","window_2"]
window_1:           Human Pancreas        canvases:1  busy:false
window_2:           Mouse Brain Coronal   canvases:1  busy:false
per-window state:   each window reads back its own value, not the other's
channel broadcast:  reached both windows, tagged origin=window_2
```

That is: two windows rendering **different datasets simultaneously**, per-window
state isolated, and shared-channel changes reaching every window.

---

## Reviewing this

Suggested order:

1. **`src/obs_app.js`** — the whole store, ~100 lines. The per-window vs shared
   split is the thing to agree with or reject.
2. **`src/main.js`** — window tracking, the `focused_window()` helper replacing
   `main_window`, and the IPC bridge with its broadcast.
3. **`src/preload.js`** — the surface exposed to renderers.
4. **`src/renderer/app.js`** — the three `set_window` calls and the (currently
   inert) `on_change` subscriber.

The question worth answering in review is not "does this work" — it does — but
**"is per-window vs shared-channel the right seam for linked views later?"**
That decision is cheap to change now and expensive after Clustergram and
Yearbook are both depending on it.
