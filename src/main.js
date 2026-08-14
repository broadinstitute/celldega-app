// Electron main process.
//
// Responsibilities: start the loopback server, open the window against it,
// run the native menu and folder picker, and persist the recents list.
// All visualization logic lives in Celldega.js -- none of it is duplicated here.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, screen } = require('electron')
const path = require('node:path')
const fsp = require('node:fs/promises')

const crypto = require('node:crypto')

const { start_server } = require('./local_server')
const obs_app = require('./obs_app')
const anndata_reader = require('./anndata_reader')
const python_worker = require('./python_worker')
const analysis_jobs = require('./analysis_jobs')
const local_source = require('./data_sources/local_source')
const http_source = require('./data_sources/http_source')
const authenticated_source = require('./data_sources/authenticated_source')

const RENDERER_ROOT = path.join(__dirname, 'renderer')
const MAX_RECENTS = 12

// Public demo datasets from the Celldega gallery
// (https://broadinstitute.github.io/celldega/gallery/). All are served from
// raw.githubusercontent.com, which sends `access-control-allow-origin: *`, so
// the renderer's direct fetch path handles them without the proxy.
const DEMO_DATASETS = [
  {
    label: 'Human Pancreas',
    detail: 'Xenium V1 · FFPE · 4 image channels',
    base_url:
      'https://raw.githubusercontent.com/broadinstitute/celldega_Xenium_human_Pancreas_FFPE/main/Landscape_Xenium_V1_human_Pancreas_FFPE_outs_webp',
    is_default: true,
  },
  {
    label: 'Mouse Brain Coronal',
    detail: 'Xenium Prime · fresh frozen',
    base_url:
      'https://raw.githubusercontent.com/broadinstitute/celldega_Xenium_Prime_Mouse_Brain_Coronal_FF_outs/main/Xenium_Prime_Mouse_Brain_Coronal_FF_outs',
  },
  {
    label: 'Human Skin',
    detail: 'Xenium Prime · FFPE',
    base_url:
      'https://raw.githubusercontent.com/broadinstitute/celldega_Xenium_Prime_Human_Skin_FFPE_outs/main/Xenium_Prime_Human_Skin_FFPE_outs',
  },
  {
    label: 'Ovarian Cancer',
    detail: 'Xenium Prime · FFPE',
    base_url:
      'https://raw.githubusercontent.com/broadinstitute/celldega_Xenium_Prime_Ovarian_Cancer_FFPE_XRrun_outs_v2/main/Xenium_Prime_Ovarian_Cancer_FFPE_XRrun_outs',
  },
  {
    label: 'Colon Cancer',
    detail: 'Xenium V1 · CRC add-on, FFPE',
    base_url:
      'https://raw.githubusercontent.com/broadinstitute/celldega_Xenium_V1_Human_Colon_Cancer_P2_CRC_Add_on_FFPE_outs/main/Xenium_V1_Human_Colon_Cancer_P2_CRC_Add_on_FFPE_outs',
  },
  {
    label: 'Atera Cervical Cancer',
    detail: 'Atera Preview · FFPE · 4 image channels',
    // DegaFiles live at the repository root rather than in a subdirectory
    base_url:
      'https://raw.githubusercontent.com/cornhundred/Celldega_WTA_Preview_FFPE_Cervical_Cancer_outs_gh/main',
  },
]

let server = null

// window_id -> BrowserWindow. Each window is an independent viewer with its own
// dataset; obs_app keys its per-window state by the same id.
const windows = new Map()
let window_counter = 0

// Menu actions and dialogs target whichever window has focus, falling back to
// the most recently created one.
const focused_window = () =>
  BrowserWindow.getFocusedWindow() || [...windows.values()].pop() || null

const window_id_for = (win) => {
  for (const [id, w] of windows) if (w === win) return id
  return null
}

// Credentials for private datasets, cached for the lifetime of this process so
// a dataset can be reopened from Recents without retyping them.
//
// In memory only, keyed by normalised base URL. Never written to disk -- the
// recents file on disk still stores no credentials at all (see add_recent), so
// nothing survives a quit. Held in main rather than the renderer so it survives
// a window reload, and so the renderer only receives credentials when it is
// about to sign a request with them.
const session_creds = new Map()

