// Local folder -> dataset source.
//
// Mounts the folder on the loopback server so celldega.js sees an ordinary
// base URL. Also handles the common case where the user picks the *parent*
// of the real dataset: Landscape datasets on disk are usually nested one level
// down in a `*_landscape_files` / `*_outs` directory, so we descend to find
// the manifest rather than making the user click into it.

const fsp = require('node:fs/promises')
const path = require('node:path')

const MANIFEST = 'landscape_parameters.json'

// A conversion in progress writes .celldega_incomplete and removes it on
// success, so a cancelled or failed run leaves a folder that does not validate
// as a dataset rather than one that opens and renders wrong.
const INCOMPLETE = '.celldega_incomplete'

const is_incomplete = async (dir) => {
  try {
    await fsp.access(path.join(dir, INCOMPLETE))
    return true
  } catch {
    return false
  }
}

const has_manifest = async (dir) => {
  if (await is_incomplete(dir)) return false
  try {
    await fsp.access(path.join(dir, MANIFEST))
    return true
  } catch {
    return false
  }
}

// Look in `dir`, then one level of subdirectories.
const find_dataset_dir = async (dir) => {
  if (await has_manifest(dir)) return dir

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    // Prefer conventionally named directories, but fall back to checking all
    .sort((a, b) => score_name(b) - score_name(a))

  for (const name of candidates) {
    const child = path.join(dir, name)
    if (await has_manifest(child)) return child
  }
  return null
}

const score_name = (name) => {
  if (name.includes('landscape_files')) return 2
  if (name.endsWith('_outs')) return 1
  return 0
}

const resolve = async (dir_path, server) => {
  const dataset_dir = await find_dataset_dir(dir_path)
  if (!dataset_dir) {
    return {
      ok: false,
      error: `No ${MANIFEST} found in that folder or its immediate subfolders. Pick a DegaFiles / Landscape dataset directory.`,
    }
  }

  const mount_id = server.add_local_mount(dataset_dir)

  return {
    ok: true,
    source: {
      kind: 'local',
      label: path.basename(dataset_dir),
      detail: dataset_dir,
      base_url: `${server.origin}/data/${mount_id}`,
      dataset_dir,
    },
  }
}

module.exports = { resolve, find_dataset_dir, is_incomplete }
