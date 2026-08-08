// Renderer. This is the whole app: resolve a base URL, read the manifest,
// work out an initial view, and hand off to Celldega.js. No visualization
// logic lives here by design -- Celldega.js owns all of it.

import celldega from '/vendor/celldega.js'
import { AwsClient } from '/vendor/aws4fetch.js'

const api = window.celldega_app

const $ = (id) => document.getElementById(id)

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
}

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
  $('viewer').hidden = true
  $('start_screen').hidden = false
  state.source = null
  api.obs_app.set_window(window_id, { title: 'Celldega', view_type: null, label: null })
}

const show_viewer = (source) => {
  show_start_error('')
  $('start_screen').hidden = true
  $('viewer').hidden = false
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
  const image_name = manifest.image_info?.[0]?.name
  const dims = image_name ? await fetch_image_dimensions(base_url, image_name, do_fetch) : null
  const { ini_x, ini_y, ini_z, ini_zoom } = AUTO_FIT_VIEW

  const pills = [technology]
  if (dims) pills.push(`${dims.width.toLocaleString()} × ${dims.height.toLocaleString()} px`)
  if (via_proxy) pills.push('proxied')
  if (source.kind === 'authenticated') pills.push('S3 auth')
  set_viewer_pills(pills)

  show_status('Rendering…', 'Fetching tiles and cell metadata')

  try {
    const creds = source.creds || {}
    const model = make_standalone_model()

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
        {},            // meta_cell    -- fetched from base_url by celldega
        [],            // meta_cell_attr
        {},            // meta_cluster -- fetched from base_url by celldega
        [],            // meta_cluster_attr
        {},            // umap
        {},            // nbhd
        false,         // nbhd_edit
        'spatial',     // landscape_state
        'default',     // segmentation
        creds
      )
    }
    hide_status()
    record_recent(source)

    // Publish what this window is showing. Per-window state, so opening a
    // different dataset in another window does not disturb this one.
    api.obs_app.set_window(window_id, {
      title: `${source.label} — Celldega`,
      view_type: 'landscape',
      label: source.label,
      detail: source.detail,
      technology,
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
  }).then(render_recents).catch(() => {})
}

// -------------------------------------------------------------- open ops

const open_local = async () => {
  show_start_error('')
  try {
    const result = await api.open_local_dataset()
    if (result.canceled) return
    if (!result.ok) return show_start_error(result.error)
    await load_dataset(result.source)
  } catch (err) {
    show_start_error(String(err.message || err))
  }
}

const open_remote_from_modal = async () => {
  const url = $('remote_url').value
  const creds = {
    accessKeyId: $('remote_access_key').value,
    secretAccessKey: $('remote_secret_key').value,
    sessionToken: $('remote_session_token').value,
  }

  const error_el = $('remote_error')
  error_el.hidden = true

  const result = await api.resolve_remote_dataset(url, creds)
  if (!result.ok) {
    error_el.textContent = result.error
    error_el.hidden = false
    return
  }

  close_remote_modal()
  await load_dataset(result.source)
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
  if (entry.kind === 'local') {
    // Local mount ids are per-launch, so re-resolve the folder path
    const result = await api.reopen_local_path(entry.detail)
    if (!result.ok) return show_start_error(result.error)
    return load_dataset(result.source)
  }
  return open_remote_url(entry.detail, entry.label, entry.detail, entry.kind)
}

// ---------------------------------------------------------------- modal

const open_remote_modal = () => {
  $('remote_error').hidden = true
  $('remote_modal').hidden = false
  $('remote_url').focus()
}

const close_remote_modal = () => { $('remote_modal').hidden = true }

// ----------------------------------------------------------- card lists

const make_card = ({ name, detail, meta, on_click }) => {
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
        meta: [entry.kind === 'local' ? 'Local folder' : 'Remote', format_when(entry.opened_at)]
          .filter(Boolean)
          .join(' · '),
        on_click: () => reopen_recent(entry),
      })
    )
  }
}

// ---------------------------------------------------------------- events

const handle_resize = () => {
  if (!state.source || $('viewer').hidden) return
  clearTimeout(state.resize_timer)
  // deck.gl is handed explicit pixel dimensions at construction time, so a
  // resize means rebuilding the view. Debounced hard to avoid thrashing
  // during a window drag.
  state.resize_timer = setTimeout(() => load_dataset(state.source), 400)
}

const wire_events = () => {
  $('btn_open_local').addEventListener('click', open_local)
  $('btn_open_remote').addEventListener('click', open_remote_modal)
  $('btn_back').addEventListener('click', show_start)
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

  api.on_menu_action((action) => {
    if (action === 'open_local') open_local()
    if (action === 'open_remote') open_remote_modal()
    if (action === 'close_dataset') show_start()
  })

  // Shared channels are broadcast to every window. Nothing subscribes to them
  // yet -- there is only one view type -- but this is the seam that will carry
  // Landscape <-> Clustergram / Yearbook linking, and eventually a Jupyter
  // bridge, without any window referencing another.
  api.obs_app.on_change((change) => {
    if (change.type !== 'channel') return
    if (change.origin_window_id === window_id) return // ignore our own echo
  })
}

// ------------------------------------------------------------------ init

const init = async () => {
  if (navigator.userAgent.includes('Mac OS X')) document.body.classList.add('is-mac')

  wire_events()
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
