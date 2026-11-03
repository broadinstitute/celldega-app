const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const store = require('../src/clustergram_store')

test('cache invalidates when the input, settings or Celldega changes', () => {
  const options = { anndata_path: '/data/a.h5ad', category: 'cell_type', zscore: 'row',
    top_genes: 40, dot_plot: true, normalization: 'log1p_cpm' }
  const key = store.cache_key(options, 'mtime:size', '0.28.0a4')
  for (const [input, stamp, version] of [
    [{ ...options, top_genes: 50 }, 'mtime:size', '0.28.0a4'],
    [options, 'newmtime:size', '0.28.0a4'],
    [options, 'mtime:size', '0.28.0a3'],
  ]) assert.notEqual(store.cache_key(input, stamp, version), key)
})

test('saved matrices reopen with stable paths; incomplete and old caches are ignored', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'celldega-store-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const key = 'abcdef0123456789'
  const dir = path.join(root, key)
  await fs.mkdir(path.join(dir, 'matrix.zarr'), { recursive: true })
  await fs.writeFile(path.join(dir, 'matrix.zarr', 'zarr.json'), '{}')
  await fs.writeFile(path.join(dir, 'app_stats.json'), JSON.stringify({ category: 'cell_type', created_at: 1 }))
  await fs.mkdir(path.join(root, '0123456789abcdef'), { recursive: true })
  const entries = await store.list(root)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].matrix_path, path.join(dir, 'matrix.zarr'))
  assert.equal((await store.read(root, key)).category, 'cell_type')
  await assert.rejects(store.read(root, '../escape'), /Invalid/)
})

test('npm and Python alpha pins match', async () => {
  const npm = require('../package.json').dependencies.celldega
  const py = npm.replace(/-alpha\.(\d+)$/, 'a$1')
  assert.equal(py, '0.28.0a4')
  assert.match(await fs.readFile(path.join(__dirname, '../python/requirements.in'), 'utf8'), new RegExp(`celldega\\[pre\\]==${py}`))
  assert.match(await fs.readFile(path.join(__dirname, '../python/requirements.lock'), 'utf8'), new RegExp(`celldega==${py}`))
})
