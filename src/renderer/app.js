// Renderer. This is the whole app: resolve a base URL, read the manifest,
// work out an initial view, and hand off to Celldega.js. No visualization
// logic lives here by design -- Celldega.js owns all of it.

import celldega from '/vendor/celldega.js'
import { AwsClient } from '/vendor/aws4fetch.js'

const api = window.celldega_app

const $ = (id) => document.getElementById(id)

// Exactly one of these is ever visible. They were previously toggled ad hoc at
// each call site, which meant opening a Landscape from the dataset card left
// the card visible too -- both sections stacked, so the Landscape rendered into
// half the page, and going back re-showed the card above it.
const VIEWS = ['start_screen', 'viewer', 'card_view', 'yb_view', 'cgm_view']

const show_view = (id) => {
  for (const view of VIEWS) $(view).hidden = view !== id
}

// 3D orbit technologies use a different render path and have no image pyramid
// to fit the camera to. Out of scope for v0.1.0 -- flagged explicitly so they
// fail with an explanation instead of a blank canvas.
const ORBIT_TECHNOLOGIES = ['point-cloud', 'neighborhood-cloud', 'cell-cloud']

// Which window this renderer is. Supplied by main as a query param, and used to
// scope this window's obs_app state and to ignore the echo of its own changes.
const window_id = new URLSearchParams(location.search).get('window_id') || 'window_1'

const state = {
  source: null,
  cleanup: null,
  resize_timer: null,
  // The controller returned by landscape_ist, used to drive a rendered
  // Landscape from a selection published by another window
  landscape: null,
  clustergram: null,
  // yearbook_api: update_gene / update_cluster / update_page / update_query
  yearbook: null,
  yearbook_spec: null,
  // { path, info, column, meta, stats } once an .h5ad is attached
  anndata: null,
  // Where these DegaFiles were converted from, when the app produced them
  raw_source: null,
  // Which scope this window's shared state belongs to. Windows sharing a scope
  // are linked; windows over different data are not. Today this is the dataset,
  // later it may be a cohort spanning several datasets -- so it is treated as an
  // opaque key and never parsed.
  scope_id: null,
}

// A dataset's stable identity.
//
// Must come from where the data actually lives, never from `detail` -- for demo
// entries `detail` is a human-readable description, and several demos share the
// same one ("Xenium Prime · FFPE" covers both Human Skin and Ovarian Cancer),
// which would put unrelated datasets in one scope and wrongly link them.
//
// dataset_dir for local (canonical, and stable across the per-launch mount id),
// base_url for remote (the original URL, not the proxy fallback, so the same
// dataset resolves to one scope either way).
const scope_id_for = (source) => source.dataset_dir || source.base_url || null

// --------------------------------------------------------------- helpers

// Celldega reads widget state through an anywidget model. Standalone there is
// no widget, and we must pass a BARE object -- not a stub with a get() method.
//
// Celldega branches on `typeof model?.get === 'function'` to decide whether it
// is running inside a widget. A stub makes that check true, so it takes the
// widget path and then reads undefined for every trait (which fails with
// "Cannot convert undefined or null to object"). With {} the check is false and
// it correctly uses the standalone defaults, fetching everything from base_url.
// This is what the published gallery embed passes.
const make_standalone_model = () => ({})

// Returns the fetch to use for this dataset's own pre-flight requests.
//
// Celldega signs its internal requests itself when handed `creds`, but the
// manifest and .dzi are fetched *here*, before Celldega is ever called. Using a
// plain fetch for those means a private bucket rejects them with 403 and the
// dataset never loads, however valid the credentials are.
//
// Mirrors Celldega's own AwsClient setup (see landscape_ist.js) so both halves
// sign identically -- including the hardcoded us-east-1, which is what Celldega
// uses regardless of where the bucket actually lives.
const make_fetcher = (creds) => {
  if (!creds || !creds.accessKeyId) return (url, init) => fetch(url, init)

  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    region: 'us-east-1',
    service: 's3',
  })
  return (url, init) => aws.fetch(url, init)
}

const fetch_manifest = async (base_url, do_fetch = fetch) => {
  const response = await do_fetch(`${base_url}/landscape_parameters.json`, { cache: 'no-store' })
  if (!response.ok) {
    const err = new Error(`Server returned HTTP ${response.status} for landscape_parameters.json`)
    err.is_http_error = true
    err.status = response.status
    throw err
  }
  return response.json()
}

// Direct first, proxy only on a genuine network/CORS failure.
//
// A thrown fetch means the browser refused the request (CORS, DNS, TLS) --
// that is exactly what the proxy fixes. An HTTP error status means we reached
// the server and it said no, so retrying through the proxy would just repeat
// the same answer; we report it straight away instead.
const resolve_base_url = async (source, do_fetch) => {
  try {
    const manifest = await fetch_manifest(source.base_url, do_fetch)
    return { base_url: source.base_url, manifest, via_proxy: false }
  } catch (err) {
    if (err.is_http_error || !source.proxy_url) throw err

    // The proxy relays requests unsigned, so it cannot reach a private bucket.
    // Falling back to it would only turn a network error into a confusing 403.
    if (source.creds && source.creds.accessKeyId) throw err

    const manifest = await fetch_manifest(source.proxy_url, do_fetch)
    return { base_url: source.proxy_url, manifest, via_proxy: true }
  }
}

// Image dimensions come from the Deep Zoom sidecar, e.g.
// pyramid_images/dapi.dzi -> <Size Width="24134" Height="8571"/>
const fetch_image_dimensions = async (base_url, image_name, do_fetch = fetch) => {
  try {
    const response = await do_fetch(`${base_url}/pyramid_images/${image_name}.dzi`, {
      cache: 'no-store',
    })
    if (!response.ok) return null

    const doc = new DOMParser().parseFromString(await response.text(), 'application/xml')
    const size = doc.getElementsByTagName('Size')[0]
    if (!size) return null

    const width = Number(size.getAttribute('Width'))
    const height = Number(size.getAttribute('Height'))
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null
    }
    return { width, height }
  } catch {
    return null
  }
}

// Celldega auto-fits the camera when ini_x/ini_y/ini_z/ini_zoom are all zero:
// set_initial_view_state falls back to viz_state.spatial's center_x/center_y/
// ini_zoom, which it derives from the dataset's own extent. That is better than
// computing a fit here -- it works for every technology and needs no image
// pyramid. The gallery embeds pass hand-tuned values only to open on a specific
// region; for a general viewer, whole-dataset is the right default.
const AUTO_FIT_VIEW = { ini_x: 0, ini_y: 0, ini_z: 0, ini_zoom: 0 }

// ---------------------------------------------------------- anndata

// Fallback palette when the .h5ad carries no uns['<column>_colors'].
// Okabe-Ito extended -- colourblind-safe, and consistent with the app chrome.
const FALLBACK_COLORS = [
  '#0072b2', '#e69f00', '#009e73', '#d55e00', '#cc79a7',
  '#56b4e9', '#f0e442', '#8c564b', '#7f7f7f', '#279e68', '#aa40fc',
]

// Convert one categorical obs column into the exact shape landscape_ist wants.
//
// Celldega's own parquet path (objects_from_parquet) produces meta_cell as
// { cell_id: [v0, v1, ...] } -- a POSITIONAL array matched to meta_cell_attr,
// not an object keyed by attribute name. meta_cluster is the same idea, with
// meta_cluster_attr naming the positions, and set_cluster_metadata looking up
// 'color' and 'count' by index. Matching that exactly is what makes this work
// without any change to Celldega.js.
//
// Only one attribute is passed at a time, which also settles which one is
// displayed: with a bare {} model there is no cluster_attr trait, so celldega
// falls back to meta_cell_attr[0].
const build_meta_from_column = (col) => {
  const colors = col.colors || col.categories.map((_, i) => FALLBACK_COLORS[i % FALLBACK_COLORS.length])

  const meta_cell = {}
  const { cell_ids, codes, categories } = col
  for (let i = 0; i < cell_ids.length; i += 1) {
    const code = codes[i]
    // code < 0 is AnnData's NaN category; leave the cell out entirely so it
    // renders unstyled rather than being lumped into the first category.
    if (code >= 0) meta_cell[cell_ids[i]] = [categories[code]]
  }

  const meta_cluster = {}
  categories.forEach((name, i) => {
    meta_cluster[name] = [colors[i], col.counts[i]]
  })

  return {
    meta_cell,
    meta_cell_attr: [col.column],
    meta_cluster,
    meta_cluster_attr: ['color', 'count'],
    n_labelled: Object.keys(meta_cell).length,
  }
}

