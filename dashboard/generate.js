require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');
const config = require('./config');

if (!config.token) {
  console.error('❌ GITHUB_TOKEN not set');
  process.exit(1);
}

const octokit = new Octokit({ auth: config.token });

/**
 * Fetch latest COMPLETED build per app
 */
async function fetchBuildData() {
  const builds = [];

  for (const app of config.appRepos) {
    try {
      const { data } = await octokit.actions.listWorkflowRuns({
        owner: config.owner,
        repo: app.repo,
        workflow_id: app.buildWorkflow,
        per_page: 20,
      });

      const latestRun = data.workflow_runs
        .filter(r => r.status === 'completed')
        .sort((a, b) => new Date(b.run_started_at) - new Date(a.run_started_at))[0];

      builds.push({
        appName: app.name,
        branch: latestRun?.head_branch || 'N/A',
        link:
          latestRun?.html_url ||
          `https://github.com/${config.owner}/${app.repo}/actions/workflows/${app.buildWorkflow}`,
      });

    } catch (err) {
      console.error(`❌ Build fetch failed for ${app.name}:`, err.message);
      builds.push({
        appName: app.name,
        branch: 'Error',
        link: `https://github.com/${config.owner}/${app.repo}/actions`,
      });
    }
  }

  return builds;
}

/**
 * Fetch release data
 */
async function fetchReleaseData() {
  const releases = [];

  try {
    const { data } = await octokit.actions.listWorkflowRuns({
      owner: config.owner,
      repo: config.repoB,
      workflow_id: config.releaseWorkflowName,
      per_page: 50,
    });

    for (const run of data.workflow_runs) {
      if (!run.name) continue;

      // Expected: branch - app - release
      const match = run.name.match(/^(.+?)\s*-\s*(.+?)\s*-\s*release$/i);
      if (!match) continue;

      const [, branch, appName] = match;

      releases.push({
        appName: appName.trim(),
        branch: branch.trim(),
        link: run.html_url,
      });
    }
  } catch (err) {
    console.error('❌ Release fetch failed:', err.message);
  }

  return releases;
}

/**
 * Generate HTML (CSS UNCHANGED)
 */
function generateHTML(builds, releases) {
  const buildTimestamp = new Date().toISOString();

  function getUniqueValues(arr, key) {
    return ['', ...Array.from(new Set(arr.map(item => item[key]))).sort()];
  }

  const buildApps = getUniqueValues(builds, 'appName');
  const buildBranches = getUniqueValues(builds, 'branch');
  const releaseApps = getUniqueValues(releases, 'appName');
  const releaseBranches = getUniqueValues(releases, 'branch');

  // ---- ORIGINAL HTML + CSS (unchanged) ----
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Workflow Dashboard</title>

    <!-- 🔥 Cache busting -->
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <meta name="build-timestamp" content="${buildTimestamp}" />

    <style>
${fs.readFileSync(path.join(__dirname, 'INLINE_CSS.tmp'), 'utf8')}
    </style>
</head>
<body>

    <div class="container">
        <header>
            <h1>Workflow Dashboard</h1>
            <div class="subtitle">
              Build and Release pipelines overview<br/>
              <small>Last updated: ${buildTimestamp}</small>
            </div>
        </header>

        <div class="tab-buttons">
            <button class="tab-btn tab-btn-primary active" id="build-btn" onclick="showTab('build')">Build Workflows</button>
            <button class="tab-btn tab-btn-primary" id="release-btn" onclick="showTab('release')">Release Pipelines</button>
        </div>

        <div id="build-tab" class="tab-content active">
            <div class="section-title">Build Workflows</div>
            <div class="filters">
                <div class="filter-group">
                    <label>Application</label>
                    <select id="build-app-select" class="filter-select" onchange="filterTable('build')">
                        ${buildApps.map(a => `<option value="${a}">${a || 'All'}</option>`).join('')}
                    </select>
                </div>
                <div class="filter-group">
                    <label>Branch</label>
                    <select id="build-branch-select" class="filter-select" onchange="filterTable('build')">
                        ${buildBranches.map(b => `<option value="${b}">${b || 'All'}</option>`).join('')}
                    </select>
                </div>
                <button class="clear-btn" onclick="clearFilters('build')">Reset Filters</button>
            </div>
            <div id="build-table-container"></div>
        </div>

        <div id="release-tab" class="tab-content">
            <div class="section-title">Release Pipelines</div>
            <div class="filters">
                <div class="filter-group">
                    <label>Application</label>
                    <select id="release-app-select" class="filter-select" onchange="filterTable('release')">
                        ${releaseApps.map(a => `<option value="${a}">${a || 'All'}</option>`).join('')}
                    </select>
                </div>
                <div class="filter-group">
                    <label>Branch</label>
                    <select id="release-branch-select" class="filter-select" onchange="filterTable('release')">
                        ${releaseBranches.map(b => `<option value="${b}">${b || 'All'}</option>`).join('')}
                    </select>
                </div>
                <button class="clear-btn" onclick="clearFilters('release')">Reset Filters</button>
            </div>
            <div id="release-table-container"></div>
        </div>
    </div>

<script>
const buildData = ${JSON.stringify(builds)};
const releaseData = ${JSON.stringify(releases)};

function renderTable(rows, tab) {
  if (!rows.length) return '<div class="no-results">No matching results.</div>';
  const title = tab === 'build' ? 'Build' : 'Release';
  return \`
    <table>
      <thead>
        <tr>
          <th>Application</th>
          <th>Branch</th>
          <th>\${title === 'Build' ? 'Latest Run / Workflow' : 'Release Run'}</th>
        </tr>
      </thead>
      <tbody>
        \${rows.map(r => \`
          <tr>
            <td>\${r.appName}</td>
            <td>\${r.branch}</td>
            <td><a href="\${r.link}" target="_blank">View →</a></td>
          </tr>
        \`).join('')}
      </tbody>
    </table>\`;
}

function filterTable(tab) {
  const appVal = document.getElementById(tab + '-app-select').value;
  const branchVal = document.getElementById(tab + '-branch-select').value;
  const data = tab === 'build' ? buildData : releaseData;

  const filtered = data.filter(d =>
    (!appVal || d.appName === appVal) &&
    (!branchVal || d.branch === branchVal)
  );

  document.getElementById(tab + '-table-container').innerHTML =
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
</html>`;
}

/**
 * Main
 */
async function main() {
  const builds = await fetchBuildData();
  const releases = await fetchReleaseData();

  // 🔥 force artifact hash change every run
  fs.writeFileSync('build.txt', `build=${Date.now()}`);

  const html = generateHTML(builds, releases);
  fs.writeFileSync('index.html', html);

  console.log('✅ Dashboard generated successfully');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
