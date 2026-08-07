// Electron main process.
//
// Responsibilities: start the loopback server, open the window against it,
// run the native menu and folder picker, and persist the recents list.
// All visualization logic lives in Celldega.js -- none of it is duplicated here.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron')
const path = require('node:path')
const fsp = require('node:fs/promises')

const { start_server } = require('./local_server')
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
]

let server = null
let main_window = null

// The celldega bundle is a single pre-built ESM file. Resolve it from
// node_modules rather than copying it, so the pinned version is the one served.
const resolve_celldega_entry = () => {
  try {
    return require.resolve('celldega')
  } catch {
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

const create_window = () => {
  main_window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
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

  main_window.once('ready-to-show', () => main_window.show())

  // Surface renderer errors on the main process stdout. Without this a module
  // that throws at import time fails silently and the UI just looks inert.
  main_window.webContents.on('console-message', (...args) => {
    const detail = args[1] && typeof args[1] === 'object' ? args[1] : null
    if (detail) console.log(`[renderer] ${detail.message} (${detail.sourceId}:${detail.lineNumber})`)
    else console.log(`[renderer] ${args[2]} (${args[4]}:${args[3]})`)
  })
  main_window.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`)
  })

  main_window.loadURL(server.origin)

  // External links open in the system browser, never in the app window
  main_window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

const send_menu_action = (action) => {
  if (main_window) main_window.webContents.send('menu_action', action)
}

const build_menu = () => {
  const is_mac = process.platform === 'darwin'

  const template = [
    ...(is_mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
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
    const result = await dialog.showOpenDialog(main_window, {
      title: 'Open DegaFiles / Landscape dataset',
      properties: ['openDirectory'],
      buttonLabel: 'Open Dataset',
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return local_source.resolve(result.filePaths[0], server)
  })

  ipcMain.handle('resolve_remote_dataset', async (_event, { url, creds }) => {
    const use_auth = creds && (creds.accessKeyId || creds.secretAccessKey)
    if (use_auth) return authenticated_source.resolve(url, creds, server)
    return http_source.resolve(url, server)
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

  server = await start_server({
    renderer_root: RENDERER_ROOT,
    celldega_entry: resolve_celldega_entry(),
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
})
