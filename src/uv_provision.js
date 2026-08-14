// Obtain uv, which is used to install the analysis runtime.
//
// uv is DOWNLOADED on first setup rather than shipped in the app. Bundling it
// would add ~88 MB to a universal build for every user, including the majority
// who only ever view Landscapes -- and it would buy nothing, because setting up
// the runtime already needs network access to fetch Python and ~1 GB of
// packages. Nothing here runs unless a user asks for the analysis runtime.
//
// The version is pinned and the download is checksum-verified, so this is as
// reproducible as bundling would have been.

const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const fsp = require('node:fs/promises')
const path = require('node:path')

const UV_VERSION = '0.12.4'

// platform-arch -> [release target, sha256 of the archive]
const TARGETS = {
  'darwin-arm64': ['aarch64-apple-darwin', '99a913b606194867b43086404412c1afe079547fee72ecfb6af7e7b0dd54b0c6'],
  'darwin-x64': ['x86_64-apple-darwin', 'e603f1eb634ca97a2a125539b983891f53235e901511ed10c32c08c86e253ecd'],
  'win32-x64': ['x86_64-pc-windows-msvc', '4f3b7d63cd81fca0da5a655d973d20affca89ce6e5f9a29fd0183cc4204a7639'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'c8c60f47e6f88d18dbf6f33d7279fb1fbf7ae76631768152cf5578c3d65729b4'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '49d881b3403187e1f1789720881e77e4251ad4259d86c4844862657d2a35d13f'],
}

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout, stderr: stderr || (error && error.message) || '' })
    )
  })

const exists = async (p) => {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

// Returns a usable uv path, downloading it if necessary.
//
// Order: an explicit override, then a copy a dev checkout fetched into vendor/,
// then one downloaded previously, then download it.
const ensure_uv = async ({ install_dir, vendor_dir, on_progress = () => {} }) => {
  if (process.env.CELLDEGA_UV && (await exists(process.env.CELLDEGA_UV))) {
    return { ok: true, path: process.env.CELLDEGA_UV, source: 'override' }
  }

  const key = `${process.platform}-${process.arch}`
  const entry = TARGETS[key]
  if (!entry) return { ok: false, error: `No uv build for ${key}` }
  const [target, sha256] = entry

  const bin_name = process.platform === 'win32' ? 'uv.exe' : 'uv'

  if (vendor_dir) {
    const vendored = path.join(vendor_dir, key, bin_name)
    if (await exists(vendored)) return { ok: true, path: vendored, source: 'vendored' }
  }

  const dest_dir = path.join(install_dir, UV_VERSION, key)
  const dest_bin = path.join(dest_dir, bin_name)
  if (await exists(dest_bin)) return { ok: true, path: dest_bin, source: 'cached' }

  on_progress({ step: 'uv', message: `Downloading uv ${UV_VERSION}…` })

  const is_windows = process.platform === 'win32'
  const ext = is_windows ? 'zip' : 'tar.gz'
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.${ext}`

  const tmp = path.join(install_dir, `.tmp-${key}`)
  await fsp.rm(tmp, { recursive: true, force: true })
  await fsp.mkdir(tmp, { recursive: true })

  const archive = path.join(tmp, `uv.${ext}`)
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) {
      return { ok: false, error: `Could not download uv: HTTP ${response.status}` }
    }
    await fsp.writeFile(archive, Buffer.from(await response.arrayBuffer()))
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      error: `Could not download uv: ${err.message}. If you are behind a proxy, set HTTPS_PROXY.`,
    }
  }

  // Verify before executing anything from it
  const digest = createHash('sha256').update(await fsp.readFile(archive)).digest('hex')
  if (digest !== sha256) {
    await fsp.rm(tmp, { recursive: true, force: true })
    return {
      ok: false,
      error: `Downloaded uv did not match its expected checksum (got ${digest.slice(0, 12)}…). Not running it.`,
    }
  }

  const extracted = is_windows
    ? await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`])
    : await run('tar', ['xzf', archive, '-C', tmp])
  if (!extracted.ok) {
    return { ok: false, error: `Could not unpack uv: ${extracted.stderr}` }
  }

  // The binary is either at the archive root or one directory down
  const find = async (dir) => {
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        const hit = await find(full)
        if (hit) return hit
      } else if (item.name === bin_name) {
        return full
      }
    }
    return null
  }

  const found = await find(tmp)
  if (!found) return { ok: false, error: 'uv binary not found in the downloaded archive' }

  await fsp.mkdir(dest_dir, { recursive: true })
  await fsp.rename(found, dest_bin)
  if (!is_windows) await fsp.chmod(dest_bin, 0o755)
  await fsp.rm(tmp, { recursive: true, force: true })

  return { ok: true, path: dest_bin, source: 'downloaded' }
}

module.exports = { ensure_uv, UV_VERSION }
