// Run with `npm run screenshots`. Captures real Electron views using public
// gallery data and an isolated temporary profile; no Python is needed.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const outputArg = process.argv.find((value) => value.startsWith('--screenshot-output='))
const output = path.resolve(outputArg?.slice('--screenshot-output='.length) || path.join(root, 'docs', 'screenshots'))
const profile = fsSync.mkdtempSync(path.join(os.tmpdir(), 'celldega-screenshots-'))
process.env.CELLDEGA_USER_DATA = profile
delete process.env.CELLDEGA_JS

const firstWindow = new Promise((resolve) => {
  app.once('browser-window-created', (_event, win) => resolve(win))
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (win, code) => win.webContents.executeJavaScript(code)
const captures = []

const until = async (win, code, description, timeout = 120000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await evaluate(win, code)) return
    await wait(250)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const ready = async (win) => {
  win.setContentSize(1440, 1000)
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  }
  const url = new URL(win.webContents.getURL())
  url.searchParams.set('dev', '1')
  await win.loadURL(url.href)
  await until(win, 'Boolean(window.__dev)', 'renderer')
}

const capture = async (win, filename, description) => {
  win.show()
  win.focus()
  await evaluate(win, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  // Celldega's async tile/layer draws continue after its renderer resolves.
  await wait(2000)
  const screenshot = await win.webContents.capturePage()
  await fs.writeFile(path.join(output, filename), screenshot.toPNG())
  const size = screenshot.getSize()
  captures.push({ filename, description, ...size })
  console.log(`[screenshots] ${filename} (${size.width} × ${size.height})`)
}

const run = async () => {
  await fs.mkdir(output, { recursive: true })
  const win = await firstWindow
  await ready(win)
  await until(win, "document.querySelectorAll('#demos_grid .card').length >= 9 && document.getElementById('pill_celldega').textContent.includes('0.28.0')", 'gallery and version labels')
  await capture(win, 'gallery.png', 'Start screen with Atera Kidney first and Tabula Sapiens examples last.')

  await evaluate(win, "document.getElementById('btn_open_dataset').click()")
  await capture(win, 'open-dataset.png', 'Open Dataset form for a local folder or remote URL, with an optional AnnData attachment.')
  await evaluate(win, "document.getElementById('btn_remote_cancel').click()")

  await evaluate(win, "document.querySelector('#demos_grid .card').click()")
  await until(win, "window.__dev.state.landscape && document.getElementById('viewer_status').hidden", 'Atera Kidney Landscape')
  await capture(win, 'atera-kidney-landscape.png', 'Atera Kidney spatial Landscape with image, cell-type and gene controls.')

  await evaluate(win, "window.__dev.open_gallery_demo('tabula_sapiens_linked')")
  await until(win, "window.__dev.state.clustergram_view && document.getElementById('viewer_status').hidden && document.getElementById('cgm_status').hidden", 'linked Tabula Sapiens views')
  await capture(win, 'tabula-sapiens-linked.png', 'Tabula Sapiens UMAP and marker Clustergram linked in one window.')

  const separateWindow = new Promise((resolve) => {
    app.once('browser-window-created', (_event, next) => resolve(next))
  })
  await evaluate(win, "document.getElementById('btn_cgm_separate').click()")
  const clustergram = await separateWindow
  await ready(clustergram)
  await until(clustergram, "window.__dev.state.clustergram_view && document.getElementById('cgm_status').hidden", 'separate Clustergram')
  await capture(clustergram, 'tabula-sapiens-clustergram.png', 'Tabula Sapiens Clustergram in its own window; the UMAP remains open separately.')
  await until(win, "window.__dev.state.landscape && !window.__dev.state.linked && document.getElementById('viewer_status').hidden", 'separate UMAP')
  await capture(win, 'tabula-sapiens-umap.png', 'Tabula Sapiens UMAP in its own window, paired with the separate Clustergram.')

  let revision = null
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch { /* Capturing a source archive does not require Git. */ }
  const pkg = require('../package.json')
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
    captured_at: new Date().toISOString(),
    app_version: pkg.version,
    celldega_js: pkg.dependencies.celldega,
    source_revision: revision,
    platform: process.platform,
    mode: 'source run with a clean temporary profile',
    captures,
  }, null, 2) + '\n')
  console.log(`[screenshots] Saved ${captures.length} captures to ${output}`)
}

const timeout = setTimeout(() => {
  console.error('[screenshots] Capture timed out')
  app.exit(1)
}, 480000)
timeout.unref()

app.once('will-quit', () => {
  try { fsSync.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* OS temp cleanup can retry locked Chromium files. */ }
})

run().then(() => {
  clearTimeout(timeout)
  app.quit()
}).catch((error) => {
  console.error('[screenshots]', error)
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  app.exit(1)
})
