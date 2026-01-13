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
          page: page,
        });

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

        hasMore = runs.workflow_runs.length === 100;
        page++;

        if (page > 10) break;
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

      if (page > 10) break;
    }
  } catch (error) {
    console.error(`Error fetching releases from ${config.repoB}:`, error.message);
  }

  releases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return releases;
}

function formatTimestamp(isoString) {
  if (!isoString) return 'N/A';
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  }).replace(/,/, ''); // cleaner look
}

function generateHTML(builds, releases) {
  function getUniqueValues(arr, key) {
    const set = new Set(arr.map(item => item[key]));
    return Array.from(set).sort();
  }

  const buildApps = getUniqueValues(builds, 'appName');
  const buildBranches = getUniqueValues(builds, 'branch');
  const releaseApps = getUniqueValues(releases, 'appName');
  const releaseBranches = getUniqueValues(releases, 'branch');

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
          <th>Timestamp</th>
          <th>Run Link</th>
        </tr>
      </thead>
      <tbody>
        ${builds.slice(0, 20).map(b => `
          <tr>
            <td style="font-weight: 500;">${b.appName}</td>
            <td>${b.branch}</td>
            <td><span class="status-badge status-${getStatusClass(b.status, b.conclusion)}">${getStatusText(b.status, b.conclusion)}</span></td>
            <td>${formatTimestamp(b.createdAt)}</td>
            <td><a href="${b.link}" target="_blank" rel="noopener noreferrer">View →</a></td>
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
          <th>Timestamp</th>
          <th>Run Link</th>
        </tr>
      </thead>
      <tbody>
        ${releases.slice(0, 20).map(r => `
          <tr>
            <td style="font-weight: 500;">${r.appName}</td>
            <td>${r.branch}</td>
            <td><span class="status-badge status-${getStatusClass(r.status, r.conclusion)}">${getStatusText(r.status, r.conclusion)}</span></td>
            <td>${formatTimestamp(r.createdAt)}</td>
            <td><a href="${r.link}" target="_blank" rel="noopener noreferrer">View →</a></td>
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
        /* Your existing CSS remains the same – just adding minor tweaks for timestamp column */
        td, th { white-space: nowrap; } /* prevent wrapping in timestamp */
        .combo-input {
            padding: 0.5rem 0.75rem;
            border: 1px solid var(--border);
            border-radius: 0.375rem;
            font-size: 1rem;
            width: 100%;
            box-sizing: border-box;
            background: var(--card-bg);
            color: var(--text);
        }
        [data-theme="dark"] .combo-input {
            background: #374151;
            color: #f3f4f6;
            border-color: #4b5563;
        }
        /* Rest of your CSS (status badges, pagination, etc.) stays unchanged */
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
                    <label for="build-app-input">Application</label>
                    <input list="build-app-list" id="build-app-input" class="combo-input" placeholder="Type or select app..." oninput="filterTable('build')">
                    <datalist id="build-app-list">
                        <option value="">All</option>
                        ${buildApps.map(app => `<option value="${app}">${app}</option>`).join('')}
                    </datalist>
                </div>
                <div class="filter-group">
                    <label for="build-branch-input">Branch</label>
                    <input list="build-branch-list" id="build-branch-input" class="combo-input" placeholder="Type or select branch..." oninput="filterTable('build')">
                    <datalist id="build-branch-list">
                        <option value="">All</option>
                        ${buildBranches.map(br => `<option value="${br}">${br}</option>`).join('')}
                    </datalist>
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
                    <label for="release-app-input">Application</label>
                    <input list="release-app-list" id="release-app-input" class="combo-input" placeholder="Type or select app..." oninput="filterTable('release')">
                    <datalist id="release-app-list">
                        <option value="">All</option>
                        ${releaseApps.map(app => `<option value="${app}">${app}</option>`).join('')}
                    </datalist>
                </div>
                <div class="filter-group">
                    <label for="release-branch-input">Branch</label>
                    <input list="release-branch-list" id="release-branch-input" class="combo-input" placeholder="Type or select branch..." oninput="filterTable('release')">
                    <datalist id="release-branch-list">
                        <option value="">All</option>
                        ${releaseBranches.map(br => `<option value="${br}">${br}</option>`).join('')}
                    </datalist>
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

        // Your existing getStatusClass, getStatusText, formatTimestamp (moved to JS if needed)
        function formatTimestamp(isoString) {
            if (!isoString) return 'N/A';
            const date = new Date(isoString);
            return date.toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false
            }).replace(/,/, '');
        }

        function getStatusClass(status, conclusion) {
            if (status === 'completed') return conclusion === 'success' ? 'success' : 'failure';
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
                return conclusion || 'Completed';
            }
            if (status === 'in_progress') return '⟳ Running';
            if (status === 'queued') return '⧗ Queued';
            if (status === 'error') return '⚠ Error';
            return status || 'Unknown';
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
                            <th>Timestamp</th>
                            <th>Run Link</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${pageRows.map(item => \`
                            <tr>
                                <td style="font-weight: 500;">\${item.appName}</td>
                                <td>\${item.branch}</td>
                                <td><span class="status-badge status-\${getStatusClass(item.status, item.conclusion)}">\${getStatusText(item.status, item.conclusion)}</span></td>
                                <td>\${formatTimestamp(item.createdAt)}</td>
                                <td><a href="\${item.link}" target="_blank" rel="noopener noreferrer">View →</a></td>
                            </tr>
                        \`).join('')}
                    </tbody>
                </table>
                <div class="pagination-controls" id="\${tab}-pagination"></div>
            \`;

            container.innerHTML = html;
            renderPagination(tab);
        }

        // Your existing renderPagination, changePage, filterTable, clearFilters, showTab functions remain the same
        // ... paste them here from your current file ...

        // Update filterTable to work with input + datalist
        function filterTable(tab) {
            const appInput = document.getElementById(tab + '-app-input').value.trim();
            const branchInput = document.getElementById(tab + '-branch-input').value.trim();

            const data = tab === 'build' ? buildData : releaseData;
            const filtered = data.filter(item => {
                const appMatch = !appInput || item.appName.toLowerCase().includes(appInput.toLowerCase());
                const branchMatch = !branchInput || item.branch.toLowerCase().includes(branchInput.toLowerCase());
                return appMatch && branchMatch;
            });

            pagination[tab].filteredData = filtered;
            pagination[tab].currentPage = 1;
            renderTable(filtered, tab);
        }

        function clearFilters(tab) {
            document.getElementById(tab + '-app-input').value = '';
            document.getElementById(tab + '-branch-input').value = '';
            filterTable(tab);
        }

        showTab('build');
    </script>
</body>
</html>
  `;
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
