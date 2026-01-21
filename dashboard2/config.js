// CI/CD DASHBOARD CONFIGURATION FILE
// This file configures:
// 1. GitHub organization/owner
// 2. Teams and their permissions
// 3. User roles and access control
// 4. Application repositories and workflows

module.exports = {
  
  // GITHUB CONFIGURATION
  
  // Your GitHub organization or username
  owner: 'dpdeepankar',  // Example: 'microsoft', 'google', 'mycompany'
  
  // GitHub Personal Access Token (should be stored in .env file)
  // Create one at: https://github.com/settings/tokens
  // Required scopes: repo, workflow
  token: process.env.GITHUB_TOKEN,
  
  
  // TEAMS CONFIGURATION
  // Define your teams, their branches, apps, and permissions
  
  teams: {
    
    // EXAMPLE TEAM 1: Frontend Team
    frontend: {
      // Display name shown in the UI
      name: 'Frontend Team',
      
      // Branches this team can work with
      branches: ['main', 'dev01', 'dev02', 'dev03'],
      
      // Apps/services owned by this team
      // These names must match the 'name' field in appRepos below
      apps: ['app1', 'app2'],
      
      // Role-based permissions for different actions
      permissions: {
        // Who can trigger builds
        trigger_build: ['developer', 'lead', 'admin'],
        
        // Who can trigger releases/deployments
        trigger_release: ['lead', 'admin'],
        
        // Who can approve releases
        approve_release: ['lead', 'admin'],
        
        // Who can view logs
        view_logs: ['developer', 'lead', 'admin'],
        
        // Who can restart services
        restart_services: ['lead', 'admin']
      }
    },
    
    // EXAMPLE TEAM 2: Backend Team
    backend: {
      name: 'Backend Team',
      branches: ['main', 'dev01', 'dev02', 'dev03'],
      apps: ['app3'],
      permissions: {
        trigger_build: ['developer', 'lead', 'admin'],
        trigger_release: ['lead', 'admin'],
        approve_release: ['admin'],  // Only admins can approve backend releases
        view_logs: ['developer', 'lead', 'admin'],
        restart_services: ['admin']  // Only admins can restart backend services
      }
    },
    
  //   // EXAMPLE TEAM 3: DevOps Team
  //   devops: {
  //     name: 'DevOps Team',
  //     branches: ['main', 'develop', 'staging', 'production'],
  //     apps: ['infrastructure', 'monitoring-service', 'ci-cd-pipeline'],
  //     permissions: {
  //       trigger_build: ['lead', 'admin'],
  //       trigger_release: ['admin'],
  //       approve_release: ['admin'],
  //       view_logs: ['lead', 'admin'],
  //       restart_services: ['admin']
  //     }
  //   },
    
  //   // EXAMPLE TEAM 4: Data Team
  //   data: {
  //     name: 'Data Engineering',
  //     branches: ['main', 'develop'],
  //     apps: ['data-pipeline', 'analytics-service'],
  //     permissions: {
  //       trigger_build: ['developer', 'lead', 'admin'],
  //       trigger_release: ['lead', 'admin'],
  //       approve_release: ['lead', 'admin'],
  //       view_logs: ['developer', 'lead', 'admin'],
  //       restart_services: ['admin']
  //     }
  //   }
   },
  
  
  // USER ROLES & ACCESS CONTROL
  // Define users, their roles, and which teams they belong to
  // In production, this should come from your authentication system
  
  userRoles: {
    
    // ADMINS - Full access to everything
    'john.doe': {
      role: 'admin',
      teams: [ 'frontend','backend', 'devops', 'data'],  // All teams
      password: 'password123'  // Change this in production!
    },
    
    'jane.smith': {
      role: 'admin',
      teams: ['frontend', 'devops', 'data'],
      password: 'password123'
    },
    
    // TEAM LEADS - Can manage their team's workflows
    'alice.frontend': {
      role: 'lead',
      teams: ['frontend'],  // Only frontend team
      password: 'password123'
    },
    
    'bob.backend': {
      role: 'lead',
      teams: ['backend'],
      password: 'password123'
    },
    
    'charlie.devops': {
      role: 'lead',
      teams: ['devops'],
      password: 'password123'
    },
    
    // DEVELOPERS - Can trigger builds and view logs
    'dev1': {
      role: 'developer',
      teams: ['frontend'],
      password: 'password123'
    },
    
    'dev2': {
      role: 'developer',
      teams: ['backend'],
      password: 'password123'
    },
    
    'dev3': {
      role: 'developer',
      teams: ['frontend', 'backend'],  // Developer on multiple teams
      password: 'password123'
    },
    
    // VIEWERS - Read-only access (if you add this role)
    'viewer.user': {
      role: 'viewer',
      teams: ['frontend', 'backend'],
      password: 'password123'
    }
  },
  
  
  // APPLICATION REPOSITORIES - BUILD WORKFLOWS
  // Define all your apps that have BUILD workflows
  
  appRepos: [
    
    // FRONTEND APPS
    {
      name: 'app1',                    // App name (must match teams.apps)
      repo: 'githubActionsBuildRepo',       // GitHub repository name
      buildWorkflow: 'app1-build.yml'          // Build workflow filename in .github/workflows/
    },
    
    {
      name: 'app2',
      repo: 'githubActionsBuildRepo',
      buildWorkflow: 'app2-build.yml'
    },
    
    // BACKEND APPS
    {
      name: 'app3',
      repo: 'githubActionsBuildRepo',
      buildWorkflow: 'app3-build.yml'
    }
   
  ],
  
  
  // RELEASE WORKFLOWS (Optional - for apps that have separate release workflows)
  // Define apps that have RELEASE/DEPLOYMENT workflows
  
  releaseRepos: [
    
    // FRONTEND RELEASES
    {
      appName: 'app1',                 // Must match appRepos[].name
      repo: 'githubActionsReleaseRepo',       // GitHub repository
      releaseWorkflow: 'app-release.yml'      // Release workflow filename
    },
    
    {
      appName: 'app2',
      repo: 'githubActionsReleaseRepo',
      releaseWorkflow: 'app-release.yml'
    },
    
   
    
    // BACKEND RELEASES
     {
      appName: 'app3',
      repo: 'githubActionsReleaseRepo',
      releaseWorkflow: 'app-release.yml'
    }
  ]

};