const render_color_by_options = () => {
  const wrap = $('color_by_wrap')
  const select = $('color_by')
  const ann = state.anndata

  // The Clustergram needs an annotation to group by, so it appears exactly when
  // COLOR BY does -- both are gated on an AnnData being attached.
  const has_columns = Boolean(ann && ann.info && ann.info.columns.length > 0)
  $('btn_clustergram').hidden = !has_columns

  if (!has_columns) {
    wrap.hidden = true
    return
  }

  select.innerHTML = ''
  for (const c of ann.info.columns) {
    const opt = document.createElement('option')
    opt.value = c.name
    opt.textContent = `${c.name} (${c.n_categories})`
    if (c.name === ann.column) opt.selected = true
    select.appendChild(opt)
  }
  wrap.hidden = false
}

const attach_anndata = async () => {
  const result = await api.pick_anndata_file()
  if (result.canceled) return
  if (!result.ok) {
    show_status('Could not read that AnnData', result.error, {
      spinner: false,
      dismissable: true,
    })
    return
  }

  if (result.columns.length === 0) {
    show_status(
      'No categorical annotations found',
      `${result.file_name} has ${result.n_obs.toLocaleString()} cells but no categorical obs column with more than one category. Only categorical annotations can be used to colour cells.`,
      { spinner: false, dismissable: true }
    )
    return
  }

  state.anndata = { path: result.path, info: result, column: result.columns[0].name }
  render_color_by_options()
  await apply_color_by(state.anndata.column)
}

// Load an .h5ad and one of its categorical columns into state, ready for the
// next render. Shared by the open form, the COLOR BY dropdown, and reopening a
// recent dataset that had an AnnData attached.
const prepare_anndata = async (file_path, column) => {
  const info = await api.anndata_inspect(file_path)
  if (!info.ok) return { ok: false, error: info.error }
  if (info.columns.length === 0) {
    return { ok: false, error: 'No categorical annotation to colour by' }
  }

  // A remembered column may be gone if the file was regenerated
  const names = info.columns.map((c) => c.name)
  const chosen = column && names.includes(column) ? column : names[0]

  const col = await api.anndata_read_column(file_path, chosen)
  if (!col.ok) return { ok: false, error: col.error }

  state.anndata = {
    path: file_path,
    info,
    column: chosen,
    meta: build_meta_from_column(col),
    stats: {
      n_obs: col.n_obs,
      n_categories: col.categories.length,
      has_colors: Boolean(col.colors),
      unassigned: col.unassigned,
    },
  }
  return { ok: true, column: chosen, requested: column }
}

const apply_color_by = async (column) => {
  const ann = state.anndata
  if (!ann || !state.source) return

  show_status('Reading annotation…', `${column} from ${ann.info.file_name}`)

  const prepared = await prepare_anndata(ann.path, column)
  if (!prepared.ok) {
    show_status('Could not read that annotation', prepared.error, {
      spinner: false,
      dismissable: true,
    })
    return
  }

  // The Landscape takes cell metadata at construction, so recolouring means
  // rebuilding. That is acceptable here -- the camera is auto-fit anyway, and
  // it avoids needing an in-place update API in Celldega.js.
  await load_dataset(state.source)
}

// ----------------------------------------------------- dataset card

// One dataset's components (DegaFiles, AnnData) and the views that can be
// opened from it. Everything on a card shares one scope, so the card is the
// linking group made visible -- which is why it needs no link-graph UI.
//
// A door, not a turnstile: clicking a recent still opens its Landscape
// directly. The card is for when you want to see or change what is attached.

const card_state = { entry: null, anndata: null }

const show_dataset_card = async (entry) => {
  card_state.entry = entry
  card_state.anndata = entry.anndata_path
    ? { path: entry.anndata_path, column: entry.anndata_column }
    : null

  show_view('card_view')
  $('card_error').hidden = true

  $('card_title').textContent = entry.label
  $('card_subtitle').textContent = entry.kind === 'local' ? 'Local dataset' : 'Remote dataset'
  $('card_dega_detail').textContent = entry.detail
  $('card_dega_note').textContent = entry.kind === 'local' ? 'Folder on this machine' : 'Streamed over HTTP'

  // Provenance, when the DegaFiles were produced by the app rather than found
  $('card_raw_row').hidden = !entry.raw_source
  if (entry.raw_source) $('card_raw_detail').textContent = entry.raw_source

  await refresh_card_anndata()
}

const refresh_card_anndata = async () => {
  const ann = card_state.anndata
  const cgm_button = $('btn_card_clustergram')

  if (!ann) {
    $('card_ann_detail').textContent = 'Not attached'
    $('card_ann_note').textContent = 'Attach an .h5ad to colour cells and enable Clustergrams.'
    $('btn_card_attach').textContent = 'Attach…'
    $('card_cgm_note').textContent = 'Requires an AnnData.'
    cgm_button.disabled = true
    return
  }

  $('btn_card_attach').textContent = 'Change…'
  $('card_ann_detail').textContent = ann.path.split('/').pop()

  // Read the columns so the card reports what is actually usable, rather than
  // just that a file is attached -- a file with no categorical column cannot
  // drive anything, and saying so here avoids a dead end later.
  const info = await api.anndata_inspect(ann.path)
  if (!info.ok) {
    $('card_ann_note').textContent = info.error
    $('card_cgm_note').textContent = 'The attached AnnData could not be read.'
    cgm_button.disabled = true
    return
  }

  card_state.anndata.info = info
  const names = info.columns.map((c) => `${c.name} (${c.n_categories})`).join(', ')
  $('card_ann_note').textContent = names
    ? `${info.n_obs.toLocaleString()} cells · ${names}`
    : `${info.n_obs.toLocaleString()} cells · no categorical annotation`

  const usable = info.columns.length > 0
  cgm_button.disabled = !usable
  $('card_cgm_note').textContent = usable
    ? 'Aggregate expression per group and cluster it. Uses Python.'
    : 'Needs a categorical annotation to group by.'
}

const card_attach_anndata = async () => {
  const result = await api.pick_anndata_file()
  if (result.canceled) return
  if (!result.ok) {
    $('card_error').textContent = result.error
    $('card_error').hidden = false
    return
  }
  card_state.anndata = { path: result.path, column: result.columns[0] && result.columns[0].name }
  await refresh_card_anndata()
}

// Open the Landscape this card describes in its own window, carrying its
// AnnData across so the first render is already coloured. Every view opens a
// window, so the card stays a launcher rather than becoming one of its views.
const card_open_landscape = async () => {
  const entry = card_state.entry
  if (!entry) return
  await api.open_landscape({
    detail: entry.detail,
    kind: entry.kind,
    label: entry.label,
    scope_id: entry.detail,
    anndata_path: card_state.anndata ? card_state.anndata.path : null,
    anndata_column: card_state.anndata ? card_state.anndata.column : null,
  })
}

// A Clustergram needs only the AnnData and a scope, so it can be generated
// straight from the card without opening the Landscape first.
const card_generate_clustergram = async () => {
  const entry = card_state.entry
  const ann = card_state.anndata
  if (!entry || !ann || !ann.info) return

  state.anndata = { path: ann.path, info: ann.info, column: ann.column || ann.info.columns[0].name }
  state.scope_id = entry.detail
  state.source = { label: entry.label, detail: entry.detail, kind: entry.kind }
  await open_clustergram_modal()
}

// --------------------------------------------------------- yearbook

// Fills a window better than celldega's own 2x3 default, which leaves most of
// the space empty at the sizes these windows open at.
const YB_DEFAULT_ROWS = 3
const YB_DEFAULT_COLS = 5

