require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const config = require('./config');

const octokit = new Octokit({ auth: config.token });

async function fetchBuildData() {
  const builds = [];
  for (const app of config.appRepos) {
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const { data: runs } = await octokit.actions.listWorkflowRuns({
          owner: config.owner,
          repo: app.repo,
          workflow_id: app.buildWorkflow,
          per_page: 100,
          page,
        });

        for (const run of runs.workflow_runs) {
          builds.push({
            appName: app.name,
            branch: run.head_branch || 'N/A',
            status: run.status || 'unknown',
            conclusion: run.conclusion || '',
            createdAt: run.created_at || new Date().toISOString(),
            link: run.html_url,
          });
        }

        hasMore = runs.workflow_runs.length === 100;
        page++;
        if (page > 10) break;
      }
    } catch (error) {
      console.error(`Build fetch error ${app.repo}:`, error.message);
      builds.push({
        appName: app.name,
        branch: 'N/A',
        status: 'error',
        conclusion: '',
        createdAt: new Date().toISOString(),
        link: `https://github.com/${config.owner}/${app.repo}/actions`,
      });
    }
  }

  // Default sort: newest first
  builds.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return builds;
}

async function fetchReleaseData() {
  const releases = [];
  try {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const { data: runs } = await octokit.actions.listWorkflowRuns({
        owner: config.owner,
        repo: config.repoB,
        workflow_id: config.releaseWorkflowName,
        per_page: 100,
        page,
      });

      for (const run of runs.workflow_runs) {
        const match = run.name.match(/^(.+?)\s*-\s*(.+?)\s*-\s*release$/i);
        if (match) {
          const [, branch, appName] = match;
          releases.push({
            appName: appName.trim(),
            branch: branch.trim(),
            status: run.status || 'unknown',
            conclusion: run.conclusion || '',
            createdAt: run.created_at || new Date().toISOString(),
            link: run.html_url,
          });
        }
      }

      hasMore = runs.workflow_runs.length === 100;
      page++;
      if (page > 10) break;
    }
  } catch (error) {
    console.error('Release fetch error:', error.message);
  }

  releases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return releases;
}

