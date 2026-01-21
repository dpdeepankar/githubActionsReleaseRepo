// ═══════════════════════════════════════════════════════════════════════
// ENHANCED index.js - WITH AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const session = require('express-session');
const cookieParser = require('cookie-parser');
let config;
try {
  config = require('./config');
} catch (err) {
  console.error('Failed to load config.js:', err.message);
  process.exit(1);
}

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

const octokit = new Octokit({ auth: config.token });

// Configuration
const MAX_RUNS_PER_WORKFLOW = 15;
const CACHE_FILE = path.join(__dirname, '.workflow-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
const CONCURRENT_WORKFLOWS = 10;
const CONCURRENT_JOBS = 20;
const REAL_TIME_POLL_INTERVAL = 120000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-key-change-this';

// Teams and user configuration
const TEAMS_CONFIG = config.teams || {};
const USER_ROLES = config.userRoles || {};


// Scheduled jobs storage
const scheduledJobs = new Map();

// ══════════════════════════════════════════════
// MIDDLEWARE & SETUP
// ══════════════════════════════════════════════
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Serve static files from 'public' directory
app.use(express.static('public'));

// ══════════════════════════════════════════════
// AUTHENTICATION MIDDLEWARE
// ══════════════════════════════════════════════

// Check if user is authenticated
function requireAuth(req, res, next) {
  if (req.session && req.session.username) {
    const userConfig = USER_ROLES[req.session.username];
    if (userConfig) {
      req.user = userConfig;
      req.username = req.session.username;
      return next();
    }
  }
  
  res.status(401).json({ error: 'Unauthorized', message: 'Please log in' });
}

// Check specific permission
function checkPermission(action) {
  return (req, res, next) => {
    // For GET requests (like logs), skip team check or get from query/headers
    if (req.method === 'GET') {
      return next(); // or add custom logic if needed
    }

    // For POST/PUT etc. (which have body)
    const { team } = req.body;
    if (!team) {
      return res.status(400).json({ error: 'Team is required for this action' });
    }

    const teamConfig = TEAMS_CONFIG[team];
    if (!teamConfig) {
      return res.status(404).json({ error: 'Team not found' });
    }

    if (!req.user.teams.includes(team)) {
      return res.status(403).json({ error: 'Not a member of this team' });
    }

    const allowedRoles = teamConfig.permissions[action] || [];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Insufficient permissions for ${action}`,
        required: allowedRoles,
        yourRole: req.user.role
      });
    }

    next();
  };
}

// ══════════════════════════════════════════════
// AUTHENTICATION ROUTES
// ══════════════════════════════════════════════

// Serve login page at root
app.get('/', (req, res) => {
  if (req.session && req.session.username) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

// Serve dashboard (protected)
app.get('/dashboard', (req, res) => {
  if (req.session && req.session.username) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/');
  }
});

// Login endpoint
// Login endpoint (replace the existing one)
app.post('/api/auth/login', (req, res) => {
  let { username, password } = req.body;

  // Normalize username: trim + lowercase
  username = (username || '').trim().toLowerCase();

  // Check if user exists (case-insensitive lookup)
  const userConfig = USER_ROLES[username] || 
                     Object.values(USER_ROLES).find(u => 
                       u.username?.toLowerCase() === username || 
                       Object.keys(USER_ROLES).some(key => key.toLowerCase() === username)
                     );

  if (!userConfig) {
    return res.status(401).json({
      error: 'Invalid credentials',
      message: 'Username not found'
    });
  }

  // Get the correct (original case) username key
  const actualUsername = Object.keys(USER_ROLES).find(key => 
    key.toLowerCase() === username
  ) || username;

  const expectedPassword = userConfig.password || 'password123';

  if (password !== expectedPassword) {
    return res.status(401).json({
      error: 'Invalid credentials',
      message: 'Incorrect password'
    });
  }

  // Set session with the ORIGINAL case username
  req.session.username = actualUsername;
  req.session.role = userConfig.role;

  res.json({
    success: true,
    user: {
      username: actualUsername,
      role: userConfig.role,
      teams: userConfig.teams
    }
  });
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// Get current user info
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    username: req.username,
    role: req.user.role,
    teams: req.user.teams
  });
});

// Get all users (admin only)
app.get('/api/auth/users', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const users = Object.keys(USER_ROLES).map(username => ({
    username,
    role: USER_ROLES[username].role,
    teams: USER_ROLES[username].teams
  }));
  
  res.json({ users });
});

// Switch user (for admins - useful for testing)
app.post('/api/auth/switch-user', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  const { username } = req.body;
  const targetUser = USER_ROLES[username];
  
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  req.session.username = username;
  req.session.role = targetUser.role;
  
  res.json({
    success: true,
    user: {
      username,
      role: targetUser.role,
      teams: targetUser.teams
    }
  });
});

// ══════════════════════════════════════════════
// WEBSOCKET - REAL-TIME UPDATES
// ══════════════════════════════════════════════
const activeConnections = new Map(); // Map of username -> WebSocket

wss.on('connection', (ws, req) => {
  console.log('WebSocket client connected');
  
  // Get session from cookie
  const cookies = req.headers.cookie?.split(';').reduce((acc, cookie) => {
    const [key, value] = cookie.trim().split('=');
    acc[key] = value;
    return acc;
  }, {});
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'auth' && data.username) {
        // Store username with WebSocket connection
        activeConnections.set(data.username, ws);
        console.log(`WebSocket authenticated for user: ${data.username}`);
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });
  
  ws.on('close', () => {
    // Remove from active connections
    for (const [username, socket] of activeConnections.entries()) {
      if (socket === ws) {
        activeConnections.delete(username);
        console.log(`WebSocket disconnected for user: ${username}`);
        break;
      }
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

function broadcastUpdate(type, data, targetUsername = null) {
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  
  if (targetUsername) {
    // Send to specific user
    const ws = activeConnections.get(targetUsername);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  } else {
    // Broadcast to all
    activeConnections.forEach((ws, username) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
}

// Real-time polling for active workflows
let realtimePolling = null;

function startRealtimePolling() {
  if (realtimePolling) return;
  
  realtimePolling = setInterval(async () => {
    try {
      const builds = await fetchBuildData();
      const releases = await fetchReleaseData();
      
      const activeBuilds = builds.filter(b => 
        b.status === 'in_progress' || 
        b.status === 'queued' ||
        new Date() - new Date(b.createdAt) < 300000
      );
      
      const activeReleases = releases.filter(r => 
        r.status === 'in_progress' || 
        r.status === 'queued' ||
        new Date() - new Date(r.createdAt) < 300000
      );
      
      if (activeBuilds.length > 0 || activeReleases.length > 0) {
        broadcastUpdate('workflow_update', { builds: activeBuilds, releases: activeReleases });
      }
    } catch (err) {
      console.error('Real-time polling error:', err);
      if (err.status === 403 && err.message.includes('rate limit')) {
        console.warn('GitHub rate limit hit → waiting longer before next poll');
        // Optional: pause polling for 5 min
        setTimeout(() => {}, 300000);
      }
    }
  }, REAL_TIME_POLL_INTERVAL);
}

startRealtimePolling();

// ══════════════════════════════════════════════
// UTILITY FUNCTIONS (from original code)
// ══════════════════════════════════════════════
function parseRunName(runName, isRelease = false) {
  if (!runName) return null;

  if (isRelease) {
    const match = runName.match(/^(.+?)-([^-]+)-release-([^-]+)-([a-f0-9]{7,})$/i);
    if (match) {
      let branch = match[1].trim();
      const appName = match[2].trim();
      const version = match[3].trim();
      const commit = match[4].trim().substring(0, 7);
      if (branch.toLowerCase() === 'prod') branch = 'main';
      return { appName, branch, version, commit };
    }
  } else {
    const match = runName.match(/^(.+?)-([^-]+)-build-(.+)$/i);
    if (match) {
      let branch = match[1].trim();
      const appName = match[2].trim();
      const version = match[3].trim();
      if (branch.toLowerCase() === 'prod') branch = 'main';
      return { appName, branch, version, commit: null };
    }
  }
  return null;
}

async function batchProcess(items, processor, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - cache.timestamp < CACHE_TTL_MS) {
        return cache.data;
      }
    }
  } catch (err) {
    console.warn('Cache read failed:', err.message);
  }
  return null;
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data }, null, 2));
  } catch (err) {
    console.warn('Cache save failed:', err.message);
  }
}

function formatDuration(createdAt, updatedAt) {
  if (!createdAt || !updatedAt) return 'N/A';
  const diff = new Date(updatedAt) - new Date(createdAt);
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

async function fetchWorkflowDetails(owner, repo, workflowId, configAppName, isRelease = false) {
  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner, repo, workflow_id: workflowId, per_page: MAX_RUNS_PER_WORKFLOW, page: 1
    });

    if (!runs.workflow_runs?.length) return [];

    const jobPromises = runs.workflow_runs.map(run => async () => {
      try {
        const { data: jobsData } = await octokit.actions.listJobsForWorkflowRun({
          owner, repo, run_id: run.id, per_page: 100
        });

        const jobs = jobsData.jobs.map(job => ({
          id: job.id,
          name: job.name,
          conclusion: job.conclusion || job.status,
          status: job.status,
          startedAt: job.started_at,
          completedAt: job.completed_at,
          duration: formatDuration(job.started_at, job.completed_at),
          htmlUrl: job.html_url,
          steps: job.steps?.map(step => ({
            name: step.name,
            status: step.status,
            conclusion: step.conclusion,
            number: step.number
          })) || []
        }));

        const parsed = parseRunName(run.name, isRelease);
        const appName = parsed?.appName || configAppName;
        const branch = parsed?.branch || run.head_branch || 'N/A';
        const version = parsed?.version || `build-${run.run_number}`;
        const commit = parsed?.commit || run.head_sha?.substring(0, 7) || 'N/A';

        return {
          appName, repo, type: isRelease ? 'Release' : 'Build', version, branch,
          status: run.status || 'unknown',
          conclusion: run.conclusion || run.status,
          createdAt: run.created_at || new Date().toISOString(),
          updatedAt: run.updated_at || run.created_at,
          duration: formatDuration(run.created_at, run.updated_at),
          triggeredBy: run.triggering_actor?.login || run.actor?.login || 'System',
          event: run.event || 'unknown',
          link: run.html_url,
          commitSha: commit,
          commitMessage: run.display_title || run.head_commit?.message || 'N/A',
          jobs, runNumber: run.run_number || 0, attempt: run.run_attempt || 1,
          runId: run.id,
          runName: run.name || 'N/A'
        };
      } catch (jobErr) {
        console.warn(`Jobs fetch failed for run ${run.id}:`, jobErr.message);
        return null;
      }
    });

    const results = await batchProcess(jobPromises, fn => fn(), CONCURRENT_JOBS);
    return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  } catch (error) {
    console.error(`Workflow fetch error for workflow ${workflowId}:`, error.message);
    return [];
  }
}

async function fetchBuildData() {
  const tasks = config.appRepos.map(app =>
    () => fetchWorkflowDetails(config.owner, app.repo, app.buildWorkflow, app.name, false)
  );
  const results = await batchProcess(tasks, t => t(), CONCURRENT_WORKFLOWS);
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function fetchReleaseData() {
  if (!config.releaseRepos?.length) return [];
  const tasks = config.releaseRepos.map(entry =>
    () => fetchWorkflowDetails(config.owner, entry.repo, entry.releaseWorkflow, entry.appName, true)
  );
  const results = await batchProcess(tasks, t => t(), CONCURRENT_WORKFLOWS);
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ══════════════════════════════════════════════
// DASHBOARD API ENDPOINTS (Protected)
// ══════════════════════════════════════════════

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const { team, branch } = req.query;
    let builds = await fetchBuildData();
    let releases = await fetchReleaseData();
    
    if (team && TEAMS_CONFIG[team]) {
      const teamApps = TEAMS_CONFIG[team].apps;
      builds = builds.filter(b => teamApps.includes(b.appName));
      releases = releases.filter(r => teamApps.includes(r.appName));
    }
    
    if (branch) {
      builds = builds.filter(b => b.branch === branch);
      releases = releases.filter(r => r.branch === branch);
    }
    
    const all = [...builds, ...releases];
    const metrics = {
      totalRuns: all.length,
      successRate: all.length ? (all.filter(i => i.conclusion === 'success').length / all.length * 100).toFixed(1) : 0,
      activeRuns: all.filter(i => i.status === 'in_progress' || i.status === 'queued').length,
      failedRuns: all.filter(i => i.conclusion === 'failure').length
    };
    
    res.json({ builds, releases, metrics, teams: TEAMS_CONFIG, userPermissions: req.user });
  } catch (err) {
    console.error('Dashboard data error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

app.post('/api/trigger/workflow', requireAuth, checkPermission('trigger_build'), async (req, res) => {
  try {
    const { repo, workflowId, ref, inputs } = req.body;
    
    await octokit.actions.createWorkflowDispatch({
      owner: config.owner,
      repo,
      workflow_id: workflowId,
      ref,
      inputs: inputs || {}
    });
    
    broadcastUpdate('workflow_triggered', { repo, workflowId, ref, user: req.username });
    res.json({ success: true, message: 'Workflow triggered successfully' });
  } catch (err) {
    console.error('Trigger workflow error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trigger/bulk-builds', requireAuth, checkPermission('trigger_build'), async (req, res) => {
  try {
    const { apps, branch, team } = req.body;
    const teamConfig = TEAMS_CONFIG[team];
    
    if (!teamConfig) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const results = [];
    for (const appName of apps) {
      const appConfig = config.appRepos.find(a => a.name === appName);
      if (!appConfig || !teamConfig.apps.includes(appName)) {
        results.push({ app: appName, success: false, error: 'App not found or not in team' });
        continue;
      }
      
      try {
        await octokit.actions.createWorkflowDispatch({
          owner: config.owner,
          repo: appConfig.repo,
          workflow_id: appConfig.buildWorkflow,
          ref: branch
        });
        results.push({ app: appName, success: true });
      } catch (err) {
        results.push({ app: appName, success: false, error: err.message });
      }
    }
    
    broadcastUpdate('bulk_builds_triggered', { apps, branch, team, user: req.username });
    res.json({ results });
  } catch (err) {
    console.error('Bulk build trigger error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trigger/bulk-releases', requireAuth, checkPermission('trigger_release'), async (req, res) => {
  try {
    const { apps, branch, team, version } = req.body;
    const teamConfig = TEAMS_CONFIG[team];
    
    if (!teamConfig) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const results = [];
    for (const appName of apps) {
      const releaseConfig = config.releaseRepos?.find(r => r.appName === appName);
      if (!releaseConfig || !teamConfig.apps.includes(appName)) {
        results.push({ app: appName, success: false, error: 'Release config not found or not in team' });
        continue;
      }
      
      try {
        await octokit.actions.createWorkflowDispatch({
          owner: config.owner,
          repo: releaseConfig.repo,
          workflow_id: releaseConfig.releaseWorkflow,
          ref: branch,
          inputs: { version: version || 'latest' }
        });
        results.push({ app: appName, success: true });
      } catch (err) {
        results.push({ app: appName, success: false, error: err.message });
      }
    }
    
    broadcastUpdate('bulk_releases_triggered', { apps, branch, team, user: req.username });
    res.json({ results });
  } catch (err) {
    console.error('Bulk release trigger error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cancel/workflow', requireAuth, async (req, res) => {
  try {
    const { repo, runId } = req.body;
    
    await octokit.actions.cancelWorkflowRun({
      owner: config.owner,
      repo,
      run_id: runId
    });
    
    broadcastUpdate('workflow_cancelled', { repo, runId, user: req.username });
    res.json({ success: true, message: 'Workflow cancelled successfully' });
  } catch (err) {
    console.error('Cancel workflow error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs/:repo/:runId', requireAuth, checkPermission('view_logs'), async (req, res) => {
  try {
    const { repo, runId } = req.params;
    
    const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
      owner: config.owner,
      repo,
      run_id: runId
    });
    
    const logsPromises = jobs.jobs.map(async job => {
      try {
        const { data: logs } = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner: config.owner,
          repo,
          job_id: job.id
        });
        return { jobId: job.id, jobName: job.name, logs };
      } catch (err) {
        return { jobId: job.id, jobName: job.name, error: err.message };
      }
    });
    
    const allLogs = await Promise.all(logsPromises);
    res.json({ jobs: allLogs });
  } catch (err) {
    console.error('Get logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule/workflow', requireAuth, checkPermission('trigger_release'), async (req, res) => {
  try {
    const { repo, workflowId, ref, scheduledTime, inputs } = req.body;
    const scheduleDate = new Date(scheduledTime);
    
    if (scheduleDate <= new Date()) {
      return res.status(400).json({ error: 'Scheduled time must be in the future' });
    }
    
    const jobId = `${repo}-${workflowId}-${Date.now()}`;
    const delay = scheduleDate - new Date();
    
    const timeoutId = setTimeout(async () => {
      try {
        await octokit.actions.createWorkflowDispatch({
          owner: config.owner, repo, workflow_id: workflowId, ref, inputs: inputs || {}
        });
        broadcastUpdate('scheduled_workflow_triggered', { repo, workflowId, ref });
        scheduledJobs.delete(jobId);
      } catch (err) {
        console.error('Scheduled workflow error:', err);
        broadcastUpdate('scheduled_workflow_failed', { repo, workflowId, error: err.message });
      }
    }, delay);
    
    scheduledJobs.set(jobId, { timeoutId, repo, workflowId, ref, scheduledTime, user: req.username });
    res.json({ success: true, jobId, scheduledTime });
  } catch (err) {
    console.error('Schedule workflow error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule/cancel/:jobId', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = scheduledJobs.get(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Scheduled job not found' });
    }
    
    clearTimeout(job.timeoutId);
    scheduledJobs.delete(jobId);
    
    res.json({ success: true, message: 'Scheduled workflow cancelled' });
  } catch (err) {
    console.error('Cancel scheduled workflow error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/schedule/list', requireAuth, async (req, res) => {
  try {
    const jobs = Array.from(scheduledJobs.entries()).map(([id, job]) => ({
      id, ...job, timeoutId: undefined
    }));
    res.json({ scheduledJobs: jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/services/restart', requireAuth, checkPermission('restart_services'), async (req, res) => {
  try {
    const { service, environment } = req.body;
    
    broadcastUpdate('service_restart_initiated', { service, environment, user: req.username });
    res.json({ success: true, message: `Service restart initiated for ${service} in ${environment}` });
  } catch (err) {
    console.error('Service restart error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tests/:repo/:runId', requireAuth, async (req, res) => {
  try {
    const { repo, runId } = req.params;
    
    res.json({ 
      testResults: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        suites: []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Enhanced CI/CD Dashboard running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server active for real-time updates`);

console.log('Raw config object:', config);
console.log('userRoles exists?', !!config?.userRoles);

// Output: All usernames: ["john.doe", "jane.smith", "dev1", "dev2", ...]
  Object.keys(USER_ROLES).forEach(username => {
    console.log(`   - ${username} (${USER_ROLES[username].role})`);
  });
  console.log(`\n🔐 Default password: password123 (configure in config.js)`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});


