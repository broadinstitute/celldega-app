// Long-running analysis jobs: one process per job, cancellable, reporting
// progress.
//
// Deliberately separate from python_worker's daemon. That one serves jobs of a
// few seconds, where paying process start and a cold import each time would be
// most of the cost. Preprocessing runs for minutes to hours and holds a lot of
// memory, so a process per job is right: memory is reclaimed when it exits, and
// cancelling means killing it rather than asking it to stop.
//
// Only main spawns anything. The renderer reaches jobs through narrow IPC.

const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')
const fsp = require('node:fs/promises')

const jobs = new Map()

let jobs_root = null
const set_jobs_root = (dir) => { jobs_root = dir }

let on_event = () => {}
const set_listener = (fn) => { on_event = fn }

const new_job_id = () => crypto.randomBytes(4).toString('hex')

const publish = (job) => {
  on_event({
    job_id: job.job_id,
    operation: job.operation,
    status: job.status,
    stage: job.stage,
    fraction: job.fraction,
    error: job.error,
    output: job.output,
    started_at: job.started_at,
  })
}

// Run a one-shot Python script against a request file.
//
// The request goes through a file rather than argv or stdin: it keeps the
// command line short, survives inspection after the fact, and means a job
// directory is a complete record of what was asked for.
const run = async ({ operation, python, script, request, output_dir }) => {
  if (!jobs_root) return { ok: false, error: 'No jobs directory configured' }

  const job_id = new_job_id()
  const job_dir = path.join(jobs_root, job_id)
  await fsp.mkdir(job_dir, { recursive: true })

  const request_path = path.join(job_dir, 'request.json')
  await fsp.writeFile(request_path, JSON.stringify({ ...request, job_id }, null, 2))

  const log_path = path.join(job_dir, 'stderr.log')
  const log = await fsp.open(log_path, 'a')

  const child = spawn(python, ['-u', script, request_path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const job = {
    job_id,
    operation,
    pid: child.pid,
    status: 'running',
    stage: 'Starting',
    fraction: 0,
    error: null,
    output: output_dir || null,
    started_at: Date.now(),
    child,
    job_dir,
    cancelled: false,
  }
  jobs.set(job_id, job)
  publish(job)

  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'progress') {
          job.stage = event.stage || job.stage
          job.fraction = typeof event.fraction === 'number' ? event.fraction : job.fraction
          publish(job)
        } else if (event.type === 'error') {
          job.error = event.error
        } else if (event.type === 'complete') {
          job.output = event.output || job.output
        }
      } catch {
        // Not protocol; the script sends everything else to stderr
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    log.write(String(chunk)).catch(() => {})
  })

  child.on('error', (err) => {
    job.status = 'failed'
    job.error = err.message
    publish(job)
  })

  child.on('close', async (code) => {
    await log.close().catch(() => {})
    if (job.cancelled) {
      job.status = 'cancelled'
    } else if (code === 0 && !job.error) {
      job.status = 'complete'
      job.fraction = 1
    } else {
      job.status = 'failed'
      job.error = job.error || `exited with code ${code}`
    }
    job.child = null
    publish(job)
  })

  return { ok: true, job_id }
}

// Killing the process is the cancellation. A long job holds a lot of memory
// and there is no safe point to ask it to stop, so it is terminated and its
// partial output discarded by the caller.
const cancel = async (job_id) => {
  const job = jobs.get(job_id)
  if (!job || !job.child) return { ok: false, error: 'No such running job' }

  job.cancelled = true
  try {
    if (process.platform === 'win32') {
      // Python spawns workers of its own; taskkill /T takes the tree
      spawn('taskkill', ['/pid', String(job.pid), '/f', '/t'])
    } else {
      job.child.kill('SIGTERM')
      // SIGTERM can be swallowed mid-computation in native code
      setTimeout(() => {
        if (job.child) {
          try {
            job.child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }, 4000)
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
  return { ok: true }
}

const status = (job_id) => {
  const job = jobs.get(job_id)
  if (!job) return null
  return {
    job_id: job.job_id,
    operation: job.operation,
    status: job.status,
    stage: job.stage,
    fraction: job.fraction,
    error: job.error,
    output: job.output,
    started_at: job.started_at,
  }
}

const stop_all = () => {
  for (const job of jobs.values()) {
    if (job.child) {
      try {
        job.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
}

module.exports = { set_jobs_root, set_listener, run, cancel, status, stop_all }
