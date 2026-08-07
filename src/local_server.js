// Loopback HTTP server -- the spine of the app.
//
// Celldega.js loads a dataset by fetching `${base_url}/landscape_parameters.json`,
// `${base_url}/cell_metadata.parquet`, image tiles, etc. Under file:// Chromium
// blocks those fetches and refuses Range requests, so everything -- the renderer
// itself, the celldega bundle, and local dataset folders -- is served over
// http://127.0.0.1:<random_port>.
//
// The payoff is uniformity: once a local folder is mounted it looks exactly like
// a remote dataset to the renderer. Both are just a base URL.

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  // .dzi is the Deep Zoom XML sidecar we read image dimensions from
  '.dzi': 'application/xml; charset=utf-8',
  '.parquet': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

const mime_for = (file_path) =>
  MIME_TYPES[path.extname(file_path).toLowerCase()] || 'application/octet-stream'

// Mounted local dataset directories, keyed by an opaque id: /data/<id>/...
const local_mounts = new Map()
// Registered remote origins used only for the CORS fallback: /proxy/<id>/...
const remote_proxies = new Map()

const new_id = () => crypto.randomBytes(9).toString('hex')

const add_local_mount = (root_dir) => {
  for (const [id, mount] of local_mounts) {
    if (mount.root === root_dir) return id
  }
  const id = new_id()
  local_mounts.set(id, { root: root_dir })
  return id
}

const add_remote_proxy = (base_url) => {
  const trimmed = base_url.replace(/\/+$/, '')
  for (const [id, proxy] of remote_proxies) {
    if (proxy.base_url === trimmed) return id
  }
  const id = new_id()
  remote_proxies.set(id, { base_url: trimmed })
  return id
}

// Resolve a request path inside a root, refusing anything that escapes it.
const safe_join = (root, rel_path) => {
  const decoded = decodeURIComponent(rel_path)
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + decoded))
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

const parse_range = (range_header, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec((range_header || '').trim())
  if (!match) return null

  const [, raw_start, raw_end] = match
  if (raw_start === '' && raw_end === '') return null

  let start
  let end
  if (raw_start === '') {
    // Suffix form: "bytes=-500" means the final 500 bytes
    const suffix_len = Number(raw_end)
    if (suffix_len <= 0) return null
    start = Math.max(0, size - suffix_len)
    end = size - 1
  } else {
    start = Number(raw_start)
    end = raw_end === '' ? size - 1 : Math.min(Number(raw_end), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null
  }
  return { start, end }
}

// Serve a file with Range support. Parquet row-group reads and image pyramid
// tiles both lean on ranges, so this is not optional.
const serve_file = async (req, res, file_path) => {
  let stat
  try {
    stat = await fsp.stat(file_path)
  } catch {
    return send_error(res, 404, 'Not found')
  }
  if (stat.isDirectory()) return send_error(res, 404, 'Not found')

  const headers = {
    'Content-Type': mime_for(file_path),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  }

  const range = parse_range(req.headers.range, stat.size)
  if (range) {
    const { start, end } = range
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    })
    if (req.method === 'HEAD') return res.end()
    return fs.createReadStream(file_path, { start, end }).pipe(res)
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size })
  if (req.method === 'HEAD') return res.end()
  return fs.createReadStream(file_path).pipe(res)
}

// Used only when a remote host lacks permissive CORS headers -- the renderer
// retries through here after a direct fetch fails.
const serve_proxy = async (req, res, proxy, rest_path) => {
  const target = `${proxy.base_url}/${rest_path}`
  const headers = {}
  if (req.headers.range) headers.range = req.headers.range

  try {
    const upstream = await fetch(target, { headers, redirect: 'follow' })
    const out_headers = { 'Cache-Control': 'no-cache' }
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name)
      if (value) out_headers[name] = value
    }
    if (!out_headers['content-type']) out_headers['content-type'] = mime_for(target)

    res.writeHead(upstream.status, out_headers)
    if (req.method === 'HEAD' || !upstream.body) return res.end()
    return Readable.fromWeb(upstream.body).pipe(res)
  } catch (err) {
    return send_error(res, 502, `Upstream fetch failed: ${err.message}`)
  }
}

const send_error = (res, code, message) => {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(message)
}

const start_server = async ({ renderer_root, celldega_entry, aws4fetch_entry }) =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send_error(res, 405, 'Method not allowed')
      }

      let pathname
      try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname
      } catch {
        return send_error(res, 400, 'Bad request')
      }

      // The celldega ESM bundle, read straight out of node_modules (works
      // inside asar, which is why we read rather than copy it at build time).
      if (pathname === '/vendor/celldega.js') {
        return serve_file(req, res, celldega_entry)
      }

      // Used to sign the renderer's own pre-flight requests for private S3
      // datasets. Celldega bundles its own copy for its internal fetches.
      if (pathname === '/vendor/aws4fetch.js') {
        return serve_file(req, res, aws4fetch_entry)
      }

      const data_match = /^\/data\/([a-f0-9]+)\/(.*)$/.exec(pathname)
      if (data_match) {
        const mount = local_mounts.get(data_match[1])
        if (!mount) return send_error(res, 404, 'Unknown mount')
        const file_path = safe_join(mount.root, data_match[2])
        if (!file_path) return send_error(res, 403, 'Forbidden')
        return serve_file(req, res, file_path)
      }

      const proxy_match = /^\/proxy\/([a-f0-9]+)\/(.*)$/.exec(pathname)
      if (proxy_match) {
        const proxy = remote_proxies.get(proxy_match[1])
        if (!proxy) return send_error(res, 404, 'Unknown proxy')
        return serve_proxy(req, res, proxy, proxy_match[2])
      }

      // Everything else is the renderer itself
      const rel = pathname === '/' ? 'index.html' : pathname
      const file_path = safe_join(renderer_root, rel)
      if (!file_path) return send_error(res, 403, 'Forbidden')
      return serve_file(req, res, file_path)
    })

    server.on('error', reject)

    // Port 0 = let the OS pick a free port. Bound to loopback only, so the
    // server is not reachable from the network.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        add_local_mount,
        add_remote_proxy,
        close: () => server.close(),
      })
    })
  })

module.exports = { start_server, add_local_mount, add_remote_proxy }
