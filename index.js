require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const { initializeAdmin, verifyUser, generateToken, authMiddleware } = require('./config/auth');
const { getServers, addServer, updateServer, deleteServer } = require('./config/servers');
const { monitorServer } = require('./services/awsMonitor');
const { startBackgroundMonitoring, getLatestMetrics } = require('./services/backgroundMonitor');
const { isEmailConfigured, sendTestEmail } = require('./services/emailService');
const metricsStore = require('./services/metricsStore');
const { getRecommendations } = require('./services/advisorEngine');
const deployService = require('./services/deployService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
  origin: true,
  credentials: true
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Initialize admin user on startup
initializeAdmin().catch(console.error);

// Initialise SQLite metrics store
try {
  metricsStore.init();
  console.log('Metrics store initialised');
} catch (err) {
  console.error('Failed to initialise metrics store:', err);
}

// Start background monitoring
startBackgroundMonitoring();

// ============ Authentication Routes ============

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    const user = await verifyUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = generateToken(user);
    
    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });
    
    res.json({
      success: true,
      user: { id: user.id, username: user.username },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Check auth status
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ============ Server Management Routes ============

// Get all servers
app.get('/api/servers', authMiddleware, (req, res) => {
  try {
    const servers = getServers();
    // Don't send sensitive data like private keys
    const safeServers = servers.map(({ privateKey, ...server }) => server);
    res.json({ servers: safeServers });
  } catch (error) {
    console.error('Error getting servers:', error);
    res.status(500).json({ error: 'Failed to get servers' });
  }
});

// Add server
app.post('/api/servers', authMiddleware, (req, res) => {
  try {
    const server = addServer(req.body);
    const { privateKey, ...safeServer } = server;
    res.json({ success: true, server: safeServer });
  } catch (error) {
    console.error('Error adding server:', error);
    res.status(500).json({ error: 'Failed to add server' });
  }
});

// Update server
app.put('/api/servers/:id', authMiddleware, (req, res) => {
  try {
    const server = updateServer(req.params.id, req.body);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    const { privateKey, ...safeServer } = server;
    res.json({ success: true, server: safeServer });
  } catch (error) {
    console.error('Error updating server:', error);
    res.status(500).json({ error: 'Failed to update server' });
  }
});

// Update server public status
app.put('/api/servers/:id/public', authMiddleware, (req, res) => {
  try {
    const { publicStatus } = req.body;
    const server = updateServer(req.params.id, { publicStatus });
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating server public status:', error);
    res.status(500).json({ error: 'Failed to update server' });
  }
});

// Update container public status (stored in cache)
app.put('/api/containers/:id/public', authMiddleware, (req, res) => {
  try {
    const { publicStatus } = req.body;
    // Store container public status preferences in a separate file
    const fs = require('fs');
    const path = require('path');
    const configFile = path.join(__dirname, 'data/container-config.json');
    
    let config = { containers: {} };
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
    
    if (!config.containers[req.params.id]) {
      config.containers[req.params.id] = {};
    }
    config.containers[req.params.id].publicStatus = publicStatus;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating container public status:', error);
    res.status(500).json({ error: 'Failed to update container' });
  }
});

// Update server display name
app.put('/api/servers/:id/displayName', authMiddleware, (req, res) => {
  try {
    const { displayName } = req.body;
    const server = updateServer(req.params.id, { displayName });
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating server display name:', error);
    res.status(500).json({ error: 'Failed to update server' });
  }
});

// Update container display name
app.put('/api/containers/:id/displayName', authMiddleware, (req, res) => {
  try {
    const { displayName } = req.body;
    const fs = require('fs');
    const path = require('path');
    const configFile = path.join(__dirname, 'data/container-config.json');
    
    let config = { containers: {} };
    if (fs.existsSync(configFile)) {
      config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
    
    if (!config.containers[req.params.id]) {
      config.containers[req.params.id] = {};
    }
    config.containers[req.params.id].displayName = displayName;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating container display name:', error);
    res.status(500).json({ error: 'Failed to update container' });
  }
});

// Delete server
app.delete('/api/servers/:id', authMiddleware, (req, res) => {
  try {
    const success = deleteServer(req.params.id);
    if (!success) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting server:', error);
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

// ============ Email Routes ============

// Get email configuration status
app.get('/api/email/status', authMiddleware, (req, res) => {
  try {
    const configured = isEmailConfigured();
    res.json({ 
      configured,
      config: configured ? {
        smtpHost: process.env.SMTP_HOST,
        smtpPort: process.env.SMTP_PORT || '587',
        smtpUser: process.env.SMTP_USER,
        alertTo: process.env.ALERT_EMAIL_TO,
        alertFrom: process.env.SMTP_FROM || process.env.SMTP_USER
      } : null
    });
  } catch (error) {
    console.error('Error checking email status:', error);
    res.status(500).json({ error: 'Failed to check email status' });
  }
});

// Send test email
app.post('/api/email/test', authMiddleware, async (req, res) => {
  try {
    if (!isEmailConfigured()) {
      return res.status(400).json({ 
        error: 'Email not configured. Please set SMTP_HOST, SMTP_USER, SMTP_PASS, and ALERT_EMAIL_TO in your environment variables.' 
      });
    }
    
    await sendTestEmail();
    res.json({ 
      success: true, 
      message: 'Test email sent successfully! Check your inbox.' 
    });
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({ 
      error: 'Failed to send test email: ' + error.message 
    });
  }
});

// ============ Monitoring Routes ============

// Get metrics for all servers (uses cached data from background monitoring)
app.get('/api/monitor/all', authMiddleware, async (req, res) => {
  try {
    const metrics = getLatestMetrics();
    const servers = getServers();
    const fs = require('fs');
    const path = require('path');
    
    // Load container config for public status
    const containerConfigFile = path.join(__dirname, 'data/container-config.json');
    let containerConfig = { containers: {} };
    if (fs.existsSync(containerConfigFile)) {
      containerConfig = JSON.parse(fs.readFileSync(containerConfigFile, 'utf8'));
    }
    
    // Merge server config (publicStatus, displayName) with metrics
    const serversWithConfig = metrics.servers.map(serverMetric => {
      const serverConfig = servers.find(s => s.id === serverMetric.id);
      return {
        ...serverMetric,
        publicStatus: serverConfig?.publicStatus !== false,
        displayName: serverConfig?.displayName || null
      };
    });
    
    // Merge container config with metrics
    const containersWithConfig = (metrics.containers || []).map(container => {
      const config = containerConfig.containers[container.id] || {};
      return {
        ...container,
        publicStatus: config.publicStatus !== false,
        displayName: config.displayName || null
      };
    });
    
    res.json({
      ...metrics,
      servers: serversWithConfig,
      containers: containersWithConfig
    });
  } catch (error) {
    console.error('Error getting metrics:', error);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Get metrics for a specific server (uses cached data)
app.get('/api/monitor/:id', authMiddleware, async (req, res) => {
  try {
    const metrics = getLatestMetrics();
    const server = metrics.servers.find(s => s.id === req.params.id);
    
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    res.json(server);
  } catch (error) {
    console.error('Error getting server metrics:', error);
    res.status(500).json({ error: 'Failed to get server metrics' });
  }
});

// ============ Public Status Page ============

// Public status endpoint (no authentication required)
app.get('/api/status/public', (req, res) => {
  try {
    const metrics = getLatestMetrics();
    const fs = require('fs');
    const path = require('path');
    
    // Load container config
    const containerConfigFile = path.join(__dirname, 'data/container-config.json');
    let containerConfig = { containers: {} };
    if (fs.existsSync(containerConfigFile)) {
      containerConfig = JSON.parse(fs.readFileSync(containerConfigFile, 'utf8'));
    }
    
    // Get server configs for display names
    const servers = getServers();
    
    // Filter servers and containers by publicStatus flag (default to true)
    const publicServers = metrics.servers
      .map(server => {
        const serverConfig = servers.find(s => s.id === server.id);
        return {
          ...server,
          publicStatus: serverConfig?.publicStatus !== false,
          displayName: serverConfig?.displayName
        };
      })
      .filter(server => server.publicStatus !== false)
      .map(server => ({
        id: server.id,
        name: server.displayName || server.name,
        status: server.status,
        metrics: server.metrics,
        error: server.error
      }));
    
    const publicContainers = (metrics.containers || [])
      .map(container => {
        const config = containerConfig.containers[container.id] || {};
        return {
          ...container,
          publicStatus: config.publicStatus !== false,
          displayName: config.displayName
        };
      })
      .filter(container => container.publicStatus !== false)
      .map(container => ({
        id: container.id,
        name: container.displayName || container.name,
        state: container.state,
        stats: container.stats
      }));
    
    const publicData = {
      servers: publicServers,
      containers: publicContainers,
      lastUpdate: metrics.lastUpdate
    };
    res.json(publicData);
  } catch (error) {
    console.error('Error getting public status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Serve public status page
app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

// ============ Right-Sizing Routes (authenticated) ============

// Get metric history for a server
// Query params: ?days=7 (default), ?resolution=hourly (default) | raw
app.get('/api/history/:serverId', authMiddleware, (req, res) => {
  try {
    const serverId = req.params.serverId;
    const days = Math.min(parseInt(req.query.days || '7', 10), 90);
    const resolution = req.query.resolution === 'raw' ? 'raw' : 'hourly';

    let rows;
    if (resolution === 'raw') {
      rows = metricsStore.readRaw(serverId, days);
    } else {
      rows = metricsStore.readHourly(serverId, days);
    }

    res.json({ serverId, resolution, days, rows });
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get right-sizing recommendations for all servers
app.get('/api/recommendations', authMiddleware, (req, res) => {
  try {
    const recommendations = getRecommendations();
    res.json({ recommendations });
  } catch (error) {
    console.error('Error computing recommendations:', error);
    res.status(500).json({ error: 'Failed to compute recommendations' });
  }
});

// ============ Health Check ============

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ============ Auto-Deploy Webhook ============
// POST /deploy/:service
//   Header: X-Hive-Secret: <shared or per-service secret>
//
// Authentication & allowlisting (see services/deployService.js):
//
//   * Shared secret mode (recommended for a growing fleet):
//     DEPLOY_WEBHOOK_SECRET=<value> plus DEPLOY_WEBHOOK_SERVICES=<list|*>
//
//   * Per-service secret mode (backward compat):
//     DEPLOY_WEBHOOK_SECRET_<NAME>=<value>
//
// On a valid request we spawn a detached sidecar container that runs
//   docker compose -f $COMPOSE_FILE pull  <svc>
//   docker compose -f $COMPOSE_FILE up -d <svc>
// and return 202 Accepted with the sidecar's container id. The sidecar
// pattern lets server-monitor redeploy itself without being killed
// mid-response.
app.post('/deploy/:service', async (req, res) => {
  const service = req.params.service;
  const provided = req.headers['x-hive-secret'];
  const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';

  const auth = deployService.authorize(service, provided);
  if (!auth.ok) {
    deployService.appendAuditLog({
      event: 'reject', reason: auth.reason, service, ip: clientIp,
    });
    const body = { error: auth.reason };
    if (auth.reason === 'not_configured') {
      body.hint =
        'allowlist this service via DEPLOY_WEBHOOK_SERVICES (shared-secret mode) ' +
        `or DEPLOY_WEBHOOK_SECRET_${service.toUpperCase().replace(/-/g, '_')} ` +
        '(per-service mode) in the server-monitor environment, then restart';
    }
    return res.status(auth.status).json(body);
  }

  try {
    const { sidecarId, logFile } = await deployService.spawnDeploy(service);
    deployService.appendAuditLog({
      event: 'accept', service, via: auth.via, sidecar: sidecarId, logFile, ip: clientIp,
    });
    return res.status(202).json({
      ok: true,
      service,
      via: auth.via,
      sidecar: sidecarId,
      logFile,
      message: 'deploy accepted; monitor logFile for progress',
    });
  } catch (err) {
    console.error(`[deploy] ${service}: ${err.message}`);
    deployService.appendAuditLog({
      event: 'error', service, message: err.message, ip: clientIp,
    });
    return res.status(500).json({ error: err.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server Monitor running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Access the dashboard at: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});
