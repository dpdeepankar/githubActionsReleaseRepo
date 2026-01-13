require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const octokit = new Octokit({ auth: config.token });

// Configuration
const MAX_RUNS_PER_WORKFLOW = 15;
const CACHE_FILE = path.join(__dirname, '.workflow-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache
const CONCURRENT_REQUESTS = 50;

// ──────────────────────────────────────────────
// UTILITY: Batch processing with concurrency limit
async function batchProcess(items, processor, concurrency = CONCURRENT_REQUESTS) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

// ──────────────────────────────────────────────
// UTILITY: Cache management
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - cache.timestamp < CACHE_TTL_MS) {
        console.log('✓ Using cached data (fresh)');
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
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      data
    }, null, 2));
    console.log('✓ Cache updated');
  } catch (err) {
    console.warn('Cache save failed:', err.message);
  }
}

// ──────────────────────────────────────────────
// (keeping your existing extractVersion, extractArtifactVersion, extractSourceCommit, formatDuration)

function extractVersion(run, app) {
  const commitMsg = run.display_title || run.head_commit?.message || '';
  const versionMatch = commitMsg.match(/v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i);
  if (versionMatch) return versionMatch[1];

  const runName = run.name || '';
  const runVersionMatch = runName.match(/v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i);
  if (runVersionMatch) return runVersionMatch[1];

  return `build-${run.run_number || 'unknown'}`;
}

function extractArtifactVersion(run) {
  const commitMsg = run.display_title || run.head_commit?.message || '';
  const artifactMatch = commitMsg.match(/(?:artifact|image|docker):\s*([^\s,]+)/i);
  if (artifactMatch) return artifactMatch[1];

  const tagMatch = commitMsg.match(/tag[:\s]+([^\s,]+)/i);
  if (tagMatch) return tagMatch[1];

  return extractVersion(run, null);
}

async function extractSourceCommit(owner, repo, run) {
  const commitMsg = run.display_title || run.head_commit?.message || '';
  const sourceCommitMatch = commitMsg.match(/(?:source|from|commit)[:\s]+([a-f0-9]{7,40})/i);
  if (sourceCommitMatch) return sourceCommitMatch[1].substring(0, 7);

  return run.head_sha?.substring(0, 7) || 'N/A';
}

function formatDuration(createdAt, updatedAt) {
  if (!createdAt || !updatedAt) return 'N/A';
  const diff = new Date(updatedAt) - new Date(createdAt);
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ──────────────────────────────────────────────
// Fetch single workflow run details
async function fetchWorkflowDetails(owner, repo, workflowId, appName, isRelease = false) {
  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowId,
      per_page: MAX_RUNS_PER_WORKFLOW,
      page: 1,
    });

    const results = [];

    const jobPromises = runs.workflow_runs.map(async (run) => {
      try {
        const { data: jobsData } = await octokit.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: run.id,
          per_page: 50,
        });

        const jobs = jobsData.jobs.map(job => ({
          name: job.name,
          conclusion: job.conclusion || job.status,
          status: job.status,
          startedAt: job.started_at,
          completedAt: job.completed_at,
          duration: formatDuration(job.started_at, job.completed_at),
          steps: job.steps?.map(step => ({
            name: step.name,
            status: step.status,
            conclusion: step.conclusion,
            number: step.number
          })) || []
        }));

        const sourceCommit = isRelease ? await extractSourceCommit(owner, repo, run) : run.head_sha?.substring(0, 7) || 'N/A';
        const artifactVersion = isRelease ? extractArtifactVersion(run) : extractVersion(run, appName);

        return {
          appName,
          type: isRelease ? 'Release' : 'Build',
          version: artifactVersion,
          branch: run.head_branch || 'N/A',
          status: run.status || 'unknown',
          conclusion: run.conclusion || run.status,
          createdAt: run.created_at || new Date().toISOString(),
          updatedAt: run.updated_at || run.created_at,
          duration: formatDuration(run.created_at, run.updated_at),
          triggeredBy: run.triggering_actor?.login || run.actor?.login || 'System',
          event: run.event || 'unknown',
          link: run.html_url,
          commitSha: sourceCommit,
          commitMessage: run.display_title || run.head_commit?.message || 'N/A',
          jobs,
          runNumber: run.run_number || 0,
          attempt: run.run_attempt || 1
        };
      } catch (jobErr) {
        console.warn(`Jobs fetch failed for run ${run.id}:`, jobErr.message);
        return {
          appName,
          type: isRelease ? 'Release' : 'Build',
          version: isRelease ? extractArtifactVersion(run) : extractVersion(run, appName),
          branch: run.head_branch || 'N/A',
          status: 'error',
          conclusion: 'error',
          createdAt: run.created_at || new Date().toISOString(),
          updatedAt: run.updated_at || run.created_at,
          duration: 'N/A',
          triggeredBy: run.triggering_actor?.login || 'Unknown',
          event: run.event || 'unknown',
          link: run.html_url,
          commitSha: isRelease ? await extractSourceCommit(owner, repo, run) : run.head_sha?.substring(0, 7) || 'N/A',
          commitMessage: run.display_title || 'N/A',
          jobs: [],
          runNumber: run.run_number || 0,
          attempt: run.run_attempt || 1
        };
      }
    });

    results.push(...await Promise.all(jobPromises));
    return results;
  } catch (error) {
    console.error(`Workflow fetch error for ${appName}:`, error.message);
    return [{
      appName,
      type: isRelease ? 'Release' : 'Build',
      version: 'unknown',
      branch: 'N/A',
      status: 'error',
      conclusion: 'error',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      duration: 'N/A',
      triggeredBy: 'Unknown',
      event: 'error',
      link: `https://github.com/${owner}/${repo}/actions`,
      commitSha: 'N/A',
      commitMessage: 'Error fetching data',
      jobs: [],
      runNumber: 0,
      attempt: 1
    }];
  }
}

