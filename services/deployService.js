// Auto-deploy webhook service
//
// Invoked by POST /deploy/:service (see index.js). Accepts a per-service
// shared secret in the X-Hive-Secret header, then spawns a detached
// `docker compose pull <svc> && docker compose up -d <svc>` against the host
// stack.
//
// Configuration (env vars):
//   DEPLOY_COMPOSE_FILE    absolute path to the compose file
//                          (default: /srv/stack/docker-compose.yml)
//   DEPLOY_PROJECT_DIR     working directory for docker compose
//                          (default: /srv/stack)
//   DEPLOY_LOG_DIR         where audit + per-deploy logs are written
//                          (default: <app>/data/deploys)
//   DEPLOY_SIDECAR_IMAGE   image used for the one-shot deploy sidecar that
//                          runs docker compose (default: docker:cli). A
//                          sidecar is used instead of an in-process spawn so
//                          self-deploys (redeploying server-monitor itself)
//                          survive the parent container being recreated.
//   DEPLOY_DOCKER_CONFIG   host path of the .docker config directory that the
//                          sidecar should use for registry auth (default:
//                          /root/.docker). It is bind-mounted into the
//                          sidecar read-only at the same path and
//                          DOCKER_CONFIG is set so the docker CLI picks it
//                          up. This is how the sidecar authenticates to
//                          ghcr.io when pulling private images.
//
// Authentication has two modes (either or both can be configured; a request
// is accepted if EITHER matches):
//
//   1. Shared secret (recommended for a growing fleet):
//        DEPLOY_WEBHOOK_SECRET      one secret, shared by every allowlisted
//                                   service
//        DEPLOY_WEBHOOK_SERVICES    required allowlist. Either a
//                                   comma-separated list of compose service
//                                   names (e.g. "server-monitor,app,clients")
//                                   or the wildcard "*" to allow any valid
//                                   service name. If unset or empty, the
//                                   shared secret is disabled (only
//                                   per-service secrets are honoured).
//
//   2. Per-service secret (backward compatible, also acts as its own
//      allowlist):
//        DEPLOY_WEBHOOK_SECRET_<SERVICE_NAME>
//                                   per-service secret. Service name is
//                                   uppercased with hyphens replaced by
//                                   underscores. Presence of this env var
//                                   also allowlists the service.
//
//   Anything that isn't allowlisted via either mechanism is rejected with 404.
//   Invalid secret / missing header are rejected with 401.
//
// Audit log: JSON lines appended to <DEPLOY_LOG_DIR>/deploy.log.
// Per-deploy sidecar stdout/stderr: <DEPLOY_LOG_DIR>/<service>-<ts>.log.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COMPOSE_FILE   = process.env.DEPLOY_COMPOSE_FILE   || '/srv/stack/docker-compose.yml';
const PROJECT_DIR    = process.env.DEPLOY_PROJECT_DIR    || '/srv/stack';
const LOG_DIR        = process.env.DEPLOY_LOG_DIR        || path.join(__dirname, '..', 'data', 'deploys');
const SIDECAR_IMAGE  = process.env.DEPLOY_SIDECAR_IMAGE  || 'docker:cli';
const DOCKER_CONFIG  = process.env.DEPLOY_DOCKER_CONFIG  || '/root/.docker';

const SECRET_PREFIX = 'DEPLOY_WEBHOOK_SECRET_';
const SHARED_SECRET_ENV = 'DEPLOY_WEBHOOK_SECRET';
const SHARED_ALLOWLIST_ENV = 'DEPLOY_WEBHOOK_SERVICES';

// Service name whitelist pattern: must start with a letter, then letters,
// digits, hyphens, or underscores. Keeps shell injection impossible even if
// the value ends up in a shell string.
const SERVICE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;

function validServiceName(s) {
  return typeof s === 'string' && SERVICE_NAME_RE.test(s);
}

// Map of "<service-name>" -> secret, populated from env at call time so that
// secrets added after startup are picked up without a restart. Only returns
// per-service secrets (not the shared one).
function getServiceSecrets() {
  const map = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === SHARED_SECRET_ENV) continue; // not per-service
    if (k.startsWith(SECRET_PREFIX) && typeof v === 'string' && v.length > 0) {
      const svc = k.slice(SECRET_PREFIX.length).toLowerCase().replace(/_/g, '-');
      map[svc] = v;
    }
  }
  return map;
}

// Parses DEPLOY_WEBHOOK_SERVICES into either the string "*" (wildcard —
// any validServiceName is allowed) or a Set of explicit compose service
// names. Returns null if no allowlist is configured.
function getSharedAllowlist() {
  const raw = (process.env[SHARED_ALLOWLIST_ENV] || '').trim();
  if (!raw) return null;
  if (raw === '*') return '*';
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  return new Set(entries);
}