// HOW TO ADD A NEW APP
/*

STEP 1: Add the app to a team
Edit the team's 'apps' array:

teams: {
  frontend: {
    name: 'Frontend Team',
    branches: ['main', 'develop'],
    apps: ['web-app', 'mobile-app', 'NEW-APP-NAME'],  // ← Add here
    permissions: { ... }
  }
}


STEP 2: Add the build configuration
Add an entry to appRepos:

appRepos: [
  ...existing apps,
  {
    name: 'NEW-APP-NAME',              // Same as in team's apps array
    repo: 'github-repo-name',          // Your GitHub repository name
    buildWorkflow: 'build.yml'         // Workflow file in .github/workflows/
  }
]


STEP 3: (Optional) Add release configuration
If the app has a separate release workflow:

releaseRepos: [
  ...existing releases,
  {
    appName: 'NEW-APP-NAME',           // Must match appRepos name
    repo: 'github-repo-name',          // Same repository
    releaseWorkflow: 'release.yml'     // Release workflow file
  }
]


STEP 4: Restart the dashboard
node index.js

The new app will now appear in:
✓ Team's app list
✓ Build triggers
✓ Release triggers
✓ Dashboard tables

*/


// WORKFLOW FILE NAMING CONVENTIONS
/*

Your GitHub Actions workflow files should follow a naming pattern:

BUILD WORKFLOWS (for development/testing):
.github/workflows/build.yml
.github/workflows/app-build.yml
.github/workflows/test-and-build.yml

These workflows typically:
- Run on push/PR to develop branches
- Compile code
- Run tests
- Build Docker images
- Push to artifact registry (with dev tags)


RELEASE WORKFLOWS (for production deployment):
.github/workflows/release.yml
.github/workflows/deploy.yml
.github/workflows/deploy-production.yml

These workflows typically:
- Run on manual trigger or tag push
- Pull tested artifacts
- Deploy to staging/production
- Run smoke tests
- Perform blue-green deployments
- Update service versions

*/


// WORKFLOW NAMING PATTERN FOR DASHBOARD PARSING
/*

The dashboard expects workflow run names in these formats:

BUILD RUNS:
Format: branchname-appname-build-version
Examples:
  - main-web-app-build-v1.2.3
  - develop-api-service-build-v2.0.0
  - feature/new-ui-mobile-app-build-v1.5.0

RELEASE RUNS:
Format: branchname-appname-release-version-commit
Examples:
  - main-web-app-release-v1.2.3-abc1234
  - production-api-service-release-2.0.0-def5678

To set this in your GitHub Actions workflow:

jobs:
  build:
    name: ${{ github.ref_name }}-my-app-build-${{ github.run_number }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      ...

*/


// EXAMPLE: MINIMAL CONFIGURATION FOR GETTING STARTED
/*

// Minimal config.js to get started:

module.exports = {
  owner: 'your-github-username',
  token: process.env.GITHUB_TOKEN,
  
  teams: {
    myteam: {
      name: 'My Team',
      branches: ['main', 'develop'],
      apps: ['my-app'],
      permissions: {
        trigger_build: ['admin'],
        trigger_release: ['admin'],
        approve_release: ['admin'],
        view_logs: ['admin'],
        restart_services: ['admin']
      }
    }
  },
  
  userRoles: {
    'admin': { role: 'admin', teams: ['myteam'] }
  },
  
  appRepos: [
    {
      name: 'my-app',
      repo: 'my-app-repository',
      buildWorkflow: 'build.yml'
    }
  ],
  
  releaseRepos: [
    {
      appName: 'my-app',
      repo: 'my-app-repository',
      releaseWorkflow: 'release.yml'
    }
  ]
};

*/
