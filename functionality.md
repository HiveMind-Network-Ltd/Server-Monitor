# Server Monitor - Functionality Documentation

## Overview
Server Monitor is a comprehensive AWS EC2 monitoring application with authentication that tracks CPU, RAM, and disk usage across multiple servers with real-time alerts, background monitoring, and a public status page. It also exposes an authenticated webhook endpoint that lets CI pipelines redeploy individual compose services on the host stack.

## Version
Current version: 3.1.0

## Features and Functions

### 0. Auto-Deploy Webhook (NEW in v3.1.0)

#### Purpose
Lets GitHub Actions (or any trusted caller) trigger a `docker compose pull + up -d` for a single service on the host stack, without SSH access. Replaces the previously silently-404ing "trigger deploy" CI step.

#### Endpoint
- **POST /deploy/:service** — `service` must be a compose service name defined in the host stack's `docker-compose.yml`.
- Requires header **`X-Hive-Secret: <per-service-shared-secret>`**.
- Returns **202 Accepted** on success with `{ ok, service, sidecar, logFile }`. The actual redeploy is performed asynchronously by a one-shot sidecar container.

#### Security
- Each service is allowlisted explicitly via an env var: `DEPLOY_WEBHOOK_SECRET_<NAME>` (e.g. `DEPLOY_WEBHOOK_SECRET_MARKETSCRAPER_API`). No secret means 404 — the webhook can't redeploy services it hasn't been configured for.
- Secret comparison uses `crypto.timingSafeEqual`.
- Service name is validated against a strict regex (`[a-zA-Z][a-zA-Z0-9_-]{0,62}`) so it cannot leak into the shell.
- All attempts (accept / reject / error / complete) are written as JSON lines to `data/deploys/deploy.log`.

#### Sidecar Deploy Pattern
The redeploy runs inside a one-shot `docker:cli` container (`docker run --rm -d`) that mounts `/var/run/docker.sock` and `/srv/stack:/srv/stack:ro`. Using a sidecar rather than an in-process spawn means server-monitor can auto-deploy *itself* without being killed mid-response.

#### Required Host Wiring
- Host `docker-compose.yml` must bind-mount the stack root into server-monitor read-only:
  `- /srv/stack:/srv/stack:ro`
- Host `docker.sock` must be mounted (already standard for this app): `- /var/run/docker.sock:/var/run/docker.sock`
- Server-monitor's `.env` must contain one `DEPLOY_WEBHOOK_SECRET_<NAME>` entry per allowlisted service.

#### CI Workflow Pattern
```yaml
- name: Trigger deploy on grid server
  run: |
    curl -sS -X POST \
      -H "X-Hive-Secret: ${{ secrets.DEPLOY_WEBHOOK_SECRET_<NAME> }}" \
      https://server-monitor.grid.hivemindnetwork.com/deploy/<compose-service-name>
```

#### Environment Variables
- `DEPLOY_COMPOSE_FILE` — path to host compose file (default `/srv/stack/docker-compose.yml`)
- `DEPLOY_PROJECT_DIR` — compose project root (default `/srv/stack`)
- `DEPLOY_LOG_DIR` — audit log location (default `<app>/data/deploys`)
- `DEPLOY_SIDECAR_IMAGE` — docker image used to run compose (default `docker:cli`)
- `DEPLOY_WEBHOOK_SECRET_<NAME>` — per-service shared secret (required for each allowlisted service)

### 1. Background Monitoring System (NEW in v2.1.0)

#### Continuous Monitoring
- **Automatic Monitoring**: Runs every 30 seconds (configurable) even when no one is logged in
- **Background Service**: Starts automatically when the application starts
- **Metrics Caching**: Stores latest metrics in memory and on disk
- **Persistent Cache**: Metrics survive container restarts via disk cache
- **Logging**: Console logs for each monitoring cycle with timing and issue counts

#### Monitoring Service Features
- **Parallel Execution**: All servers monitored simultaneously for speed
- **Error Handling**: Graceful handling of connection failures
- **Performance Tracking**: Monitors duration of each check cycle
- **Issue Detection**: Counts and logs servers with errors or unreachable status