// A gallery of individual cells. Takes the same meta_cell / meta_cluster shape
// as the Landscape, so an attached AnnData carries over with no extra work.
const render_yearbook = async (spec) => {
  const el = $('yearbook')
  show_view('yb_view')

  $('yb_label').textContent = spec.label || 'Yearbook'
  $('yb_status_text').textContent = 'Loading dataset…'
  $('yb_status_sub').textContent = spec.detail || ''
  $('yb_status').hidden = false

  // Re-resolve the dataset here rather than being handed a base_url: a local
  // mount id is per-launch, so a window that outlives a restart would hold a
  // dead URL.
  let source
  if (spec.kind === 'local') {
    const result = await api.reopen_local_path(spec.detail)
    if (!result.ok) {
      $('yb_spinner').hidden = true
      $('yb_status_text').textContent = 'Could not open that dataset'
      $('yb_status_sub').textContent = result.error
      return
    }
    source = result.source
  } else {
    const result = await api.resolve_remote_dataset(spec.detail, null)
    if (!result.ok) {
      $('yb_spinner').hidden = true
      $('yb_status_text').textContent = 'Could not open that dataset'
      $('yb_status_sub').textContent = result.error
      return
    }
    source = result.source
  }

  state.source = source
  state.scope_id = scope_id_for(source)

  // Read the annotation in this window rather than shipping 122k entries over
  // IPC -- a column read is ~70ms.
  let meta = { meta_cell: {}, meta_cell_attr: [], meta_cluster: {}, meta_cluster_attr: [] }
  if (spec.anndata_path) {
    $('yb_status_text').textContent = 'Reading annotation…'
    const prepared = await prepare_anndata(spec.anndata_path, spec.anndata_column)
    if (prepared.ok) meta = state.anndata.meta
  }

  const do_fetch = make_fetcher(source.creds)
  const { base_url, manifest } = await resolve_base_url(source, do_fetch)

  $('yb_detail').textContent = state.anndata
    ? `${manifest.technology} · ${state.anndata.column}`
    : manifest.technology || ''

  const pills = []
  if (state.anndata) pills.push(`${state.anndata.column} · ${state.anndata.stats.n_categories} categories`)
  $('yb_pills').innerHTML = ''
  for (const text of pills) {
    const pill = document.createElement('span')
    pill.className = 'pill'
    pill.textContent = text
    $('yb_pills').appendChild(pill)
  }

  $('yb_status_text').textContent = 'Rendering…'

  try {
    const scroller = $('yb_scroll')
    const toolbar = document.querySelector('#yb_view .toolbar')
    const toolbar_h = toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 60
    const width = scroller.clientWidth - 16
    const height = window.innerHeight - toolbar_h - 16

    el.innerHTML = ''
    state.yearbook = await celldega.yearbook(
      el,
      make_standalone_model(),
      '', // token
      base_url,
      '', // dataset_name
      [], // cells -- empty picks a default selection
      spec.num_rows || YB_DEFAULT_ROWS,
      spec.num_cols || YB_DEFAULT_COLS,
      50, // portrait_size_um
      4, // portrait_gap
      width,
      height,
      meta.meta_cell,
      meta.meta_cell_attr,
      meta.meta_cluster,
      meta.meta_cluster_attr,
      'default', // segmentation
      source.creds || {}
    )
    state.yearbook_spec = spec
    $('yb_grid').value = `${spec.num_rows || 2}x${spec.num_cols || 3}`
    $('yb_status').hidden = true
  } catch (err) {
    $('yb_spinner').hidden = true
    $('yb_status_text').textContent = 'Could not render Yearbook'
    $('yb_status_sub').textContent = String(err && err.message ? err.message : err)
  }
}

const card_open_yearbook = async () => {
  const entry = card_state.entry
  if (!entry) return
  await api.open_yearbook({
    detail: entry.detail,
    kind: entry.kind,
    label: entry.label,
    scope_id: entry.detail,
    anndata_path: card_state.anndata ? card_state.anndata.path : null,
    anndata_column: card_state.anndata ? card_state.anndata.column : null,
  })
}

// ------------------------------------------------------- clustergram

// Rendering a Clustergram needs no Python at all -- matrix_from_dega_files
// reads the same cgm/ parquet files whether Python just produced them or they
// shipped inside a DegaFiles directory. Python is only involved in *making*
// them, which is why this window can be reopened later with no interpreter.
const render_clustergram = async (spec) => {
  const el = $('clustergram')
  show_view('cgm_view')

  $('cgm_label').textContent = spec.label || 'Clustergram'
  $('cgm_detail').textContent = `grouped by ${spec.category}`

  // Pills are filled in after drawing: whether a dot plot was actually produced
  // is only known once the size matrix has been loaded.
  const set_cgm_pills = () => {
    const pills = []
    if (spec.stats) pills.push(`${spec.stats.n_rows} genes × ${spec.stats.n_cols} groups`)
    if (spec.zscore) pills.push(`z-score by ${spec.zscore}`)
    if (spec.top_genes) pills.push(`top ${spec.top_genes} by variance`)
    if (spec.dot_plot && state.clustergram_has_dot) pills.push('dot plot')
    else if (spec.dot_plot) pills.push('dot plot unavailable')
    if (spec.cached) pills.push('cached')
    $('cgm_pills').innerHTML = ''
    for (const text of pills) {
      const pill = document.createElement('span')
      pill.className = 'pill'
      pill.textContent = text
      $('cgm_pills').appendChild(pill)
    }
  }
  set_cgm_pills()

  $('cgm_status_text').textContent = 'Loading Clustergram…'
  $('cgm_status_sub').textContent = ''
  $('cgm_status').hidden = false

  try {
    // width/height are the size of the MATRIX, not of everything drawn:
    // celldega adds a control panel above it and a row-label gutter beside it.
    // Passing the container's size therefore always overflows, clipping the
    // right-hand columns and the bottom rows.
    //
    // Rather than hardcode an allowance that would break whenever that chrome
    // changes, render once, measure how far the result overflows, and redraw
    // with the difference subtracted. Self-correcting for any layout.
    // Clicking a label publishes to the shared channel rather than reaching for
    // another window. Windows over the same dataset receive it; windows over
    // other data do not, which is what makes linking correct by construction.
    const publish = (entity, values) => {
      if (!state.scope_id) return
      api.obs_app.set_channel(
        state.scope_id,
        'selection',
        { entity, values, source_view: 'clustergram' },
        window_id
      )
    }

    // Built from networkFromDegaFiles + matrix_viz rather than
    // matrix_from_dega_files, which is otherwise the obvious call.
    //
    // matrix_from_dega_files hardcodes a stub model returning null for every
    // trait except the row/col entities, and celldega reads the display mode
    // from model.get('viz_mode'). So it always resolves to 'heatmap' -- the
    // dot_mat.parquet we compute is loaded into network.size_mat and then
    // ignored, which is why the dot plot never appeared despite being requested.
    // Both pieces are public exports, so passing our own model fixes it without
    // any upstream change.
    const draw = async (width, height) => {
      el.innerHTML = ''
      const network = await celldega.networkFromDegaFiles(spec.base_url, spec.name, {})

      const has_dot = Array.isArray(network.size_mat)
      const model = {
        get: (key) => {
          if (key === 'viz_mode') return has_dot && spec.dot_plot ? 'dotplot' : 'heatmap'
          if (key === 'row_entity')
            return JSON.stringify(network.row_entity || { entity: 'gene', attr: 'name' })
          if (key === 'col_entity')
            return JSON.stringify(network.col_entity || { entity: 'cell', attr: 'leiden' })
          return null
        },
        set: () => {},
        save_changes: () => {},
        on: () => {},
      }

      state.clustergram_has_dot = has_dot
      state.clustergram_view = await celldega.matrix_viz(
        model,
        el,
        network,
        Math.max(200, Math.floor(width)),
        Math.max(200, Math.floor(height)),
        (gene) => publish('gene', [gene]), // rows are genes
        (cluster) => publish('cell_cluster', [cluster]), // columns are groups
        (clusters) => publish('cell_cluster', clusters) // dendrogram branch
      )
    }

    // celldega's own sizing is deterministic, so this needs no measuring:
    //
    //   root.style.height = height + height_margin   (height_margin = 100)
    //   root.style.width  = width  + height_margin
    //   row_offset        = mat_height / num_rows
    //
    // The margin is the control panel and axis chrome, and rows divide the
    // remaining space evenly -- they scale, they do not have a minimum height.
    // So the whole problem is just to subtract that margin from both axes;
    // asking for the container's full size overflows it by exactly 100px in
    // each direction, which is what was cutting off the right-hand columns and
    // the bottom rows.
    const CELLDEGA_MARGIN = 100

    const scroller = $('cgm_scroll')

    // Size from the window and the toolbar rather than from the scroller. The
    // scroller is a flex child whose height is still settling while the view is
    // being shown -- it reported 921 for what ends up 821 -- whereas
    // window.innerHeight is correct immediately and the toolbar's height does
    // not depend on what is drawn inside the scroller.
    const toolbar = document.querySelector('#cgm_view .toolbar')
    const toolbar_h = toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 60

    // Three things sit between the window and the drawn matrix, and all three
    // have to come off the height:
    //
    //   toolbar_h        our own chrome, above the scroller
    //   CONTROL_PANEL    celldega's cluster/dendrogram controls, above the canvas
    //   CELLDEGA_MARGIN  height_margin, which celldega adds to what it is given
    //
    // Measured with all three: canvas bottom 1007 in a 1015 window. Subtracting
    // only the margin left it at 1108, i.e. 93px below the fold -- which is
    // exactly the missing column dendrogram.
    // Both constants are internal celldega values with no accessor. If either
    // changes upstream this clips again, silently -- see future/js_api.md,
    // where self-sizing is the top request precisely because it would delete
    // all of this arithmetic.
    const CONTROL_PANEL = 101
    const SLACK = 8
    const height = window.innerHeight - toolbar_h - CONTROL_PANEL - CELLDEGA_MARGIN - SLACK
    const width = scroller.clientWidth - CELLDEGA_MARGIN - SLACK

    await draw(width, height)

    state.clustergram = spec
    set_cgm_pills()
    $('cgm_status').hidden = true
  } catch (err) {
    $('cgm_spinner').hidden = true
    $('cgm_status_text').textContent = 'Could not render Clustergram'
    $('cgm_status_sub').textContent = String(err && err.message ? err.message : err)
  }
}

