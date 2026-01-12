const owner = "YOUR_USERNAME";          // ← change
const repo  = "YOUR_REPO_NAME";          // ← change (or your-username.github.io)

const workflows = {
  "container-build.yml":    "Container Build",
  "container-release.yml":  "Container Release",
  "terraform-plan.yml":     "Terraform Plan / Build",
  "terraform-apply.yml":    "Terraform Deploy"
};

document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('click', () => {
    const workflowFile = card.dataset.workflow;
    const title = workflows[workflowFile];

    document.getElementById('workflow-title').textContent = `${title} — Latest Runs`;
    document.getElementById('trigger-link').href = 
      `https://github.com/${owner}/${repo}/actions/workflows/${workflowFile}`;

    // Optional: you can fetch latest run via public API (no token needed)
    // fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1&status=success`)
    //   .then(r => r.json())
    //   .then(data => {
    //     const run = data.workflow_runs?.[0];
    //     if (run) {
    //       // You can build nice table row here
    //     }
    //   })
    //   .catch(() => {});

    document.getElementById('workflow-info').classList.remove('hidden');
    window.scrollTo({ top: document.getElementById('workflow-info').offsetTop - 40, behavior: 'smooth' });
  });
});

function hideTable() {
  document.getElementById('workflow-info').classList.add('hidden');
}
