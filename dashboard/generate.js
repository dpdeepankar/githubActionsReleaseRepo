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
      
      // Paginate through all workflow runs
      while (hasMore) {
        const { data: runs } = await octokit.actions.listWorkflowRuns({
          owner: config.owner,
          repo: app.repo,
          workflow_id: app.buildWorkflow,
          per_page: 100, // Max allowed by GitHub API
          page: page,
        });

        // Add all runs from this page
        for (const run of runs.workflow_runs) {
          builds.push({
            appName: app.name,
            branch: run.head_branch || 'N/A',
            status: run.status || 'N/A',
            conclusion: run.conclusion || 'N/A',
            createdAt: run.created_at,
            link: run.html_url,
          });
        }

        // Check if there are more pages
        hasMore = runs.workflow_runs.length === 100;
        page++;
        
        // Safety limit to prevent infinite loops (adjust as needed)
        if (page > 10) break; // Max 1000 runs per workflow
      }

    } catch (error) {
      console.error(`Error fetching build for ${app.repo} (${app.buildWorkflow}):`, error.message);
      builds.push({
        appName: app.name,
        branch: 'Not Found',
        status: 'error',
        conclusion: 'error',
        createdAt: new Date().toISOString(),
        link: `https://github.com/${config.owner}/${app.repo}/actions`,
      });
    }
  }
  
  // Sort by creation date (newest first)
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
        page: page,
      });
      
      for (const run of runs.workflow_runs) {
        const match = run.name.match(/^(.+?)\s*-\s*(.+?)\s*-\s*release$/i);
        if (match) {
          const [, branch, appName] = match;
          releases.push({
            appName: appName.trim(),
            branch: branch.trim(),
            status: run.status || 'N/A',
            conclusion: run.conclusion || 'N/A',
            createdAt: run.created_at,
            link: run.html_url,
          });
        }
      }
      
      hasMore = runs.workflow_runs.length === 100;
      page++;
      
      if (page > 10) break; // Max 1000 runs
    }
  } catch (error) {
    console.error(`Error fetching releases from ${config.repoB}:`, error.message);
  }
  
  // Sort by creation date (newest first)
  releases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return releases;
}