#### Cache Management
- **In-Memory Cache**: Fast access to latest metrics
- **Disk Persistence**: Saves to `data/metrics-cache.json`
- **Auto-Loading**: Loads cached metrics on startup
- **Timestamp Tracking**: Records last update time for each monitoring cycle

### 2. Public Status Page (NEW in v2.1.0)

#### Public Access
- **No Authentication Required**: `/status` endpoint is publicly accessible
- **Real-time Display**: Shows current status of all monitored servers
- **Auto-Refresh**: Updates every 30 seconds automatically
- **Mobile Responsive**: Works on all device sizes

#### Status Page Features
- **Overall System Status**:
  - ✓ All Systems Operational (all servers healthy)
  - ⚠️ Partial Service Issues (servers with high load)
  - ⚠️ Service Disruption (servers unreachable)
- **Server List**: Shows each server with name, status, and metrics
- **Visual Indicators**: Color-coded status badges (green/yellow/red)
- **Metric Display**: CPU, RAM, and Disk usage with color coding
- **Last Updated Timestamp**: Shows when data was last refreshed
- **Error Messages**: Displays connection errors when servers unreachable

#### Public API Endpoint
- **GET /api/status/public**: Returns sanitized metrics without sensitive data
- **No Private Information**: SSH keys, usernames, and hosts excluded
- **JSON Format**: Structured data for integration with other systems

### 3. Authentication System

#### User Management
- **Secure Password Storage**: Uses bcryptjs for password hashing
- **JWT Token Authentication**: Stateless authentication with JSON Web Tokens
- **Cookie-based Sessions**: Secure HTTP-only cookies for token storage
- **Admin User Initialization**: Automatic admin account creation on first run
- **Credentials Storage**: User credentials stored in JSON file (data/users.json)

#### Authentication Endpoints
- **POST /api/auth/login**: User login with username/password
- **POST /api/auth/logout**: User logout and token clearing
- **GET /api/auth/me**: Check current authentication status

#### Security Features
- **Protected Routes**: authMiddleware guards all API endpoints
- **Token Expiration**: 24-hour token validity
- **Secure Cookies**: HttpOnly cookies in production mode

### 3. Server Management

#### Server Configuration
- **Server Storage**: Server configurations stored in data/servers.json
- **SSH Credentials**: Secure storage of SSH private keys
- **EC2 Integration**: Optional AWS EC2 instance ID association
- **Server Metadata**: Name, host, username, and connection details

#### Server Management Endpoints
- **GET /api/servers**: List all configured servers (protected)
- **POST /api/servers**: Add new server configuration (protected)
- **PUT /api/servers/:id**: Update server configuration (protected)
- **DELETE /api/servers/:id**: Remove server (protected)

### 4. AWS EC2 Monitoring

#### CloudWatch Integration
- **EC2 Instance Discovery**: Retrieve instance details via AWS SDK
- **CloudWatch Metrics**: CPU utilization from CloudWatch
- **Instance Metadata**: Instance type, IPs, state, and tags
- **Regional Support**: Configurable AWS region

#### SSH-based Monitoring
- **CPU Utilization**: Real-time CPU usage via SSH commands
- **RAM Utilization**: Memory usage statistics
- **Disk Space Monitoring**: Disk usage for root partition (/)
- **Disk Details**: Total, used, and free space reporting

#### Monitoring Endpoints
- **GET /api/monitor/all**: Get metrics for all servers (protected)
- **GET /api/monitor/:id**: Get metrics for specific server (protected)

#### Metrics Collected
- **CPU**: Percentage utilization
- **RAM**: Percentage utilization
- **Disk**: Percentage used on / partition
- **Disk Space**: Total, used, and free space in human-readable format
- **Timestamp**: ISO 8601 timestamp of measurement

### 5. Docker Container Monitoring

#### Container Discovery
- **Automatic Detection**: Discovers all Docker containers on the host
- **Docker Socket**: Connects to `/var/run/docker.sock` for container access
- **State Tracking**: Monitors running, stopped, and exited containers
- **Image Information**: Displays container images and versions

#### Container Metrics (Updated in v2.2.0)
- **CPU Usage**: Real-time CPU utilization percentage per container
- **Memory Usage**: RAM utilization percentage and absolute usage
- **Disk Usage**: Disk space utilization within container filesystem
- **Visual Progress Bars**: Same UI treatment as server metrics (CPU, RAM, Disk)
- **Disk Details**: Total, used, and free space in human-readable format