function generateHTML(builds, releases) {
  // Unique values for datalist
  const getUnique = (arr, key) => ['', ...new Set(arr.map(item => item[key])).values()].sort();

  const buildApps     = getUnique(builds,    'appName');
  const buildBranches  = getUnique(builds,    'branch');
  const buildStatuses  = getUnique(builds,    'status');

  const relApps       = getUnique(releases, 'appName');
  const relBranches   = getUnique(releases, 'branch');
  const relStatuses   = getUnique(releases, 'status');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>CI/CD Dashboard</title>
  <style>
    :root {
      --bg: #f8f9fc;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --border: #e2e8f0;
      --accent: #3b82f6;
      --accent-dark: #2563eb;
      --sort-active: #1e40af;
    }
    [data-theme="dark"] {
      --bg: #111827;
      --card: #1f2937;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --border: #374151;
      --accent: #60a5fa;
      --accent-dark: #3b82f6;
      --sort-active: #93c5fd;
    }
    body {
      margin:0;
      font-family: system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .container { max-width: 1440px; margin: 0 auto; padding: 2rem 1rem; }
    header { text-align:center; margin-bottom: 2.5rem; }
    h1 { font-size: 2.25rem; font-weight: 700; margin-bottom: 0.5rem; }
    .subtitle { color: var(--muted); }

    .tabs { display:flex; justify-content:center; gap:1rem; margin-bottom:2rem; }
    .tab-btn {
      padding: 0.75rem 2rem;
      font-weight: 500;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      background: var(--accent);
      color: white;
    }
    .tab-btn:hover { background: var(--accent-dark); }
    .tab-btn.active { background: var(--accent-dark); }

    .tab-content { display:none; background:var(--card); border-radius:0.75rem; border:1px solid var(--border); overflow:hidden; }
    .tab-content.active { display:block; }

    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 1.25rem;
      padding: 1rem 1.5rem;
      background: rgba(243,244,246,0.4);
      border-bottom: 1px solid var(--border);
    }
    [data-theme="dark"] .filters { background: rgba(55,65,81,0.4); }

    .filter-group { flex: 1 1 220px; min-width: 180px; }
    .filter-group label { font-size:0.875rem; color:var(--muted); display:block; margin-bottom:0.35rem; }
    .filter-input {
      width:100%;
      padding:0.5rem 0.75rem;
      border:1px solid var(--border);
      border-radius:0.375rem;
      font-size:1rem;
      background:var(--card);
      color:var(--text);
    }

    .clear-btn {
      padding:0.5rem 1.25rem;
      background:#ef4444;
      color:white;
      border:none;
      border-radius:0.375rem;
      cursor:pointer;
      font-size:0.875rem;
      align-self:flex-end;
    }

    .table-container { padding:0 1.5rem 1.5rem; overflow-x:auto; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:1rem; text-align:left; border-bottom:1px solid var(--border); }
    th {
      background:var(--header-bg || #f9fafb);
      font-weight:600;
      color:var(--muted);
      text-transform:uppercase;
      font-size:0.875rem;
      cursor: pointer;
      user-select: none;
    }
    th:hover { background: rgba(59,130,246,0.1); }
    th.sorted-asc::after { content: " ↑"; color: var(--sort-active); }
    th.sorted-desc::after { content: " ↓"; color: var(--sort-active); }

    .status {
      display:inline-block;
      padding:0.25rem 0.75rem;
      border-radius:9999px;
      font-size:0.75rem;
      font-weight:600;
      text-transform:uppercase;
    }
    .status-queued    { background:#fef3c7; color:#92400e; }
    .status-in_progress { background:#dbeafe; color:#1e40af; }
    .status-completed { background:#dcfce7; color:#166534; }
    .status-failure   { background:#fee2e2; color:#991b1b; }
    .status-cancelled { background:#f3f4f6; color:#4b5563; }
    .status-unknown   { background:#e5e7eb; color:#4b5563; }

    .pagination {
      display:flex;
      justify-content:center;
      gap:0.5rem;
      padding:1.5rem;
      flex-wrap:wrap;
    }
    .page-btn {
      padding:0.5rem 0.9rem;
      min-width:40px;
      border:1px solid var(--border);
      background:var(--card);
      color:var(--text);
      border-radius:0.375rem;
      cursor:pointer;
    }
    .page-btn:hover:not(:disabled) { background:var(--accent); color:white; }
    .page-btn.active { background:var(--accent); color:white; font-weight:600; }
    .page-btn:disabled { opacity:0.5; cursor:not-allowed; }

    .no-results { padding:4rem 1rem; text-align:center; color:var(--muted); font-style:italic; }

    .dark-toggle {
      position:fixed;
      bottom:1.5rem;
      right:1.5rem;
      background:#374151;
      color:white;
      border:none;
      width:48px; height:48px;
      border-radius:50%;
      font-size:1.25rem;
      cursor:pointer;
    }
  </style>
</head>
<body>

<div class="container">
  <header>
    <h1>Workflow Dashboard</h1>
    <div class="subtitle">Build & Release overview</div>
  </header>

  <div class="tabs">
    <button class="tab-btn active" data-tab="build">Build Workflows</button>
    <button class="tab-btn" data-tab="release">Release Pipelines</button>
  </div>

  <!-- Build Tab -->
  <div id="build" class="tab-content active">
    <div class="filters">
      <div class="filter-group">
        <label for="build-app">Application</label>
        <input list="build-apps" id="build-app" class="filter-input" placeholder="Type or select..." autocomplete="off">
        <datalist id="build-apps"><option value="">All</option>${buildApps.map(v => `<option value="${v}">${v}</option>`).join('')}</datalist>
      </div>
      <div class="filter-group">
        <label for="build-branch">Branch</label>
        <input list="build-branches" id="build-branch" class="filter-input" placeholder="Type or select..." autocomplete="off">
        <datalist id="build-branches"><option value="">All</option>${buildBranches.map(v => `<option value="${v}">${v}</option>`).join('')}</datalist>
      </div>
      <div class="filter-group">
        <label for="build-status">Status</label>
        <input list="build-statuses" id="build-status" class="filter-input" placeholder="Type or select..." autocomplete="off">
        <datalist id="build-statuses"><option value="">All</option>${buildStatuses.map(v => `<option value="${v}">${v}</option>`).join('')}</datalist>
      </div>
      <button class="clear-btn" onclick="clearFilters('build')">Clear</button>
    </div>

    <div id="build-table-container"></div>
    <div id="build-pagination" class="pagination"></div>
  </div>

  <!-- Release Tab -->
  <div id="release" class="tab-content">
    <div class="filters">
      <div class="filter-group">
        <label for="release-app">Application</label>
        <input list="release-apps" id="release-app" class="filter-input" placeholder="Type or select..." autocomplete="off">
        <datalist id="release-apps"><option value="">All</option>${relApps.map(v => `<option value="${v}">${v}</option>`).join('')}</datalist>
      </div>
      <div class="filter-group">
        <label for="release-branch">Branch</label>
        <input list="release-branches" id="release-branch" class="filter-input" placeholder="Type or select..." autocomplete="off">
        <datalist id="release-branches"><option value="">All</option>${relBranches.map(v => `<option value="${v}">${v}</option>`).join('')}</datalist>
      </div>
      <div class="filter-group">
        <label for="release-status">Status</label>
        <input list="release-statuses" id="release-status" class="filter-input" placeholder="Type or select..." autocomplete="off">
        <datalist id="release-statuses"><option value="">All</option>${relStatuses.map(v => `<option value="${v}">${v}</option>`).join('')}</datalist>
      </div>
      <button class="clear-btn" onclick="clearFilters('release')">Clear</button>
    </div>

    <div id="release-table-container"></div>
    <div id="release-pagination" class="pagination"></div>
  </div>
</div>

<button class="dark-toggle" onclick="document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? '' : 'dark'">🌙</button>

<script>
const ITEMS_PER_PAGE = 15;

const state = {
  build:   { data: ${JSON.stringify(builds)},   filtered: [], page: 1, sortBy: 'createdAt', sortDir: 'desc' },
  release: { data: ${JSON.stringify(releases)}, filtered: [], page: 1, sortBy: 'createdAt', sortDir: 'desc' }
};

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).replace(',', '');
}

function getStatusClass(s) {
  s = (s || '').toLowerCase();
  if (s === 'completed' && !s.includes('fail')) return 'completed';
  if (s.includes('fail') || s === 'failure' || s === 'error') return 'failure';
  if (s === 'in_progress') return 'in_progress';
  if (s === 'queued') return 'queued';
  if (s === 'cancelled') return 'cancelled';
  return 'unknown';
}

function sortData(tab) {
  const s = state[tab];
  const dir = s.sortDir === 'asc' ? 1 : -1;
  s.filtered.sort((a, b) => {
    if (s.sortBy === 'createdAt') {
      return dir * (new Date(a.createdAt) - new Date(b.createdAt));
    }
    // Add more sort fields here later if needed
    return 0;
  });
}

function renderTable(tab) {
  const s = state[tab];
  const container = document.getElementById(tab + '-table-container');
  const pag = document.getElementById(tab + '-pagination');

  if (s.filtered.length === 0) {
    container.innerHTML = '<div class="no-results">No matching workflows found.</div>';
    pag.innerHTML = '';
    return;
  }

  const start = (s.page - 1) * ITEMS_PER_PAGE;
  const end   = Math.min(start + ITEMS_PER_PAGE, s.filtered.length);
  const pageItems = s.filtered.slice(start, end);

  let html = \`
    <table>
      <thead>
        <tr>
          <th>Application</th>
          <th>Branch</th>
          <th>Status</th>
          <th class="sorted-\${s.sortDir}" onclick="toggleSort('\${tab}', 'createdAt')">Timestamp</th>
          <th>Run Link</th>
        </tr>
      </thead>
      <tbody>
  \`;

  pageItems.forEach(item => {
    html += \`
      <tr>
        <td>\${item.appName}</td>
        <td>\${item.branch}</td>
        <td><span class="status status-\${getStatusClass(item.status)}">\${item.status}</span></td>
        <td>\${formatTime(item.createdAt)}</td>
        <td><a href="\${item.link}" target="_blank" rel="noopener">View run →</a></td>
      </tr>
    \`;
  });

  html += '</tbody></table>';
  container.innerHTML = html;

  // Pagination
  const totalPages = Math.ceil(s.filtered.length / ITEMS_PER_PAGE);
  let pagHtml = '';

  if (totalPages > 1) {
    pagHtml += \`<button \${s.page===1?'disabled':''} onclick="changePage('\${tab}', \${s.page-1})">← Prev</button>\`;

    for (let i = 1; i <= totalPages; i++) {
      if (i === s.page) pagHtml += \`<button class="active">\${i}</button>\`;
      else if (i === 1 || i === totalPages || Math.abs(i - s.page) <= 2)
        pagHtml += \`<button onclick="changePage('\${tab}', \${i})">\${i}</button>\`;
      else if (Math.abs(i - s.page) === 3) pagHtml += '<span>...</span>';
    }

    pagHtml += \`<button \${s.page===totalPages?'disabled':''} onclick="changePage('\${tab}', \${s.page+1})">Next →</button>\`;
  }

  pag.innerHTML = pagHtml;
}

function toggleSort(tab, field) {
  const s = state[tab];
  if (s.sortBy === field) {
    s.sortDir = s.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    s.sortBy = field;
    s.sortDir = 'desc'; // default to newest first
  }
  sortData(tab);
  renderTable(tab);
}

function changePage(tab, page) {
  const s = state[tab];
  const total = Math.ceil(s.filtered.length / ITEMS_PER_PAGE);
  if (page < 1 || page > total) return;
  s.page = page;
  renderTable(tab);
}

function applyFilters(tab) {
  const s = state[tab];
  const appVal = document.getElementById(tab + '-app').value.trim().toLowerCase();
  const brVal  = document.getElementById(tab + '-branch').value.trim().toLowerCase();
  const stVal  = document.getElementById(tab + '-status').value.trim().toLowerCase();

  s.filtered = s.data.filter(item => {
    return (!appVal || item.appName.toLowerCase().includes(appVal)) &&
           (!brVal  || item.branch.toLowerCase().includes(brVal))  &&
           (!stVal  || item.status.toLowerCase().includes(stVal));
  });

  // Re-apply current sort after filtering
  sortData(tab);
  s.page = 1;
  renderTable(tab);
}

function clearFilters(tab) {
  document.getElementById(tab + '-app').value = '';
  document.getElementById(tab + '-branch').value = '';
  document.getElementById(tab + '-status').value = '';
  applyFilters(tab);
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(tab).classList.add('active');
    btn.classList.add('active');
    applyFilters(tab);
  });
});

// Live filtering
['build', 'release'].forEach(tab => {
  ['app','branch','status'].forEach(f => {
    document.getElementById(tab + '-' + f).addEventListener('input', () => applyFilters(tab));
  });
});

// Initial render
applyFilters('build');
</script>
</body>
</html>
  `;
}

async function main() {
  console.log('Fetching data...');
  const builds   = await fetchBuildData();
  const releases = await fetchReleaseData();

  console.log(`Builds: ${builds.length}   Releases: ${releases.length}`);

  const html = generateHTML(builds, releases);
  fs.writeFileSync('index.html', html);
  console.log('index.html generated');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

