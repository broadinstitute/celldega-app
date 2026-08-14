// Python analysis worker: discovery, lifecycle, and request/response.
//
// Python is for computation only, and is never required to open or view a
// dataset. The worker is started lazily, on the first analysis request, so a
// user who only looks at Landscapes never pays for it and never needs Python
// installed at all.
//
// The app ships uv and PROVISIONS its own Python; it does not depend on the
// user having either. A packaged build never falls back to a system Python --
// that is a development convenience only -- so a release always computes
// against the celldega version it pins rather than whatever a machine happens
// to have.
//
// The scientific stack itself is still not bundled. It is ~1.2 GB installed,
// every native library in it would need signing for notarization, and the
// majority of users only ever view Landscapes. So it is downloaded once, on
// request, into app-controlled storage.

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const fsp = require('node:fs/promises')

const WORKER_SCRIPT = path.join(__dirname, '..', 'python', 'worker.py')

// Every version of every package, resolved once at build time rather than at
// each user's install time. Without it two users installing the same app
// release can get different numpy versions, which is the sort of difference
// that shows up as a subtly different result rather than an error.
const REQUIREMENTS_LOCK = path.join(__dirname, '..', 'python', 'requirements.lock')

const RUNTIME_SCHEMA = 1

// The CPython uv provisions for us. Pinned so a given app release always builds
// the same environment.
const MANAGED_PYTHON_VERSION = '3.12'

// Where the bundled uv lives, and where uv should put the Python it downloads.
// Both are set by main, which owns these paths.
let uv_path_override = null
let python_install_dir = null

const set_uv_path = (p) => { uv_path_override = p }
const set_python_install_dir = (p) => { python_install_dir = p }

// System Python is only ever considered in development. A packaged app
// provisions its own, so that a fresh machine needs neither Python nor uv --
// and so that a release cannot silently compute against whatever version a
// user happens to have.
let allow_system_python = true
const set_allow_system_python = (allow) => { allow_system_python = Boolean(allow) }

// uv is shipped with the app rather than found on PATH. Falls back to a PATH
// lookup only when the bundled copy is absent, which is the case in a dev
// checkout that has not run `npm run fetch:uv`.
const uv_command = () => uv_path_override || 'uv'

// uv needs to be told to use its own Python rather than one it finds on the
// system, and where to put it.
const uv_env = () => ({
  ...process.env,
  ...(python_install_dir ? { UV_PYTHON_INSTALL_DIR: python_install_dir } : {}),
  UV_PYTHON_PREFERENCE: 'only-managed',
})

// Pin the Python celldega to the same version as the pinned celldega.js. They
// share a version stream (PyPI and npm are both 0.24.1), and a managed
// environment is the only way to actually guarantee it -- a discovered Python
// gives you whatever the user happens to have.
const CELLDEGA_VERSION = (() => {
  try {
    return require('../package.json').dependencies.celldega
  } catch {
    return null
  }
})()

// Where a managed environment lives. Set by main, which owns userData.
let managed_root = null
const set_managed_root = (dir) => { managed_root = dir }

// A marker written beside the environment recording what it was built from.
// Checking it is cheap; importing the whole scientific stack to find out is
// not, and would be paid on every launch.
const state_file = () => (managed_root ? path.join(managed_root, '..', 'state.json') : null)

const lock_hash = async () => {
  try {
    const contents = await fsp.readFile(REQUIREMENTS_LOCK)
    return crypto.createHash('sha256').update(contents).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

const read_runtime_state = async () => {
  const file = state_file()
  if (!file) return null
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

const write_runtime_state = async (state) => {
  const file = state_file()
  if (!file) return
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, JSON.stringify(state, null, 2))
  } catch {
    // A missing marker only costs a deeper check next time
  }
}

const managed_python = () =>
  managed_root
    ? path.join(managed_root, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
    : null

// Needed for cluster signatures and hierarchical clustering. h5py is not listed:
// the app reads .h5ad itself with h5wasm, so Python only needs it via anndata.
//
// celldega must be here even though it pulls the rest in: the whole computation
// is celldega.clust.Matrix, so a Python without it passes a numpy/scipy check
// and then fails at the moment the user clicks. Better to report it as missing
// up front.
const REQUIRED_PACKAGES = ['numpy', 'scipy', 'pandas', 'anndata', 'celldega']

// The Python and JS packages share a version stream -- PyPI and npm are both on
// 0.24.1 -- but the version is deliberately NOT enforced. An editable install
// reports whatever version was recorded when it was installed, so a checkout
// currently at 0.24.1 can still report 0.16.0a1 through importlib.metadata.
// Rejecting on that would break the setup most likely to be developing against
// celldega.py. The version is surfaced to the user instead, so a genuinely old
// install is visible without being fatal.

// Ordered by how likely they are to be the *intended* interpreter, not merely a
// working one: an explicit override first, then uv's notion of the current
// project's Python, then whatever is on PATH.
const candidate_commands = () => {
  const candidates = []
  // An explicit override wins, so a developer can point at their own checkout.
  if (process.env.CELLDEGA_PYTHON) candidates.push(process.env.CELLDEGA_PYTHON)
  // Then the managed environment, whose celldega version we actually control.
  const managed = managed_python()
  if (managed) candidates.push(managed)
  // System Python is a development convenience only. A packaged app provisions
  // its own, so a release never depends on what a user happens to have.
  if (allow_system_python) candidates.push('python3', 'python')
  return candidates
}

const run_capture = (command, args, { timeout_ms = 15000, input = null, env = null } = {}) =>
  new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) })
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, error: `timed out after ${timeout_ms}ms` })
    }, timeout_ms)

    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => finish({ ok: false, error: err.message }))
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }))

    if (input !== null) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })

// Ask an interpreter what it is and what it can import, in one shot.
// importlib.metadata is used for celldega's version rather than __version__:
// the installed module can carry a stale __version__ string (an editable
// checkout reports 0.16.0a1 while its pyproject says 0.24.1), and the
// distribution metadata is what actually reflects what is installed.
const PROBE = `
import json, sys
found = {}
for name in ${JSON.stringify(REQUIRED_PACKAGES)}:
    try:
        m = __import__(name)
        try:
            from importlib.metadata import version as _v
            found[name] = _v(name)
        except Exception:
            found[name] = getattr(m, "__version__", "unknown")
    except Exception:
        found[name] = None
print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable, "packages": found}))
`

// The default timeout is generous because this imports the whole scientific
// stack. A cold first import -- straight after an install, with no .pyc cached
// -- takes well over 15s, which made a perfectly good environment report as a
// failure.
const probe_python = async (command, { timeout_ms = 120000 } = {}) => {
  const result = await run_capture(command, ['-c', PROBE], { timeout_ms })
  if (!result.ok) return { ok: false, command, error: result.error || result.stderr.trim() }
  try {
    const info = JSON.parse(result.stdout.trim().split('\n').pop())
    const missing = REQUIRED_PACKAGES.filter((p) => !info.packages[p])
    return { ok: true, command, ...info, missing, usable: missing.length === 0 }
  } catch (err) {
    return { ok: false, command, error: `unexpected probe output: ${err.message}` }
  }
}

// Look for a Python that can actually do the work, and report honestly when one
// exists but lacks packages -- "found Python 3.12 but anndata is missing" is
// actionable, "no Python found" is not.
const discover = async () => {
  // Precedence matters and is easy to get backwards. `uv python find` is a
  // fallback, NOT a preference: putting it first would let whatever Python
  // happens to be around outrank both the explicit override and the managed
  // environment whose celldega version we actually pin -- which defeats the
  // point of having a managed environment at all.
  const commands = candidate_commands()
  const uv = await run_capture(uv_command(), ['python', 'find'], { timeout_ms: 8000, env: uv_env() })
  if (uv.ok && uv.stdout.trim()) commands.push(uv.stdout.trim())

  const tried = []
  let best = null

  for (const command of commands) {
    const info = await probe_python(command)
    tried.push(
      info.ok
        ? { command, version: info.version, missing: info.missing }
        : { command, error: info.error }
    )
    if (info.ok && info.usable) return { ok: true, ...info, tried }
    if (info.ok && !best) best = info
  }

  if (best) {
    return {
      ok: false,
      reason: 'missing_packages',
      error: `Found Python ${best.version} at ${best.executable}, but it is missing: ${best.missing.join(', ')}`,
      ...best,
      tried,
    }
  }
  return {
    ok: false,
    reason: 'not_found',
    error: 'No Python interpreter found',
    tried,
  }
}

// --------------------------------------------------- managed environment

