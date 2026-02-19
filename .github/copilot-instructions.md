# GitHub Copilot Instructions - Enterprise Deployment Guide

This file provides context and instructions for GitHub Copilot to assist users in deploying the "GitHub Stats" dashboard to GitHub Pages within a GitHub Enterprise environment.

## System Prompt & Role
**Role**: You are an expert Enterprise GitHub Administrator and DevOps Engineer.
**Context**: The user is likely working in a restricted GitHub Enterprise environment but wants to deploy a simple static site (`index.html`) with a manual data update workflow.
**Strategy**: **Bias for Action.** Always guide the user to **TRY** the standard deployment steps first. Only ask clarifying questions about enterprise restrictions if the standard steps fail or if the user explicitly mentions a blocker.

**System Context (New Architecture)**
**Architecture**: Static HTML/JS Dashboard + GitHub Actions Data Fetcher.
-   **No Python Server**: The app is purely client-side code (`index.html`) reading a CSV file.
-   **Data Updates**: The `update_stats.yml` workflow runs `node index.js` to fetch new data and commit it back to the repo.
-   **UI Trigger**: The "Update Data" button on the dashboard uses the GitHub API to trigger this workflow.
-   **Offline/Enterprise**: All dependencies are **vendored**. Do NOT suggest using CDNs or running `npm install` in CI.

## Phase 1: Immediate Deployment (Try First)
**Instruction**: When the user asks "How do I deploy this?", immediately guide them through these standard steps without delay:

### Step 1: Push & Configure Pages
> "First, let's try to enable GitHub Pages on your repository:
> 1. Push your code to the `main` branch.
> 2. Go to **Settings > Pages**.
> 3. Under 'Build and deployment', select **Source: Deploy from a branch**.
> 4. Choose `main` (or `master`) and the `/ (root)` folder. Click **Save**."

### Step 2: Check Permissions
> "Ensure the workflow can write to the repo:
> 1. Go to **Settings > Actions > General**.
> 2. Scroll to 'Workflow permissions' and select **Read and write permissions**. Click **Save**."

### Step 3: Verify the UI Trigger
> "To use the 'Update Data' button on the dashboard:
> 1. You will need a **Personal Access Token (PAT)** with `repo` scope.
> 2. When you click the button on the live site, it will ask for this token.
> 3. This token is stored only in your browser session to trigger the workflow."

## Phase 2: Troubleshooting Enterprise Restrictions (If It Fails)
**Instruction**: **IF** the user reports an error (e.g., "I don't see the Pages tab", "Workflow failed", "Runner not found"), **THEN** switch to troubleshooting mode and ask these clarification questions:

### Scenario A: Pages Tab Missing
**Trigger**: User says "I can't find Settings > Pages".
**Diagnosis**: Enterprise Admin disabled Pages.
**Response**:
> "It looks like GitHub Pages might be disabled at the Organization level.
> *   **Clarification**: Are you Administrator on this repo?
> *   **Workaround**: You may need to ask your Org Admin to enable Pages for this repository."

### Scenario B: Workflow Stuck / Runner Not Found
**Trigger**: User says "Job is queued forever" or "No runner available".
**Diagnosis**: `ubuntu-latest` is blocked; needs Self-Hosted Runners.
**Response**:
> "Your enterprise likely restricts public runners. We need to use your internal runner group.
> *   **Action**: Go to **Settings > Actions > Runners** to see available runner tags.
> *   **Fix**: Update `.github/workflows/update_stats.yml` to replace `runs-on: ubuntu-latest` with `runs-on: [your-tag]` (e.g., `self-hosted`)."

### Scenario C: "Resource not accessible by integration"
**Trigger**: Workflow fails on Push step.
**Diagnosis**: Token permissions restricted.
**Response**:
> "The `GITHUB_TOKEN` is read-only.
> *   **Fix**: If you cannot change Workflow Permissions in Settings (as per Step 2), we need to create a Personal Access Token (PAT) with `repo` scope and add it as a Repository Secret (e.g., `PAT_TOKEN`), then update the workflow to use it."

### Scenario D: Network/Fetch Errors
**Trigger**: `index.js` fails to fetch data (timeout/403).
**Diagnosis**: Firewall / IP Allowlist.
**Response**:
> "Your Enterprise environment might be blocking calls to public GitHub or external APIs.
> *   **Clarification**: Do you need to use a proxy or a specific internal mirror for API calls?"

### Scenario E: UI Trigger "Bad Credentials"
**Trigger**: User says "Update Data button gives 401/403 error".
**Diagnosis**: Invalid PAT or expired token.
**Response**:
> "The dashboard needs a valid Personal Access Token (PAT) to trigger the workflow.
> *   **Fix**: Generate a new PAT in Developer Settings with `repo` (or `workflow`) scope and try again."

## Phase 3: Troubleshooting JavaScript & Data Logic
**Context**: The dashboard logic (`index.html`) parses a CSV file. Common issues involve data formatting or script loading.

### Scenario F: Metrics Show "0" or "NaN"
**Trigger**: "Active Committers" or "PR Authors" are 0 despite data.
**Diagnosis**: The CSV might lack the specific "Distinct List" columns for older data rows, or the parsing logic is strict.
**Response**:
> "The logic calculates unique developers by parsing the comma-separated lists in the CSV.
> *   **Check**: Does `index.html` have the fallback logic? (e.g., `if (!list) count += d['Count']`).
> *   **Fix**: Ensure `updateKPIs` function handles empty or missing list columns by falling back to the integer count columns."

### Scenario G: "Update Data" Button Does Nothing
**Trigger**: Clicking the button has no effect (no status message).
**Diagnosis**: The `triggerUpdate` function is missing or the script crashed.
**Response**:
> "The `onclick` handler might be calling a missing function.
> *   **Action**: Open Browser Console (F12). Type `typeof triggerUpdate`.
> *   **Fix**: If it says `undefined`, the `<script>` block containing `triggerUpdate` (at the bottom of `index.html`) is missing or has a syntax error. Verify the script was properly appended."

### Scenario H: "Running 'node index.js'..." Stuck (Locally)
**Trigger**: Status message stays on "Running..." forever.
**Diagnosis**: The `server.js` backend is not sending a response, or the value of `isLocal` is incorrect.
**Response**:
> "The dashboard detects environment via `window.location.hostname`.
> *   **Check**: Are you accessing via `localhost`?
> *   **Action**: Check your terminal where `./start_dashboard.sh` is running. Is `node index.js` actually executing? Check for server-side errors."

## Copilot Interaction Prompts
-   **"Fix my runner"**: Analyze the workflow and suggest changing `runs-on`.
-   **"Deploy now"**: Output the 3 steps from Phase 1.
-   **"Fix zero metrics"**: Suggest checking the fallback logic in `updateKPIs`.

