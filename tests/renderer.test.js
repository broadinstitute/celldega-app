const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const model = (values = {}) => {
  const listeners = new Map()
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => { values[key] = value; listeners.get(`change:${key}`)?.forEach((fn) => fn()) },
    on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    off: (name, fn) => listeners.get(name)?.delete(fn),
  }
}

const setup = (t, { crlf = false } = {}) => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
  const dom = new JSDOM(html, { url: 'http://localhost/?dev=1', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const w = dom.window
  const calls = { published: [], windows: [], finalizes: 0 }
  const api = {
    get_saved_clustergrams: async () => [],
    open_clustergram_window: async (spec) => { calls.windows.push(spec); return { ok: true } },
    on_job_event() {}, on_menu_action() {}, on_python_setup_progress() {},
    obs_app: { set_window: async () => {}, set_channel: async (...args) => calls.published.push(args),
      on_change: (fn) => { calls.change = fn } },
  }
  w.celldega_app = api
  w.celldega = {
    landscape: async () => ({ model: model(), finalize: () => calls.finalizes++ }),
    clustergram: async (_el, opts) => ({ model: model({ rank_dim: opts.rank_dim, viz_mode: opts.viz_mode }),
      finalize: () => calls.finalizes++ }),
    link_models: (source, key, target, targetKey) => {
      const listener = () => target.set(targetKey, source.get(key))
      source.on(`change:${key}`, listener)
      return () => source.off(`change:${key}`, listener)
    },
  }
  w.tabula_landscape = { zarr_url: 'https://example.org/atlas.zarr' }
  w.tabula_clustergram = {}
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 700, height: 800, bottom: 800 })
  let source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  if (crlf) source = source.replace(/\r?\n/g, '\r\n')
  const js = source.replace(/\r\n/g, '\n')
    .replace(/^import .*\n/gm, '').replace(/\ninit\(\)\s*$/, '')
  w.eval(`${js}\nwindow.test_app = {state, render_clustergram, open_linked_clustergram, show_start, apply_selection, wire_events, scope_id_for, generate_clustergram, publish_selection};`)
  const app = w.test_app
  app.wire_events()
  return { app, w, api, calls }
}

const spec = () => ({ label: 'Test atlas', url: 'https://example.org/matrix.zarr',
  scope_id: 'https://example.org/atlas.zarr', category: 'cell_type', rank_dim: 3,
  dataset: { detail: 'https://example.org/atlas.zarr', label: 'Test atlas',
    landscape_options: { zarr_url: 'https://example.org/atlas.zarr' } } })

test('renderer harness accepts Windows line endings', async (t) => {
  const { app, w } = setup(t, { crlf: true })
  await app.render_clustergram({ url: 'https://example.org/matrix.zarr' })
  assert.equal(w.document.getElementById('cgm_status').hidden, true)
})

test('same-window Clustergram links via models and publishes to other windows', async (t) => {
  const { app, w, calls } = setup(t)
  await app.open_linked_clustergram(spec())
  assert.equal(w.document.getElementById('linked_view').hidden, false)
  for (const id of ['viewer', 'cgm_view']) {
    assert.equal(w.document.getElementById(id).parentElement.id, 'linked_panels')
    assert.equal(w.document.getElementById(id).hidden, false)
  }
  const click = { type: 'row_label', value: { name: 'CD3D', entity: 'gene', attr: 'name' } }
  app.state.clustergram_view.model.set('click_info', click)
  assert.equal(app.state.landscape.model.get('update_trigger'), click)
  assert.equal(calls.published.length, 1)
  assert.equal(calls.published[0][0], spec().scope_id)
  assert.equal(calls.published[0][2].values[0], 'CD3D')
  app.show_start()
  assert.equal(calls.finalizes, 2)
  assert.equal(w.document.getElementById('viewer').parentElement.className, 'app')
})

test('separate-window selections respect scope and suppress programmatic echoes', async (t) => {
  const { app, calls } = setup(t)
  let updates = 0
  app.state.scope_id = 'dataset-a'
  app.state.landscape = {
    update_matrix_gene: async () => {
      updates++
      // The legacy controller reports programmatic selections as well.
      app.publish_selection('gene', ['CD3D'], 'landscape')
      await Promise.resolve()
    },
  }
  calls.change({ type: 'channel', scope_id: 'dataset-b', channel: 'selection',
    origin_window_id: 'window_2', value: { entity: 'gene', values: ['CD3D'] } })
  assert.equal(updates, 0)
  calls.change({ type: 'channel', scope_id: 'dataset-a', channel: 'selection',
    origin_window_id: 'window_2', value: { entity: 'gene', values: ['CD3D'] } })
  assert.equal(updates, 1)
  assert.equal(calls.published.length, 0)
})

test('a saved Matrix renders without AnnData or Python', async (t) => {
  const { app, w } = setup(t)
  await app.render_clustergram({ url: 'http://localhost/data/matrix', key: 'abcdef0123456789' })
  assert.equal(w.document.getElementById('cgm_view').hidden, false)
  assert.equal(w.document.getElementById('btn_cgm_save_table').hidden, true)
  assert.equal(w.document.getElementById('btn_cgm_export').hidden, false)
})

test('generation keeps the separate-window choice', async (t) => {
  const { app, w, api, calls } = setup(t)
  app.state.anndata = { path: '/data/a.h5ad' }
  app.state.source = { kind: 'remote', label: 'Test', base_url: 'https://example.org/dataset' }
  app.state.scope_id = 'https://example.org/dataset'
  w.document.getElementById('cgm_category').innerHTML = '<option value="cell_type">cell_type</option>'
  w.document.getElementById('cgm_layout').value = 'separate'
  api.generate_clustergram = async (options) => {
    assert.equal(options.dataset.detail, app.state.source.base_url)
    return { ok: true, spec: spec() }
  }
  await app.generate_clustergram()
  assert.equal(calls.windows.length, 1)
  assert.equal(app.state.landscape, null)
})


test('closing a loading Matrix prevents it from resurrecting the viewer', async (t) => {
  const { app, w, calls } = setup(t)
  let complete
  w.celldega.clustergram = () => new Promise(resolve => { complete = resolve })
  const loading = app.render_clustergram({ url: 'https://example.org/slow.zarr' })
  app.show_start()
  complete({ model: model(), finalize: () => calls.finalizes++ })
  await loading
  assert.equal(app.state.clustergram_view, null)
  assert.equal(w.document.getElementById('start_screen').hidden, false)
  assert.equal(calls.finalizes, 1)
})

test('a missing Landscape does not prevent opening its saved Clustergram', async (t) => {
  const { app, w, api } = setup(t)
  api.reopen_local_path = async () => ({ ok: false, error: 'Folder was moved' })
  const saved = spec()
  saved.dataset = { kind: 'local', detail: '/moved/dataset' }
  await app.open_linked_clustergram(saved)
  assert.equal(w.document.getElementById('cgm_view').hidden, false)
  assert.equal(w.document.getElementById('cgm_message').hidden, false)
  assert.equal(app.state.clustergram_view !== null, true)
})