// The celldega bundle is a single pre-built ESM file. Resolve it from
// node_modules rather than copying it, so the pinned version is the one served.
//
// CELLDEGA_JS overrides that with a path to a local Celldega build, which makes
// the develop-against-Celldega.js loop fast: run `npm run build` (or `npm run
// watch`) in the celldega checkout, then just reload the window here with
// Cmd/Ctrl+R. No reinstall, no repackaging -- the file is read per request.
const resolve_celldega_entry = () => {
  const override = process.env.CELLDEGA_JS
  if (override) {
    const resolved = path.resolve(override)
    console.log(`[celldega] using local build: ${resolved}`)
    return resolved
  }

  try {
    return require.resolve('celldega')
  } catch {
    /* falls through to the node_modules path below */
    return path.join(
      __dirname,
      '..',
      'node_modules',
      'celldega',
      'src',
      'celldega',
      'static',
      'celldega.js'
    )
  }
}

// ---------------------------------------------------------------- recents

const recents_path = () => path.join(app.getPath('userData'), 'recents.json')

const read_recents = async () => {
  try {
    return JSON.parse(await fsp.readFile(recents_path(), 'utf8'))
  } catch {
    return []
  }
}

const write_recents = async (entries) => {
  try {
    await fsp.writeFile(recents_path(), JSON.stringify(entries, null, 2))
  } catch {
    // A failed recents write should never block opening a dataset
  }
}

// ---------------------------------------------------------------- window

