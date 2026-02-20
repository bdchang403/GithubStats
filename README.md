# GitHub Stats Dashboard

A static, serverless dashboard for visualizing GitHub repository metrics (commits, PRs, velocity, quality). 
Built with **HTML/JS** and powered by **GitHub Actions**.

![Dashboard Status](https://img.shields.io/badge/Status-Active-success)
![Deployment](https://img.shields.io/badge/Deployment-GitHub%20Pages-blue)

## 🚀 Overview

This dashboard provides engineering insights by analyzing GitHub repositories. 
Unlike traditional apps requiring a backend server, this project uses a **Self-Updating Static Architecture**:

1.  **Data Fetching**: A Node.js script (`index.js`) runs via GitHub Actions.
2.  **Data Storage**: Metrics are saved to a CSV file (`github_stats_history.csv`) in the repo.
3.  **Visualization**: A static `index.html` page fetches the raw CSV from the repo and renders charts using Chart.js.

## ✨ Features

*   **KPI Cards**: Total Commits, Merged PRs, Active Developers, Review Velocity, Code Churn.
*   **DORA & SPACE Metrics**: Lead Time to Production, CI/CD Failure Rates, Mean Time to Recover (Security), and Wait Times versus Code Churn.
*   **AI Proxies**: Test Scaffold Quality vs Change Failure Rate bubble charts correlating AI adoption with boilerplate velocity.
*   **Third-Party Integrations**: Cross-reference pull requests against Jira / ServiceNow IDs, and extract SonarQube unit tests, security ratings, and tech debt.
*   **UI Data Trigger**: Trigger a fresh data update directly from the dashboard.

## 🚀 Installation & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/your-org/GithubStats.git
cd GithubStats
```

### 2. Dependencies (Pre-installed)
⚠️ **NOTE:** All dependencies are **vendored** and committed to the repository to support offline/enterprise environments.
- **Backend:** `node_modules/` is included. **Do NOT run `npm install`.**
- **Frontend:** Libraries (Chart.js, PapaParse) are in `vendor/`.

### 3. Configure Input Data & Integrations
For security, repository tracking databases and API configurations have been moved to template files. You must instantiate them locally or in your CI/CD runner:
1. Copy all `.csv.template` files to `.csv`:
   ```bash
   cp github_input.csv.template github_input.csv
   cp github_stats_history.csv.template github_stats_history.csv
   cp github_stats_output.csv.template github_stats_output.csv
   cp github_activity_log.csv.template github_activity_log.csv
   ```
2. Define the repositories to scan in `github_input.csv`. 
   - Note: The third column allows you to specify `SonarQubeProjectKey` overrides. For monorepos or repos with multiple SonarQube projects, you can append multiple keys separated by pipes (`|`) or semicolons (`;`).
3. Set up integrations (`integration_config.json`):
   ```bash
   cp integration_config.json.template integration_config.json
   ```
   Edit the file to inject your SonarQube, Jira, or ServiceNow credentials and endpoint URL arrays. Multiple auth methods (Bearer Tokens vs Basic Auth) are supported.

### 4. Configure Environment Secrets
1. Create a `.env` file (copy from `.env.example` if available, or create new):
   ```bash
   cp .env.example .env
   ```
2. Add your GitHub PAT:
   ```ini
   GITHUB_TOKEN=your_personal_access_token
   
   # NOTE: For GitHub Enterprise Cloud, defaults to api.github.com.
   # For Enterprise Server (Self-Hosted):
   # GITHUB_API_BASE_URL=https://github.company.com/api/v3
   ```

### 5. Start the Dashbord
```bash
./start_dashboard.sh
```
- Opens dashboard at `http://localhost:8080`.
- Local "Update Data" button runs `node index.js` immediately.

## 🐛 Troubleshooting & Logs
If your dashboard metrics say `Unknown`, `N/A`, or data fails to populate during an update cycle:
- Check `run_errors.log` in the root directory. API connection failures (401 Unauthorized, 404 Not Found, 429 Rate Limits) across GitHub, SonarQube, Jira, and ServiceNow are intercepted and appended here with precise ISO timestamps.

## 📦 Deployment (GitHub Pages)

This app is designed to run on GitHub Pages.

1.  **Enable Pages**:
    - Go to **Settings > Pages**.
    - Source: **Deploy from a branch** (`main` / root).
2.  **Permissions**:
    - Go to **Settings > Actions > General**.
    - Workflow permissions: **Read and write permissions** (needed for the Action to commit data).
3.  **Usage**:
    - The dashboard will load data from `github_stats_history.csv`.
    - **To Update Data**: Click the **"🔄 Update Data"** button on the dashboard.
        - The workflow will run (~2 mins), commit new data, and the dashboard will update on next refresh.

## 🏢 Enterprise / Offline Mode

For environments with restricted internet access:
*   **Frontend**: `Chart.js` and `PapaParse` are vendored in `vendor/`. `index.html` uses these local files instead of CDNs.
*   **Backend**: `node_modules/` is committed to the repo. `npm install` is NOT required during deployment.
*   **Updates**: When adding new dependencies, you must commit them to `node_modules/` or `vendor/`.

## 📂 Project Structure

-   `index.html`: The main dashboard UI (Chart.js, PapaParse).
-   `index.js`: Data fetching logic (GitHub API -> CSV).
-   `server.js`: Simple Express server for local development.
-   `.github/workflows/update_stats.yml`: The automation brain.
-   `github_stats_history.csv`: The database (Git-backed).

## 🔧 Enterprise & Copilot

For users deploying in restricting Enterprise environments, see:
-   [Copilot Instructions](.github/copilot-instructions.md): Guide for fixing runner/network issues.
