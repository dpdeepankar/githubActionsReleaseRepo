module.exports = {
  owner: process.env.OWNER,
  token: process.env.GITHUB_TOKEN,

  apps: [
    {
      name: 'app1',
      build: {
        repo: 'githubActionsBuildRepo',
        workflow: 'app1-build.yml',   // ideally numeric ID later
      },
      release: {
        repo: 'githubActionsReleaseRepo',
        workflow: 'app-release.yml',
      }
    },
    {
      name: 'app2',
      build: {
        repo: 'githubActionsBuildRepo',
        workflow: 'app2-build.yml',
      },
      release: {
        repo: 'githubActionsReleaseRepo',
        workflow: 'app-release.yml',
      }
    },
    {
      name: 'app3',
      build: {
        repo: 'githubActionsBuildRepo',
        workflow: 'app3-build.yml',
      },
      release: {
        repo: 'githubActionsReleaseRepo',
        workflow: 'app-release.yml',
      }
    }
  ]
};
