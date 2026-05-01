// State
let currentUser = null;
let servers = [];
let containers = [];
let refreshInterval = null;

// Right-sizing state
let rsHistoryData = {}; // { serverId: { hourly: [...] } }
let rsCurrentServerId = null;
let rsActiveMetric = 'cpu';

// ── Theme helpers ──────────────────────────────────────────────────────────────

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) btn.textContent = theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
    try { localStorage.setItem('theme', theme); } catch (e) {}
}

function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) {}
    if (saved === 'light' || saved === 'dark') {
        applyTheme(saved);
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
        applyTheme('light');
    } else {
        applyTheme('dark');
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

// Constants (hardcoded for browser)
const CPU_THRESHOLD = 80;
const RAM_THRESHOLD = 80;
const DISK_THRESHOLD = 90;
const MONITOR_INTERVAL = 30000;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    setupEventListeners();
});

// Setup event listeners
function setupEventListeners() {
    // Login form
    document.getElementById('login-form')?.addEventListener('submit', handleLogin);
    
    // Logout button
    document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
    
    // Add server button
    document.getElementById('add-server-btn')?.addEventListener('click', openAddServerModal);
    
    // Add server form
    document.getElementById('add-server-form')?.addEventListener('submit', handleAddServer);
    
    // Email settings button
    document.getElementById('email-settings-btn')?.addEventListener('click', openEmailSettingsModal);
    
    // Test email button
    document.getElementById('test-email-btn')?.addEventListener('click', sendTestEmail);
    
    // Refresh button
    document.getElementById('refresh-btn')?.addEventListener('click', loadServers);

    // Theme toggle
    document.getElementById('theme-toggle-btn')?.addEventListener('click', toggleTheme);

    // Right-sizing panel toggle
    document.getElementById('rightsizing-btn')?.addEventListener('click', toggleRightSizingPanel);

    // Right-sizing modal — close on backdrop click
    document.getElementById('rightsizing-modal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeRightSizingModal();
    });

    // ESC key closes modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeRightSizingModal();
        }
    });
}

// Check authentication status
async function checkAuth() {
    initTheme();
    try {
        const response = await fetch('/api/auth/me', {
            credentials: 'include'
        });

        if (response.ok) {
            const data = await response.json();
            currentUser = data.user;
            showDashboard();
            loadServers();
            startAutoRefresh();
        } else {
            showLogin();
        }
    } catch (error) {
        showLogin();
    }
}

// Handle login
async function handleLogin(e) {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('login-error');
    
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            currentUser = data.user;
            showDashboard();
            loadServers();
            startAutoRefresh();
        } else {
            errorDiv.textContent = data.error || 'Login failed';
        }
    } catch (error) {
        errorDiv.textContent = 'Connection error. Please try again.';
    }
}

// Handle logout
async function handleLogout() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (error) {
        console.error('Logout error:', error);
    }
    
    stopAutoRefresh();
    currentUser = null;
    showLogin();
}

// Show login screen
function showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.add('hidden');
}

// Show dashboard
function showDashboard() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');
    document.getElementById('username-display').textContent = currentUser.username;
}

// Load servers
async function loadServers() {
    try {
        const response = await fetch('/api/monitor/all', {
            credentials: 'include'
        });
        
        if (!response.ok) {
            if (response.status === 401) {
                showLogin();
                return;
            }
            throw new Error('Failed to load servers');
        }
        
        const data = await response.json();
        servers = data.servers || [];
        containers = data.containers || [];
        renderServers();
        renderContainers();
        updateStats();
        updateLastUpdated();
    } catch (error) {
        console.error('Error loading servers:', error);
    }
}