#### Container Management
- **Real-time Status**: Live container state (running, stopped, exited)
- **Public Visibility**: Toggle containers on/off from public status page
- **Display Names**: Custom names for public-facing status page
- **Alert Integration**: Containers included in critical alert emails
- **Background Monitoring**: Continuous monitoring alongside servers

#### Container Stats Display
- **Unified UI**: Container cards match server cards exactly
- **Three Metrics**: CPU, RAM, and Disk with color-coded progress bars
- **Alert Thresholds**: Same thresholds as servers (80% warning, 90-95% critical)
- **Status Indicators**: Color-coded state badges
- **Summary Stats**: Container counts included in dashboard header

### 6. Dashboard UI Enhancements (Updated in v2.1.0)

#### Server Management
- **Delete Functionality**: 🗑️ delete button on each server card
- **Confirmation Dialogs**: Prevents accidental deletions
- **Real-time Updates**: Servers removed immediately from display
- **Cached Metrics**: Dashboard now uses pre-fetched background data for instant loading

### 7. Frontend Dashboard

#### User Interface Components
- **Login Screen**: Clean authentication interface
- **Dashboard Header**: Navigation with user info and actions
- **Statistics Bar**: Real-time overview of server fleet
  - Total servers count
  - Running servers count
  - Servers with issues count
  - Last update timestamp
- **Server Cards Grid**: Responsive grid layout of server status
- **Add Server Modal**: Form for configuring new servers

#### Visual Alert System
- **Normal State**: Green indicators for healthy metrics
- **Warning State**: Orange/yellow for metrics above warning threshold (80%)
- **Critical State**: Red alerts for metrics above critical threshold (90-95%)
- **Card Highlighting**: Server cards with red borders for critical issues
- **Status Badges**: Color-coded status indicators per server

#### Real-time Features
- **Auto-refresh**: Dashboard updates every 30 seconds using cached data
- **Manual Refresh**: On-demand refresh button
- **Live Metrics**: Progress bars showing current utilization
- **Timestamp Display**: Last updated time shown
- **Instant Loading**: Uses background-monitored cached metrics for immediate display
- **Always Current**: Background monitoring keeps data fresh even when logged out

#### Metric Thresholds
- **CPU Warning**: 80% (configurable)
- **CPU Critical**: 95% (configurable)
- **RAM Warning**: 80% (configurable)
- **RAM Critical**: 90% (configurable)
- **Disk Warning**: 80% (configurable)
- **Disk Critical**: 90% (configurable)

### 8. Server Monitoring Service

#### Connection Methods
- **SSH Monitoring**: Direct SSH connection for detailed metrics
- **CloudWatch Fallback**: AWS CloudWatch for EC2 instances without SSH
- **Hybrid Mode**: Combines EC2 metadata with SSH metrics

#### Error Handling
- **Connection Failures**: Graceful error reporting
- **Timeout Management**: Proper SSH connection timeouts
- **Status Reporting**: Clear error messages in UI

### 9. Configuration

#### Environment Variables
- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Node environment (default: development)
- `SESSION_SECRET`: Session encryption key
- `ADMIN_USERNAME`: Initial admin username (default: admin)
- `ADMIN_PASSWORD`: Initial admin password (default: admin123)
- `AWS_REGION`: AWS region (default: us-east-1)
- `AWS_ACCESS_KEY_ID`: AWS access key for API access
- `AWS_SECRET_ACCESS_KEY`: AWS secret key for API access
- `JWT_SECRET`: Secret key for JWT signing
- `MONITOR_INTERVAL`: Auto-refresh interval in ms (default: 30000)
- `CPU_THRESHOLD`: CPU warning threshold (default: 80)
- `RAM_THRESHOLD`: RAM warning threshold (default: 80)
- `DISK_THRESHOLD`: Disk warning threshold (default: 90)

### 10. API Endpoints

