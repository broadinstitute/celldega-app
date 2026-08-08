// Python analysis worker: discovery, lifecycle, and request/response.
//
// Python is for computation only, and is never required to open or view a
// dataset. The worker is started lazily, on the first analysis request, so a
// user who only looks at Landscapes never pays for it and never needs Python
// installed at all.
//
// We DISCOVER a Python rather than bundling one. A bundled scientific stack
// would add ~500 MB to a 240 MB app, and every native .so in it would need
// signing for notarization. Provisioning one with `uv` when none is found is
// the planned fallback (see future/python_worker.md) -- deliberately not built
// until the protocol itself is proven against a Python that already exists.

const { spawn } = require('node:child_process')
const path = require('node:path')
const fsp = require('node:fs/promises')

const WORKER_SCRIPT = path.join(__dirname, '..', 'python', 'worker.py')

// Needed for cluster signatures and hierarchical clustering. h5py is not listed:
// the app reads .h5ad itself with h5wasm, so Python only needs it via anndata.
const REQUIRED_PACKAGES = ['numpy', 'scipy', 'pandas', 'anndata']

// Ordered by how likely they are to be the *intended* interpreter, not merely a
// working one: an explicit override first, then uv's notion of the current
// project's Python, then whatever is on PATH.
const candidate_commands = () => {
  const candidates = []
  if (process.env.CELLDEGA_PYTHON) candidates.push(process.env.CELLDEGA_PYTHON)
  candidates.push('python3', 'python')
  return candidates
}

const run_capture = (command, args, { timeout_ms = 15000, input = null } = {}) =>
  new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
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
const PROBE = `
import json, sys
found = {}
for name in ${JSON.stringify(REQUIRED_PACKAGES)}:
    try:
        m = __import__(name)
        found[name] = getattr(m, "__version__", "unknown")
    except Exception:
        found[name] = None
print(json.dumps({"version": sys.version.split()[0], "executable": sys.executable, "packages": found}))
`

const probe_python = async (command) => {
  const result = await run_capture(command, ['-c', PROBE])
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
  const uv = await run_capture('uv', ['python', 'find'], { timeout_ms: 8000 })
  const commands = candidate_commands()
  if (uv.ok && uv.stdout.trim()) commands.unshift(uv.stdout.trim())

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

module.exports = { discover, request, stop, status }