// Render servers
function renderServers() {
    const container = document.getElementById('servers-container');
    const noServers = document.getElementById('no-servers');
    
    if (servers.length === 0) {
        container.innerHTML = '';
        noServers.classList.remove('hidden');
        return;
    }
    
    noServers.classList.add('hidden');
    
    container.innerHTML = servers.map(server => {
        const hasIssues = checkForIssues(server);
        const cardClass = hasIssues.critical ? 'error' : hasIssues.warning ? 'warning' : '';
        
        return `
            <div class="server-card ${cardClass}">
                <div class="server-header">
                    <div class="server-name">
                        <label class="checkbox-label">
                            <input type="checkbox" ${server.publicStatus !== false ? 'checked' : ''} onchange="togglePublicStatus('${server.id}', this.checked, 'server')" title="Include in public status page">
                            ${escapeHtml(server.name)}
                        </label>
                        <button class="edit-name-btn" onclick="editDisplayName('${server.id}', '${escapeHtml(server.name)}', '${escapeHtml(server.displayName || '')}', 'server')" title="Edit display name for public status">✏️</button>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        ${server.displayName ? `<span style="color: var(--text-secondary); font-size: 0.85rem;" title="Public display name">📝 ${escapeHtml(server.displayName)}</span>` : ''}
                        <div class="server-status ${getStatusClass(server.status)}">
                            ${server.status}
                        </div>
                        <button class="delete-btn" onclick="deleteServer('${server.id}')" title="Delete server">🗑️</button>
                    </div>
                </div>
                
                ${server.metrics ? renderMetrics(server.metrics) : ''}
                ${server.error ? `<div style="color: var(--danger); margin-top: 10px;">⚠️ ${escapeHtml(server.error)}</div>` : ''}
                
                ${server.details ? `
                    <div class="server-info">
                        ${server.details.instanceId ? `<div>Instance ID: ${escapeHtml(server.details.instanceId)}</div>` : ''}
                        ${server.details.type ? `<div>Type: ${escapeHtml(server.details.type)}</div>` : ''}
                        ${server.details.publicIp ? `<div>Public IP: ${escapeHtml(server.details.publicIp)}</div>` : ''}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

// Render metrics
function renderMetrics(metrics) {
    if (!metrics) return '';
    
    return `
        <div class="server-metrics">
            ${renderMetric('CPU Usage', metrics.cpu, '%', 80, 95)}
            ${renderMetric('RAM Usage', metrics.ram, '%', 80, 90)}
            ${renderMetric('Disk Usage', metrics.disk, '%', 80, 90)}
            ${metrics.diskTotal && metrics.diskTotal !== 'N/A' ? `
                <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 10px;">
                    💾 ${metrics.diskUsed} used / ${metrics.diskTotal} total (${metrics.diskFree} free)
                </div>
            ` : ''}
        </div>
    `;
}

// Render individual metric
function renderMetric(label, value, unit, warningThreshold, criticalThreshold) {
    if (value === 'N/A') {
        return `
            <div class="metric">
                <div class="metric-header">
                    <span class="metric-label">${label}</span>
                    <span class="metric-value">${value}</span>
                </div>
            </div>
        `;
    }
    
    const numValue = parseFloat(value);
    const status = numValue >= criticalThreshold ? 'critical' : 
                   numValue >= warningThreshold ? 'warning' : 'normal';
    
    return `
        <div class="metric">
            <div class="metric-header">
                <span class="metric-label">${label}</span>
                <span class="metric-value ${status}">${value}${unit}</span>
            </div>
            <div class="metric-bar">
                <div class="metric-fill ${status}" style="width: ${Math.min(numValue, 100)}%"></div>
            </div>
        </div>
    `;
}

// Check for issues
function checkForIssues(server) {
    if (!server.metrics) return { critical: false, warning: false };
    
    const cpu = parseFloat(server.metrics.cpu);
    const ram = parseFloat(server.metrics.ram);
    const disk = parseFloat(server.metrics.disk);
    
    const critical = cpu >= 95 || ram >= 90 || disk >= 90;
    const warning = cpu >= 80 || ram >= 80 || disk >= 80;
    
    return { critical, warning };
}

// Get status class
function getStatusClass(status) {
    if (status === 'running') return 'running';
    if (status === 'stopped') return 'stopped';
    return 'error';
}

// Render containers
function renderContainers() {
    const container = document.getElementById('containers-list');
    const noContainers = document.getElementById('no-containers');
    
    if (!container) return; // Element might not exist yet
    
    if (containers.length === 0) {
        container.innerHTML = '';
        if (noContainers) noContainers.classList.remove('hidden');
        return;
    }
    
    if (noContainers) noContainers.classList.add('hidden');
    
    container.innerHTML = containers.map(cont => {
        const statusClass = cont.state === 'running' ? 'running' : 
                          cont.state === 'exited' ? 'stopped' : 'error';
        
        // Check for issues (high CPU, memory, or disk)
        const cpu = cont.stats ? parseFloat(cont.stats.cpu) : 0;
        const memory = cont.stats ? parseFloat(cont.stats.memory) : 0;
        const disk = cont.stats && cont.stats.disk !== 'N/A' ? parseFloat(cont.stats.disk) : 0;
        
        const hasCritical = cpu >= 95 || memory >= 90 || disk >= 90;
        const hasWarning = cpu >= 80 || memory >= 80 || disk >= 80;
        const cardClass = cont.state !== 'running' ? 'error' : hasCritical ? 'error' : hasWarning ? 'warning' : '';
        
        return `
            <div class="server-card ${cardClass}">
                <div class="server-header">
                    <div class="server-name">
                        <label class="checkbox-label">
                            <input type="checkbox" ${cont.publicStatus !== false ? 'checked' : ''} onchange="togglePublicStatus('${cont.id}', this.checked, 'container')" title="Include in public status page">
                            🐳 ${escapeHtml(cont.name)}
                        </label>
                        <button class="edit-name-btn" onclick="editDisplayName('${cont.id}', '${escapeHtml(cont.name)}', '${escapeHtml(cont.displayName || '')}', 'container')" title="Edit display name for public status">✏️</button>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        ${cont.displayName ? `<span style="color: var(--text-secondary); font-size: 0.85rem;" title="Public display name">📝 ${escapeHtml(cont.displayName)}</span>` : ''}
                        <div class="server-status ${statusClass}">
                            ${cont.state}
                        </div>
                    </div>
                </div>
                
                ${cont.stats ? `
                    <div class="server-metrics">
                        ${renderMetric('CPU Usage', cont.stats.cpu, '%', 80, 95)}
                        ${renderMetric('Memory Usage', cont.stats.memory, '%', 80, 90)}
                        ${renderMetric('Disk Usage', cont.stats.disk, '%', 80, 90)}
                        ${cont.stats.diskTotal && cont.stats.diskTotal !== 'N/A' ? `
                            <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 10px;">
                                💾 ${cont.stats.diskUsed} used / ${cont.stats.diskTotal} total (${cont.stats.diskFree} free)
                            </div>
                        ` : ''}
                    </div>
                ` : ''}
                
                <div class="server-info">
                    <div>Image: ${escapeHtml(cont.image)}</div>
                </div>
            </div>
        `;
    }).join('');
}

// Update stats
function updateStats() {
    const totalServers = servers.length;
    const totalContainers = containers.length;
    
    const runningServers = servers.filter(s => s.status === 'running').length;
    const runningContainers = containers.filter(c => c.state === 'running').length;
    
    const serverIssues = servers.filter(s => s.status !== 'running' || checkForIssues(s).warning || checkForIssues(s).critical).length;
    const containerIssues = containers.filter(c => c.state !== 'running').length;
    
    const healthyCount = runningServers + runningContainers - servers.filter(s => s.status === 'running' && checkForIssues(s).warning).length;
    const totalIssues = serverIssues + containerIssues;
    
    document.getElementById('total-servers').textContent = totalServers;
    document.getElementById('total-containers').textContent = totalContainers;
    document.getElementById('healthy-count').textContent = healthyCount;
    document.getElementById('issue-count').textContent = totalIssues;
}

// Update last updated time
function updateLastUpdated() {
    const now = new Date();
    const timeString = now.toLocaleTimeString();
    document.getElementById('last-updated').textContent = timeString;
}

// Auto refresh
function startAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    refreshInterval = setInterval(loadServers, 30000); // Refresh every 30 seconds
}

function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

// Modal functions
function openAddServerModal() {
    document.getElementById('add-server-modal').classList.remove('hidden');
}

function closeAddServerModal() {
    document.getElementById('add-server-modal').classList.add('hidden');
    document.getElementById('add-server-form').reset();
}

// Handle add server
async function handleAddServer(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const serverData = {
        name: formData.get('name'),
        instanceId: formData.get('instanceId') || null,
        host: formData.get('host'),
        username: formData.get('username'),
        privateKey: formData.get('privateKey')
    };
    
    try {
        const response = await fetch('/api/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(serverData)
        });
        
        if (response.ok) {
            closeAddServerModal();
            loadServers();
        } else {
            const data = await response.json();
            alert('Error: ' + (data.error || 'Failed to add server'));
        }
    } catch (error) {
        alert('Connection error. Please try again.');
        console.error('Error adding server:', error);
    }
}

// Email Settings Modal functions
async function openEmailSettingsModal() {
    const modal = document.getElementById('email-settings-modal');
    modal.classList.remove('hidden');
    
    // Load email status
    try {
        const response = await fetch('/api/email/status', {
            credentials: 'include'
        });
        
        if (response.ok) {
            const data = await response.json();
            
            if (data.configured) {
                // Show configured section
                document.getElementById('email-configured').classList.remove('hidden');
                document.getElementById('email-not-configured').classList.add('hidden');
                
                // Fill in config details
                document.getElementById('config-smtp-host').textContent = data.config.smtpHost;
                document.getElementById('config-smtp-port').textContent = data.config.smtpPort;
                document.getElementById('config-from').textContent = data.config.alertFrom;
                document.getElementById('config-to').textContent = data.config.alertTo;
            } else {
                // Show not configured section
                document.getElementById('email-configured').classList.add('hidden');
                document.getElementById('email-not-configured').classList.remove('hidden');
            }
        }
    } catch (error) {
        console.error('Error loading email status:', error);
        // Show not configured by default if error
        document.getElementById('email-configured').classList.add('hidden');
        document.getElementById('email-not-configured').classList.remove('hidden');
    }
}

function closeEmailSettingsModal() {
    document.getElementById('email-settings-modal').classList.add('hidden');
    // Clear test email status
    const statusEl = document.getElementById('test-email-status');
    statusEl.textContent = '';
    statusEl.className = '';
}

async function sendTestEmail() {
    const btn = document.getElementById('test-email-btn');
    const statusEl = document.getElementById('test-email-status');
    
    // Disable button and show loading
    btn.disabled = true;
    btn.textContent = '📨 Sending...';
    statusEl.textContent = 'Sending test email...';
    statusEl.className = 'loading';
    
    try {
        const response = await fetch('/api/email/test', {
            method: 'POST',
            credentials: 'include'
        });
        
        const data = await response.json();
        
        if (response.ok) {
            statusEl.textContent = '✅ ' + data.message;
            statusEl.className = 'success';
        } else {
            statusEl.textContent = '❌ ' + (data.error || 'Failed to send test email');
            statusEl.className = 'error';
        }
    } catch (error) {
        statusEl.textContent = '❌ Connection error';
        statusEl.className = 'error';
        console.error('Error sending test email:', error);
    } finally {
        btn.disabled = false;
        btn.textContent = '📨 Send Test Email';
        
        // Clear status after 5 seconds
        setTimeout(() => {
            statusEl.textContent = '';
            statusEl.className = '';
        }, 5000);
    }
}

// Toggle public status visibility
async function togglePublicStatus(id, isPublic, type) {
    try {
        const response = await fetch(`/api/${type === 'server' ? 'servers' : 'containers'}/${id}/public`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ publicStatus: isPublic })
        });
        
        if (!response.ok) {
            const data = await response.json();
            alert('Error: ' + (data.error || 'Failed to update status'));
            loadServers(); // Reload to reset checkbox
        }
    } catch (error) {
        alert('Connection error. Please try again.');
        console.error('Error updating public status:', error);
        loadServers(); // Reload to reset checkbox
    }
}