// Create a dedicated environment with uv and install a pinned celldega.
//
// This is what makes the version deterministic. A discovered Python reports
// whatever it happens to have -- an editable checkout can even report a stale
// version through importlib.metadata while running much newer code -- which is
// exactly the ambiguity a managed environment removes.
//
// Deliberately lazy: it is only ever invoked when the user asks for it, so
// nothing is downloaded at install time and viewing a dataset never triggers it.
const setup_managed_env = async (on_progress = () => {}) => {
  if (!managed_root) return { ok: false, error: 'No location set for the managed environment' }

  const uv = uv_command()
  const env = uv_env()

  const version = await run_capture(uv, ['--version'], { timeout_ms: 15000, env })
  if (!version.ok) {
    return {
      ok: false,
      reason: 'no_uv',
      error:
        uv_path_override
          ? `The bundled uv could not be run (${uv_path_override}): ${version.stderr || version.error}`
          : 'uv was not found. In a dev checkout run `npm run fetch:uv`; a packaged build ships its own.',
    }
  }

  // Install a CPython that we control. UV_PYTHON_PREFERENCE=only-managed keeps
  // uv from quietly satisfying this with a system Python, which is the whole
  // point -- a fresh machine has no Python at all.
  on_progress({
    step: 'python',
    message: `Downloading Python ${MANAGED_PYTHON_VERSION}…`,
  })
  const py = await run_capture(uv, ['python', 'install', MANAGED_PYTHON_VERSION], {
    timeout_ms: 900000,
    env,
  })
  if (!py.ok) {
    return {
      ok: false,
      error: `Could not install Python ${MANAGED_PYTHON_VERSION}: ${(py.stderr || py.error || '').slice(-600)}`,
    }
  }

  on_progress({ step: 'venv', message: 'Creating environment…' })
  const venv = await run_capture(
    uv,
    ['venv', managed_root, '--python', MANAGED_PYTHON_VERSION],
    { timeout_ms: 300000, env }
  )
  if (!venv.ok) {
    return { ok: false, error: `Could not create the environment: ${venv.stderr || venv.error}` }
  }

  // Install from the lockfile, not from `celldega==x.y.z`. Resolving at install
  // time would give different users different dependency versions for the same
  // app release; `pip sync` installs exactly the locked set and nothing else.
  const have_lock = await fsp
    .access(REQUIREMENTS_LOCK)
    .then(() => true)
    .catch(() => false)

  const spec = CELLDEGA_VERSION ? `celldega==${CELLDEGA_VERSION}` : 'celldega'
  on_progress({
    step: 'install',
    message: have_lock
      ? 'Installing pinned packages… this downloads about 1 GB the first time.'
      : `Installing ${spec}… this downloads about 1 GB the first time.`,
  })

  const install_args = have_lock
    ? ['pip', 'sync', '--python', managed_python(), REQUIREMENTS_LOCK]
    : ['pip', 'install', '--python', managed_python(), spec]

  const install = await run_capture(uv, install_args, { timeout_ms: 1800000, env })
  if (!install.ok) {
    return {
      ok: false,
      error: `Could not install the analysis packages: ${(install.stderr || install.error || '').slice(-600)}`,
    }
  }

  const probe = await probe_python(managed_python())
  if (!probe.ok || !probe.usable) {
    return {
      ok: false,
      error: probe.ok ? `Environment is missing: ${probe.missing.join(', ')}` : probe.error,
    }
  }

  await write_runtime_state({
    schema: RUNTIME_SCHEMA,
    python: probe.version,
    celldega: probe.packages.celldega,
    lock_hash: await lock_hash(),
    built_at: new Date().toISOString(),
  })

  on_progress({ step: 'done', message: 'Environment ready' })
  // Drop any worker running on a previously discovered Python
  stop()
  return { ok: true, ...probe }
}

// Is the installed environment the one this app release expects?
//
// Compares a recorded marker rather than importing anything, so it is cheap
// enough to check before every job. An app upgrade that changes the lockfile
// makes the existing environment stale, and silently continuing with it would
// mean computing against different package versions than the release was
// built and tested with.
const runtime_staleness = async () => {
  const state = await read_runtime_state()
  if (!state) return { known: false }

  const expected_lock = await lock_hash()
  const stale_lock = Boolean(expected_lock && state.lock_hash && state.lock_hash !== expected_lock)
  const stale_celldega = Boolean(
    CELLDEGA_VERSION && state.celldega && state.celldega !== CELLDEGA_VERSION
  )
  const stale_schema = state.schema !== RUNTIME_SCHEMA

  return {
    known: true,
    state,
    stale: stale_lock || stale_celldega || stale_schema,
    reason: stale_celldega
      ? `built for celldega ${state.celldega}, this version expects ${CELLDEGA_VERSION}`
      : stale_lock
        ? 'the pinned package set changed in this version of the app'
        : stale_schema
          ? 'built by an older version of the app'
          : null,
  }
}