#### Public Endpoints
- **GET /health**: Health check endpoint
- **GET /**: Serves frontend application
- **GET /status**: Public status page (no authentication)
- **GET /api/status/public**: Public API for status data (no authentication)

#### Protected Endpoints (Require Authentication)
All `/api/*` endpoints except `/api/auth/login` and `/api/status/public` require valid JWT token

#### Monitoring Endpoints (Updated in v2.1.0)
- **GET /api/monitor/all**: Returns cached metrics from background monitoring
- **GET /api/monitor/:id**: Returns cached metrics for specific server
- Note: No longer performs live monitoring on request; uses cached data for instant response

#### Response Formats
- All responses in JSON format
- Consistent error message structure
- HTTP status codes for different scenarios

### 11. Data Persistence

#### File-based Storage
- **data/users.json**: User account information
- **data/servers.json**: Server configurations and credentials
- **data/metrics-cache.json**: Cached monitoring metrics (NEW in v2.1.0)
- **data/alert-state.json**: Email alert tracking state (NEW in v2.2.0)

#### Security Considerations
- Passwords hashed with bcrypt (10 rounds)
- Private keys stored securely server-side
- Never expose private keys in API responses
- Token-based authentication for all sensitive operations

### 12. Docker Support

#### Dockerfile Features
- **Base Image**: Node.js 20 Alpine (lightweight) — bumped from 18 in v3.1.0 because AWS SDK v3 dropped Node 18 support
- **Production Build**: Uses `npm ci` for reproducible builds
- **Security**: Runs as non-root user
- **Port**: Exposes port 3000
- **Environment**: NODE_ENV set to production

#### Docker Considerations
- All data persisted in /app/data directory
- Consider volume mounting for data persistence
- Environment variables for configuration

### 13. CI/CD Pipeline

#### GitHub Actions Workflow
- **Trigger**: Automatic build on push to main branch
- **Registry**: Publishes to GitHub Container Registry (ghcr.io)
- **Image**: ghcr.io/hivemind-network-ltd/server-monitor:latest (moved from `hivemindnet` GHCR org during org rename)
- **Authentication**: Uses GitHub token for GHCR authentication
- **Tagging**: Creates 'latest' tag and SHA-based tags

## Dependencies

### Production Dependencies
- **express**: ^4.18.2 - Web framework
- **express-session**: ^1.17.3 - Session management
- **bcryptjs**: ^2.4.3 - Password hashing
- **jsonwebtoken**: ^9.0.2 - JWT authentication
- **dotenv**: ^16.3.1 - Environment variable management
- **@aws-sdk/client-ec2**: ^3.478.0 - AWS EC2 API client
- **@aws-sdk/client-cloudwatch**: ^3.478.0 - AWS CloudWatch client
- **node-ssh**: ^13.1.0 - SSH client for server monitoring
- **cookie-parser**: ^1.4.6 - Cookie parsing middleware
- **cors**: ^2.8.5 - CORS middleware

### Development Dependencies
- **nodemon**: ^3.0.2 - Development auto-reload

## Usage Workflow

1. **Initial Setup**: Set environment variables and start application
2. **Background Monitoring Starts**: Automatically begins monitoring all configured servers
3. **First Login**: Use admin credentials from environment variables
4. **Add Servers**: Configure servers with SSH credentials and optional EC2 instance IDs
5. **Monitor**: View real-time metrics from background monitoring
6. **Public Status**: Share `/status` page for public visibility (no login required)
7. **Alert Response**: Red-highlighted cards indicate servers requiring attention

## Key Improvements in v2.1.0

### Background Monitoring
- **Always Running**: Monitoring continues 24/7 even when no one is logged in
- **Faster Dashboard**: Instant loading using pre-cached metrics
- **Reliable Data**: Consistent monitoring intervals regardless of user activity
- **Lower Load**: API requests don't trigger new SSH connections

### Public Status Page
- **External Visibility**: Share server status without granting login access
- **Customer-Facing**: Use as a status page for clients/stakeholders
- **Clean Design**: Modern, responsive interface
- **Privacy Preserved**: No sensitive server details exposed

## Technical Architecture

- **Backend**: Node.js with Express
- **Frontend**: Vanilla JavaScript with modern CSS
- **Authentication**: JWT with HTTP-only cookies
- **Cloud Integration**: AWS SDK for EC2 and CloudWatch
- **Server Monitoring**: SSH-based metric collection
- **Data Storage**: JSON file-based persistence
- **Deployment**: Dockerized with CI/CD automation
