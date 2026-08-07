// Remote http(s) URL -> dataset source.
//
// Strategy is "direct by default, proxy on failure". Note that CORS is a
// *browser* restriction: a fetch from the main process would succeed even
// where the renderer's would be blocked. So we deliberately do NOT decide here
// which mode to use -- we hand the renderer both URLs and let it try the direct
// one first, falling back to the proxy only when the browser actually refuses.
// That puts the CORS test in the only place that can answer it honestly.

const normalize_url = (raw_url) => {
  const trimmed = String(raw_url || '').trim().replace(/\/+$/, '')
  if (!trimmed) return null

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return trimmed
}

const label_for = (url) => {
  const parts = new URL(url).pathname.split('/').filter(Boolean)
  return parts[parts.length - 1] || new URL(url).hostname
}

const resolve = async (raw_url, server) => {
  const base_url = normalize_url(raw_url)
  if (!base_url) {
    return { ok: false, error: 'Enter a valid http:// or https:// URL.' }
  }

  const proxy_id = server.add_remote_proxy(base_url)

  return {
    ok: true,
    source: {
      kind: 'remote',
      label: label_for(base_url),
      detail: base_url,
      base_url,
      proxy_url: `${server.origin}/proxy/${proxy_id}`,
    },
  }
}

module.exports = { resolve, normalize_url }
