module.exports = {
  appRepos: [  // List of Repo A's (app repos)
    { name: 'app1', repo: 'githubActionsBuildRepo', buildWorkflow: 'app1-build.yml' },  // e.g., { name: 'myapp', repo: 'myapp-repo' }
    { name: 'app2', repo: 'githubActionsBuildRepo', buildWorkflow: 'app2-build.yml' },
    { name: 'app3', repo: 'githubActionsBuildRepo', buildWorkflow: 'app3-build.yml' },
    { name: 'app4', repo: 'githubActionsBuildRepo', buildWorkflow: 'app4-build.yml' },
    // Add more apps here
  ],
  owner: process.env.OWNER,
  token: process.env.GITHUB_TOKEN,
  repoB: process.env.REPO_B,
  releaseWorkflowName: process.env.RELEASE_WORKFLOW_NAME,
};
