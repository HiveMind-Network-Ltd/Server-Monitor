/**
 * advisorEngine.js
 * Rule engine: generates right-sizing signals for all monitored servers.
 *
 * Signals (7-day p95):
 *   DOWNGRADE  — CPU p95 < 20% AND mem p95 < 30%
 *   UPGRADE    — CPU p95 > 80% OR  mem p95 > 85%
 *   WATCH      — CPU p95 60–80% OR mem p95 70–85%
 *   OK         — All other cases
 *
 * Confidence gate: no recommendation if dataAgeDays < 5.
 *
 * TODO (v1.1): Email / webhook alerts when signal changes to UPGRADE
 * TODO (v1.1): Pricing config map for actual savings estimates per instance type
 */

const { getServers } = require('../config/servers');
const { dataAgeDays, computeP95 } = require('./metricsStore');

const MIN_DATA_AGE_DAYS = 5;

/**
 * Classify a server's signal based on 7-day p95 metrics.
 *
 * @param {{ cpu: number|null, mem: number|null }} p95s
 * @returns {{ signal: string, reason: string }}
 */
function classify(p95s) {
  const { cpu, mem } = p95s;

  if (cpu == null && mem == null) {
    return { signal: 'OK', reason: 'Insufficient metric data to classify' };
  }

  // UPGRADE: either metric is critically high
  if ((cpu != null && cpu > 80) || (mem != null && mem > 85)) {
    const reasons = [];
    if (cpu != null && cpu > 80) reasons.push(`CPU p95 ${cpu.toFixed(1)}% > 80%`);
    if (mem != null && mem > 85) reasons.push(`RAM p95 ${mem.toFixed(1)}% > 85%`);
    return {
      signal: 'UPGRADE',
      reason: `Approaching capacity ceiling — ${reasons.join(', ')}`
    };
  }

  // DOWNGRADE: both available metrics are under-utilised
  const cpuLow = cpu == null || cpu < 20;
  const memLow = mem == null || mem < 30;
  if (cpuLow && memLow && (cpu != null || mem != null)) {
    const parts = [];
    if (cpu != null) parts.push(`CPU p95 ${cpu.toFixed(1)}%`);
    if (mem != null) parts.push(`RAM p95 ${mem.toFixed(1)}%`);
    return {
      signal: 'DOWNGRADE',
      reason: `Consistently under-utilised — ${parts.join(', ')}`
    };
  }

  // WATCH: either metric in the caution band
  if ((cpu != null && cpu >= 60) || (mem != null && mem >= 70)) {
    const parts = [];
    if (cpu != null && cpu >= 60) parts.push(`CPU p95 ${cpu.toFixed(1)}%`);
    if (mem != null && mem >= 70) parts.push(`RAM p95 ${mem.toFixed(1)}%`);
    return {
      signal: 'WATCH',
      reason: `Monitor closely — ${parts.join(', ')}`
    };
  }

  return { signal: 'OK', reason: 'Sizing looks appropriate' };
}

/**
 * Build a human-readable savings label.
 * Static placeholder — TODO (v1.1): populate from pricing config per instance type.
 *
 * @param {string} signal
 * @returns {string}
 */
function savingsLabel(signal) {
  if (signal === 'DOWNGRADE') {
    // TODO (v1.1): derive from instance-type pricing map
    return 'Potential savings available';
  }
  return '';
}

/**
 * Compute recommendations for all configured servers.
 *
 * @returns {Array<{
 *   server: string,
 *   serverId: string,
 *   signal: string,
 *   reason: string,
 *   dataAgeDays: number,
 *   p95: { cpu: number|null, mem: number|null, disk: number|null },
 *   savingsLabel: string
 * }>}
 */
function getRecommendations() {
  const servers = getServers();

  return servers.map(server => {
    const age = dataAgeDays(server.id);

    // Confidence gate — not enough history yet
    if (age < MIN_DATA_AGE_DAYS) {
      return {
        server: server.name,
        serverId: server.id,
        signal: 'PENDING',
        reason: `Collecting data — ${age.toFixed(1)} of ${MIN_DATA_AGE_DAYS} days required`,
        dataAgeDays: parseFloat(age.toFixed(2)),
        p95: { cpu: null, mem: null, disk: null },
        savingsLabel: ''
      };
    }

    const p95s = computeP95(server.id);
    const { signal, reason } = classify(p95s);

    return {
      server: server.name,
      serverId: server.id,
      signal,
      reason,
      dataAgeDays: parseFloat(age.toFixed(2)),
      p95: p95s,
      savingsLabel: savingsLabel(signal)
    };
  });
}

module.exports = { getRecommendations };
