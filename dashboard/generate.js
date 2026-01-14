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
const CONCURRENT_WORKFLOWS = 10;
const CONCURRENT_JOBS = 20;

// ──────────────────────────────────────────────
// UPDATED: Extract app name, branch, version, and commit from run name
// Release format: branchname-appname-release-version-commit
// Build format: branchname-appname-build-version
function parseRunName(runName, isRelease = false) {
  if (!runName) {
    return null;
  }

  if (isRelease) {
    // Pattern: branchname-appname-release-version-commit
    // Example: main-myapp-release-v1.2.3-abc1234
    //          develop-api-service-release-2.0.0-def5678
    //          feature/new-ui-frontend-release-1.5.0-ghi9012

    // Match pattern: everything up to -release-, then version, then commit
    const match = runName.match(/^(.+?)-([^-]+)-release-([^-]+)-([a-f0-9]{7,})$/i);

    if (match) {
      let branch = match[1].trim();
      const appName = match[2].trim();
      const version = match[3].trim();
      const commit = match[4].trim().substring(0, 7); // Ensure 7 chars

      // If branch is "prod", show "main" instead
      if (branch.toLowerCase() === 'prod') {
        branch = 'main';
      }

      return {
        appName: appName,
        branch: branch,
        version: version,
        commit: commit
      };
    }

    // Fallback: try alternative parsing for release
    const parts = runName.split('-');
    if (parts.length >= 5) {
      // Try to find "release" keyword position
      const releaseIdx = parts.findIndex(p => p.toLowerCase() === 'release');
      if (releaseIdx >= 2) {
        // Branch is everything before app name
        // App name is the part just before "release"
        const appName = parts[releaseIdx - 1];
        let branch = parts.slice(0, releaseIdx - 1).join('-');

        // Version is right after "release"
        const version = parts[releaseIdx + 1] || 'unknown';

        // Commit is the last part (or second to last if there's trailing data)
        const commit = parts[parts.length - 1]?.substring(0, 7) || 'N/A';

        // If branch is "prod", show "main" instead
        if (branch.toLowerCase() === 'prod') {
          branch = 'main';
        }

        return {
          appName: appName || 'Unknown',
          branch: branch || 'N/A',
          version: version,
          commit: commit
        };
      }
    }
  } else {
    // Pattern: branchname-appname-build-version
    // Example: main-myapp-build-v1.2.3
    //          develop-api-service-build-2.0.0
    //          feature/new-ui-frontend-build-1.5.0

    // Match pattern: everything up to -build-, then version
    const match = runName.match(/^(.+?)-([^-]+)-build-(.+)$/i);

    if (match) {
      let branch = match[1].trim();
      const appName = match[2].trim();
      const version = match[3].trim();

      // If branch is "prod", show "main" instead
      if (branch.toLowerCase() === 'prod') {
        branch = 'main';
      }

      return {
        appName: appName,
        branch: branch,
        version: version,
        commit: null // No commit in build workflow names
      };
    }

    // Fallback: try alternative parsing for build
    const parts = runName.split('-');
    if (parts.length >= 4) {
      // Try to find "build" keyword position
      const buildIdx = parts.findIndex(p => p.toLowerCase() === 'build');
      if (buildIdx >= 2) {
        // App name is the part just before "build"
        const appName = parts[buildIdx - 1];
        let branch = parts.slice(0, buildIdx - 1).join('-');

        // Version is everything after "build"
        const version = parts.slice(buildIdx + 1).join('-') || 'unknown';

        // If branch is "prod", show "main" instead
        if (branch.toLowerCase() === 'prod') {
          branch = 'main';
        }

        return {
          appName: appName || 'Unknown',
          branch: branch || 'N/A',
          version: version,
          commit: null
        };
      }
    }
  }

  // Last resort: return null to use default extraction
  return null;
}