const open_clustergram_modal = async () => {
  const ann = state.anndata
  if (!ann) return

  $('cgm_error').hidden = true

  const select = $('cgm_category')
  select.innerHTML = ''
  for (const c of ann.info.columns) {
    const opt = document.createElement('option')
    opt.value = c.name
    opt.textContent = `${c.name} (${c.n_categories})`
    if (c.name === ann.column) opt.selected = true
    select.appendChild(opt)
  }

  // Suggest a gene count whose rows stay legible at this window size. Rows
  // divide the available height between them, so more genes means thinner rows.
  if (!$('cgm_top_genes').value) {
    const usable = (window.innerHeight || 900) - 260 - 100
    const fits = Math.max(10, Math.floor(usable / 12))
    $('cgm_top_genes').value = String(fits)
    $('cgm_top_genes_note').textContent =
      `About ${fits} genes keeps rows readable at this window size. More still works — rows just get thinner. Clear the box to keep every gene.`
  }

  $('cgm_modal').hidden = false

  // Report the Python situation up front rather than after a click that fails.
  const status = $('cgm_python_status')
  status.className = 'banner banner-info'
  status.textContent = 'Checking for Python…'
  status.hidden = false

  await refresh_python_status()
}

// Report the Python situation up front, and offer a way out of it. Without the
// setup button a machine with no suitable Python reaches a dead end here: the
// managed environment exists but nothing would ever create it.
const refresh_python_status = async () => {
  const status = $('cgm_python_status')
  const setup = $('cgm_python_setup')
  const generate = $('btn_cgm_generate')

  const py = await api.python_status()

  if (py.ok) {
    const managed = py.using_managed ? ' · managed environment' : ''
    const wanted = py.wanted_celldega
    const found = py.packages && py.packages.celldega
    // Flag a mismatch rather than hiding it -- an editable install reports the
    // version recorded when it was installed, which is how a checkout at 0.24.1
    // ends up claiming 0.16.0a1.
    const drift = wanted && found && found !== wanted ? ` (app pins ${wanted})` : ''

    status.className = 'banner banner-info'
    status.textContent = `Python ${py.version} · celldega ${found}${drift}${managed}`
    setup.hidden = py.using_managed || !py.managed || py.managed.exists
    generate.disabled = false
    return
  }

  status.className = 'banner banner-error'
  status.textContent = py.error
  setup.hidden = false
  generate.disabled = true
}

// ------------------------------------------------- convert to DegaFiles

const convert_state = { job_id: null, output: null, source: null, technology: null, stages: [] }

const open_convert_modal = () => {
  convert_state.job_id = null
  convert_state.output = null
  $('convert_error').hidden = true
  $('convert_progress').hidden = true
  $('btn_convert_cancel').hidden = true
  $('btn_convert_open').hidden = true
  $('btn_convert_start').hidden = false
  $('convert_modal').hidden = false
  validate_convert_source()
}

const validate_convert_source = async () => {
  const raw = $('convert_source').value.trim()
  const start = $('btn_convert_start')
  start.disabled = true

  if (!raw) return set_status('convert_source_status', '')

  set_status('convert_source_status', 'Checking…', 'busy')
  const info = await api.inspect_raw_dataset(raw)
  if (!info.ok) return set_status('convert_source_status', info.error, 'bad')

  convert_state.source = raw
  convert_state.technology = info.technology
  set_status(
    'convert_source_status',
    `${info.technology} · ${info.sample}${info.has_morphology ? ' · morphology image' : ''}`,
    'ok'
  )
  if (!$('convert_output').value) $('convert_output').value = info.suggested_output
  start.disabled = false
}

const render_convert_stages = (current) => {
  if (!convert_state.stages.includes(current)) convert_state.stages.push(current)
  const list = $('convert_stages')
  list.innerHTML = ''
  convert_state.stages.forEach((stage, index) => {
    const li = document.createElement('li')
    li.textContent = stage
    li.className = index === convert_state.stages.length - 1 ? 'active' : 'done'
    list.appendChild(li)
  })
  list.scrollTop = list.scrollHeight
}

const start_conversion = async () => {
  $('convert_error').hidden = true
  convert_state.stages = []
  $('convert_stages').innerHTML = ''
  $('convert_bar').style.width = '0%'
  $('convert_stage').textContent = 'Starting…'
  $('convert_progress').hidden = false
  $('btn_convert_start').hidden = true
  $('btn_convert_cancel').hidden = false

  const result = await api.convert_to_degafiles({
    source: $('convert_source').value.trim(),
    output: $('convert_output').value.trim(),
    tile_size: Number($('convert_tile_size').value),
    image_tile_layer: $('convert_layers').value,
  })

  if (!result.ok) {
    $('convert_error').textContent =
      result.reason === 'not_found' || result.reason === 'missing_packages'
        ? `${result.error} — set up the analysis runtime from File > Analysis Runtime.`
        : result.error
    $('convert_error').hidden = false
    $('btn_convert_start').hidden = false
    $('btn_convert_cancel').hidden = true
    return
  }
  convert_state.job_id = result.job_id
}

const on_job_event = (job) => {
  if (!convert_state.job_id || job.job_id !== convert_state.job_id) return

  if (job.stage) {
    $('convert_stage').textContent = job.stage
    render_convert_stages(job.stage)
  }
  if (typeof job.fraction === 'number') {
    $('convert_bar').style.width = `${Math.round(job.fraction * 100)}%`
  }

  if (job.status === 'complete') {
    convert_state.output = job.output
    $('convert_stage').textContent = 'Finished'
    $('btn_convert_cancel').hidden = true
    $('btn_convert_open').hidden = false
  } else if (job.status === 'failed') {
    $('convert_error').textContent = job.error || 'Conversion failed'
    $('convert_error').hidden = false
    $('btn_convert_cancel').hidden = true
    $('btn_convert_start').hidden = false
  } else if (job.status === 'cancelled') {
    $('convert_stage').textContent = 'Cancelled'
    $('btn_convert_cancel').hidden = true
    $('btn_convert_start').hidden = false
  }
}

const open_converted_dataset = async () => {
  if (!convert_state.output) return
  $('convert_modal').hidden = true
  await api.open_landscape({
    detail: convert_state.output,
    kind: 'local',
    label: convert_state.output.split('/').pop(),
    scope_id: convert_state.output,
    // Where it came from, so the card can show provenance
    raw_source: convert_state.source,
  })
}

// ------------------------------------------------------ runtime settings