// Edit display name
function editDisplayName(id, actualName, currentDisplayName, type) {
    const displayName = prompt(
        `Edit public display name for: ${actualName}\n\n` +
        `Leave empty to use actual name.\n` +
        `Current display name: ${currentDisplayName || '(none)'}`,
        currentDisplayName
    );
    
    if (displayName === null) return; // Cancelled
    
    updateDisplayName(id, displayName.trim(), type);
}

async function updateDisplayName(id, displayName, type) {
    try {
        const response = await fetch(`/api/${type === 'server' ? 'servers' : 'containers'}/${id}/displayName`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ displayName: displayName || null })
        });
        
        if (response.ok) {
            loadServers(); // Reload to show new display name
        } else {
            const data = await response.json();
            alert('Error: ' + (data.error || 'Failed to update display name'));
        }
    } catch (error) {
        alert('Connection error. Please try again.');
        console.error('Error updating display name:', error);
    }
}

// Delete server
async function deleteServer(serverId) {
    if (!confirm('Are you sure you want to delete this server? This cannot be undone.')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/servers/${serverId}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        
        if (response.ok) {
            loadServers(); // Refresh the list
        } else {
            const data = await response.json();
            alert('Error: ' + (data.error || 'Failed to delete server'));
        }
    } catch (error) {
        alert('Connection error. Please try again.');
        console.error('Error deleting server:', error);
    }
}