const create_window = (options = {}) => {
  window_counter += 1
  const window_id = `window_${window_counter}`

  // Cascade new windows so they don't land exactly on top of each other
  const previous = focused_window()
  const offset = previous && windows.size > 0 ? previous.getPosition() : null

  const main_window = new BrowserWindow({
    width: options.width || 1440,
    height: options.height || 940,
    minWidth: 900,
    minHeight: 600,
    ...(offset ? { x: offset[0] + 32, y: offset[1] + 32 } : {}),
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  windows.set(window_id, main_window)
  obs_app.set_window(window_id, { title: 'Celldega' })
  main_window.__celldega_window_id = window_id

  main_window.on('closed', () => {
    windows.delete(window_id)
    obs_app.remove_window(window_id)
  })

  main_window.once('ready-to-show', () => main_window.show())

  // Surface renderer errors on the main process stdout. Without this a module
  // that throws at import time fails silently and the UI just looks inert.
  main_window.webContents.on('console-message', (...args) => {
    const detail = args[1] && typeof args[1] === 'object' ? args[1] : null
    const msg = detail ? `${detail.message} (${detail.sourceId}:${detail.lineNumber})` : `${args[2]} (${args[4]}:${args[3]})`
    console.log(`[${window_id}] ${msg}`)
  })
  main_window.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`)
  })

  // The renderer needs to know which window it is, so it can scope its own
  // obs_app state and ignore the echo of its own channel updates.
  main_window.loadURL(`${server.origin}/?window_id=${window_id}`)

  // External links open in the system browser, never in the app window
  main_window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return main_window
}

const send_menu_action = (action) => {
  const win = focused_window()
  if (win) win.webContents.send('menu_action', action)
}

const build_menu = () => {
  const is_mac = process.platform === 'darwin'

  const template = [
    ...(is_mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => create_window(),
        },
        { type: 'separator' },
        {
          label: 'Open Local Dataset…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send_menu_action('open_local'),
        },
        {
          label: 'Open Remote URL…',
          accelerator: 'CmdOrCtrl+L',
          click: () => send_menu_action('open_remote'),
        },
        { type: 'separator' },
        {
          label: 'Close Dataset',
          accelerator: 'CmdOrCtrl+W',
          click: () => send_menu_action('close_dataset'),
        },
        {
          label: 'Convert Raw Data to DegaFiles…',
          click: () => send_menu_action('convert_degafiles'),
        },
        { type: 'separator' },
        {
          label: 'Analysis Runtime…',
          click: () => send_menu_action('runtime_settings'),
        },
        {
          label: 'Forget Stored Credentials',
          click: () => {
            const count = session_creds.size
            session_creds.clear()
            const win = focused_window()
            if (win) {
              dialog.showMessageBox(win, {
                type: 'info',
                message:
                  count === 0
                    ? 'No credentials were stored.'
                    : `Forgot credentials for ${count} dataset${count === 1 ? '' : 's'}.`,
                detail:
                  'Credentials are only ever kept in memory for the current session and are never written to disk.',
                buttons: ['OK'],
              })
            }
          },
        },
        { type: 'separator' },
        is_mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Celldega Documentation',
          click: () => shell.openExternal('https://broadinstitute.github.io/celldega/'),
        },
        {
          label: 'Dataset Gallery',
          click: () => shell.openExternal('https://broadinstitute.github.io/celldega/gallery/'),
        },
        {
          label: 'Celldega on GitHub',
          click: () => shell.openExternal('https://github.com/broadinstitute/celldega'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ------------------------------------------------------------------- ipc

const register_ipc = () => {
  ipcMain.handle('open_local_dataset', async () => {
    const result = await dialog.showOpenDialog(focused_window(), {
      title: 'Open DegaFiles / Landscape dataset',
      properties: ['openDirectory'],
      buttonLabel: 'Open Dataset',
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return local_source.resolve(result.filePaths[0], server)
  })

  ipcMain.handle('resolve_remote_dataset', async (_event, { url, creds }) => {
    const key = http_source.normalize_url(url)
    const supplied = creds && (creds.accessKeyId || creds.secretAccessKey)

    if (supplied) {
      const result = await authenticated_source.resolve(url, creds, server)
      // Only remember credentials that actually resolved cleanly
      if (result.ok && key) session_creds.set(key, result.source.creds)
      return result
    }

    // Reopening from Recents sends no credentials; reuse this session's if the
    // same dataset was opened successfully earlier.
    if (key && session_creds.has(key)) {
      const result = await authenticated_source.resolve(url, session_creds.get(key), server)
      if (result.ok) return { ...result, source: { ...result.source, creds_from_session: true } }
    }

    return http_source.resolve(url, server)
  })

  ipcMain.handle('has_session_creds', async (_event, url) => {
    const key = http_source.normalize_url(url)
    return Boolean(key && session_creds.has(key))
  })

  ipcMain.handle('clear_session_creds', async () => {
    const count = session_creds.size
    session_creds.clear()
    return count
  })

  // Cached credentials go stale -- temporary STS tokens expire. Drop them on an
  // auth failure so the next attempt asks for fresh ones instead of retrying
  // dead credentials forever.
  ipcMain.handle('forget_session_creds', async (_event, url) => {
    const key = http_source.normalize_url(url)
    if (key) session_creds.delete(key)
    return true
  })

  ipcMain.handle('get_demo_datasets', async () =>
    DEMO_DATASETS.map((entry) => ({ ...entry, kind: 'demo' }))
  )

  ipcMain.handle('get_recents', async () => read_recents())

  ipcMain.handle('add_recent', async (_event, entry) => {
    // Never persist credentials -- they stay in renderer memory for the session
    const { creds, base_url, proxy_url, ...safe_entry } = entry || {}
    if (!safe_entry.detail) return read_recents()

    const entries = await read_recents()
    const deduped = entries.filter((item) => item.detail !== safe_entry.detail)
    // Local mounts get a fresh id each launch, so store the folder path and
    // re-resolve it on click rather than the (stale) base_url.
    deduped.unshift({ ...safe_entry, opened_at: Date.now() })
    const trimmed = deduped.slice(0, MAX_RECENTS)
    await write_recents(trimmed)
    return trimmed
  })

  ipcMain.handle('clear_recents', async () => {
    await write_recents([])
    return []
  })

  ipcMain.handle('open_external', async (_event, url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })

  ipcMain.handle('get_app_version', async () => app.getVersion())

  // ---- AnnData ---------------------------------------------------------
  //
  // Reading happens here rather than in the renderer: an .h5ad is 100-350 MB
  // and mostly expression data we never use, so only the compact result
  // crosses the IPC boundary.

  // Folder picker for the open-dataset form. Returns the chosen path only --
  // mounting happens when the form is submitted, not while browsing.
  ipcMain.handle('pick_dataset_folder', async () => {
    const result = await dialog.showOpenDialog(focused_window(), {
      title: 'Choose a DegaFiles / Landscape dataset folder',
      properties: ['openDirectory'],
      buttonLabel: 'Choose',
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, path: result.filePaths[0] }
  })

  // Live validation for the form: does this local path hold a dataset?
  ipcMain.handle('validate_local_path', async (_event, dir_path) => {
    if (!dir_path) return { ok: false, error: 'No path given' }
    const dataset_dir = await local_source.find_dataset_dir(dir_path)
    if (!dataset_dir) {
      if (await local_source.is_incomplete(dir_path)) {
        return {
          ok: false,
          error: 'This folder is a conversion that did not finish. Re-run Make DegaFiles on it to continue.',
        }
      }
      return {
        ok: false,
        error: 'No landscape_parameters.json here or one level down',
      }
    }
    try {
      const manifest = JSON.parse(
        await fsp.readFile(path.join(dataset_dir, 'landscape_parameters.json'), 'utf8')
      )
      return {
        ok: true,
        dataset_dir,
        technology: manifest.technology || 'unknown',
        nested: dataset_dir !== dir_path,
      }
    } catch (err) {
      return { ok: false, error: `Could not read the manifest: ${err.message}` }
    }
  })

  ipcMain.handle('pick_anndata_file', async () => {
    const result = await dialog.showOpenDialog(focused_window(), {
      title: 'Attach AnnData',
      properties: ['openFile'],
      filters: [{ name: 'AnnData', extensions: ['h5ad'] }],
      buttonLabel: 'Attach',
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }

    const file_path = result.filePaths[0]
    const info = await anndata_reader.inspect(file_path)
    if (!info.ok) return info
    return { ...info, path: file_path }
  })

  ipcMain.handle('anndata_inspect', async (_event, file_path) =>
    anndata_reader.inspect(file_path)
  )

  ipcMain.handle('anndata_read_column', async (_event, { file_path, column }) =>
    anndata_reader.read_categorical(file_path, column)
  )

  // ---- Clustergram ------------------------------------------------------

  ipcMain.handle('python_status', async () => {
    const managed = await python_worker.managed_env_status()
    const found = await python_worker.discover()
    return {
      ok: found.ok,
      executable: found.executable || null,
      version: found.version || null,
      packages: found.packages || null,
      error: found.error || null,
      reason: found.reason || null,
      wanted_celldega: python_worker.CELLDEGA_VERSION,
      managed: { exists: managed.exists, usable: Boolean(managed.usable), python: managed.python || null },
      // True when we are running someone else's Python, so its celldega version
      // is whatever they happen to have rather than the one we pin.
      using_managed: Boolean(found.ok && managed.python && found.executable === managed.python),
    }
  })

  // ---- DegaFiles conversion --------------------------------------------

  // Does this folder look like raw instrument output we can convert?
  // Answering before the job starts means a mistyped path fails in a second
  // rather than forty minutes in.
  ipcMain.handle('inspect_raw_dataset', async (_event, dir_path) => {
    if (!dir_path) return { ok: false, error: 'No folder given' }

    let entries
    try {
      entries = await fsp.readdir(dir_path)
    } catch (err) {
      return { ok: false, error: `Could not read that folder: ${err.message}` }
    }

    const names = new Set(entries)
    // Same signals celldega.pre._determine_technology uses
    const is_xenium = names.has('experiment.xenium') || names.has('transcripts.parquet')
    const is_merscope =
      entries.some((n) => n.startsWith('detected_transcripts')) ||
      entries.some((n) => n.startsWith('cell_boundaries') && n.endsWith('.hdf5'))

    if (!is_xenium && !is_merscope) {
      return {
        ok: false,
        error: 'Not a recognised Xenium or MERSCOPE output folder',
      }
    }

    const technology = is_xenium ? 'Xenium' : 'MERSCOPE'
    const sample = path.basename(dir_path.replace(/[/\\]+$/, ''))
    return {
      ok: true,
      technology,
      sample,
      // Beside the source by convention, so converted output sits with the data
      // it came from rather than somewhere only the app knows about.
      suggested_output: path.join(path.dirname(dir_path.replace(/[/\\]+$/, '')), `${sample}_landscape_files`),
      has_morphology: names.has('morphology.ome.tif') || names.has('morphology_focus'),
    }
  })

  ipcMain.handle('pick_raw_folder', async () => {
    const result = await dialog.showOpenDialog(focused_window(), {
      title: 'Choose raw Xenium or MERSCOPE output',
      properties: ['openDirectory'],
      buttonLabel: 'Choose',
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, path: result.filePaths[0] }
  })

  ipcMain.handle('pick_output_folder', async (_event, default_path) => {
    const result = await dialog.showSaveDialog(focused_window(), {
      title: 'Where should the DegaFiles go?',
      defaultPath: default_path || undefined,
      buttonLabel: 'Choose',
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    return { ok: true, path: result.filePath }
  })

  ipcMain.handle('convert_to_degafiles', async (_event, options) => {
    const { source, output, tile_size = 250, image_tile_layer = 'all' } = options || {}
    if (!source || !output) return { ok: false, error: 'A source and an output folder are required' }

    const found = await python_worker.discover()
    if (!found.ok) return { ok: false, error: found.error, reason: found.reason }

    // Image tiling needs pyvips, and celldega imports it in a try/except that
    // leaves it None. Without this check a missing libvips surfaces as an
    // AttributeError two thirds of the way through a long conversion rather
    // than before it starts.
    const has_pyvips = await python_worker.request('capabilities', {}, { timeout_ms: 120000 })
    if (has_pyvips.ok && has_pyvips.result.packages && !has_pyvips.result.packages.pyvips) {
      return {
        ok: false,
        reason: 'missing_packages',
        error:
          'This Python cannot build image tiles: pyvips is missing. Rebuild the analysis runtime from File > Analysis Runtime, which installs it.',
      }
    }

    return analysis_jobs.run({
      operation: 'preprocess',
      python: found.command,
      script: path.join(__dirname, '..', 'python', 'preprocess.py'),
      output_dir: output,
      request: { source, output, tile_size, image_tile_layer },
    })
  })

  ipcMain.handle('cancel_job', async (_event, job_id) => analysis_jobs.cancel(job_id))
  ipcMain.handle('job_status', async (_event, job_id) => analysis_jobs.status(job_id))

  ipcMain.handle('runtime_info', async () => {
    const [managed, staleness, size, legacy] = await Promise.all([
      python_worker.managed_env_status(),
      python_worker.runtime_staleness(),
      python_worker.managed_env_size(),
      python_worker.legacy_env_status(),
    ])
    return {
      exists: managed.exists,
      usable: Boolean(managed.usable),
      python: managed.version || null,
      packages: managed.packages || null,
      path: managed.python || null,
      size_bytes: size,
      state: staleness.state || null,
      stale: Boolean(staleness.stale),
      stale_reason: staleness.reason || null,
      wanted_celldega: python_worker.CELLDEGA_VERSION,
      wanted_python: python_worker.MANAGED_PYTHON_VERSION,
      legacy,
    }
  })

  ipcMain.handle('remove_legacy_python_env', async () => python_worker.remove_legacy_env())

  ipcMain.handle('remove_python_env', async () => python_worker.remove_managed_env())

  ipcMain.handle('setup_python_env', async (event) => {
    const send_progress = (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('python_setup_progress', progress)
    }
    return python_worker.setup_managed_env(send_progress)
  })

  // Signatures are a deterministic function of (file, column, options), so the
  // result is cached by a hash of exactly those. Re-clustering is an iterative
  // step -- flipping z-score off and back on should be instant, not a recompute.
  //
  // The cache lives in userData rather than the dataset folder. Writing
  // cgm/ into DegaFiles is for finished work destined for a gallery or a
  // presentation, so it stays a deliberate action rather than a side effect of
  // experimenting.
  const clustergram_cache_root = () => path.join(app.getPath('userData'), 'clustergram_cache')

  ipcMain.handle('generate_clustergram', async (_event, options) => {
    const {
      anndata_path,
      category,
      scope_id,
      label,
      zscore = 'row',
      top_genes = null,
      dot_plot = true,
      normalization = 'log1p_cpm',
    } = options || {}

    if (!anndata_path || !category) {
      return { ok: false, error: 'An AnnData file and a category are required' }
    }

    // Include the file's mtime and size, so regenerating the .h5ad invalidates
    // the cache rather than silently serving a stale Clustergram.
    let stamp = ''
    try {
      const stat = await fsp.stat(anndata_path)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch {
      return { ok: false, error: `Could not read ${anndata_path}` }
    }

    const key = crypto
      .createHash('sha256')
      .update(JSON.stringify([anndata_path, stamp, category, zscore, top_genes, dot_plot, normalization]))
      .digest('hex')
      .slice(0, 16)

    const out_dir = path.join(clustergram_cache_root(), key)
    const name = String(category).replace(/[^a-zA-Z0-9_-]/g, '_')
    const meta_file = path.join(out_dir, 'cgm', name, 'meta.json')

    // Stats are cached alongside the files. Without this a cache hit returned
    // no row count, and the renderer sizes the Clustergram from exactly that --
    // so a cached Clustergram silently rendered too short and lost its lower
    // rows, while a freshly computed one was fine.
    const stats_file = path.join(out_dir, 'app_stats.json')

    let cached = false
    let stats = null
    try {
      await fsp.access(meta_file)
      cached = true
      stats = JSON.parse(await fsp.readFile(stats_file, 'utf8'))
    } catch {
      cached = false
    }

    if (!cached) {
      await fsp.mkdir(out_dir, { recursive: true })
      const result = await python_worker.request(
        'cluster_signature',
        { path: anndata_path, category, out_dir, name, zscore, top_genes, dot_plot, normalization },
        { timeout_ms: 900000 }
      )
      if (!result.ok) return { ok: false, error: result.error }
      stats = result.result
      await fsp.writeFile(stats_file, JSON.stringify(stats)).catch(() => {})
    }

    // Serve the cache directory like any other dataset, so the renderer loads it
    // with matrix_from_dega_files exactly as it would a Clustergram that shipped
    // inside a DegaFiles folder.
    const mount_id = server.add_local_mount(out_dir)
    const base_url = `${server.origin}/data/${mount_id}`

    // Taller than a Landscape window: a Clustergram's rows divide the height
    // between them, so vertical space is what decides how many genes stay
    // legible. Clamped to the display so it cannot open partly offscreen.
    const work_area = screen.getPrimaryDisplay().workAreaSize
    const win = create_window({
      width: Math.min(1440, work_area.width - 40),
      height: Math.min(1100, work_area.height - 40),
    })
    const new_window_id = win.__celldega_window_id
    obs_app.set_window(new_window_id, {
      title: `${label || category} — Clustergram`,
      view_type: 'clustergram',
      scope_id: scope_id || null,
      label: label || category,
      clustergram: { base_url, name, category, zscore, top_genes, dot_plot, cached, stats },
    })

    return { ok: true, base_url, name, cached, window_id: new_window_id, stats }
  })

  // Open a Yearbook in its own window, over the same dataset.
  //
  // The window is told what to show through its obs_app state rather than
  // being handed the data: it re-resolves the dataset and re-reads the AnnData
  // itself. Reading a column takes ~70ms, so this is cheaper than pushing
  // 122k cell annotations across IPC, and it keeps the window self-sufficient
  // if it is later reloaded.
  // Opening a view from the dataset card always opens a window. The card is a
  // launcher, so replacing its own contents would be a surprise -- and it left
  // the card visible underneath, which is how a Landscape ended up rendering
  // into half the page.
  ipcMain.handle('open_landscape', async (_event, options) => {
    const { detail, kind, label, scope_id, anndata_path, anndata_column, raw_source } = options || {}
    if (!detail) return { ok: false, error: 'No dataset given' }

    const win = create_window()
    obs_app.set_window(win.__celldega_window_id, {
      title: `${label || 'Landscape'} — Celldega`,
      view_type: 'landscape',
      scope_id: scope_id || null,
      label: label || null,
      landscape: { detail, kind, anndata_path, anndata_column, raw_source },
    })
    return { ok: true, window_id: win.__celldega_window_id }
  })

  ipcMain.handle('open_yearbook', async (_event, options) => {
    const { detail, kind, label, scope_id, anndata_path, anndata_column } = options || {}
    if (!detail) return { ok: false, error: 'No dataset given' }

    const win = create_window()
    obs_app.set_window(win.__celldega_window_id, {
      title: `${label || 'Yearbook'} — Yearbook`,
      view_type: 'yearbook',
      scope_id: scope_id || null,
      label: label || null,
      yearbook: { detail, kind, anndata_path, anndata_column },
    })
    return { ok: true, window_id: win.__celldega_window_id }
  })

  ipcMain.handle('save_signature_table', async (_event, options) => {
    const { anndata_path, category, normalization = 'log1p_cpm', zscore = 'row' } = options || {}
    const result = await dialog.showSaveDialog(focused_window(), {
      title: 'Save signatures',
      defaultPath: `${category}_signatures.csv`,
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'Parquet', extensions: ['parquet'] },
      ],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }

    const written = await python_worker.request(
      'signature_dataframe',
      { path: anndata_path, category, out_file: result.filePath, normalization, zscore },
      { timeout_ms: 900000 }
    )
    return written.ok ? { ok: true, ...written.result } : { ok: false, error: written.error }
  })

  // ---- obs_app bridge -------------------------------------------------
  //
  // Renderers never hold the authoritative state; they read and write through
  // here, and receive changes via the broadcast below.

  ipcMain.handle('obs_app_get_window', async (_event, window_id) => obs_app.get_window(window_id))

  ipcMain.handle('obs_app_set_window', async (_event, { window_id, patch }) => {
    const next = obs_app.set_window(window_id, patch)
    // Keep the OS window title in step with whatever the window is showing
    const win = windows.get(window_id)
    if (win && next && next.title) win.setTitle(next.title)
    return next
  })

  ipcMain.handle('obs_app_get_channel', async (_event, { scope_id, name }) =>
    obs_app.get_channel(scope_id, name)
  )

  ipcMain.handle('obs_app_set_channel', async (_event, { scope_id, name, value, window_id }) =>
    obs_app.set_channel(scope_id, name, value, window_id)
  )

  // Which other windows share this window's scope -- i.e. what it is linked to
  ipcMain.handle('obs_app_linked_windows', async (_event, { scope_id, window_id }) =>
    obs_app.windows_in_scope(scope_id).filter((id) => id !== window_id)
  )

  ipcMain.handle('obs_app_snapshot', async () => obs_app.snapshot())

  ipcMain.handle('new_window', async () => {
    create_window()
    return true
  })

  // Fan every change out to all live windows. Each renderer decides what it
  // cares about -- this is what makes cross-window linking possible later
  // without any window knowing another exists.
  obs_app.subscribe((event) => {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('obs_app_change', event)
    }
  })

  // Reopening a recent local dataset needs a fresh mount id
  ipcMain.handle('reopen_local_path', async (_event, dir_path) =>
    local_source.resolve(dir_path, server)
  )
}

// ------------------------------------------------------------------ boot

app.whenReady().then(async () => {
  // Force light: Celldega's control panel renders into the page, and a dark
  // app surface makes it hard to read. This also keeps the native title bar
  // and form controls light regardless of the OS setting.
  nativeTheme.themeSource = 'light'

  // A managed Python lives beside the app's other data, not in the bundle, so
  // it survives upgrades and can be deleted without touching the install.
  const python_root = path.join(app.getPath('userData'), 'python')
  python_worker.set_managed_root(path.join(python_root, 'env'))
  python_worker.set_python_install_dir(path.join(python_root, 'runtime'))
  // Where 0.4.x kept its environment. Reported so ~1.2 GB is not silently
  // stranded by the move, but never reused: it was built against whatever
  // Python was around then rather than one we provisioned.
  python_worker.set_legacy_root(path.join(app.getPath('userData'), 'python_env'))

  // uv is shipped as an extraResource so it sits outside app.asar -- an
  // executable cannot be run from inside an archive. In a dev checkout it is
  // in vendor/, populated by `npm run fetch:uv`.
  // uv is downloaded on first setup and cached here. A dev checkout that ran
  // `npm run fetch:uv` has one in vendor/, which is used in preference so
  // development does not re-download it.
  python_worker.set_uv_dirs({
    install_dir: path.join(python_root, 'uv'),
    vendor_dir: app.isPackaged ? null : path.join(__dirname, '..', 'vendor', 'uv'),
  })

  // Only a development build may fall back to a system Python. A packaged one
  // provisions its own, which is what makes a fresh machine work.
  python_worker.set_allow_system_python(!app.isPackaged)

  // Long jobs write a request, a log and their output under here, so a job
  // directory is a complete record of what was asked for and what happened.
  analysis_jobs.set_jobs_root(path.join(app.getPath('userData'), 'jobs'))
  analysis_jobs.set_listener((event) => {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('job_event', event)
    }
  })

  server = await start_server({
    renderer_root: RENDERER_ROOT,
    celldega_entry: resolve_celldega_entry(),
    // ESM build, so the renderer can import it directly
    aws4fetch_entry: path.join(
      __dirname,
      '..',
      'node_modules',
      'aws4fetch',
      'dist',
      'aws4fetch.esm.mjs'
    ),
  })

  register_ipc()
  build_menu()
  create_window()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) create_window()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  if (server) server.close()
  python_worker.stop()
  analysis_jobs.stop_all()
})