// ──────────────────────────────────────────────
// Fetch functions (unchanged except naming clarity)
async function fetchBuildData() {
  console.log('⏳ Fetching builds...');
  const start = Date.now();
  const tasks = config.appRepos.map(app =>
    () => fetchWorkflowDetails(config.owner, app.repo, app.buildWorkflow, app.name, false)
  );
  const results = await batchProcess(tasks, t => t());
  const builds = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  console.log(`✓ ${builds.length} builds in ${Date.now() - start}ms`);
  return builds;
}

async function fetchReleaseData() {
  if (!config.releaseRepos?.length) return [];
  console.log('⏳ Fetching releases...');
  const start = Date.now();
  const tasks = config.releaseRepos.map(entry =>
    () => fetchWorkflowDetails(config.owner, entry.repo, entry.releaseWorkflow, entry.appName, true)
  );
  const results = await batchProcess(tasks, t => t());
  const releases = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  console.log(`✓ ${releases.length} releases in ${Date.now() - start}ms`);
  return releases;
}

// ──────────────────────────────────────────────
// Render step statuses (small pills)
function renderStepStatuses(steps) {
  if (!steps?.length) return '<div style="color:#9ca3af; font-size:0.8rem; padding:4px;">No steps available</div>';

  return steps.map(step => {
    let color = '#6b7280', symbol = '○', bg = '#f3f4f6';
    if (step.status === 'in_progress') {
      color = '#eab308'; symbol = '⟳'; bg = '#fef3c7';
    } else if (step.conclusion === 'success') {
      color = '#22c55e'; symbol = '✓'; bg = '#dcfce7';
    } else if (step.conclusion === 'failure') {
      color = '#ef4444'; symbol = '✗'; bg = '#fee2e2';
    } else if (step.conclusion === 'skipped') {
      color = '#9ca3af'; symbol = '⊘'; bg = '#f3f4f6';
    }
    return `
      <div style="display:flex; align-items:center; padding:4px 8px; margin:3px 0; background:${bg}; border-radius:6px; font-size:0.8rem; border:1px solid #e5e7eb;">
        <span style="color:${color}; font-weight:bold; margin-right:6px;">${symbol}</span>
        <span>${step.number}. ${step.name}</span>
      </div>
    `;
  }).join('');
}