// Utility function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ────────────────────────────────────────────────────────────
// RIGHT-SIZING PANEL
// ────────────────────────────────────────────────────────────

/**
 * Toggle the right-sizing panel visibility.
 * Fetches recommendations from the API on first open.
 */
async function toggleRightSizingPanel() {
    const panel = document.getElementById('rightsizing-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
        await loadRecommendations();
    } else {
        panel.classList.add('hidden');
    }
}

/**
 * Fetch recommendations from /api/recommendations and render the table.
 */
async function loadRecommendations() {
    const content = document.getElementById('rightsizing-content');
    if (!content) return;

    content.innerHTML = '<div class="rightsizing-loading">Loading recommendations…</div>';

    try {
        const resp = await fetch('/api/recommendations', { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        renderRecommendations(content, data.recommendations || []);
    } catch (err) {
        content.innerHTML = `<div class="rightsizing-loading">Failed to load recommendations: ${escapeHtml(err.message)}</div>`;
    }
}

/**
 * Render the recommendations table.
 * @param {HTMLElement} container
 * @param {Array} recs
 */
function renderRecommendations(container, recs) {
    if (!recs.length) {
        container.innerHTML = '<div class="rightsizing-loading">No servers configured.</div>';
        return;
    }

    const rows = recs.map(r => {
        const p = r.p95 || {};
        const cpuStr  = p.cpu  != null ? p.cpu.toFixed(1) + '%'  : '—';
        const memStr  = p.mem  != null ? p.mem.toFixed(1) + '%'  : '—';
        const diskStr = p.disk != null ? p.disk.toFixed(1) + '%' : '—';
        const savingsBadge = r.savingsLabel
            ? `<span class="rs-savings">↓ ${escapeHtml(r.savingsLabel)}</span>`
            : '';
        return `
          <tr onclick="openRightSizingModal('${escapeHtml(r.serverId)}', '${escapeHtml(r.server)}')"
              style="cursor:pointer">
            <td>${escapeHtml(r.server)}</td>
            <td><span class="rs-badge rs-badge-${r.signal}">${escapeHtml(r.signal)}</span></td>
            <td>${escapeHtml(r.reason)}${savingsBadge ? '  ' + savingsBadge : ''}</td>
            <td class="rs-p95-cell">CPU ${cpuStr} &nbsp; RAM ${memStr} &nbsp; Disk ${diskStr}</td>
          </tr>`;
    }).join('');

    container.innerHTML = `
      <table class="rs-table">
        <thead>
          <tr>
            <th>Server</th>
            <th>Signal</th>
            <th>Reason</th>
            <th>7-day p95</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
}

// ────────────────────────────────────────────────────────────
// DETAIL MODAL + SPARKLINE
// ────────────────────────────────────────────────────────────

/**
 * Open the right-sizing detail modal for a server.
 * @param {string} serverId
 * @param {string} serverName
 */
async function openRightSizingModal(serverId, serverName) {
    rsCurrentServerId = serverId;
    rsActiveMetric = 'cpu';

    // Reset tabs
    document.querySelectorAll('.rs-tab').forEach(t => t.classList.remove('active'));
    const cpuTab = document.querySelector('.rs-tab[data-metric="cpu"]');
    if (cpuTab) cpuTab.classList.add('active');

    // Set title
    const title = document.getElementById('rs-modal-title');
    if (title) title.textContent = serverName + ' — Utilisation History';

    // Show modal
    const modal = document.getElementById('rightsizing-modal');
    if (modal) modal.classList.remove('hidden');

    // Fetch history if not cached
    if (!rsHistoryData[serverId]) {
        drawSparklinePlaceholder();
        try {
            const resp = await fetch(`/api/history/${encodeURIComponent(serverId)}?resolution=hourly`, {
                credentials: 'include'
            });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            rsHistoryData[serverId] = data.rows || [];
        } catch (err) {
            rsHistoryData[serverId] = [];
        }
    }

    drawSparkline(rsHistoryData[serverId], rsActiveMetric);
    renderModalSummary(serverId);
}

/** Close the right-sizing detail modal. */
function closeRightSizingModal() {
    const modal = document.getElementById('rightsizing-modal');
    if (modal) modal.classList.add('hidden');
}

/**
 * Switch the active metric tab in the sparkline modal.
 * @param {HTMLElement} btn
 * @param {string} metric  'cpu' | 'mem' | 'disk'
 */
function switchSparklineTab(btn, metric) {
    document.querySelectorAll('.rs-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    rsActiveMetric = metric;
    if (rsCurrentServerId && rsHistoryData[rsCurrentServerId]) {
        drawSparkline(rsHistoryData[rsCurrentServerId], metric);
    }
}

/** Draw a placeholder while history loads. */
function drawSparklinePlaceholder() {
    const canvas = document.getElementById('rs-sparkline');
    const emptyDiv = document.getElementById('rs-chart-empty');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (emptyDiv) {
        emptyDiv.textContent = 'Loading…';
        emptyDiv.classList.remove('hidden');
    }
}

/**
 * Draw the sparkline chart on <canvas id="rs-sparkline">.
 * Uses native canvas — no external dependencies.
 *
 * @param {Array} rows   Hourly aggregated rows from /api/history
 * @param {string} metric  'cpu' | 'mem' | 'disk'
 */
function drawSparkline(rows, metric) {
    const canvas = document.getElementById('rs-sparkline');
    const emptyDiv = document.getElementById('rs-chart-empty');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const W = canvas.offsetWidth  || canvas.width;
    const H = canvas.offsetHeight || canvas.height;
    canvas.width  = W;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const metricKey = metric === 'cpu' ? 'cpu_pct' : metric === 'mem' ? 'mem_pct' : 'disk_pct';
    const values = rows.map(r => r[metricKey]);
    const valid = values.filter(v => v != null);

    if (!valid.length) {
        if (emptyDiv) {
            emptyDiv.textContent = 'No data available for this period';
            emptyDiv.classList.remove('hidden');
        }
        return;
    }
    if (emptyDiv) emptyDiv.classList.add('hidden');

    const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
    const lineColor = metric === 'cpu' ? '#6366f1'
                    : metric === 'mem' ? '#10b981'
                    : '#f59e0b';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = isDark ? '#94a3b8' : '#64748b';

    const PAD = { top: 16, right: 24, bottom: 28, left: 40 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top  - PAD.bottom;

    // Grid lines at 0, 25, 50, 75, 100
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = `11px -apple-system, sans-serif`;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'right';
    [0, 25, 50, 75, 100].forEach(pct => {
        const y = PAD.top + chartH * (1 - pct / 100);
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(PAD.left + chartW, y);
        ctx.stroke();
        ctx.fillText(pct + '%', PAD.left - 6, y + 4);
    });

    // Warning threshold line (80%)
    ctx.strokeStyle = 'rgba(245,158,11,0.5)';
    ctx.setLineDash([4, 4]);
    const warnY = PAD.top + chartH * (1 - 0.8);
    ctx.beginPath();
    ctx.moveTo(PAD.left, warnY);
    ctx.lineTo(PAD.left + chartW, warnY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Data line
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    values.forEach((v, i) => {
        if (v == null) return;
        const x = PAD.left + (i / (values.length - 1 || 1)) * chartW;
        const y = PAD.top + chartH * (1 - Math.min(v, 100) / 100);
        if (first) { ctx.moveTo(x, y); first = false; }
        else        { ctx.lineTo(x, y); }
    });
    ctx.stroke();

    // Fill under line
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + chartH);
    grad.addColorStop(0, lineColor + '33');
    grad.addColorStop(1, lineColor + '00');
    ctx.fillStyle = grad;
    ctx.beginPath();
    let firstFill = true;
    values.forEach((v, i) => {
        if (v == null) return;
        const x = PAD.left + (i / (values.length - 1 || 1)) * chartW;
        const y = PAD.top + chartH * (1 - Math.min(v, 100) / 100);
        if (firstFill) { ctx.moveTo(x, PAD.top + chartH); ctx.lineTo(x, y); firstFill = false; }
        else            { ctx.lineTo(x, y); }
    });
    ctx.lineTo(PAD.left + chartW, PAD.top + chartH);
    ctx.closePath();
    ctx.fill();

    // X-axis time labels (start / mid / end)
    if (rows.length >= 2) {
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.font = '10px -apple-system, sans-serif';
        const labelIdxs = [0, Math.floor(rows.length / 2), rows.length - 1];
        labelIdxs.forEach(i => {
            const row = rows[i];
            const ts = row.bucket || row.ts;
            if (!ts) return;
            const d = new Date(ts * 1000);
            const label = `${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:00`;
            const x = PAD.left + (i / (rows.length - 1)) * chartW;
            ctx.fillText(label, x, H - 6);
        });
    }
}

/**
 * Render the stat summary row below the sparkline.
 * @param {string} serverId
 */
function renderModalSummary(serverId) {
    const rows = rsHistoryData[serverId] || [];
    const summaryEl = document.getElementById('rs-summary');
    if (!summaryEl) return;

    if (!rows.length) {
        summaryEl.innerHTML = '<span style="color:var(--text-secondary);font-size:0.875rem">No history data yet</span>';
        return;
    }

    function pct95(arr) {
        const clean = arr.filter(v => v != null).sort((a,b) => a-b);
        if (!clean.length) return null;
        return clean[Math.min(Math.floor(clean.length * 0.95), clean.length - 1)];
    }
    function avg(arr) {
        const clean = arr.filter(v => v != null);
        return clean.length ? clean.reduce((s,v) => s+v, 0) / clean.length : null;
    }
    function fmt(v) { return v != null ? v.toFixed(1) + '%' : '—'; }

    const cpus  = rows.map(r => r.cpu_pct);
    const mems  = rows.map(r => r.mem_pct);
    const disks = rows.map(r => r.disk_pct);

    summaryEl.innerHTML = `
      <div class="rs-stat">
        <span class="rs-stat-label">Data points</span>
        <span class="rs-stat-value">${rows.length}</span>
      </div>
      <div class="rs-stat">
        <span class="rs-stat-label">CPU avg</span>
        <span class="rs-stat-value">${fmt(avg(cpus))}</span>
      </div>
      <div class="rs-stat">
        <span class="rs-stat-label">CPU p95</span>
        <span class="rs-stat-value">${fmt(pct95(cpus))}</span>
      </div>
      <div class="rs-stat">
        <span class="rs-stat-label">RAM avg</span>
        <span class="rs-stat-value">${fmt(avg(mems))}</span>
      </div>
      <div class="rs-stat">
        <span class="rs-stat-label">RAM p95</span>
        <span class="rs-stat-value">${fmt(pct95(mems))}</span>
      </div>
      <div class="rs-stat">
        <span class="rs-stat-label">Disk p95</span>
        <span class="rs-stat-value">${fmt(pct95(disks))}</span>
      </div>`;
}

