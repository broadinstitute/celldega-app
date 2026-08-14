// Download the pinned uv binaries into vendor/uv/ before packaging.
//
// uv is shipped with the app so that provisioning a Python environment needs
// neither Python nor uv already installed. Run at build time, not at runtime:
// a release should contain a known uv, not whatever happens to be current.
//
//   node scripts/fetch_uv.mjs            # this machine's platform
//   node scripts/fetch_uv.mjs --all      # every target (needs tar and unzip)
//   node scripts/fetch_uv.mjs --mac      # both macOS arches, for universal builds
//
// The binaries are gitignored. CI fetches them on each runner, so a Windows
// runner only ever unpacks the Windows archive.

import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, rmSync, renameSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const UV_VERSION = '0.12.4'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'vendor', 'uv')

// platform-arch (as Node reports it) -> uv release target triple
const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
}

const args = process.argv.slice(2)

// macOS releases are universal, so both arches are always needed there -- the
// packaged app has to carry a uv for whichever machine it ends up on, not just
// the one that built it.
const default_targets =
  process.platform === 'darwin'
    ? ['darwin-arm64', 'darwin-x64']
    : [`${process.platform}-${process.arch}`]

const wanted = args.includes('--all')
  ? Object.keys(TARGETS)
  : args.includes('--mac')
    ? ['darwin-arm64', 'darwin-x64']
    : default_targets

const run = (cmd, argv, cwd) =>
  execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

for (const key of wanted) {
  const target = TARGETS[key]
  if (!target) {
    console.error(`no uv build for ${key}`)
    process.exit(1)
  }

  const is_windows = key.startsWith('win32')
  const bin_name = is_windows ? 'uv.exe' : 'uv'
  const dest_dir = join(VENDOR, key)
  const dest_bin = join(dest_dir, bin_name)

  if (existsSync(dest_bin)) {
    console.log(`${key}: already present`)
    continue
  }

  const ext = is_windows ? 'zip' : 'tar.gz'
  const archive_name = `uv-${target}.${ext}`
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archive_name}`

  const tmp = join(VENDOR, `.tmp-${key}`)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })

  console.log(`${key}: downloading uv ${UV_VERSION}…`)
  const archive = join(tmp, archive_name)
  run('curl', ['-fsSL', url, '-o', archive])

  if (is_windows) {
    // PowerShell on a Windows runner; unzip elsewhere (for cross-fetching)
    if (process.platform === 'win32') {
      run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}' -Force`])
    } else {
      run('unzip', ['-q', archive, '-d', tmp])
    }
  } else {
    run('tar', ['xzf', archive, '-C', tmp])
  }

  // Archives contain the binary either at the root or one directory down
  const found = (function find(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        const hit = find(full)
        if (hit) return hit
      } else if (entry === bin_name) {
        return full
      }
    }
    return null
  })(tmp)

  if (!found) {
    console.error(`${key}: ${bin_name} not found in ${archive_name}`)
    process.exit(1)
  }

  mkdirSync(dest_dir, { recursive: true })
  renameSync(found, dest_bin)
  if (!is_windows) chmodSync(dest_bin, 0o755)
  rmSync(tmp, { recursive: true, force: true })

  const size = (statSync(dest_bin).size / 1e6).toFixed(1)
  console.log(`${key}: uv ${UV_VERSION} -> vendor/uv/${key}/${bin_name} (${size} MB)`)
}