function generateHTML(builds, releases) {
  // ──────────────────────────────────────────────
  // Helper: Get unique sorted values for dropdowns
  function getUniqueValues(arr, key) {
    const set = new Set(arr.map(item => item[key]));
    return ['', ...Array.from(set).sort()]; // '' = "All"
  }

  const buildApps = getUniqueValues(builds, 'appName');
  const buildBranches = getUniqueValues(builds, 'branch');

  const releaseApps = getUniqueValues(releases, 'appName');
  const releaseBranches = getUniqueValues(releases, 'branch');

  // Initial table HTML with pagination
  const buildTableHTML = builds.length > 0 ? `
    <div class="pagination-info">
      <span>Showing <span id="build-start">1</span>-<span id="build-end">20</span> of <span id="build-total">${builds.length}</span> builds</span>
    </div>
    <table id="build-table">
      <thead>
        <tr>
          <th>Application</th>
          <th>Branch</th>
          <th>Status</th>
          <th>Latest Run / Workflow</th>
        </tr>
      </thead>
      <tbody>
        ${builds.slice(0, 20).map(b => `
          <tr>
            <td style="font-weight: 500;">${b.appName}</td>
            <td>${b.branch}</td>
            <td><span class="status-badge status-${getStatusClass(b.status, b.conclusion)}">${getStatusText(b.status, b.conclusion)}</span></td>
            <td><a href="${b.link}" target="_blank" rel="noopener noreferrer">View Build →</a></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="pagination-controls" id="build-pagination"></div>
  ` : '<div class="no-data">No build information available.</div>';

  const releaseTableHTML = releases.length > 0 ? `
    <div class="pagination-info">
      <span>Showing <span id="release-start">1</span>-<span id="release-end">20</span> of <span id="release-total">${releases.length}</span> releases</span>
    </div>
    <table id="release-table">
      <thead>
        <tr>
          <th>Application</th>
          <th>Branch</th>
          <th>Status</th>
          <th>Release Run</th>
        </tr>
      </thead>
      <tbody>
        ${releases.slice(0, 20).map(r => `
          <tr>
            <td style="font-weight: 500;">${r.appName}</td>
            <td>${r.branch}</td>
            <td><span class="status-badge status-${getStatusClass(r.status, r.conclusion)}">${getStatusText(r.status, r.conclusion)}</span></td>
            <td><a href="${r.link}" target="_blank" rel="noopener noreferrer">View Release →</a></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="pagination-controls" id="release-pagination"></div>
  ` : '<div class="no-data">No release information available.</div>';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workflow Dashboard</title>
    <style>
        :root {
            --bg: #ffffff;
            --card-bg: #ffffff;
            --text: #111827;
            --text-muted: #6b7280;
            --border: #e5e7eb;
            --header-bg: #f9fafb;
            --accent: #2563eb;
            --accent-dark: #1d4ed8;
        }

        [data-theme="dark"] {
            --bg: #111827;
            --card-bg: #1f2937;
            --text: #f3f4f6;
            --text-muted: #9ca3af;
            --border: #374151;
            --header-bg: #1f2937;
            --accent: #60a5fa;
            --accent-dark: #3b82f6;
        }

        body {
            background-color: var(--bg);
            color: var(--text);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            margin: 0;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem 1rem;
        }

        header {
            text-align: center;
            margin-bottom: 2.5rem;
        }

        h1 {
            font-size: 2.25rem;
            font-weight: 700;
            margin: 0 0 0.5rem;
        }

        .subtitle {
            color: var(--text-muted);
            font-size: 1.1rem;
        }

        .tab-buttons {
            display: flex;
            justify-content: center;
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .tab-btn {
            padding: 0.75rem 2rem;
            font-size: 1rem;
            font-weight: 500;
            border: none;
            border-radius: 0.5rem;
            cursor: pointer;
            transition: background-color 0.2s;
        }

        .tab-btn-primary {
            background-color: var(--accent);
            color: white;
        }

        .tab-btn-primary:hover {
            background-color: var(--accent-dark);
        }

        .tab-btn.active {
            background-color: var(--accent-dark);
        }

        .tab-content {
            display: none;
            background: var(--card-bg);
            border-radius: 0.75rem;
            border: 1px solid var(--border);
            overflow: hidden;
        }

        .tab-content.active {
            display: block;
        }

        .filters {
            display: flex;
            flex-wrap: wrap;
            gap: 1.25rem;
            margin: 1rem 1.5rem;
            align-items: flex-end;
        }

        .filter-group {
            display: flex;
            flex-direction: column;
            min-width: 160px;
        }

        .filter-group label {
            font-size: 0.875rem;
            margin-bottom: 0.3rem;
            color: var(--text-muted);
        }

        .filter-select {
            padding: 0.5rem 0.75rem;
            border: 1px solid var(--border);
            border-radius: 0.375rem;
            font-size: 1rem;
            background: var(--card-bg);
            color: var(--text);
            min-width: 140px;
        }

        [data-theme="dark"] .filter-select {
            background: #374151;
            color: #f3f4f6;
            border-color: #4b5563;
        }

        .clear-btn {
            padding: 0.5rem 1.25rem;
            background: #ef4444;
            color: white;
            border: none;
            border-radius: 0.375rem;
            cursor: pointer;
            font-size: 0.875rem;
            margin-top: 1.6rem;
        }

        .clear-btn:hover {
            background: #dc2626;
        }

        .section-title {
            font-size: 1.5rem;
            font-weight: 600;
            margin: 1rem 1.5rem;
        }

        .pagination-info {
            padding: 0.75rem 1.5rem;
            color: var(--text-muted);
            font-size: 0.9rem;
            border-bottom: 1px solid var(--border);
        }

        .pagination-controls {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 0.5rem;
            padding: 1.5rem;
            flex-wrap: wrap;
        }

        .page-btn {
            padding: 0.5rem 0.75rem;
            min-width: 40px;
            border: 1px solid var(--border);
            background: var(--card-bg);
            color: var(--text);
            border-radius: 0.375rem;
            cursor: pointer;
            font-size: 0.9rem;
            transition: all 0.2s;
        }

        .page-btn:hover:not(:disabled) {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }

        .page-btn.active {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
            font-weight: 600;
        }

        .page-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        th, td {
            padding: 1rem 1.5rem;
            text-align: left;
            border-bottom: 1px solid var(--border);
        }

        th {
            background-color: var(--header-bg);
            font-weight: 600;
            font-size: 0.9rem;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.4px;
        }

        a {
            color: var(--accent);
            text-decoration: none;
            font-weight: 500;
        }

        a:hover {
            text-decoration: underline;
        }

        .status-badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .status-success {
            background-color: #dcfce7;
            color: #166534;
        }

        .status-failure {
            background-color: #fee2e2;
            color: #991b1b;
        }

        .status-in_progress {
            background-color: #dbeafe;
            color: #1e40af;
        }

        .status-queued {
            background-color: #fef3c7;
            color: #92400e;
        }

        .status-cancelled {
            background-color: #f3f4f6;
            color: #4b5563;
        }

        .status-error, .status-na {
            background-color: #fecaca;
            color: #7f1d1d;
        }

        [data-theme="dark"] .status-success {
            background-color: #064e3b;
            color: #6ee7b7;
        }

        [data-theme="dark"] .status-failure {
            background-color: #7f1d1d;
            color: #fca5a5;
        }

        [data-theme="dark"] .status-in_progress {
            background-color: #1e3a8a;
            color: #93c5fd;
        }

        [data-theme="dark"] .status-queued {
            background-color: #78350f;
            color: #fde68a;
        }

        [data-theme="dark"] .status-cancelled {
            background-color: #374151;
            color: #d1d5db;
        }

        [data-theme="dark"] .status-error,
        [data-theme="dark"] .status-na {
            background-color: #7f1d1d;
            color: #fca5a5;
        }

        .no-data, .no-results {
            padding: 3rem 1rem;
            text-align: center;
            color: var(--text-muted);
            font-style: italic;
        }

        .dark-toggle {
            position: fixed;
            bottom: 1.5rem;
            right: 1.5rem;
            background: #374151;
            color: white;
            border: none;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            font-size: 1.25rem;
            cursor: pointer;
            box-shadow: 0 2px 10px rgba(0,0,0,0.25);
        }

        @media (max-width: 640px) {
            .filters { flex-direction: column; align-items: stretch; gap: 1rem; }
            .clear-btn { margin-top: 0; }
        }
    </style>
</head>
<body>

    <div class="container">
        <header>
            <h1>Workflow Dashboard</h1>
            <div class="subtitle">Build and Release pipelines overview</div>
        </header>

        <div class="tab-buttons">
            <button class="tab-btn tab-btn-primary active" id="build-btn" onclick="showTab('build')">Build Workflows</button>
            <button class="tab-btn tab-btn-primary" id="release-btn" onclick="showTab('release')">Release Pipelines</button>
        </div>

        <!-- Build Tab -->
        <div id="build-tab" class="tab-content active">
            <div class="section-title">Build Workflows</div>
            <div class="filters">
                <div class="filter-group">
                    <label for="build-app-select">Application</label>
                    <select id="build-app-select" class="filter-select" onchange="filterTable('build')">
                        ${buildApps.map(app => `<option value="${app}">${app || 'All'}</option>`).join('')}
                    </select>
                </div>
                <div class="filter-group">
                    <label for="build-branch-select">Branch</label>
                    <select id="build-branch-select" class="filter-select" onchange="filterTable('build')">
                        ${buildBranches.map(br => `<option value="${br}">${br || 'All'}</option>`).join('')}
                    </select>
                </div>
                <button class="clear-btn" onclick="clearFilters('build')">Reset Filters</button>
            </div>
            <div id="build-table-container">${buildTableHTML}</div>
        </div>

        <!-- Release Tab -->
        <div id="release-tab" class="tab-content">
            <div class="section-title">Release Pipelines</div>
            <div class="filters">
                <div class="filter-group">
                    <label for="release-app-select">Application</label>
                    <select id="release-app-select" class="filter-select" onchange="filterTable('release')">
                        ${releaseApps.map(app => `<option value="${app}">${app || 'All'}</option>`).join('')}
                    </select>
                </div>
                <div class="filter-group">
                    <label for="release-branch-select">Branch</label>
                    <select id="release-branch-select" class="filter-select" onchange="filterTable('release')">
                        ${releaseBranches.map(br => `<option value="${br}">${br || 'All'}</option>`).join('')}
                    </select>
                </div>
                <button class="clear-btn" onclick="clearFilters('release')">Reset Filters</button>
            </div>
            <div id="release-table-container">${releaseTableHTML}</div>
        </div>
    </div>

    <button class="dark-toggle" onclick="document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? '' : 'dark'" title="Toggle dark mode">🌙</button>

    <script>
        const buildData = ${JSON.stringify(builds)};
        const releaseData = ${JSON.stringify(releases)};
        
        const pagination = {
            build: { currentPage: 1, itemsPerPage: 20, filteredData: buildData },
            release: { currentPage: 1, itemsPerPage: 20, filteredData: releaseData }
        };

        function getStatusClass(status, conclusion) {
            if (status === 'completed') {
                return conclusion === 'success' ? 'success' : 'failure';
            }
            if (status === 'in_progress') return 'in_progress';
            if (status === 'queued') return 'queued';
            if (status === 'error') return 'error';
            return 'na';
        }

        function getStatusText(status, conclusion) {
            if (status === 'completed') {
                if (conclusion === 'success') return '✓ Success';
                if (conclusion === 'failure') return '✗ Failed';
                if (conclusion === 'cancelled') return '⊘ Cancelled';
                return conclusion;
            }
            if (status === 'in_progress') return '⟳ Running';
            if (status === 'queued') return '⧗ Queued';
            if (status === 'error') return '⚠ Error';
            return status;
        }

        function renderPagination(tab) {
            const pag = pagination[tab];
            const totalPages = Math.ceil(pag.filteredData.length / pag.itemsPerPage);
            const container = document.getElementById(tab + '-pagination');
            
            if (totalPages <= 1) {
                container.innerHTML = '';
                return;
            }

            let html = '';
            
            // Previous button
            html += \`<button class="page-btn" onclick="changePage('\${tab}', \${pag.currentPage - 1})" \${pag.currentPage === 1 ? 'disabled' : ''}>← Prev</button>\`;
            
            // Page numbers
            const maxButtons = 7;
            let startPage = Math.max(1, pag.currentPage - Math.floor(maxButtons / 2));
            let endPage = Math.min(totalPages, startPage + maxButtons - 1);
            
            if (endPage - startPage < maxButtons - 1) {
                startPage = Math.max(1, endPage - maxButtons + 1);
            }
            
            if (startPage > 1) {
                html += \`<button class="page-btn" onclick="changePage('\${tab}', 1)">1</button>\`;
                if (startPage > 2) html += '<span style="padding: 0.5rem;">...</span>';
            }
            
            for (let i = startPage; i <= endPage; i++) {
                html += \`<button class="page-btn \${i === pag.currentPage ? 'active' : ''}" onclick="changePage('\${tab}', \${i})">\${i}</button>\`;
            }
            
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) html += '<span style="padding: 0.5rem;">...</span>';
                html += \`<button class="page-btn" onclick="changePage('\${tab}', \${totalPages})">\${totalPages}</button>\`;
            }
            
            // Next button
            html += \`<button class="page-btn" onclick="changePage('\${tab}', \${pag.currentPage + 1})" \${pag.currentPage === totalPages ? 'disabled' : ''}>Next →</button>\`;
            
            container.innerHTML = html;
        }

        function changePage(tab, page) {
            const pag = pagination[tab];
            const totalPages = Math.ceil(pag.filteredData.length / pag.itemsPerPage);
            
            if (page < 1 || page > totalPages) return;
            
            pag.currentPage = page;
            renderTable(pag.filteredData, tab);
        }

        function renderTable(rows, tab) {
            const pag = pagination[tab];
            const container = document.getElementById(tab + '-table-container');
            
            if (rows.length === 0) {
                container.innerHTML = '<div class="no-results">No matching results.</div>';
                return;
            }

            const start = (pag.currentPage - 1) * pag.itemsPerPage;
            const end = Math.min(start + pag.itemsPerPage, rows.length);
            const pageRows = rows.slice(start, end);
            
            const title = tab === 'build' ? 'Build' : 'Release';
            const html = \`
                <div class="pagination-info">
                    <span>Showing <span id="\${tab}-start">\${start + 1}</span>-<span id="\${tab}-end">\${end}</span> of <span id="\${tab}-total">\${rows.length}</span> \${tab}s</span>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Application</th>
                            <th>Branch</th>
                            <th>Status</th>
                            <th>\${title === 'Build' ? 'Latest Run / Workflow' : 'Release Run'}</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${pageRows.map(item => \`
                            <tr>
                                <td style="font-weight: 500;">\${item.appName}</td>
                                <td>\${item.branch}</td>
                                <td><span class="status-badge status-\${getStatusClass(item.status, item.conclusion)}">\${getStatusText(item.status, item.conclusion)}</span></td>
                                <td><a href="\${item.link}" target="_blank" rel="noopener noreferrer">View \${title} →</a></td>
                            </tr>
                        \`).join('')}
                    </tbody>
                </table>
                <div class="pagination-controls" id="\${tab}-pagination"></div>
            \`;
            
            container.innerHTML = html;
            renderPagination(tab);
        }

        function filterTable(tab) {
            const appVal = document.getElementById(tab + '-app-select').value;
            const branchVal = document.getElementById(tab + '-branch-select').value;

            const data = tab === 'build' ? buildData : releaseData;

            const filtered = data.filter(item => {
                const appMatch = !appVal || item.appName === appVal;
                const branchMatch = !branchVal || item.branch === branchVal;
                return appMatch && branchMatch;
            });

            pagination[tab].filteredData = filtered;
            pagination[tab].currentPage = 1;
            renderTable(filtered, tab);
        }

        function clearFilters(tab) {
            document.getElementById(tab + '-app-select').value = '';
            document.getElementById(tab + '-branch-select').value = '';
            filterTable(tab);
        }

        function showTab(tab) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById(tab + '-tab').classList.add('active');
            document.getElementById(tab + '-btn').classList.add('active');
            filterTable(tab);
        }

        showTab('build');
    </script>

</body>
</html>
  `;
}

// Helper functions for status handling
function getStatusClass(status, conclusion) {
  if (status === 'completed') {
    return conclusion === 'success' ? 'success' : 'failure';
  }
  if (status === 'in_progress') return 'in_progress';
  if (status === 'queued') return 'queued';
  if (status === 'error') return 'error';
  return 'na';
}

function getStatusText(status, conclusion) {
  if (status === 'completed') {
    if (conclusion === 'success') return '✓ Success';
    if (conclusion === 'failure') return '✗ Failed';
    if (conclusion === 'cancelled') return '⊘ Cancelled';
    return conclusion;
  }
  if (status === 'in_progress') return '⟳ Running';
  if (status === 'queued') return '⧗ Queued';
  if (status === 'error') return '⚠ Error';
  return status;
}

async function main() {
  console.log('Fetching workflow data...');
  const builds = await fetchBuildData();
  console.log(`Fetched ${builds.length} build workflows`);
  
  const releases = await fetchReleaseData();
  console.log(`Fetched ${releases.length} release workflows`);
  
  const html = generateHTML(builds, releases);
  fs.writeFileSync('index.html', html);
  console.log('Generated index.html successfully!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