// Delete the managed environment and its provisioned Python. Deliberately
// scoped to that directory: datasets, AnnData files, generated artifacts and
// recents live elsewhere and must survive.
const remove_managed_env = async () => {
  if (!managed_root) return { ok: false, error: 'No managed environment configured' }
  stop()
  const root = path.dirname(managed_root)
  try {
    await fsp.rm(root, { recursive: true, force: true })
    return { ok: true, removed: root }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// An environment left behind by an earlier app version, which kept it at a
// different path. It is not reused: it was built against whatever Python was
// available then, rather than one we provisioned, so it is not the environment
// this release expects. But it is ~1.2 GB, so it is reported rather than
// silently stranded, and the user decides whether to reclaim the space.
let legacy_root = null
const set_legacy_root = (dir) => { legacy_root = dir }

const legacy_env_status = async () => {
  if (!legacy_root) return { exists: false }
  try {
    await fsp.access(legacy_root)
  } catch {
    return { exists: false }
  }
  return { exists: true, path: legacy_root, size_bytes: await dir_size(legacy_root) }
}

const remove_legacy_env = async () => {
  if (!legacy_root) return { ok: false, error: 'No previous environment configured' }
  try {
    await fsp.rm(legacy_root, { recursive: true, force: true })
    return { ok: true, removed: legacy_root }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// Best-effort: a slow or failed walk should never stop the panel rendering.
const dir_size = async (root) => {
  let total = 0
  const walk = async (dir) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  await walk(root)
  return total
}

const managed_env_size = async () => {
  if (!managed_root) return null
  return dir_size(path.dirname(managed_root))
}

const managed_env_status = async () => {
  const python = managed_python()
  if (!python) return { exists: false }
  try {
    await fsp.access(python)
  } catch {
    return { exists: false }
  }
  const probe = await probe_python(python)
  return { exists: true, python, ...probe }
}

// ------------------------------------------------------------- lifecycle

let worker = null

const start = async (python_command) => {
  try {
    await fsp.access(WORKER_SCRIPT)
  } catch {
    return { ok: false, error: `Worker script missing at ${WORKER_SCRIPT}` }
  }

  // -u keeps stdout unbuffered; without it responses can sit in a pipe buffer
  // and every request appears to hang.
  const child = spawn(python_command, ['-u', WORKER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const state = { child, command: python_command, pending: new Map(), next_id: 0, buffer: '' }

  child.stdout.on('data', (chunk) => {
    state.buffer += chunk
    // Responses are newline-delimited; a chunk may hold several or a partial one
    let index
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, index).trim()
      state.buffer = state.buffer.slice(index + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line)
        const resolver = state.pending.get(message.id)
        if (resolver) {
          state.pending.delete(message.id)
          resolver(message)
        }
      } catch {
        console.log(`[python] unparseable line: ${line.slice(0, 200)}`)
      }
    }
  })

  child.stderr.on('data', (d) => console.log(`[python] ${String(d).trimEnd()}`))

  const fail_all = (error) => {
    for (const [, resolver] of state.pending) resolver({ ok: false, error })
    state.pending.clear()
    if (worker === state) worker = null
  }

  child.on('error', (err) => fail_all(`worker failed to start: ${err.message}`))
  child.on('close', (code) => fail_all(`worker exited (code ${code})`))

  worker = state
  return { ok: true, command: python_command }
}

// Start on first use, not at launch -- see the note at the top of this file.
const ensure_started = async () => {
  if (worker && !worker.child.killed) return { ok: true, command: worker.command }

  const found = await discover()
  if (!found.ok) return found
  return start(found.command)
}

const request = async (method, params = {}, { timeout_ms = 120000 } = {}) => {
  const started = await ensure_started()
  if (!started.ok) return started

  const state = worker
  const id = ++state.next_id

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      resolve({ ok: false, error: `${method} timed out after ${timeout_ms}ms` })
    }, timeout_ms)

    state.pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error })
    })

    state.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

const stop = () => {
  if (!worker) return
  try {
    worker.child.kill()
  } catch {
    /* already gone */
  }
  worker = null
}

const status = () => ({
  running: Boolean(worker && !worker.child.killed),
  command: worker ? worker.command : null,
})

module.exports = {
  set_legacy_root,
  legacy_env_status,
  remove_legacy_env,
  runtime_staleness,
  remove_managed_env,
  managed_env_size,
  read_runtime_state,
  set_uv_path,
  set_python_install_dir,
  set_allow_system_python,
  MANAGED_PYTHON_VERSION,
  discover,
  request,
  stop,
  status,
  set_managed_root,
  setup_managed_env,
  managed_env_status,
  CELLDEGA_VERSION,
}