// ──────────────────────────────────────────────
// UTILITY: Optimized batch processing with better error handling
async function batchProcess(items, processor, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    console.log(`Processing batch ${Math.floor(i/concurrency) + 1}/${Math.ceil(items.length/concurrency)}...`);
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
      console.log('⚠ Cache expired');
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
// Helper functions for BUILD workflows (fallback extraction)
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
// MODIFIED: Fetch single workflow run details with updated parsing logic
async function fetchWorkflowDetails(owner, repo, workflowId, configAppName, isRelease = false) {
  try {
    const { data: runs } = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowId,
      per_page: MAX_RUNS_PER_WORKFLOW,
      page: 1,
    });

    if (!runs.workflow_runs?.length) {
      console.log(`No runs found for workflow ${workflowId}`);
      return [];
    }

    const jobPromises = runs.workflow_runs.map(run => async () => {
      try {
        const { data: jobsData } = await octokit.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: run.id,
          per_page: 100,
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

        // Parse run name for BOTH release and build workflows to get all fields
        const parsed = parseRunName(run.name, isRelease);

        // Use parsed values if available, otherwise fall back to default extraction
        const appName = parsed?.appName || configAppName;
        const branch = parsed?.branch || run.head_branch || 'N/A';
        const version = parsed?.version || (isRelease ? extractArtifactVersion(run) : extractVersion(run, appName));
        const commit = parsed?.commit || (isRelease ? await extractSourceCommit(owner, repo, run) : run.head_sha?.substring(0, 7) || 'N/A');

        return {
          appName: appName,
          type: isRelease ? 'Release' : 'Build',
          version: version,
          branch: branch,
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
          jobs,
          runNumber: run.run_number || 0,
          attempt: run.run_attempt || 1,
          runName: run.name || 'N/A' // Store original run name for reference
        };
      } catch (jobErr) {
        console.warn(`⚠ Jobs fetch failed for run ${run.id}:`, jobErr.message);
        const parsed = parseRunName(run.name, isRelease);

        const appName = parsed?.appName || configAppName;
        const branch = parsed?.branch || run.head_branch || 'N/A';
        const version = parsed?.version || (isRelease ? extractArtifactVersion(run) : extractVersion(run, appName));
        const commit = parsed?.commit || (isRelease ? await extractSourceCommit(owner, repo, run) : run.head_sha?.substring(0, 7) || 'N/A');

        return {
          appName: appName,
          type: isRelease ? 'Release' : 'Build',
          version: version,
          branch: branch,
          status: 'error',
          conclusion: 'error',
          createdAt: run.created_at || new Date().toISOString(),
          updatedAt: run.updated_at || run.created_at,
          duration: 'N/A',
          triggeredBy: run.triggering_actor?.login || 'Unknown',
          event: run.event || 'unknown',
          link: run.html_url,
          commitSha: commit,
          commitMessage: run.display_title || 'N/A',
          jobs: [],
          runNumber: run.run_number || 0,
          attempt: run.run_attempt || 1,
          runName: run.name || 'N/A'
        };
      }
    });

    const results = await batchProcess(jobPromises, fn => fn(), CONCURRENT_JOBS);
    return results.filter(r => r.status === 'fulfilled').map(r => r.value);

  } catch (error) {
    console.error(`⚠ Workflow fetch error for workflow ${workflowId}:`, error.message);
    return [{
      appName: configAppName,
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
      attempt: 1,
      runName: 'N/A'
    }];
  }
}

// ──────────────────────────────────────────────
// OPTIMIZED: Fetch build data with better progress tracking
async function fetchBuildData() {
  console.log(`⏳ Fetching builds for ${config.appRepos.length} workflows...`);
  const start = Date.now();

  const tasks = config.appRepos.map(app =>
    () => fetchWorkflowDetails(config.owner, app.repo, app.buildWorkflow, app.name, false)
  );

  const results = await batchProcess(tasks, t => t(), CONCURRENT_WORKFLOWS);

  const builds = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`✓ Fetched ${builds.length} builds in ${elapsed}s`);
  return builds;
}

// ──────────────────────────────────────────────
// OPTIMIZED: Fetch release data
async function fetchReleaseData() {
  if (!config.releaseRepos?.length) return [];

  console.log(`⏳ Fetching releases for ${config.releaseRepos.length} workflows...`);
  const start = Date.now();

  const tasks = config.releaseRepos.map(entry =>
    () => fetchWorkflowDetails(config.owner, entry.repo, entry.releaseWorkflow, entry.appName, true)
  );

  const results = await batchProcess(tasks, t => t(), CONCURRENT_WORKFLOWS);

  const releases = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`✓ Fetched ${releases.length} releases in ${elapsed}s`);
  return releases;
}

