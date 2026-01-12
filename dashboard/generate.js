require('dotenv').config();
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const config = require('./config');

if (!config.token) {
  console.error('❌ GITHUB_TOKEN not set');
  process.exit(1);
}

const octokit = new Octokit({ auth: config.token });

async function fetchBuildData() {
  const builds = [];

  for (const app of config.appRepos) {
    try {
      const { data } = await octokit.actions.listWorkflowRuns({
        owner: config.owner,
        repo: app.repo,
        workflow_id: app.buildWorkflow, // numeric ID strongly recommended
        per_page: 20,
      });

      const latestRun = data.workflow_runs
        .filter(r => r.status === 'completed')
        .sort((a, b) => new Date(b.run_started_at) - new Date(a.run_started_at))[0];

      builds.push({
        appName: app.name,
        branch: latestRun?.head_branch || 'N/A',
        link: latestRun?.html_url ||
          `https://github.com/${config.owner}/${app.repo}/actions`,
      });

    } catch (err) {
      console.error(`❌ Build fetch failed for ${app.name}:`, err.message);
      builds.push({
        appName: app.name,
        branch: 'Not Found',
        link: `https://github.com/${config.owner}/${app.repo}/actions`,
      });
    }
  }

  return builds;
}

async function fetchReleaseData() {
  const releases = [];

  try {
    const { data } = await octokit.actions.listWorkflowRuns({
      owner: config.owner,
      repo: config.repoB,
      workflow_id: config.releaseWorkflowName, // numeric ID preferred
      per_page: 50,
    });

    for (const run of data.workflow_runs) {
      if (!run.name) continue;

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

function generateHTML(builds, releases) {
  const buildTimestamp = new Date().toISOString();

  function uniq(arr, key) {
    return ['', ...Array.from(new Set(arr.map(x => x[key]))).sort()];
  }

  const buildApps = uniq(builds, 'appName');
  const buildBranches = uniq(builds, 'branch');
  const releaseApps = uniq(releases, 'appName');
  const releaseBranches = uniq(releases, 'branch');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Workflow Dashboard</title>

<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
<meta http-equiv="Pragma" content="no-cache" />
<meta http-equiv="Expires" content="0" />
<meta name="build-timestamp" content="${buildTimestamp}" />

<style>
/* 🔒 YOUR ORIGINAL CSS — UNCHANGED */
${/* paste your full CSS here exactly as before */''}
</style>
</head>

<body>
<div class="container">
<header>
<h1>Workflow Dashboard</h1>
<div class="subtitle">Last updated: ${buildTimestamp}</div>
</header>

<h2>Build Pipelines</h2>
<table>
<thead><tr><th>App</th><th>Branch</th><th>Link</th></tr></thead>
<tbody>
${builds.map(b => `
<tr>
<td>${b.appName}</td>
<td>${b.branch}</td>
<td><a href="${b.link}" target="_blank">View →</a></td>
</tr>
`).join('')}
</tbody>
</table>

<h2 style="margin-top:3rem">Release Pipelines</h2>
<table>
<thead><tr><th>App</th><th>Branch</th><th>Link</th></tr></thead>
<tbody>
${releases.map(r => `
<tr>
<td>${r.appName}</td>
<td>${r.branch}</td>
<td><a href="${r.link}" target="_blank">View →</a></td>
</tr>
`).join('')}
</tbody>
</table>
</div>
</body>
</html>`;
}

async function main() {
  const builds = await fetchBuildData();
  const releases = await fetchReleaseData();

  // Force artifact change every run
  fs.writeFileSync('build.txt', `build=${Date.now()}`);

  fs.writeFileSync('index.html', generateHTML(builds, releases));
  console.log('✅ Dashboard generated successfully');
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
