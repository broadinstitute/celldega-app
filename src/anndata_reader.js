// Reads the parts of a local .h5ad useful for colouring a Landscape.
//
// Runs in the MAIN process, not the renderer. The renderer only ever receives
// the compact result -- cell ids, per-cell category codes, and the palette --
// rather than the file itself. A Xenium .h5ad is comfortably 100-350 MB and
// mostly expression data we do not use, so pulling it into the renderer would
// cost a lot of memory for nothing.
//
// Only `obs` categoricals and their `uns` colours are read. The expression
// matrix, obsm and varm are deliberately untouched.
//
// h5wasm is ESM-only, so it is loaded with a dynamic import and cached.

const path = require('node:path')

let h5wasm_promise = null

const get_h5wasm = () => {
  if (!h5wasm_promise) {
    h5wasm_promise = import('h5wasm/node').then(async (mod) => {
      const h5wasm = mod.default || mod
      await h5wasm.ready
      return h5wasm
    })
  }
  return h5wasm_promise
}

// AnnData stores a categorical obs column as a group of {categories, codes};
// a plain dataset is numeric or string.
const is_categorical = (node) =>
  node && node.type === 'Group' && node.keys && node.keys().includes('categories')

const to_strings = (values) =>
  Array.from(values, (v) => (v instanceof Uint8Array ? Buffer.from(v).toString() : String(v)))

// Columns that exist but are useless to colour by. Filtering here is what makes
// the front-end a safe dropdown rather than a guess: of the 16 obs columns in a
// typical Xenium .h5ad, only one is a meaningful categorical.
const SKIP_COLUMNS = new Set(['cell_id'])

const inspect = async (file_path) => {
  const h5wasm = await get_h5wasm()
  let f
  try {
    f = new h5wasm.File(file_path, 'r')
  } catch (err) {
    return { ok: false, error: `Could not open file: ${err.message}` }
  }

  try {
    const obs = f.get('obs')
    if (!obs) return { ok: false, error: 'No obs group — is this an .h5ad file?' }

    const index_name = obs.attrs && obs.attrs._index ? String(obs.attrs._index.value) : '_index'

    // The join key. AnnData's obs_names is often just a positional range index,
    // so an explicit cell_id column is preferred when present.
    const has_cell_id = obs.keys().includes('cell_id')
    const join_key = has_cell_id ? 'cell_id' : index_name

    const n_obs = obs.get(join_key).shape[0]

    const uns = f.get('uns')
    const palettes = new Set(
      (uns ? uns.keys() : []).filter((k) => k.endsWith('_colors')).map((k) => k.slice(0, -7))
    )

    const columns = []
    for (const name of obs.keys()) {
      if (name === index_name || SKIP_COLUMNS.has(name)) continue
      const node = obs.get(name)
      if (!is_categorical(node)) continue

      const n_categories = node.get('categories').shape[0]
      // A single category colours every cell identically -- offering it is a
      // trap, not a choice.
      if (n_categories < 2) continue

      columns.push({
        name,
        n_categories,
        has_colors: palettes.has(name),
      })
    }

    columns.sort((a, b) => a.name.localeCompare(b.name))

    return { ok: true, n_obs, join_key, columns, file_name: path.basename(file_path) }
  } catch (err) {
    return { ok: false, error: `Could not read file: ${err.message}` }
  } finally {
    try {
      f.close()
    } catch {
      /* already closed */
    }
  }
}

const read_categorical = async (file_path, column) => {
  const h5wasm = await get_h5wasm()
  let f
  try {
    f = new h5wasm.File(file_path, 'r')
  } catch (err) {
    return { ok: false, error: `Could not open file: ${err.message}` }
  }

  try {
    const obs = f.get('obs')
    if (!obs) return { ok: false, error: 'No obs group' }

    const node = obs.get(column)
    if (!is_categorical(node)) {
      return { ok: false, error: `${column} is not a categorical column` }
    }

    const index_name = obs.attrs && obs.attrs._index ? String(obs.attrs._index.value) : '_index'
    const join_key = obs.keys().includes('cell_id') ? 'cell_id' : index_name

    const cell_ids = to_strings(obs.get(join_key).value)
    const codes = Array.from(obs.get(column).get('codes').value)
    const categories = to_strings(node.get('categories').value)

    // Scanpy writes uns['<column>_colors'] alongside the categories, so using it
    // makes the app match what the user already sees in their notebook.
    const uns = f.get('uns')
    let colors = null
    if (uns && uns.keys().includes(`${column}_colors`)) {
      colors = to_strings(uns.get(`${column}_colors`).value)
    }

    // A palette that does not line up with the categories would silently
    // mis-colour clusters, which is worse than falling back to generated colours.
    if (colors && colors.length !== categories.length) colors = null

    const counts = new Array(categories.length).fill(0)
    let unassigned = 0
    for (const code of codes) {
      if (code >= 0 && code < counts.length) counts[code] += 1
      else unassigned += 1
    }

    return {
      ok: true,
      column,
      cell_ids,
      codes,
      categories,
      colors,
      counts,
      unassigned,
      n_obs: cell_ids.length,
    }
  } catch (err) {
    return { ok: false, error: `Could not read ${column}: ${err.message}` }
  } finally {
    try {
      f.close()
    } catch {
      /* already closed */
    }
  }
}

module.exports = { inspect, read_categorical }
