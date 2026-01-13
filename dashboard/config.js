// config.js
module.exports = {
  owner: process.env.OWNER || 'dpdeepankar',  // fallback if env not set

  token: process.env.GITHUB_TOKEN,

  // Build pipelines – add new apps here when needed
  appRepos: [
    { name: 'app1', repo: 'githubActionsBuildRepo', buildWorkflow: 'app1-build.yml' },
    { name: 'app2', repo: 'githubActionsBuildRepo', buildWorkflow: 'app2-build.yml' },
    { name: 'app3', repo: 'githubActionsBuildRepo', buildWorkflow: 'app3-build.yml' },

    // Example how to add a new one:
    // { name: 'payment-service', repo: 'githubActionsBuildRepo', buildWorkflow: 'payment-build.yml' },
    // { name: 'mobile-app',      repo: 'mobile-repo',           buildWorkflow: 'ci-mobile.yml'     },
  ],

  // Release pipelines – one entry per application
  // Add new ones here the same way you add build pipelines
  releaseRepos: [
    { appName: 'app1', repo: 'githubActionsReleaseRepo', releaseWorkflow: 'app-release.yml' },
    { appName: 'app2', repo: 'githubActionsReleaseRepo', releaseWorkflow: 'app-release.yml' },
    { appName: 'app3', repo: 'githubActionsReleaseRepo', releaseWorkflow: 'app-release.yml' },


    // Example how to add a new one:
    // { appName: 'payment-service', repo: 'githubActionsReleaseRepo', releaseWorkflow: 'release-payment.yml' },
  ],
};
