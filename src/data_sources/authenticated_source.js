// Authenticated (S3) dataset source.
//
// Celldega.js already supports this natively: landscape_ist takes a `creds`
// argument and constructs an aws4fetch AwsClient from it (see
// js/viz/landscape_ist.js). So this module is only responsible for shaping the
// credentials object -- the signing itself happens inside Celldega.js.
//
// Credentials are held in memory for the session only. They are never written
// to the recents file; see main.js, which strips `creds` before persisting.

const http_source = require('./http_source')

const clean = (value) => {
  const trimmed = String(value || '').trim()
  return trimmed === '' ? undefined : trimmed
}

// Matches the fields celldega passes to `new AwsClient({...})`
const build_creds = (raw_creds) => {
  if (!raw_creds) return null

  const creds = {
    accessKeyId: clean(raw_creds.accessKeyId),
    secretAccessKey: clean(raw_creds.secretAccessKey),
    sessionToken: clean(raw_creds.sessionToken),
  }
  if (!creds.accessKeyId || !creds.secretAccessKey) return null
  return creds
}

const resolve = async (raw_url, raw_creds, server) => {
  const result = await http_source.resolve(raw_url, server)
  if (!result.ok) return result

  const creds = build_creds(raw_creds)
  if (!creds) {
    return {
      ok: false,
      error: 'S3 access requires both an Access Key ID and a Secret Access Key.',
    }
  }

  return {
    ok: true,
    source: { ...result.source, kind: 'authenticated', creds },
  }
}

module.exports = { resolve, build_creds }