const format_size = (bytes) =>
  bytes == null ? '—' : bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`

const open_runtime_modal = async () => {
  $('runtime_error').hidden = true
  $('runtime_modal').hidden = false
  await refresh_runtime_modal()
}

const refresh_runtime_modal = async () => {
  const status = $('runtime_status')
  const row = $('runtime_detail_row')
  const build = $('btn_runtime_build')
  const remove = $('btn_runtime_remove')

  status.className = 'banner banner-info'
  status.textContent = 'Checking…'
  row.hidden = true
  remove.hidden = true

  const info = await api.runtime_info()

  // An environment left where 0.4.x kept it. Reported rather than silently
  // stranding ~1.2 GB, but never reused -- it was not built by us.
  const legacy = info.legacy || {}
  $('runtime_legacy_row').hidden = !legacy.exists
  if (legacy.exists) $('runtime_legacy_size').textContent = format_size(legacy.size_bytes)

  if (!info.exists) {
    status.className = 'banner banner-info'
    status.textContent = `Not installed. About 1.3 GB will be downloaded, once. Python ${info.wanted_python} · celldega ${info.wanted_celldega}.`
    build.textContent = 'Set up'
    build.hidden = false
    return
  }

  row.hidden = false
  remove.hidden = false
  $('runtime_versions').textContent = info.packages
    ? `Python ${info.python} · celldega ${info.packages.celldega}`
    : `Python ${info.python || 'unknown'}`
  $('runtime_path').textContent = info.path || ''
  $('runtime_size').textContent = format_size(info.size_bytes)

  // Stale is not broken -- it still runs, but it was built from a different
  // pinned set than this app release expects, so results would not match what
  // the release was tested with.
  if (info.stale) {
    status.className = 'banner banner-error'
    status.textContent = `Needs rebuilding — ${info.stale_reason}.`
    build.textContent = 'Rebuild'
  } else if (!info.usable) {
    status.className = 'banner banner-error'
    status.textContent = 'Installed but not working. Rebuilding should fix it.'
    build.textContent = 'Repair'
  } else {
    status.className = 'banner banner-info'
    status.textContent = 'Ready.'
    build.textContent = 'Rebuild'
  }
  build.hidden = false
}

const runtime_build = async () => {
  const build = $('btn_runtime_build')
  const status = $('runtime_status')
  $('runtime_error').hidden = true

  build.disabled = true
  status.className = 'banner banner-info'
  status.textContent = 'Setting up…'

  const result = await api.setup_python_env()
  build.disabled = false

  if (!result.ok) {
    $('runtime_error').textContent = result.error
    $('runtime_error').hidden = false
    return
  }
  await refresh_runtime_modal()
}

const runtime_remove = async () => {
  const result = await api.remove_python_env()
  if (!result.ok) {
    $('runtime_error').textContent = result.error
    $('runtime_error').hidden = false
    return
  }
  await refresh_runtime_modal()
}

const setup_python_env = async () => {
  const button = $('btn_python_setup')
  const status = $('cgm_python_status')

  button.disabled = true
  status.className = 'banner banner-info'
  status.textContent = 'Setting up…'

  const result = await api.setup_python_env()

  button.disabled = false
  if (!result.ok) {
    status.className = 'banner banner-error'
    status.textContent = result.error
    return
  }
  await refresh_python_status()
}

const close_clustergram_modal = () => { $('cgm_modal').hidden = true }

const generate_clustergram = async () => {
  const ann = state.anndata
  if (!ann) return

  const error_el = $('cgm_error')
  error_el.hidden = true

  const top_raw = $('cgm_top_genes').value.trim()
  const options = {
    anndata_path: ann.path,
    category: $('cgm_category').value,
    zscore: $('cgm_zscore').checked ? 'row' : null,
    top_genes: top_raw ? Number(top_raw) : null,
    dot_plot: $('cgm_dot_plot').checked,
    scope_id: state.scope_id,
    label: state.source ? state.source.label : null,
  }

  const button = $('btn_cgm_generate')
  button.disabled = true
  button.textContent = 'Generating…'

  const result = await api.generate_clustergram(options)

  button.disabled = false
  button.textContent = 'Generate'

  if (!result.ok) {
    error_el.textContent = result.error
    error_el.hidden = false
    return
  }
  // The Clustergram renders in its own window; this one keeps its Landscape.
  close_clustergram_modal()
}

const save_signature_table = async () => {
  const ann = state.anndata
  if (!ann) return

  const error_el = $('cgm_error')
  error_el.hidden = true

  const result = await api.save_signature_table({
    anndata_path: ann.path,
    category: $('cgm_category').value,
    zscore: $('cgm_zscore').checked ? 'row' : null,
  })
  if (result.canceled) return
  if (!result.ok) {
    error_el.textContent = result.error
    error_el.hidden = false
    return
  }
  error_el.className = 'banner banner-info'
  error_el.textContent = `Saved ${result.n_rows} × ${result.n_cols} to ${result.out_file}`
  error_el.hidden = false
}

// Apply a selection published by another window in the same scope.
//
// Only the Landscape acts on this today. The Clustergram receives the same
// events -- so a Landscape gene click already reaches it -- but matrix_viz
// exposes no equivalent controller for driving a rendered Clustergram from
// outside; see future/js_api.md.
const apply_selection = (selection) => {
  if (!selection.values || selection.values.length === 0) return

  // Each view exposes a different controller shape for the same two operations
  // -- see future/js_api.md, where a common interface is the third proposal.
  // Until then this branch is the translation layer.
  try {
    const landscape = state.landscape
    if (landscape) {
      if (selection.entity === 'gene') {
        landscape.update_matrix_gene(selection.values[0])
      } else if (selection.entity === 'cell_cluster') {
        if (selection.values.length === 1) landscape.update_matrix_col(selection.values[0])
        else landscape.update_matrix_dendro_col(selection.values)
      }
    }

    const yearbook = state.yearbook
    if (yearbook) {
      if (selection.entity === 'gene' && typeof yearbook.update_gene === 'function') {
        yearbook.update_gene(selection.values[0])
      } else if (
        selection.entity === 'cell_cluster' &&
        typeof yearbook.update_cluster === 'function'
      ) {
        yearbook.update_cluster(selection.values[0])
      }
    }
  } catch (err) {
    console.log(`[link] could not apply selection: ${err && err.message}`)
  }
}

// ------------------------------------------------------------ status ui

const show_status = (text, sub = '', { spinner = true, dismissable = false } = {}) => {
  $('status_text').textContent = text
  $('status_sub').textContent = sub
  $('status_spinner').hidden = !spinner
  $('status_dismiss').hidden = !dismissable
  $('viewer_status').hidden = false
}

const hide_status = () => { $('viewer_status').hidden = true }

const show_start_error = (message) => {
  const el = $('start_error')
  el.textContent = message
  el.hidden = !message
}

// ----------------------------------------------------------- navigation

const show_start = () => {
  teardown_viewer()
  show_view('start_screen')
  state.source = null
  state.scope_id = null
  // An attached AnnData belongs to the dataset it was attached to
  state.anndata = null
  $('color_by_wrap').hidden = true
  api.obs_app.set_window(window_id, {
    title: 'Celldega',
    view_type: null,
    label: null,
    scope_id: null,
  })
}

const show_viewer = (source) => {
  show_start_error('')
  show_view('viewer')
  $('viewer_label').textContent = source.label
  $('viewer_detail').textContent = source.detail
  $('viewer_pills').innerHTML = ''
}

const set_viewer_pills = (items) => {
  $('viewer_pills').innerHTML = ''
  for (const text of items) {
    const pill = document.createElement('span')
    pill.className = 'pill'
    pill.textContent = text
    $('viewer_pills').appendChild(pill)
  }
}

const teardown_viewer = () => {
  if (state.cleanup) {
    try {
      if (typeof state.cleanup === 'function') state.cleanup()
      else if (typeof state.cleanup.finalize === 'function') state.cleanup.finalize()
    } catch {
      // A failed teardown should not block navigating away
    }
    state.cleanup = null
  }
  state.landscape = null
  $('landscape').innerHTML = ''
}

// ------------------------------------------------------------- load flow

const load_dataset = async (source) => {
  state.source = source
  show_viewer(source)
  teardown_viewer()
  show_status('Loading dataset…', source.detail)

  const do_fetch = make_fetcher(source.creds)

  let resolved
  try {
    resolved = await resolve_base_url(source, do_fetch)
  } catch (err) {
    // 401/403 is an access problem, not a wrong path -- saying "check the URL"
    // sends people looking in the wrong place.
    const denied = err.status === 403 || err.status === 401
    const had_creds = Boolean(source.creds && source.creds.accessKeyId)

    let hint
    if (denied && source.creds_from_session) {
      // Reused credentials no longer work -- most likely an expired STS token.
      // Drop them so the next attempt prompts for fresh ones.
      await api.forget_session_creds(source.detail).catch(() => {})
      hint =
        'The credentials saved earlier in this session no longer work — they have most likely ' +
        'expired. They have been discarded; reopen the dataset with File > Open Remote URL to ' +
        'enter fresh ones.'
    } else if (denied && had_creds) {
      hint =
        'Access denied. The credentials were rejected, or they lack permission for this bucket. ' +
        'Check the key and secret, include a session token if they are temporary, and note that ' +
        'buckets outside us-east-1 are not supported yet.'
    } else if (denied) {
      hint =
        'Access denied. This dataset looks private -- reopen it with File > Open Remote URL and ' +
        'fill in the S3 credentials section.'
    } else {
      hint = 'Check the URL points at the folder containing landscape_parameters.json.'
    }

    show_status('Could not reach that dataset', `${err.message}. ${hint}`, {
      spinner: false,
      dismissable: true,
    })
    return
  }

  const { base_url, manifest, via_proxy } = resolved
  const technology = manifest.technology || 'unknown'

  if (ORBIT_TECHNOLOGIES.includes(technology)) {
    show_status(
      'Not supported yet',
      `This is a "${technology}" dataset, which uses the 3D orbit view. Celldega App v0.1.0 renders 2D Landscape datasets only.`,
      { spinner: false, dismissable: true }
    )
    return
  }

  const el = $('landscape')
  const view_width = el.clientWidth
  const view_height = el.clientHeight

  // Fetched only for the dimensions pill -- the camera is auto-fit by celldega
  // eslint-disable-next-line no-unused-vars
  const image_name = manifest.image_info?.[0]?.name
  const dims = image_name ? await fetch_image_dimensions(base_url, image_name, do_fetch) : null
  const { ini_x, ini_y, ini_z, ini_zoom } = AUTO_FIT_VIEW

  const pills = [technology]
  if (dims) pills.push(`${dims.width.toLocaleString()} × ${dims.height.toLocaleString()} px`)
  if (via_proxy) pills.push('proxied')
  if (source.kind === 'authenticated') pills.push('S3 auth')
  if (state.anndata && state.anndata.stats) {
    const s = state.anndata.stats
    pills.push(`${state.anndata.column} · ${s.n_categories} categories`)
    pills.push(`${s.n_obs.toLocaleString()} annotated cells`)
  }
  set_viewer_pills(pills)

  show_status('Rendering…', 'Fetching tiles and cell metadata')

  try {
    const creds = source.creds || {}
    const model = make_standalone_model()
    const meta = (state.anndata && state.anndata.meta) || {
      meta_cell: {},
      meta_cell_attr: [],
      meta_cluster: {},
      meta_cluster_attr: [],
    }

    if (technology === 'h&e') {
      state.cleanup = await celldega.landscape_h_e(
        model,
        el,
        base_url,
        '',
        ini_x,
        ini_y,
        ini_z,
        ini_zoom,
        '',
        view_width,
        view_height,
        creds
      )
    } else {
      // Positional call into Celldega.js. Kept in this single place on purpose:
      // when the upstream API moves to an options object, this is the only
      // call site that changes. See future/js_api.md.
      state.cleanup = await celldega.landscape_ist(
        el,
        model,
        '',            // token
        ini_x,
        ini_y,
        ini_z,
        ini_zoom,
        base_url,
        '',            // dataset_name
        0.25,          // trx_radius
        view_width,
        view_height,
        // Empty means celldega fetches cell metadata from base_url itself.
        // When an AnnData is attached these carry its categories instead.
        meta.meta_cell,
        meta.meta_cell_attr,
        meta.meta_cluster,
        meta.meta_cluster_attr,
        {},            // umap
        {},            // nbhd
        false,         // nbhd_edit
        'spatial',     // landscape_state
        'default',     // segmentation
        creds
      )
    }
    // landscape_ist returns a controller, not just a teardown handle:
    // update_matrix_gene / update_matrix_col / update_matrix_dendro_col drive a
    // rendered Landscape from outside, and on_*_select report back. This is the
    // same surface the Python widgets link through.
    state.landscape = state.cleanup

    if (state.landscape && typeof state.landscape.on_gene_select === 'function') {
      const publish = (entity, values) => {
        if (!state.scope_id) return
        api.obs_app.set_channel(
          state.scope_id,
          'selection',
          { entity, values, source_view: 'landscape' },
          window_id
        )
      }
      state.landscape.on_gene_select((gene) => publish('gene', [gene]))
      state.landscape.on_cluster_select((cluster) => publish('cell_cluster', [cluster]))
      state.landscape.on_clusters_select((clusters) => publish('cell_cluster', clusters))
    }

    hide_status()
    record_recent(source)

    // Publish what this window is showing. Per-window state, so opening a
    // different dataset in another window does not disturb this one.
    state.scope_id = scope_id_for(source)

    api.obs_app.set_window(window_id, {
      title: `${source.label} — Celldega`,
      view_type: 'landscape',
      label: source.label,
      detail: source.detail,
      technology,
      scope_id: state.scope_id,
    })
  } catch (err) {
    show_status('Failed to render dataset', String(err && err.message ? err.message : err), {
      spinner: false,
      dismissable: true,
    })
  }
}

const record_recent = (source) => {
  if (source.kind === 'demo') return
  api.add_recent({
    kind: source.kind,
    label: source.label,
    detail: source.detail,
    // A file path, not a secret, so unlike credentials this is safe to persist
    // -- and it is what makes a remembered dataset come back already coloured.
    anndata_path: state.anndata ? state.anndata.path : null,
    anndata_column: state.anndata ? state.anndata.column : null,
    // A path, like the AnnData one, so it is safe to persist and gives the
    // dataset card provenance after a restart
    raw_source: state.raw_source || null,
  }).then(render_recents).catch(() => {})
}

// -------------------------------------------------------------- open ops

const open_remote_from_modal = async () => {
  const error_el = $('remote_error')
  error_el.hidden = true

  // Validation runs as you type; re-run once here so hitting Enter immediately
  // after typing cannot submit a stale or unchecked value.
  if (!form.validated) await validate_dataset_field()
  if (!form.validated) {
    error_el.textContent = 'Point at a folder or URL containing landscape_parameters.json.'
    error_el.hidden = false
    return
  }

  let source
  if (form.validated.kind === 'remote') {
    source = form.validated.source
  } else {
    const result = await api.reopen_local_path(form.validated.path)
    if (!result.ok) {
      error_el.textContent = result.error
      error_el.hidden = false
      return
    }
    source = result.source
  }

  // Set before loading so the first render is already coloured, rather than
  // drawing once uncoloured and again with the annotation.
  state.anndata = form.anndata
    ? { path: form.anndata.path, info: form.anndata.info, column: form.anndata.info.columns[0].name }
    : null

  close_remote_modal()

  if (state.anndata) {
    const col = await api.anndata_read_column(state.anndata.path, state.anndata.column)
    if (col.ok) {
      state.anndata.meta = build_meta_from_column(col)
      state.anndata.stats = {
        n_obs: col.n_obs,
        n_categories: col.categories.length,
        has_colors: Boolean(col.colors),
        unassigned: col.unassigned,
      }
    } else {
      state.anndata = null
    }
    render_color_by_options()
  }

  await load_dataset(source)
}

const open_remote_url = async (url, label, detail, kind) => {
  const result = await api.resolve_remote_dataset(url, null)
  if (!result.ok) return show_start_error(result.error)

  await load_dataset({
    ...result.source,
    kind: kind || result.source.kind,
    label: label || result.source.label,
    detail: detail || result.source.detail,
  })
}

const reopen_recent = async (entry) => {
  show_start_error('')

  // Restore the AnnData before rendering, so a remembered dataset comes back
  // already coloured rather than drawing plain and then again with labels.
  // The file may have moved or been regenerated since; that must not block
  // reopening the dataset itself.
  state.anndata = null
  let anndata_warning = ''
  if (entry.anndata_path) {
    const prepared = await prepare_anndata(entry.anndata_path, entry.anndata_column)
    if (prepared.ok) {
      render_color_by_options()
      if (prepared.requested && prepared.requested !== prepared.column) {
        anndata_warning = `“${prepared.requested}” is no longer in that AnnData — coloured by “${prepared.column}” instead.`
      }
    } else {
      anndata_warning = `Could not reattach ${entry.anndata_path.split('/').pop()}: ${prepared.error}`
    }
  }

  if (entry.kind === 'local') {
    // Local mount ids are per-launch, so re-resolve the folder path
    const result = await api.reopen_local_path(entry.detail)
    if (!result.ok) return show_start_error(result.error)
    await load_dataset(result.source)
  } else {
    await open_remote_url(entry.detail, entry.label, entry.detail, entry.kind)
  }

  if (anndata_warning) show_start_error(anndata_warning)
}

// ---------------------------------------------------------------- modal

// The open-dataset form takes a local folder or a remote URL in one field and
// validates it as you type, so a wrong path is obvious before you commit to it
// rather than after a failed load.
const form = { validated: null, anndata: null, validate_token: 0, timer: null }

const looks_remote = (value) => /^https?:\/\//i.test(value.trim())

const set_status = (el_id, text, cls = '') => {
  const el = $(el_id)
  el.textContent = text
  el.className = `field-status${cls ? ' ' + cls : ''}`
}

const set_open_enabled = (enabled) => { $('btn_remote_open').disabled = !enabled }

const validate_dataset_field = async () => {
  const raw = $('remote_url').value.trim()
  form.validated = null
  set_open_enabled(false)

  if (!raw) return set_status('ds_status', '')

  const token = ++form.validate_token
  set_status('ds_status', 'Checking…', 'busy')

  try {
    if (looks_remote(raw)) {
      const creds = read_creds_from_form()
      const result = await api.resolve_remote_dataset(raw, creds)
      if (token !== form.validate_token) return
      if (!result.ok) return set_status('ds_status', result.error, 'bad')

      const do_fetch = make_fetcher(result.source.creds)
      const { manifest } = await resolve_base_url(result.source, do_fetch)
      if (token !== form.validate_token) return

      form.validated = { kind: 'remote', source: result.source }
      set_status('ds_status', `Found ${manifest.technology || 'dataset'} · remote`, 'ok')
    } else {
      const result = await api.validate_local_path(raw)
      if (token !== form.validate_token) return
      if (!result.ok) return set_status('ds_status', result.error, 'bad')

      form.validated = { kind: 'local', path: raw }
      const where = result.nested ? ` · found in ${result.dataset_dir.split('/').pop()}` : ''
      set_status('ds_status', `Found ${result.technology} · local folder${where}`, 'ok')
    }
    set_open_enabled(true)
  } catch (err) {
    if (token !== form.validate_token) return
    set_status('ds_status', String(err.message || err), 'bad')
  }
}

const queue_validation = () => {
  clearTimeout(form.timer)
  form.timer = setTimeout(validate_dataset_field, 450)
}

const read_creds_from_form = () => ({
  accessKeyId: $('remote_access_key').value,
  secretAccessKey: $('remote_secret_key').value,
  sessionToken: $('remote_session_token').value,
})

const browse_dataset_folder = async () => {
  const picked = await api.pick_dataset_folder()
  if (!picked.ok) return
  $('remote_url').value = picked.path
  await validate_dataset_field()
}

const browse_anndata = async () => {
  const result = await api.pick_anndata_file()
  if (result.canceled) return
  if (!result.ok) return set_status('ann_status', result.error, 'bad')

  if (result.columns.length === 0) {
    form.anndata = null
    $('ann_path').value = result.file_name
    $('btn_clear_anndata').hidden = false
    return set_status(
      'ann_status',
      `${result.n_obs.toLocaleString()} cells, but no categorical annotation to colour by`,
      'bad'
    )
  }

  form.anndata = { path: result.path, info: result }
  $('ann_path').value = result.file_name
  $('btn_clear_anndata').hidden = false
  const names = result.columns.map((c) => `${c.name} (${c.n_categories})`).join(', ')
  set_status('ann_status', `${result.n_obs.toLocaleString()} cells · ${names}`, 'ok')
}

const clear_anndata_field = () => {
  form.anndata = null
  $('ann_path').value = ''
  $('btn_clear_anndata').hidden = true
  set_status('ann_status', '')
}

const open_remote_modal = () => {
  $('remote_error').hidden = true
  $('remote_modal').hidden = false
  set_open_enabled(Boolean(form.validated))
  $('remote_url').focus()
}

const close_remote_modal = () => { $('remote_modal').hidden = true }

// ----------------------------------------------------------- card lists

const make_card = ({ name, detail, meta, on_click, on_secondary, secondary_label }) => {
  const card = document.createElement('button')
  card.className = 'card'
  card.type = 'button'

  const name_el = document.createElement('div')
  name_el.className = 'name'
  const swatch = document.createElement('span')
  swatch.className = 'swatch'
  // Text lives in its own span so it can be ellipsised independently of the swatch
  const label_el = document.createElement('span')
  label_el.className = 'label'
  label_el.textContent = name
  name_el.append(swatch, label_el)

  const detail_el = document.createElement('div')
  detail_el.className = 'detail'
  detail_el.textContent = detail

  // Truncated in the card, so expose the full values on hover
  card.title = detail ? `${name}\n${detail}` : name

  card.append(name_el, detail_el)

  if (meta) {
    const meta_el = document.createElement('div')
    meta_el.className = 'meta'
    meta_el.textContent = meta
    card.appendChild(meta_el)
  }

  card.addEventListener('click', on_click)

  if (on_secondary) {
    // A separate control rather than a mode switch: the card itself still does
    // the common thing (open it), and this is the way to inspect instead.
    const link = document.createElement('span')
    link.className = 'card-secondary'
    link.textContent = secondary_label || 'Dataset card'
    link.addEventListener('click', (event) => {
      event.stopPropagation()
      on_secondary()
    })
    card.appendChild(link)
  }

  return card
}

const render_demos = async () => {
  const demos = await api.get_demo_datasets()
  const grid = $('demos_grid')
  grid.innerHTML = ''
  for (const demo of demos) {
    grid.appendChild(
      make_card({
        name: demo.label,
        detail: demo.detail,
        meta: demo.is_default ? 'Suggested · streamed from GitHub' : 'Streamed from GitHub',
        on_click: () => open_remote_url(demo.base_url, demo.label, demo.detail, 'demo'),
      })
    )
  }
}

const format_when = (timestamp) => {
  if (!timestamp) return ''
  const days = Math.floor((Date.now() - timestamp) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(timestamp).toLocaleDateString()
}

const render_recents = async () => {
  const recents = await api.get_recents()
  const section = $('recents_section')
  const grid = $('recents_grid')

  section.hidden = recents.length === 0
  grid.innerHTML = ''

  for (const entry of recents) {
    grid.appendChild(
      make_card({
        name: entry.label,
        detail: entry.detail,
        meta: [
          entry.kind === 'local' ? 'Local folder' : 'Remote',
          entry.anndata_column ? `AnnData · ${entry.anndata_column}` : null,
          format_when(entry.opened_at),
        ]
          .filter(Boolean)
          .join(' · '),
        on_click: () => reopen_recent(entry),
        on_secondary: () => show_dataset_card(entry),
        secondary_label: 'Dataset card →',
      })
    )
  }
}

// ---------------------------------------------------------------- events

const handle_resize = () => {
  // A Clustergram window redraws from its cached DegaFiles, so this costs a
  // re-render but no recomputation.
  if (!$('cgm_view').hidden && state.clustergram) {
    clearTimeout(state.resize_timer)
    state.resize_timer = setTimeout(() => render_clustergram(state.clustergram), 400)
    return
  }

  if (!state.source || $('viewer').hidden) return
  clearTimeout(state.resize_timer)
  // deck.gl is handed explicit pixel dimensions at construction time, so a
  // resize means rebuilding the view. Debounced hard to avoid thrashing
  // during a window drag.
  state.resize_timer = setTimeout(() => load_dataset(state.source), 400)
}

const wire_events = () => {
  $('btn_open_dataset').addEventListener('click', open_remote_modal)
  $('btn_back').addEventListener('click', show_start)

  $('remote_url').addEventListener('input', queue_validation)
  $('btn_browse_dataset').addEventListener('click', browse_dataset_folder)
  $('btn_browse_anndata').addEventListener('click', browse_anndata)
  $('btn_clear_anndata').addEventListener('click', clear_anndata_field)
  // Credentials change what a remote URL resolves to, so re-check
  for (const id of ['remote_access_key', 'remote_secret_key', 'remote_session_token']) {
    $(id).addEventListener('input', queue_validation)
  }
  $('status_dismiss').addEventListener('click', show_start)

  $('btn_remote_cancel').addEventListener('click', close_remote_modal)
  $('btn_remote_open').addEventListener('click', open_remote_from_modal)
  $('remote_url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') open_remote_from_modal()
  })

  $('btn_clear_recents').addEventListener('click', async () => {
    await api.clear_recents()
    render_recents()
  })

  $('btn_open_gallery').addEventListener('click', () =>
    api.open_external('https://broadinstitute.github.io/celldega/gallery/')
  )

  $('remote_modal').addEventListener('click', (event) => {
    if (event.target === $('remote_modal')) close_remote_modal()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!$('remote_modal').hidden) close_remote_modal()
  })

  window.addEventListener('resize', handle_resize)

  // Available from both the start screen and inside a view -- opening a second
  // window is most often wanted while already looking at something
  $('btn_new_window').addEventListener('click', () => api.new_window())
  $('btn_new_window_view').addEventListener('click', () => api.new_window())

  $('btn_attach_anndata').addEventListener('click', attach_anndata)
  $('color_by').addEventListener('change', (event) => apply_color_by(event.target.value))

  $('btn_card_back').addEventListener('click', () => show_view('start_screen'))
  $('btn_card_attach').addEventListener('click', card_attach_anndata)
  $('btn_card_landscape').addEventListener('click', card_open_landscape)
  $('btn_card_yearbook').addEventListener('click', card_open_yearbook)

  // Grid size is fixed at construction, so changing it re-renders. Cheap: the
  // dataset and annotation are already resolved and cached.
  $('yb_grid').addEventListener('change', (event) => {
    if (!state.yearbook_spec) return
    const [rows, cols] = event.target.value.split('x').map(Number)
    render_yearbook({ ...state.yearbook_spec, num_rows: rows, num_cols: cols })
  })
  $('btn_card_clustergram').addEventListener('click', card_generate_clustergram)

  $('btn_clustergram').addEventListener('click', open_clustergram_modal)
  $('btn_cgm_cancel').addEventListener('click', close_clustergram_modal)
  $('btn_cgm_generate').addEventListener('click', generate_clustergram)
  $('btn_cgm_save_table').addEventListener('click', save_signature_table)
  $('btn_python_setup').addEventListener('click', setup_python_env)

  $('btn_convert_close').addEventListener('click', () => { $('convert_modal').hidden = true })
  $('btn_convert_browse_source').addEventListener('click', async () => {
    const picked = await api.pick_raw_folder()
    if (!picked.ok) return
    $('convert_source').value = picked.path
    $('convert_output').value = ''
    await validate_convert_source()
  })
  $('btn_convert_browse_output').addEventListener('click', async () => {
    const picked = await api.pick_output_folder($('convert_output').value)
    if (picked.ok) $('convert_output').value = picked.path
  })
  $('convert_source').addEventListener('input', () => {
    clearTimeout(form.timer)
    form.timer = setTimeout(validate_convert_source, 450)
  })
  $('btn_convert_start').addEventListener('click', start_conversion)
  $('btn_convert_cancel').addEventListener('click', () => {
    if (convert_state.job_id) api.cancel_job(convert_state.job_id)
  })
  $('btn_convert_open').addEventListener('click', open_converted_dataset)
  api.on_job_event(on_job_event)

  $('btn_runtime_close').addEventListener('click', () => { $('runtime_modal').hidden = true })
  $('btn_runtime_build').addEventListener('click', runtime_build)
  $('btn_runtime_remove').addEventListener('click', runtime_remove)
  $('btn_runtime_remove_legacy').addEventListener('click', async () => {
    const result = await api.remove_legacy_python_env()
    if (!result.ok) {
      $('runtime_error').textContent = result.error
      $('runtime_error').hidden = false
      return
    }
    await refresh_runtime_modal()
  })
  $('runtime_modal').addEventListener('click', (event) => {
    if (event.target === $('runtime_modal')) $('runtime_modal').hidden = true
  })

  // Setup takes a minute or two and downloads a lot; silence would read as a hang
  api.on_python_setup_progress((progress) => {
    const status = $('cgm_python_status')
    status.className = 'banner banner-info'
    status.textContent = progress.message
  })
  $('cgm_modal').addEventListener('click', (event) => {
    if (event.target === $('cgm_modal')) close_clustergram_modal()
  })

  api.on_menu_action((action) => {
    if (action === 'open_local' || action === 'open_remote') open_remote_modal()
    if (action === 'close_dataset') show_start()
    if (action === 'runtime_settings') open_runtime_modal()
    if (action === 'convert_degafiles') open_convert_modal()
  })

  // Channel changes arrive from every window; react only to our own scope.
  //
  // This is the seam that will carry Landscape <-> Clustergram / Yearbook
  // linking, and eventually a Jupyter bridge, without any window referencing
  // another. Nothing subscribes yet -- there is only one view type.
  api.obs_app.on_change((change) => {
    if (change.type !== 'channel') return
    if (change.origin_window_id === window_id) return // ignore our own echo
    if (!state.scope_id || change.scope_id !== state.scope_id) return // different data
    if (change.channel !== 'selection' || !change.value) return

    apply_selection(change.value)
  })
}

// ------------------------------------------------------------------ init

// Attach an .h5ad by path, bypassing the native file dialog. Used by the
// ?dev=1 hook below so the whole colour-by pipeline can be exercised
// automatically -- a native dialog cannot be driven from a test.
const attach_anndata_path = async (file_path) => {
  const info = await api.anndata_inspect(file_path)
  if (!info.ok || info.columns.length === 0) return info
  state.anndata = { path: file_path, info, column: info.columns[0].name }
  render_color_by_options()
  await apply_color_by(state.anndata.column)
  return info
}

const init = async () => {
  if (navigator.userAgent.includes('Mac OS X')) document.body.classList.add('is-mac')

  // Test hook, opt-in via ?dev=1 on the window URL. Not reachable in normal use.
  if (new URLSearchParams(location.search).get('dev') === '1') {
    window.__dev = { state, form, attach_anndata_path, apply_color_by, build_meta_from_column }
  }

  wire_events()

  // A window opened to show a Clustergram is told so through its own obs_app
  // state, set by main before the page loaded. Reading it here is what lets a
  // second window render something entirely different from the first.
  const own_state = await api.obs_app.get_window(window_id)
  if (own_state && own_state.view_type === 'clustergram' && own_state.clustergram) {
    state.scope_id = own_state.scope_id || null
    await render_clustergram({ ...own_state.clustergram, label: own_state.label })
    return
  }
  if (own_state && own_state.view_type === 'yearbook' && own_state.yearbook) {
    state.scope_id = own_state.scope_id || null
    await render_yearbook({ ...own_state.yearbook, label: own_state.label })
    return
  }
  if (own_state && own_state.view_type === 'landscape' && own_state.landscape) {
    const spec = own_state.landscape
    state.raw_source = spec.raw_source || null
    // reopen_recent owns attaching the AnnData -- it clears state.anndata first,
    // so preparing it here would just be undone.
    await reopen_recent({
      kind: spec.kind,
      label: own_state.label,
      detail: spec.detail,
      anndata_path: spec.anndata_path,
      anndata_column: spec.anndata_column,
    })
    return
  }

  await Promise.all([render_demos(), render_recents()])

  try {
    const version = await api.get_app_version()
    const pill = document.createElement('span')
    pill.className = 'pill'
    pill.textContent = `v${version}`
    $('version_pills').appendChild(pill)
  } catch {
    // Version pill is decorative
  }
}

init()
