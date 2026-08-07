# Future: Google Cloud Storage authentication

Deferred. v0.1.3 authenticates against **AWS S3 only**.

## Where auth happens today

Two places, and both would need a GCS path:

1. **`src/renderer/app.js`** — `make_fetcher()` signs the app's own two
   pre-flight requests (`landscape_parameters.json` and the `.dzi`) with
   `aws4fetch`'s `AwsClient`.
2. **Celldega.js** — signs every request it makes itself (tiles, parquet) from
   the `creds` object passed to `landscape_ist`.

The second is the harder half: GCS support has to land **upstream in Celldega.js**
first, or the app will authenticate its probe successfully and then fail on every
tile. Signing only in the app is not enough.

## What GCS would need

GCS is friendlier than S3 here — it accepts a plain `Authorization: Bearer
<token>` OAuth2 header, so there is no request-signing algorithm to implement.

- A short-lived OAuth2 access token (from `gcloud auth print-access-token`, a
  service-account JSON key, or a full OAuth flow)
- Attach `Authorization: Bearer …` to each request
- GCS also supports S3-compatible HMAC keys, which the existing SigV4 path could
  in principle sign for — worth testing before writing anything new, since it
  might work with only a region/endpoint change

## Design implication

`authenticated_source.js` currently assumes S3 and shapes an
`{accessKeyId, secretAccessKey, sessionToken}` object. Adding GCS means the
source needs a **provider discriminator** — e.g. `{provider: 's3' | 'gcs', ...}` —
rather than more optional fields. The remote dialog would need a provider
selector, and Celldega's `creds` argument would need to carry it too.

Worth doing at the same time as the upstream options-object refactor
(see [js_api.md](js_api.md)), since both change the shape of what gets passed to
`landscape_ist`.

## Known limitation to fix alongside

Celldega hardcodes `region: 'us-east-1'` when building its `AwsClient`
(`js/viz/landscape_ist.js`), with a comment noting the region should be parsed
from the S3 URL. Buckets outside us-east-1 may fail signature validation. The
app mirrors that hardcoding so both halves agree; fixing it upstream would let
both stop guessing.