// ──────────────────────────────────────────────
// Horizontal job badges + click to show steps popup
function renderJobStatuses(jobs) {
  if (!jobs?.length) return '<div style="color:#9ca3af; padding:8px;">No jobs</div>';

  return `
    <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:4px;">
      ${jobs.map((job, idx) => {
        let color = '#6b7280', symbol = '○', bg = '#f3f4f6';
        if (job.status === 'in_progress' || job.status === 'queued') {
          color = '#eab308'; symbol = '⟳'; bg = '#fef3c7';
        } else if (job.conclusion === 'success') {
          color = '#22c55e'; symbol = '✓'; bg = '#dcfce7';
        } else if (job.conclusion === 'failure' || job.conclusion === 'cancelled') {
          color = '#ef4444'; symbol = '✗'; bg = '#fee2e2';
        }

        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const stepCount = job.steps?.length || 0;

        return `
          <div style="position:relative;">
            <div onclick="toggleSteps('${jobId}')"
                 title="${job.name} • ${job.duration || 'N/A'} • ${stepCount} steps"
                 style="cursor:pointer; padding:5px 10px; background:${bg}; border-radius:6px; border:1px solid #d1d5db; display:flex; align-items:center; gap:6px; font-size:0.82rem; white-space:nowrap;">
              <span style="color:${color}; font-weight:bold;">${symbol}</span>
              <span style="font-weight:500;">${job.name}</span>
              ${stepCount ? `<small style="color:#6b7280;">(${stepCount})</small>` : ''}
            </div>
            <div id="${jobId}" style="display:none; position:absolute; z-index:20; background:white; border:1px solid #cbd5e1; border-radius:8px; box-shadow:0 10px 25px -5px rgba(0,0,0,0.25); min-width:340px; max-width:520px; margin-top:8px; padding:12px; max-height:380px; overflow-y:auto;">
              <div style="font-weight:600; margin-bottom:8px; color:#1f2937; font-size:0.95rem;">${job.name}</div>
              <div style="font-size:0.82rem; color:#4b5563; margin-bottom:10px;">
                ${job.duration || 'N/A'} • ${job.status}${job.conclusion ? ` → ${job.conclusion}` : ''}
              </div>
              ${renderStepStatuses(job.steps)}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ──────────────────────────────────────────────
// (keeping generateMetrics mostly unchanged)

function generateMetrics(builds, releases) {
  const all = [...builds, ...releases];
  const last24h = all.filter(i => new Date(i.createdAt) > new Date(Date.now() - 86400000));
  const successRate = all.length ? (all.filter(i => i.conclusion === 'success').length / all.length * 100).toFixed(1) : 0;
  const avgMin = all.reduce((sum, i) => {
    const m = i.duration?.match(/^(\d+)m/);
    return sum + (m ? +m[1] : 0);
  }, 0) / (all.length || 1);

  return {
    totalRuns: all.length,
    last24h: last24h.length,
    successRate,
    avgDuration: avgMin.toFixed(1),
    failedBuilds: builds.filter(b => b.conclusion === 'failure').length,
    failedReleases: releases.filter(r => r.conclusion === 'failure').length
  };
}

// ──────────────────────────────────────────────
// Updated HTML generation
function generateHTML(builds, releases) {
  const metrics = generateMetrics(builds, releases);

  const allApps = [...new Set([...builds, ...releases].map(i => i.appName))].sort();
  const allBranches = [...new Set([...builds, ...releases].map(i => i.branch).filter(b => b && b !== 'N/A'))].sort();

  const metricsHTML = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1rem; margin:2rem 0;">
      <div style="background:white; padding:1.5rem; border-radius:8px; box-shadow:0 2px 4px rgba(0,0,0,0.1);">
        <div style="font-size:2.2rem; font-weight:bold; color:#3b82f6;">${metrics.totalRuns}</div>
        <div style="color:#6b7280;">Total Runs</div>
      </div>
      <div style="background:white; padding:1.5rem; border-radius:8px; box-shadow:0 2px 4px rgba(0,0,0,0.1);">
        <div style="font-size:2.2rem; font-weight:bold; color:#22c55e;">${metrics.successRate}%</div>
        <div style="color:#6b7280;">Success Rate</div>
      </div>
      <div style="background:white; padding:1.5rem; border-radius:8px; box-shadow:0 2px 4px rgba(0,0,0,0.1);">
        <div style="font-size:2.2rem; font-weight:bold; color:#eab308;">${metrics.avgDuration}m</div>
        <div style="color:#6b7280;">Avg Duration</div>
      </div>
      <div style="background:white; padding:1.5rem; border-radius:8px; box-shadow:0 2px 4px rgba(0,0,0,0.1);">
        <div style="font-size:2.2rem; font-weight:bold; color:#ef4444;">${metrics.failedBuilds + metrics.failedReleases}</div>
        <div style="color:#6b7280;">Failed (shown runs)</div>
      </div>
    </div>
  `;

  const buildRows = builds.map(b => `
    <tr data-app="${b.appName}" data-branch="${b.branch}" data-status="${b.conclusion || b.status}">
      <td><strong>${b.appName}</strong></td>
      <td><code style="background:#f3f4f6;padding:2px 5px;border-radius:4px;">${b.version}</code></td>
      <td>${b.branch}</td>
      <td><span class="status-badge" data-status="${b.conclusion || b.status}">${b.status}</span></td>
      <td>${b.duration}</td>
      <td title="${b.commitMessage?.replace(/"/g,'&quot;')}"><code>${b.commitSha}</code></td>
      <td>${b.triggeredBy}</td>
      <td>${new Date(b.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td><a href="${b.link}" target="_blank" style="color:#3b82f6;">#${b.runNumber}</a></td>
      <td style="min-width:280px; max-width:500px;">${renderJobStatuses(b.jobs)}</td>
    </tr>
  `).join('');

  const releaseRows = releases.map(r => `
    <tr data-app="${r.appName}" data-branch="${r.branch}" data-status="${r.conclusion || r.status}">
      <td><strong>${r.appName}</strong></td>
      <td><code style="background:#f3f4f6;padding:2px 5px;border-radius:4px;">${r.version}</code></td>
      <td>${r.branch}</td>
      <td><span class="status-badge" data-status="${r.conclusion || r.status}">${r.status}</span></td>
      <td>${r.duration}</td>
      <td title="${r.commitMessage?.replace(/"/g,'&quot;')}"><code>${r.commitSha}</code></td>
      <td>${r.triggeredBy}</td>
      <td>${new Date(r.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td><a href="${r.link}" target="_blank" style="color:#3b82f6;">#${r.runNumber}</a></td>
      <td style="min-width:280px; max-width:500px;">${renderJobStatuses(r.jobs)}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>CI/CD Dashboard</title>
  <style>
    :root {
      --bg: #f8f9fc;
      --text: #1f2937;
      --muted: #6b7280;
      --border: #e2e8f0;
      --accent: #3b82f6;
    }
    [data-theme="dark"] {
      --bg: #0f172a;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --border: #334155;
      --accent: #60a5fa;
    }
    * { box-sizing:border-box; }
    body {
      margin:0;
      font-family:system-ui, sans-serif;
      background:var(--bg);
      color:var(--text);
      padding:1.5rem 2.5rem;
      line-height:1.5;
    }
    h1 { text-align:center; margin-bottom:0.4rem; }
    .subtitle { text-align:center; color:var(--muted); margin-bottom:1.8rem; }
    table {
      width:100%;
      border-collapse:collapse;
      background:white;
      border-radius:10px;
      overflow:hidden;
      box-shadow:0 2px 8px rgba(0,0,0,0.08);
      font-size:0.92rem;
    }
    [data-theme="dark"] table { background:#1e293b; }
    th, td {
      padding:0.8rem 1rem;
      border-bottom:1px solid var(--border);
      text-align:left;
    }
    th {
      background:#f1f5f9;
      font-weight:600;
      color:var(--muted);
      text-transform:uppercase;
      font-size:0.78rem;
      position:sticky;
      top:0;
      z-index:5;
    }
    [data-theme="dark"] th { background:#0f172a; }
    tbody tr:hover { background:#f9fafb; }
    [data-theme="dark"] tbody tr:hover { background:#253549; }
    .status-badge {
      padding:4px 10px;
      border-radius:999px;
      font-size:0.78rem;
      font-weight:600;
    }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .dark-toggle {
      position:fixed;
      bottom:24px;
      right:24px;
      background:#1e293b;
      color:white;
      border:none;
      width:52px;
      height:52px;
      border-radius:50%;
      font-size:1.5rem;
      cursor:pointer;
      box-shadow:0 4px 14px rgba(0,0,0,0.25);
      z-index:999;
    }
    code {
      background:var(--border);
      padding:2px 5px;
      border-radius:4px;
      font-size:0.86em;
    }
    .filter-bar {
      display:flex;
      flex-wrap:wrap;
      gap:0.8rem;
      margin:1.2rem 0;
      align-items:center;
    }
    .filter-bar select, .filter-bar button {
      padding:0.55rem 1rem;
      border:1px solid var(--border);
      border-radius:6px;
      background:white;
      color:var(--text);
      font-size:0.9rem;
    }
    [data-theme="dark"] .filter-bar select,
    [data-theme="dark"] .filter-bar button {
      background:#1e293b;
      color:#e2e8f0;
    }
    .view-toggle {
      padding:0.6rem 1.3rem;
      border:2px solid var(--border);
      border-radius:8px;
      background:white;
      font-weight:600;
      cursor:pointer;
      transition:0.18s;
    }
    .view-toggle:hover { border-color:var(--accent); }
    .view-toggle.active {
      background:var(--accent);
      color:white;
      border-color:var(--accent);
    }
    [data-theme="dark"] .view-toggle { background:#1e293b; }
  </style>
</head>
<body>
  <h1>CI/CD Pipeline Dashboard</h1>
  <div class="subtitle">Last updated: ${new Date().toLocaleString('en-GB')} | Auto-refresh: 5 min</div>

  ${metricsHTML}

  <div class="filter-bar">
    <select id="filterApp" onchange="filterTable()">
      <option value="">All Apps</option>
      ${allApps.map(a => `<option value="${a}">${a}</option>`).join('')}
    </select>

    <select id="filterBranch" onchange="filterTable()">
      <option value="">All Branches</option>
      ${allBranches.map(b => `<option value="${b}">${b}</option>`).join('')}
    </select>

    <select id="filterStatus" onchange="filterTable()">
      <option value="">All Statuses</option>
      <option value="success">✓ Success</option>
      <option value="failure">✗ Failed</option>
      <option value="in_progress">⟳ In Progress</option>
      <option value="queued">○ Queued</option>
      <option value="cancelled">Cancelled</option>
    </select>

    <button onclick="clearFilters()">Clear</button>

    <div style="margin-left:auto; display:flex; gap:0.6rem;">
      <button class="view-toggle active" onclick="showView('builds')" id="btnBuilds">
        Builds (${builds.length})
      </button>
      <button class="view-toggle" onclick="showView('releases')" id="btnReleases">
        Releases (${releases.length})
      </button>
    </div>
  </div>

  <div id="buildsView">
    <h2>Recent Build Runs</h2>
    <table id="buildsTable">
      <thead>
        <tr>
          <th>App</th><th>Version</th><th>Branch</th><th>Status</th><th>Duration</th>
          <th>Commit</th><th>Triggered By</th><th>Time</th><th>Run</th>
          <th style="min-width:280px;">Jobs & Steps</th>
        </tr>
      </thead>
      <tbody>
        ${buildRows || '<tr><td colspan="10" style="text-align:center;padding:3rem;color:var(--muted);">No build runs found</td></tr>'}
      </tbody>
    </table>
  </div>

  <div id="releasesView" style="display:none;">
    <h2>Recent Release Runs</h2>
    <table id="releasesTable">
      <thead>
        <tr>
          <th>App</th><th>Version</th><th>Branch</th><th>Status</th><th>Duration</th>
          <th>Commit</th><th>Triggered By</th><th>Time</th><th>Run</th>
          <th style="min-width:280px;">Jobs & Steps</th>
        </tr>
      </thead>
      <tbody>
        ${releaseRows || '<tr><td colspan="10" style="text-align:center;padding:3rem;color:var(--muted);">No release runs found</td></tr>'}
      </tbody>
    </table>
  </div>

  <button class="dark-toggle" onclick="toggleTheme()">🌙</button>

  <script>
    function toggleSteps(id) {
      const el = document.getElementById(id);
      el.style.display = el.style.display === 'block' ? 'none' : 'block';
    }

    function showView(view) {
      document.getElementById('buildsView').style.display = view === 'builds' ? 'block' : 'none';
      document.getElementById('releasesView').style.display = view === 'releases' ? 'block' : 'none';
      document.getElementById('btnBuilds').classList.toggle('active', view === 'builds');
      document.getElementById('btnReleases').classList.toggle('active', view === 'releases');
      localStorage.setItem('view', view);
      filterTable();
    }

    const savedView = localStorage.getItem('view') || 'builds';
    showView(savedView);

    document.querySelectorAll('.status-badge').forEach(b => {
      const s = b.dataset.status?.toLowerCase() || '';
      if (s.includes('success') || s === 'completed') {
        b.style.background = '#dcfce7'; b.style.color = '#166534';
      } else if (s.includes('failure') || s === 'cancelled') {
        b.style.background = '#fee2e2'; b.style.color = '#991b1b';
      } else if (s.includes('in_progress') || s === 'queued') {
        b.style.background = '#fef3c7'; b.style.color = '#92400e';
      } else {
        b.style.background = '#f3f4f6'; b.style.color = '#4b5563';
      }
    });

    function toggleTheme() {
      const t = document.documentElement.dataset.theme;
      document.documentElement.dataset.theme = t === 'dark' ? '' : 'dark';
      localStorage.setItem('theme', document.documentElement.dataset.theme);
    }

    if (localStorage.getItem('theme') === 'dark') {
      document.documentElement.dataset.theme = 'dark';
    }

    function filterTable() {
      const appF    = document.getElementById('filterApp').value.toLowerCase();
      const branchF = document.getElementById('filterBranch').value.toLowerCase();
      const statusF = document.getElementById('filterStatus').value.toLowerCase();

      const view = localStorage.getItem('view') || 'builds';
      const tbl = document.getElementById(view === 'builds' ? 'buildsTable' : 'releasesTable');
      if (!tbl) return;

      const rows = tbl.tBodies[0].rows;
      let count = 0;

      for (const row of rows) {
        const app    = row.dataset.app?.toLowerCase() || '';
        const branch = row.dataset.branch?.toLowerCase() || '';
        const status = row.dataset.status?.toLowerCase() || '';

        const matchA = !appF    || app.includes(appF);
        const matchB = !branchF || branch.includes(branchF);
        const matchS = !statusF || status === statusF;

        const visible = matchA && matchB && matchS;
        row.style.display = visible ? '' : 'none';
        if (visible) count++;
      }

      const btn = document.getElementById(view === 'builds' ? 'btnBuilds' : 'btnReleases');
      const label = view === 'builds' ? 'Builds' : 'Releases';
      btn.innerHTML = \`\${label} (\${count})\`;
    }

    function clearFilters() {
      document.getElementById('filterApp').value = '';
      document.getElementById('filterBranch').value = '';
      document.getElementById('filterStatus').value = '';
      filterTable();
    }

    // Initial filter
    filterTable();
  </script>
</body>
</html>
  `;
}

// ──────────────────────────────────────────────
// Main
async function main() {
  console.log('Starting dashboard generation...');
  const start = Date.now();

  let builds, releases;
  const cached = loadCache();
  if (cached && process.argv.includes('--use-cache')) {
    console.log('Using cache');
    ({ builds, releases } = cached);
  } else {
    builds = await fetchBuildData();
    releases = await fetchReleaseData();
    saveCache({ builds, releases });
  }

  const html = generateHTML(builds, releases);
  fs.writeFileSync('index.html', html);

  console.log(`Done in ${(Date.now() - start)/1000}s | Builds: ${builds.length} | Releases: ${releases.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
