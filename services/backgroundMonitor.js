const fs = require('fs');
const path = require('path');
const { getServers } = require('../config/servers');
const { monitorServer } = require('./awsMonitor');
const { monitorDockerContainers } = require('./dockerMonitor');
const { checkAndSendAlerts } = require('./emailService');
const metricsStore = require('./metricsStore');

const CACHE_FILE = path.join(__dirname, '../data/metrics-cache.json');
const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL || '30000'); // 30 seconds

let monitoringInterval = null;
let latestMetrics = { servers: [], containers: [], lastUpdate: null };

// Load cached metrics on startup
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      latestMetrics = JSON.parse(data);
      console.log('Loaded cached metrics from disk');
    }
  } catch (error) {
    console.error('Error loading metrics cache:', error.message);
  }
}

// Save metrics to cache
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(latestMetrics, null, 2));
  } catch (error) {
    console.error('Error saving metrics cache:', error.message);
  }
}

// Run monitoring check
async function runMonitoring() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting background monitoring...`);
  
  try {
    const servers = getServers();
    
    // Monitor servers and Docker containers in parallel
    const [serverResults, containerResults] = await Promise.all([
      // Monitor servers
      servers.length > 0 
        ? Promise.all(
            servers.map(server => monitorServer(server).catch(err => ({
              id: server.id,
              name: server.name,
              status: 'error',
              error: err.message
            })))
          )
        : Promise.resolve([]),
      
      // Monitor Docker containers
      monitorDockerContainers().catch(err => {
        console.error('Error monitoring Docker:', err.message);
        return [];
      })
    ]);
    
    latestMetrics = {
      servers: serverResults,
      containers: containerResults,
      lastUpdate: new Date().toISOString()
    };
    
    // Save to disk
    saveCache();

    // Write metrics to SQLite time-series store (for right-sizing advisor)
    try {
      for (const s of serverResults) {
        if (s.metrics && s.status === 'running') {
          metricsStore.write(s.id, {
            cpu_pct:  s.metrics.cpu  != null ? s.metrics.cpu  : null,
            mem_pct:  s.metrics.ram  != null ? s.metrics.ram  : null,
            disk_pct: s.metrics.disk != null ? s.metrics.disk : null
          });
        }
      }
      // Run prune guard (no-ops if already pruned today)
      metricsStore.prune();
    } catch (storeErr) {
      console.error('[backgroundMonitor] metrics store write error:', storeErr.message);
    }

    // Check for alerts and send email notifications
    await checkAndSendAlerts(serverResults, containerResults);
    
    const duration = Date.now() - startTime;
    const serverIssues = serverResults.filter(s => s.status === 'error' || s.status === 'unreachable').length;
    const containerIssues = containerResults.filter(c => c.state !== 'running').length;
    
    console.log(`[${new Date().toISOString()}] Monitoring complete: ${serverResults.length} servers, ${containerResults.length} containers in ${duration}ms (${serverIssues} server issues, ${containerIssues} container issues)`);
  } catch (error) {
    console.error('Error in background monitoring:', error);
  }
}

// Start background monitoring
function startBackgroundMonitoring() {
  if (monitoringInterval) {
    console.log('Background monitoring already running');
    return;
  }
  
  console.log(`Starting background monitoring (interval: ${MONITOR_INTERVAL}ms)`);
  
  // Load cached data
  loadCache();
  
  // Run immediately on start
  runMonitoring();
  
  // Then run on interval
  monitoringInterval = setInterval(runMonitoring, MONITOR_INTERVAL);
}

// Stop background monitoring
function stopBackgroundMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log('Background monitoring stopped');
  }
}

// Get latest metrics
function getLatestMetrics() {
  return latestMetrics;
}

module.exports = {
  startBackgroundMonitoring,
  stopBackgroundMonitoring,
  getLatestMetrics,
  runMonitoring
};