// Decide whether a (service, provided-secret) pair is authorised to trigger
// a deploy. Returns { ok: true, via } on success, or
// { ok: false, status, reason } on failure.
//
// Checks, in order:
//   1. service name is syntactically valid              (400 if not)
//   2. service is configured via either mechanism       (404 if not)
//   3. X-Hive-Secret was provided                       (401 if not)
//   4. provided secret matches per-service or shared    (401 if not)
function authorize(service, provided) {
  if (!validServiceName(service)) {
    return { ok: false, status: 400, reason: 'invalid_service_name' };
  }

  const perServiceKey = `${SECRET_PREFIX}${service.toUpperCase().replace(/-/g, '_')}`;
  const perServiceSecret = process.env[perServiceKey];
  const sharedSecret = process.env[SHARED_SECRET_ENV];
  const allowlist = getSharedAllowlist();

  const configuredViaPerService = Boolean(perServiceSecret);
  const configuredViaShared =
    Boolean(sharedSecret) &&
    (allowlist === '*' || (allowlist && allowlist.has(service)));

  if (!configuredViaPerService && !configuredViaShared) {
    return { ok: false, status: 404, reason: 'not_configured' };
  }

  if (!provided) {
    return { ok: false, status: 401, reason: 'missing_secret' };
  }

  if (configuredViaPerService && timingSafeEqual(provided, perServiceSecret)) {
    return { ok: true, via: 'per-service' };
  }
  if (configuredViaShared && timingSafeEqual(provided, sharedSecret)) {
    return { ok: true, via: 'shared' };
  }
  return { ok: false, status: 401, reason: 'bad_secret' };
}

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function appendAuditLog(entry) {
  try {
    ensureLogDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(LOG_DIR, 'deploy.log'), line);
  } catch (e) {
    // Audit log is best-effort; do not surface to caller.
    console.error('[deploy] failed to write audit log:', e.message);
  }
}

// Spawn a one-shot sidecar container that runs `docker compose pull` then
// `docker compose up -d` for the requested service. A sidecar is used (rather
// than spawning `docker compose` in-process) so the deploy survives the
// parent container being torn down, which is the case when auto-deploying
// server-monitor itself.
//
// Returns a promise that resolves with { sidecarId, logFile } when the
// `docker run` command itself has accepted the sidecar (not when the deploy
// finishes). The sidecar runs asynchronously; its output is written to
// logFile and a completion entry is appended to the audit log.
function spawnDeploy(service) {
  return new Promise((resolve, reject) => {
    if (!validServiceName(service)) {
      return reject(new Error('invalid service name'));
    }

    ensureLogDir();
    const logFile = path.join(LOG_DIR, `${service}-${Date.now()}.log`);
    const out = fs.openSync(logFile, 'a');

    // Sidecar invocation. Service name is already validated to match
    // SERVICE_NAME_RE so there is no shell-injection risk.
    const composeCmd =
      `docker compose -f "${COMPOSE_FILE}" pull "${service}" ` +
      `&& docker compose -f "${COMPOSE_FILE}" up -d "${service}"`;

    const sidecarName = `sm-deploy-${service}-${Date.now()}`;
    const args = [
      'run', '--rm', '-d',
      '--name', sidecarName,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${PROJECT_DIR}:${PROJECT_DIR}:ro`,
      // Pass registry auth into the sidecar so it can pull private images.
      '-v', `${DOCKER_CONFIG}:${DOCKER_CONFIG}:ro`,
      '-e', `DOCKER_CONFIG=${DOCKER_CONFIG}`,
      '-w', PROJECT_DIR,
      SIDECAR_IMAGE,
      'sh', '-c', composeCmd,
    ];

    const proc = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    proc.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    proc.on('error', (err) => {
      try { fs.closeSync(out); } catch {}
      reject(err);
    });

    proc.on('exit', (code) => {
      // Capture the `docker run -d` output (the sidecar's container ID) so we
      // can tail its logs asynchronously.
      try {
        fs.writeSync(out, `[server-monitor] launched sidecar ${sidecarName} (code=${code})\n`);
        if (stdoutBuf) fs.writeSync(out, `stdout: ${stdoutBuf}`);
        if (stderrBuf) fs.writeSync(out, `stderr: ${stderrBuf}`);
      } catch {}

      if (code !== 0) {
        try { fs.closeSync(out); } catch {}
        const err = new Error(
          `docker run exited ${code}: ${stderrBuf.trim() || stdoutBuf.trim() || '(no output)'}`
        );
        return reject(err);
      }

      const sidecarId = stdoutBuf.trim().slice(0, 12);

      // Asynchronously tail the sidecar's logs and capture its final exit
      // code for the audit log.
      const logsProc = spawn('docker', ['logs', '-f', sidecarId], {
        stdio: ['ignore', out, out],
      });
      logsProc.on('exit', () => { try { fs.closeSync(out); } catch {} });

      const waitProc = spawn('docker', ['wait', sidecarId], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let waitBuf = '';
      waitProc.stdout.on('data', (d) => { waitBuf += d.toString(); });
      waitProc.on('exit', () => {
        const sidecarExit = parseInt(waitBuf.trim(), 10);
        appendAuditLog({
          event: 'complete',
          service,
          sidecar: sidecarId,
          sidecarExit: Number.isFinite(sidecarExit) ? sidecarExit : null,
          logFile,
        });
      });

      resolve({ sidecarId, logFile });
    });
  });
}

module.exports = {
  validServiceName,
  getServiceSecrets,
  getSharedAllowlist,
  authorize,
  timingSafeEqual,
  appendAuditLog,
  spawnDeploy,
  constants: {
    COMPOSE_FILE, PROJECT_DIR, LOG_DIR, SIDECAR_IMAGE, DOCKER_CONFIG,
    SECRET_PREFIX, SHARED_SECRET_ENV, SHARED_ALLOWLIST_ENV,
  },
};