// ──────────────────────────────────────────────
// ENHANCED: Render step statuses with clickable links to logs
function renderStepStatuses(steps, jobUrl) {
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

    const stepAnchor = `${jobUrl}#step:${step.number}:1`;
    const isClickable = step.conclusion === 'failure' || step.status === 'in_progress';

    return `
      <div style="display:flex; align-items:center; padding:4px 8px; margin:3px 0; background:${bg}; border-radius:6px; font-size:0.8rem; border:1px solid #e5e7eb;">
        <span style="color:${color}; font-weight:bold; margin-right:6px;">${symbol}</span>
        ${isClickable ?
          `<a href="${stepAnchor}" target="_blank" rel="noopener noreferrer" style="color:inherit; text-decoration:none; flex:1; display:flex; align-items:center;" title="View logs for this step">
            <span style="flex:1;">${step.number}. ${step.name}</span>
            <span style="margin-left:8px; font-size:0.7rem; opacity:0.6;">🔗</span>
          </a>` :
          `<span>${step.number}. ${step.name}</span>`
        }
      </div>
    `;
  }).join('');
}

// ──────────────────────────────────────────────
// ENHANCED: Job badges with links and better visual hierarchy
function renderJobStatuses(jobs) {
  if (!jobs?.length) return '<div style="color:#9ca3af; padding:8px;">No jobs</div>';

  return `
    <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:4px;">
      ${jobs.map((job, idx) => {
        let color = '#6b7280', symbol = '○', bg = '#f3f4f6', borderColor = '#d1d5db';
        if (job.status === 'in_progress' || job.status === 'queued') {
          color = '#eab308'; symbol = '⟳'; bg = '#fef3c7'; borderColor = '#f59e0b';
        } else if (job.conclusion === 'success') {
          color = '#22c55e'; symbol = '✓'; bg = '#dcfce7'; borderColor = '#22c55e';
        } else if (job.conclusion === 'failure' || job.conclusion === 'cancelled') {
          color = '#ef4444'; symbol = '✗'; bg = '#fee2e2'; borderColor = '#ef4444';
        }

        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const stepCount = job.steps?.length || 0;
        const hasFailedSteps = job.steps?.some(s => s.conclusion === 'failure');

        return `
          <div style="position:relative;">
            <div onclick="toggleSteps('${jobId}')"
                 title="${job.name} • ${job.duration || 'N/A'} • ${stepCount} steps • Click to expand"
                 style="cursor:pointer; padding:5px 10px; background:${bg}; border-radius:6px; border:2px solid ${borderColor}; display:flex; align-items:center; gap:6px; font-size:0.82rem; white-space:nowrap; transition: all 0.2s;">
              <span style="color:${color}; font-weight:bold;">${symbol}</span>
              <span style="font-weight:500;">${job.name}</span>
              ${stepCount ? `<small style="color:#6b7280;">(${stepCount})</small>` : ''}
              ${hasFailedSteps ? `<span style="color:#ef4444; font-size:0.7rem;">⚠</span>` : ''}
            </div>
            <div id="${jobId}" style="display:none; position:absolute; z-index:20; background:white; border:2px solid ${borderColor}; border-radius:8px; box-shadow:0 10px 25px -5px rgba(0,0,0,0.25); min-width:380px; max-width:580px; margin-top:8px; padding:12px; max-height:420px; overflow-y:auto; left:0;">
              <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:10px;">
                <div style="flex:1;">
                  <div style="font-weight:600; margin-bottom:4px; color:#1f2937; font-size:0.95rem;">${job.name}</div>
                  <div style="font-size:0.82rem; color:#4b5563;">
                    ${job.duration || 'N/A'} • ${job.status}${job.conclusion ? ` → ${job.conclusion}` : ''}
                  </div>
                </div>
                <a href="${job.htmlUrl}" target="_blank" rel="noopener noreferrer"
                   style="background:#3b82f6; color:white; padding:6px 12px; border-radius:6px; font-size:0.8rem; text-decoration:none; white-space:nowrap; margin-left:8px;"
                   title="View full job logs on GitHub">
                  View Logs →
                </a>
              </div>
              <div style="border-top:1px solid #e5e7eb; padding-top:10px;">
                ${renderStepStatuses(job.steps, job.htmlUrl)}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ──────────────────────────────────────────────
// Metrics calculation
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
// HTML generation with horizontal scroll and fixed status filter
function generateHTML(builds, releases) {
  const metrics = generateMetrics(builds, releases);

  const allApps = [...new Set([...builds, ...releases].map(i => i.appName))].sort();
  const allBranches = [...new Set([...builds, ...releases].map(i => i.branch).filter(b => b && b !== 'N/A'))].sort();

  // Extract all unique statuses from actual data
  const allStatuses = [...new Set([...builds, ...releases].map(i => i.conclusion || i.status))].sort();

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

  // Helper function to determine the display status
  const getDisplayStatus = (item) => {
    const conclusion = item.conclusion || item.status;
    const hasFailedJobs = item.jobs?.some(job =>
      job.conclusion === 'failure' || job.conclusion === 'failed'
    );

    // If any job failed, show as failed regardless of overall status
    if (hasFailedJobs) {
      return 'failure';
    }

    return conclusion;
  };

  const buildRows = builds.map(b => {
    const displayStatus = getDisplayStatus(b);
    return `
    <tr data-app="${b.appName}" data-branch="${b.branch}" data-status="${displayStatus}">
      <td><strong>${b.appName}</strong></td>
      <td><code style="background:#f3f4f6;padding:2px 5px;border-radius:4px;">${b.version}</code></td>
      <td>${b.branch}</td>
      <td><span class="status-badge" data-status="${displayStatus}">${displayStatus === 'failure' ? 'failed' : b.status}</span></td>
      <td>${b.duration}</td>
      <td title="${b.commitMessage?.replace(/"/g,'&quot;')}"><code>${b.commitSha}</code></td>
      <td>${b.triggeredBy}</td>
      <td>${new Date(b.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td><a href="${b.link}" target="_blank" style="color:#3b82f6;">#${b.runNumber}</a></td>
      <td style="min-width:280px; max-width:500px;">${renderJobStatuses(b.jobs)}</td>
    </tr>
  `;
  }).join('');

  const releaseRows = releases.map(r => {
    const displayStatus = getDisplayStatus(r);
    return `
    <tr data-app="${r.appName}" data-branch="${r.branch}" data-status="${displayStatus}">
      <td><strong>${r.appName}</strong></td>
      <td><code style="background:#f3f4f6;padding:2px 5px;border-radius:4px;">${r.version}</code></td>
      <td>${r.branch}</td>
      <td><span class="status-badge" data-status="${displayStatus}">${displayStatus === 'failure' ? 'failed' : r.status}</span></td>
      <td>${r.duration}</td>
      <td title="${r.commitMessage?.replace(/"/g,'&quot;')}"><code>${r.commitSha}</code></td>
      <td>${r.triggeredBy}</td>
      <td>${new Date(r.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td><a href="${r.link}" target="_blank" style="color:#3b82f6;">#${r.runNumber}</a></td>
      <td style="min-width:280px; max-width:500px;">${renderJobStatuses(r.jobs)}</td>
    </tr>
  `;
  }).join('');

  // Generate status filter options dynamically
  const statusOptions = allStatuses.map(status => {
    let symbol = '';
    if (status === 'success' || status === 'completed') symbol = '✓ ';
    else if (status === 'failure' || status === 'failed') symbol = '✗ ';
    else if (status === 'in_progress') symbol = '⟳ ';
    else if (status === 'queued' || status === 'waiting') symbol = '○ ';

    const displayName = status.charAt(0).toUpperCase() + status.slice(1);
    return `<option value="${status}">${symbol}${displayName}</option>`;
  }).join('');

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

    /* Horizontal scroll container with sticky positioning */
    .table-container {
      overflow-x: auto;
      margin: 1.5rem 0;
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      position: sticky;
      top: 0;
      max-height: calc(100vh - 200px);
      overflow-y: visible;
    }

    table {
      width:100%;
      min-width: 1200px;
      border-collapse:collapse;
      background:white;
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
      white-space: nowrap;
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
      white-space: nowrap;
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

    /* Scrollbar styling - always visible */
    .table-container::-webkit-scrollbar {
      height: 12px;
    }
    .table-container::-webkit-scrollbar-track {
      background: #e5e7eb;
      border-radius: 10px;
    }
    .table-container::-webkit-scrollbar-thumb {
      background: #9ca3af;
      border-radius: 10px;
      border: 2px solid #e5e7eb;
    }
    .table-container::-webkit-scrollbar-thumb:hover {
      background: #6b7280;
    }
    [data-theme="dark"] .table-container::-webkit-scrollbar-track {
      background: #1e293b;
    }
    [data-theme="dark"] .table-container::-webkit-scrollbar-thumb {
      background: #475569;
      border-color: #1e293b;
    }
    [data-theme="dark"] .table-container::-webkit-scrollbar-thumb:hover {
      background: #64748b;
    }

    /* Force scrollbar to always show */
    .table-container {
      scrollbar-width: auto;
      scrollbar-color: #9ca3af #e5e7eb;
    }
    [data-theme="dark"] .table-container {
      scrollbar-color: #475569 #1e293b;
    }
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
      ${statusOptions}
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
    <div class="table-container">
      <table id="buildsTable">
        <thead>
          <tr>
            <th>App</th><th>Version</th><th>Branch</th><th>Status</th><th>Duration</th>
            <th>Commit</th><th>Triggered By</th><th>Time (UTC)</th><th>Run</th>
            <th style="min-width:280px;">Jobs & Steps</th>
          </tr>
        </thead>
        <tbody>
          ${buildRows || '<tr><td colspan="10" style="text-align:center;padding:3rem;color:var(--muted);">No build runs found</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>

  <div id="releasesView" style="display:none;">
    <h2>Recent Release Runs</h2>
    <div class="table-container">
      <table id="releasesTable">
        <thead>
          <tr>
            <th>App</th><th>Version</th><th>Branch</th><th>Status</th><th>Duration</th>
            <th>Commit</th><th>Triggered By</th><th>Time (UTC)</th><th>Run</th>
            <th style="min-width:280px;">Jobs & Steps</th>
          </tr>
        </thead>
        <tbody>
          ${releaseRows || '<tr><td colspan="10" style="text-align:center;padding:3rem;color:var(--muted);">No release runs found</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>

  <button class="dark-toggle" onclick="toggleTheme()">🌙</button>

  <script>
    function toggleSteps(id) {
      document.querySelectorAll('[id^="job-"]').forEach(el => {
        if (el.id !== id) el.style.display = 'none';
      });
      const el = document.getElementById(id);
      el.style.display = el.style.display === 'block' ? 'none' : 'block';
    }

    document.addEventListener('click', function(e) {
      if (!e.target.closest('[id^="job-"]') && !e.target.closest('[onclick^="toggleSteps"]')) {
        document.querySelectorAll('[id^="job-"]').forEach(el => {
          el.style.display = 'none';
        });
      }
    });

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
      if (s === 'success' || s === 'completed') {
        b.style.background = '#dcfce7'; b.style.color = '#166534';
      } else if (s === 'failure' || s === 'failed' || s === 'cancelled') {
        b.style.background = '#fee2e2'; b.style.color = '#991b1b';
      } else if (s === 'in_progress' || s === 'queued' || s === 'waiting') {
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

    filterTable();
  </script>
</body>
</html>
  `;
}

// ──────────────────────────────────────────────
// Main
async function main() {
  console.log('🚀 Starting dashboard generation...');
  const start = Date.now();

  let builds, releases;
  const cached = loadCache();
  if (cached && process.argv.includes('--use-cache')) {
    console.log('📦 Using cached data');
    ({ builds, releases } = cached);
  } else {
    builds = await fetchBuildData();
    releases = await fetchReleaseData();
    saveCache({ builds, releases });
  }

  console.log('📝 Generating HTML...');
  const html = generateHTML(builds, releases);
  fs.writeFileSync('index.html', html);

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`✅ Done in ${elapsed}s | Builds: ${builds.length} | Releases: ${releases.length}`);
  console.log(`📄 Output: index.html`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
