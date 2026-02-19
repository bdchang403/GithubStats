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

*   **KPI Cards**: Total Commits, Merged PRs, Active Developers (Unique), Review Velocity.
*   **Trend Analysis**: Line charts showing metric growth over time.
*   **Comparisons**: Scatter plots for Review Time vs. Lines of Code.
*   **Filtering**: Date range and Repository selection.
*   **UI Data Trigger**: Trigger a fresh data update directly from the dashboard (uses GitHub API).

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

### 3. Configure Environment
1. Create a `.env` file (copy from `.env.example` if available, or create new):
   ```bash
   cp .env.example .env
   ```
2. Add your GitHub Token and (optional) Enterprise API URL:
   ```ini
   GITHUB_TOKEN=your_personal_access_token
   
   # NOTE: For GitHub Enterprise Cloud (https://github.com/your-company), 
   # you do NOT need to set GITHUB_API_BASE_URL. It defaults to api.github.com.

   # Optional: Only for Enterprise Server (Self-Hosted):
   # GITHUB_API_BASE_URL=https://github.company.com/api/v3

   # Optional: Comma-separated list of repos (owner/name)
   INPUT_REPOS=facebook/react,vuejs/vue 
   ```
4.  **Start the App**:
    ```bash
    ./start_dashboard.sh
    ```
    - Opens dashboard at `http://localhost:8080`.
    - Local "Update Data" button runs `node index.js` immediately.

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
