// Durable Matrix Zarr results. Only stable paths and source identities go on
// disk; loopback URLs and credentials are reconstructed for each app launch.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const cache_key = (options, stamp, version) => crypto.createHash('sha256')
  .update(JSON.stringify([2, version, options.anndata_path, stamp, options.category,
    options.zscore, options.top_genes, options.dot_plot, options.normalization]))
  .digest('hex').slice(0, 16)

const read = async (root, key) => {
  if (!/^[a-f0-9]{16}$/.test(key || '')) throw new Error('Invalid Clustergram identifier')
  const dir = path.join(root, key)
  await fs.access(path.join(dir, 'matrix.zarr', 'zarr.json'))
  const spec = JSON.parse(await fs.readFile(path.join(dir, 'app_stats.json'), 'utf8'))
  return { ...spec, key, matrix_path: path.join(dir, 'matrix.zarr') }
}

const list = async (root) => {
  const names = await fs.readdir(root).catch(() => [])
  const entries = await Promise.all(names.map((key) => read(root, key).catch(() => null)))
  return entries.filter(Boolean).sort((a, b) => b.created_at - a.created_at)
}

const write = async (root, key, spec) => {
  if (!/^[a-f0-9]{16}$/.test(key || '')) throw new Error('Invalid Clustergram identifier')
  const dir = path.join(root, key)
  const temp = path.join(dir, `app_stats.${crypto.randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, JSON.stringify(spec, null, 2))
    await fs.rename(temp, path.join(dir, 'app_stats.json'))
  } finally {
    await fs.rm(temp, { force: true })
  }
}

module.exports = { cache_key, read, list, write }
