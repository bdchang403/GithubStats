const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

// --- Configuration ---
const CONFIG_path = path.join(__dirname, 'config', '.env');
const ENV = process.env;

const API_CACHE_DIR = path.join(__dirname, '.api_cache');
if (!fs.existsSync(API_CACHE_DIR)) {
    fs.mkdirSync(API_CACHE_DIR);
}

function loadEnv() {
    const paths = [
        path.join(__dirname, 'config', '.env'),
        path.join(__dirname, '.env')
    ];

    paths.forEach(p => {
        if (fs.existsSync(p)) {
            console.log(`Loading env from ${p}`);
            const content = fs.readFileSync(p, 'utf-8');
            content.split('\n').forEach(line => {
                const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
                if (match && !match[1].startsWith('#')) {
                    ENV[match[1]] = match[2] ? match[2].trim() : '';
                }
            });
        }
    });
}
loadEnv();

const GITHUB_TOKEN = ENV.GITHUB_TOKEN;
const API_BASE_URL = (ENV.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/$/, '');

const ENABLE_DEBUG_LOGGING = ENV.ENABLE_DEBUG_LOGGING === 'true';

// Optionally hijack console.log and console.warn to suppress noise unless debugging
const originalLog = console.log;
const originalWarn = console.warn;
console.log = function (...args) {
    if (ENABLE_DEBUG_LOGGING) originalLog.apply(console, args);
};
console.warn = function (...args) {
    if (ENABLE_DEBUG_LOGGING) originalWarn.apply(console, args);
};

// Function for dashboard ETA reporting
function writeStatus(processed, total, currentRepo, startTime) {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const avgSecPerRepo = processed > 0 ? elapsedSec / processed : 0;
    const remainingSec = avgSecPerRepo * (total - processed);
    const statusData = {
        status: currentRepo ? `Processing ${currentRepo}...` : "Idle",
        processed,
        total,
        etaSeconds: Math.round(remainingSec)
    };
    try {
        fs.writeFileSync(path.join(__dirname, 'status.json'), JSON.stringify(statusData));
    } catch (e) { }
}

// Reset status immediately on startup
writeStatus(0, 0, "Initializing Extractor...", Date.now());

// The maximum number of recent PRs to query per repository.
// High values exponentially increase API load due to downstream files/commits/reviews queries per PR.
const maxPrsLimit = parseInt(ENV.MAX_PRS_TO_ANALYZE || "30", 10);

// --- External Integration Config ---
let integrationConfig = null;
try {
    const configPath = path.join(__dirname, 'integration_config.json');
    if (fs.existsSync(configPath)) {
        integrationConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log("Loaded external integration config for Jira/ServiceNow.");
    }
} catch (e) {
    console.warn("Failed to load integration_config.json:", e.message);
}

// --- Helpers ---

function logError(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ERROR: ${message}\n`;
    try {
        fs.appendFileSync(path.join(__dirname, 'run_errors.log'), logMessage);
    } catch (e) {
        // Fallback to console only
    }
    console.error(message);
}

// Simple CSV Parser (handles quotes)
function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length === 0) return [];

    // Header parsing
    const headers = parseCSVLine(lines[0]);
    const result = [];

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const values = parseCSVLine(lines[i]);
        const obj = {};
        headers.forEach((h, index) => {
            obj[h] = values[index] || '';
        });
        result.push(obj);
    }
    return result;
}

function parseCSVLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    values.push(current.trim());
    return values.map(v => v.replace(/^"|"$/g, '').replace(/""/g, '"'));
}

async function fetchGitHub(url) {
    const cacheKey = crypto.createHash('md5').update(url).digest('hex');
    const cacheFile = path.join(API_CACHE_DIR, `${cacheKey}.json`);
    let cachedData = null;

    if (fs.existsSync(cacheFile)) {
        try {
            cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        } catch (e) {
            // Corrupt cache file, ignore
        }
    }

    const headers = {
        'User-Agent': 'NodeJS-Collector',
        'Accept': 'application/vnd.github.v3+json'
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    else console.warn("Warning: GITHUB_TOKEN not set. Rate limits apply.");

    if (cachedData && cachedData.etag) {
        headers['If-None-Match'] = cachedData.etag;
    }

    let retries = 3;
    while (retries > 0) {
        try {
            const response = await fetch(url, { headers });

            // Rate limit handling
            const remaining = parseInt(response.headers.get('x-ratelimit-remaining') || '100', 10);
            if (remaining < 10) {
                const resetTime = parseInt(response.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
                const now = Date.now();
                if (resetTime > now) {
                    const waitMs = resetTime - now + 5000; // 5s cushion
                    console.warn(`Rate limit critically low (${remaining}). Waiting ${Math.round(waitMs / 1000)}s for reset...`);
                    await new Promise(r => setTimeout(r, waitMs));
                }
            }

            if (response.status === 403 || response.status === 429) {
                const remaining = parseInt(response.headers.get('x-ratelimit-remaining') || '100', 10);
                const retryAfter = response.headers.get('retry-after');

                // Only sleep if it's an ACTUAL rate limit (Remaining 0) OR a secondary token limit (retry-after)
                if (remaining === 0 || retryAfter) {
                    let waitMs = 0;
                    if (retryAfter) {
                        waitMs = parseInt(retryAfter, 10) * 1000 + 5000;
                    } else {
                        const resetTime = parseInt(response.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
                        const now = Date.now();
                        waitMs = (resetTime > now) ? (resetTime - now + 5000) : 60000;
                    }

                    console.warn(`Rate limited (403/429). Waiting ${Math.round(waitMs / 1000)}s...`);
                    await new Promise(r => setTimeout(r, waitMs));
                    retries--;
                    continue;
                }

                // If it's 403 but NOT a rate limit (e.g., Advanced Security disabled, or issues disabled on repo)
                if (response.status === 403) {
                    console.warn(`Access denied for ${url} (Feature disabled or lack of repo scope).`);
                    return { _status: 403, data: [] }; // Special return for graceful degradation
                }
            }

            if (response.status === 304 && cachedData) {
                return {
                    data: cachedData.data,
                    headers: new Headers(cachedData.headers),
                    _status: 304
                };
            }

            if (!response.ok) {
                // Suppress 404 console noise ONLY for optional config files (CICD.yml, CT.yml)
                const isOptionalFile = url.endsWith('CICD.yml') || url.endsWith('CT.yml');
                if (!(response.status === 404 && isOptionalFile)) {
                    logError(`Error ${response.status} fetch ${url}`);
                }
                return null;
            }

            const data = await response.json();

            const etag = response.headers.get('etag');
            if (etag) {
                const cacheToSave = {
                    etag: etag,
                    headers: Array.from(response.headers.entries()),
                    data: data
                };
                try {
                    fs.writeFileSync(cacheFile, JSON.stringify(cacheToSave));
                } catch (e) {
                    // Ignore write fails
                }
            }

            return {
                data,
                headers: response.headers,
                _status: response.status
            };
        } catch (e) {
            logError(`Fetch error for ${url}: ${e.message}`);
            retries--;
            if (retries === 0) return null;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return null;
}

// Helper to extract the 'next' URL from the Link header
function getNextLink(linkHeader) {
    if (!linkHeader) return null;
    const links = linkHeader.split(', ');
    for (const link of links) {
        const match = link.match(/<([^>]+)>;\s*rel="next"/);
        if (match) return match[1];
    }
    return null;
}

// Fetch all pages of a paginated API
async function fetchGitHubPaginated(url, maxPages = 10) {
    let results = [];
    let currentUrl = url;
    let pagesFetched = 0;

    while (currentUrl && pagesFetched < maxPages) {
        const res = await fetchGitHub(currentUrl);
        if (!res) break;

        // Handle the special 403 fallback case for code-scanning
        if (res._status === 403) break;

        const { data, headers } = res;

        if (Array.isArray(data)) {
            results = results.concat(data);
        } else if (data && data.items && Array.isArray(data.items)) { // Search API
            results = results.concat(data.items);
        } else if (data && data.workflow_runs && Array.isArray(data.workflow_runs)) { // Actions API
            results = results.concat(data.workflow_runs);
        } else {
            break; // Unknown format
        }

        pagesFetched++;
        currentUrl = getNextLink(headers.get('link'));
    }
    return results;
}

// --- External API Cross-Referencing ---
const defectCache = {};

async function checkExternalDefect(text) {
    if (!integrationConfig || !text) return null;

    // Attempt cache hit
    if (defectCache[text] !== undefined) {
        return defectCache[text];
    }

    // Try Jira
    if (integrationConfig.jira && integrationConfig.jira.enabled) {
        const regex = new RegExp(integrationConfig.jira.regexPattern, 'i');
        const match = text.match(regex);
        if (match) {
            const issueKey = match[1];
            try {
                const url = `${integrationConfig.jira.baseUrl.replace(/\/$/, '')}/rest/api/2/issue/${issueKey}`;
                let authHeader = '';
                if (integrationConfig.jira.auth.bearerToken) {
                    authHeader = `Bearer ${integrationConfig.jira.auth.bearerToken}`;
                } else if (integrationConfig.jira.auth.username) {
                    const auth = Buffer.from(`${integrationConfig.jira.auth.username}:${integrationConfig.jira.auth.apiToken}`).toString('base64');
                    authHeader = `Basic ${auth}`;
                }
                const response = await fetch(url, {
                    headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
                });

                if (response.status === 401 || response.status === 403) {
                    logError(`[Access Error] Jira API access denied (${response.status}) for ${issueKey}. Marking as Unverified.`);
                    return "Unverified";
                }

                if (response.ok) {
                    const data = await response.json();
                    const issueType = data.fields && data.fields.issuetype ? data.fields.issuetype.name : "Unknown";
                    const isDefect = integrationConfig.jira.mappings.defectTypes.some(t => t.toLowerCase() === issueType.toLowerCase());

                    let createdAt = data.fields.created ? new Date(data.fields.created) : null;
                    let resolvedAt = data.fields.resolutiondate ? new Date(data.fields.resolutiondate) : null;

                    const result = { isDefect, createdAt, resolvedAt };
                    defectCache[text] = result;
                    return result;
                }
                const result = { isDefect: false, createdAt: null, resolvedAt: null };
                defectCache[text] = result;
                return result;
            } catch (e) {
                logError(`Jira API error for ${issueKey}: ${e.message}`);
                return "Unverified";
            }
        }
    }

    // Try ServiceNow
    if (integrationConfig.serviceNow && integrationConfig.serviceNow.enabled) {
        const regex = new RegExp(integrationConfig.serviceNow.regexPattern, 'i');
        const match = text.match(regex);
        if (match) {
            const issueKey = match[1];
            try {
                let table = 'incident';
                if (issueKey.startsWith('CHG')) table = 'change_request';
                else if (issueKey.startsWith('PRB')) table = 'problem';

                const url = `${integrationConfig.serviceNow.baseUrl.replace(/\/$/, '')}/api/now/table/${table}?sysparm_query=number=${issueKey}&sysparm_limit=1`;
                let authHeader = '';
                if (integrationConfig.serviceNow.auth.bearerToken) {
                    authHeader = `Bearer ${integrationConfig.serviceNow.auth.bearerToken}`;
                } else if (integrationConfig.serviceNow.auth.username) {
                    const auth = Buffer.from(`${integrationConfig.serviceNow.auth.username}:${integrationConfig.serviceNow.auth.password}`).toString('base64');
                    authHeader = `Basic ${auth}`;
                }
                const response = await fetch(url, {
                    headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
                });

                if (response.status === 401 || response.status === 403) {
                    logError(`[Access Error] ServiceNow API access denied (${response.status}) for ${issueKey}. Marking as Unverified.`);
                    return "Unverified";
                }

                if (response.ok) {
                    const json = await response.json();
                    if (json.result && json.result.length > 0) {
                        const incident = json.result[0];
                        const isDefect = integrationConfig.serviceNow.mappings.defectTypes.includes(table.toLowerCase());

                        let createdAt = incident.sys_created_on ? new Date(incident.sys_created_on + " UTC") : null;
                        let resolvedAt = incident.resolved_at ? new Date(incident.resolved_at + " UTC") : (incident.closed_at ? new Date(incident.closed_at + " UTC") : null);

                        const result = { isDefect, createdAt, resolvedAt };
                        defectCache[text] = result;
                        return result;
                    }
                }
                const result = { isDefect: false, createdAt: null, resolvedAt: null };
                defectCache[text] = result;
                return result;
            } catch (e) {
                logError(`ServiceNow API error for ${issueKey}: ${e.message}`);
                return "Unverified";
            }
        }
    }

    return null; // No match found
}

// --- SonarQube Integration ---
async function fetchSonarQubeMetrics(repoName, explicitProjectKeysStr) {
    if (!integrationConfig || !integrationConfig.sonarQube || !integrationConfig.sonarQube.enabled) {
        return null;
    }

    if (!explicitProjectKeysStr) {
        return null;
    }

    const sqConfig = integrationConfig.sonarQube;
    const projectKeys = explicitProjectKeysStr.split(/[|,;]+/).map(k => k.trim()).filter(k => k);
    const metrics = sqConfig.metrics.join(',');

    const aggregatedResult = {};
    let successCount = 0;

    for (const projectKey of projectKeys) {
        const url = `${sqConfig.baseUrl.replace(/\/$/, '')}/api/measures/component?component=${projectKey}&metricKeys=${metrics}`;

        try {
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${sqConfig.auth.token}`, 'Accept': 'application/json' }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.component && data.component.measures) {
                    successCount++;
                    data.component.measures.forEach(m => {
                        const val = parseFloat(m.value) || 0;
                        if (m.metric === 'security_rating') {
                            // Take the worst (highest number) rating
                            aggregatedResult[m.metric] = Math.max((parseFloat(aggregatedResult[m.metric]) || 0), val).toString();
                        } else {
                            // Sum quantitative metrics
                            aggregatedResult[m.metric] = ((parseFloat(aggregatedResult[m.metric]) || 0) + val).toString();
                        }
                    });
                }
            } else {
                logError(`SonarQube API error (${response.status}) for project ${projectKey}`);
            }
        } catch (e) {
            logError(`SonarQube fetch error for ${projectKey}: ${e.message}`);
        }
    }

    return successCount > 0 ? aggregatedResult : null;
}

// --- Logic ---

function getEnvironment(branch) {
    if (!branch) return "Unknown";
    const b = branch.toLowerCase();
    if (["develop", "dev", "feature"].some(x => b.includes(x))) return "Development";
    if (["sit", "test", "staging"].some(x => b.includes(x))) return "SIT";
    if (["pat", "uat", "release", "pre-prod"].some(x => b.includes(x))) return "PAT";
    if (["main", "master", "prod"].some(x => b.includes(x))) return "Production";
    return "Other";
}

function extractCrossRefID(message) {
    if (!message) return null;
    const snowMatch = message.match(/(CHG\d+)/i);
    if (snowMatch) return snowMatch[1].toUpperCase();

    const jiraMatch = message.match(/([A-Z]{2,}-\d+)/);
    if (jiraMatch) return jiraMatch[1];

    const verMatch = message.match(/(v\d+\.\d+\.\d+)/);
    if (verMatch) return verMatch[1];

    return null;
}

function extractAssociatedPR(message) {
    if (!message) return null;
    // Squash: "Title (#123)"
    const squash = message.match(/\(#(\d+)\)/);
    if (squash) return `PR #${squash[1]}`;

    // Merge commit: "Merge pull request #123"
    const merge = message.match(/Merge pull request #(\d+)/);
    if (merge) return `PR #${merge[1]}`;

    return null;
}

const cicdCache = {}; // Cache to prevent redundant API calls for the same repo+sha

async function fetchCICDConfig(repoName, sha = null) {
    const cacheKey = `${repoName}:${sha || 'HEAD'}`;
    const headKey = `${repoName}:HEAD`;

    if (cicdCache[cacheKey] !== undefined) return cicdCache[cacheKey];

    // If we already know HEAD doesn't have CICD.yml, don't ping ancient SHAs 300 times
    if (sha && cicdCache[headKey] === false) {
        return null;
    }

    try {
        let url = `${API_BASE_URL}/repos/${repoName}/contents/CICD.yml`;
        if (sha) url += `?ref=${sha}`;

        const res = await fetchGitHub(url);
        const data = res ? res.data : null;
        if (data && data.content) {
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            if (!sha) console.log(`  Found CICD.yml in ${repoName}`);

            // Simple parser for boolean flags, supports spaces in keys (e.g. "Dev active")
            const lines = content.split('\n');
            let foundEnv = null;
            for (const line of lines) {
                const match = line.match(/^\s*([^:\n]+?)\s*:\s*(true|false)/i);
                if (match) {
                    const key = match[1].toLowerCase();
                    const val = match[2].toLowerCase() === 'true';

                    if (val) {
                        if (['prod', 'production', 'release'].some(k => key.includes(k))) { foundEnv = "Production"; break; }
                        if (['sit', 'staging', 'test'].some(k => key.includes(k))) { foundEnv = "SIT"; break; }
                        if (['dev', 'develop'].some(k => key.includes(k))) { foundEnv = "Development"; break; }
                        if (['pat', 'uat', 'pre-prod'].some(k => key.includes(k))) { foundEnv = "PAT"; break; }
                        if (['trust', 'trusted'].some(k => key.includes(k))) { foundEnv = "Trusted"; break; }
                    }
                }
            }
            if (foundEnv) {
                cicdCache[cacheKey] = foundEnv;
                return foundEnv;
            }
        }
    } catch (e) {
        // Ignore errors
    }
    cicdCache[cacheKey] = false; // Mark as definitively not found so we don't spam 404s
    return null;
}

async function processRepo(repoName, capability, sonarQubeKey, prevState) {
    console.log(`Processing ${repoName}...`);
    const stats = {
        Repository: repoName,
        Capability: capability,
        "Total Commits": 0,
        "Total Merged PRs": 0,
        "Last Commit Date": null,
        "Last PR Date": null,
        "Last Workflow Date": null,
        "Distinct Committers Count": 0,
        "Distinct PR Authors Count": 0,
        "Distinct Committers List": "",
        "Distinct PR Authors List": "",
        "Repo Type": "Unknown",
        "Environment": "Unknown", // New Field
        "Verification Status": "OK",
        "Timestamp Verification": "New Repository",
        // Metrics
        "Avg Branch Duration (Hours)": 0,
        "Avg Coding Time (Hours)": 0,
        "Avg Review Time (Hours)": 0,
        "Avg LOC Changed": 0,
        "Avg Review Time / LOC": 0,
        "MTTR-Sec (Hours)": 0,
        "Successful Deployments": 0,
        "Avg Review Comments per PR": 0,
        "Avg Wait Time for First Review (Hours)": 0,
        "Avg PR Description Length (Chars)": 0,
        "Small to Large PR Ratio": 0,
        "Change Failure Rate (%)": 0,
        "True Lead Time for Changes (Hours)": 0,
        "Lead Time to Production (Days)": 0,
        "CI/CD Failure Rate (%)": 0,
        "CI/CD Avg Execution Time (Mins)": 0,
        "Avg Code Churn (Commits)": 0,
        "SQ Security Rating": 0,
        "SQ Technical Debt (Days)": 0,
        "SQ Code Smells": 0,
        "SQ Vulnerabilities": 0
    };

    // Scan CICD.yml for Environment (HEAD)
    const edpEnv = await fetchCICDConfig(repoName);
    if (edpEnv) {
        stats["Environment"] = edpEnv;
    } else if (prevState && prevState["Environment"]) {
        stats["Environment"] = prevState["Environment"];
    }

    const logs = [];

    // 1. Commits
    let sinceParam = "";
    if (prevState && prevState["Last Commit Date"]) {
        sinceParam = `&since=${prevState["Last Commit Date"]}`;
        console.log(`  Fetching commits since ${prevState["Last Commit Date"]}`);
    }

    // Multiply the PR limit by 2 to give commits a healthier buffer (e.g., 600 commits instead of 300) without blowing out API
    const maxCommitPages = Math.ceil(maxPrsLimit / 100) * 2;
    const commitsRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/commits?per_page=100${sinceParam}`, maxCommitPages);
    const commits = (commitsRes && Array.isArray(commitsRes)) ? commitsRes : [];
    const committers = new Set();

    if (Array.isArray(commits)) {
        stats["Total Commits"] = commits.length;
        if (commits.length > 0) {
            stats["Last Commit Date"] = commits[0].commit.committer.date;
        }

        commits.forEach(c => {
            // Per user request: Use Email if available, else Name
            const authorName = c.commit.author.name || "Unknown";
            const authorEmail = c.commit.author.email;
            const author = authorEmail || authorName;
            committers.add(author);

            // Log Commit
            const crossRef = extractCrossRefID(c.commit.message);
            const assocPR = extractAssociatedPR(c.commit.message);

            logs.push({
                Timestamp: new Date().toISOString(),
                Repository: repoName,
                Capability: capability,
                Action: "Commit",
                User: author,
                Date: c.commit.committer.date,
                Environment: stats["Environment"] !== "Unknown" ? stats["Environment"] : getEnvironment("Unknown"),
                "Cross-Ref ID": crossRef,
                "Associated PR": assocPR,
                ID: c.sha.substring(0, 7),
                Message: c.commit.message.split('\n')[0].substring(0, 100),
                "Branch Duration (Hours)": null,
                "Review Time (Hours)": null,
                "LOC Changed": null,
                "PR Size (Commits)": null,
                "Target Branch": null
            });
        });
    }

    // Merge prev committers
    if (prevState && prevState["Distinct Committers List"]) {
        prevState["Distinct Committers List"].split(', ').forEach(c => {
            if (c) committers.add(c);
        });
    }
    stats["Distinct Committers Count"] = committers.size;
    stats["Distinct Committers List"] = Array.from(committers).sort().join(", ");

    // 2. Workflow Runs (Broad Fetch for both Failures and Success/Deploys)
    // Must be fetched BEFORE PRs so DORA Lead Time to Production has deployment timestamps
    let lastRunDate = prevState ? prevState["Last Workflow Date"] : null;
    let failedRuns = 0;
    let totalExecMinutes = 0;
    let execCount = 0;

    let successfulDeploys = 0;
    const recentDeploys = [];

    // Unified 3-page fetch gathering up to 300 runs
    const runsRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/actions/runs?per_page=100&sort=created_at&direction=desc`, 3);
    const runs = { workflow_runs: runsRes || [] };
    if (runs && runs.workflow_runs && runs.workflow_runs.length > 0) {
        stats["Last Workflow Date"] = runs.workflow_runs[0].created_at;

        runs.workflow_runs.forEach(r => {
            if (r.conclusion === "failure" || r.conclusion === "cancelled" || r.conclusion === "timed_out") failedRuns++;
            if (r.run_started_at && r.updated_at) {
                const start = new Date(r.run_started_at);
                const end = new Date(r.updated_at);
                if (end > start) {
                    totalExecMinutes += (end - start) / 60000;
                    execCount++;
                }
            }

            // Extract Deployment Frequency from the unified bulk payload
            if (r.conclusion === "success") {
                const b = (r.head_branch || "").toLowerCase();
                if (["main", "master", "prod"].some(x => b.includes(x))) {
                    successfulDeploys++;
                    recentDeploys.push(new Date(r.created_at));
                }
            }
        });

        stats["CI/CD Failure Rate (%)"] = ((failedRuns / runs.workflow_runs.length) * 100).toFixed(2);
        stats["CI/CD Avg Execution Time (Mins)"] = execCount > 0 ? (totalExecMinutes / execCount).toFixed(2) : 0;

        for (const run of runs.workflow_runs) {
            if (lastRunDate && run.created_at <= lastRunDate) continue;

            const outcome = run.conclusion || run.status;

            // Get Environment from CICD.yml at that SHA
            let runEnv = "Unknown";
            if (run.head_sha && cicdCache[`${repoName}:HEAD`] !== false) {
                runEnv = await fetchCICDConfig(repoName, run.head_sha);
            }
            if (!runEnv || runEnv === "Unknown") {
                runEnv = stats["Environment"] !== "Unknown" ? stats["Environment"] : getEnvironment(run.head_branch);
            }

            // User: Try Head Commit Email, else Triggering Actor Login
            let runUser = "Unknown";
            if (run.head_commit && run.head_commit.author && run.head_commit.author.email) {
                runUser = run.head_commit.author.email;
            } else if (run.triggering_actor) {
                runUser = run.triggering_actor.login;
            }

            logs.push({
                Timestamp: new Date().toISOString(),
                Repository: repoName,
                Capability: capability,
                Action: `Workflow Run (${outcome})`,
                User: runUser,
                Date: run.created_at,
                Environment: runEnv,
                "Cross-Ref ID": extractCrossRefID(run.display_title),
                "Associated PR": extractAssociatedPR(run.display_title),
                ID: `Run #${run.run_number}`,
                Message: (run.display_title || "").substring(0, 100),
                "Branch Duration (Hours)": 0,
                "Review Time (Hours)": 0,
                "LOC Changed": 0,
                "PR Size (Commits)": 0,
                "Target Branch": run.head_branch || ""
            });
        }
    }
    stats["Successful Deployments"] = successfulDeploys;

    // 3. PRs (Activity Logging & DORA/SPACE Metrics)
    let lastPRDate = null;
    if (prevState) lastPRDate = prevState["Last PR Date"];

    // Use unified Pulls API block, completely skipping the 30req/min Search API limit
    const recentPRsRaw = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/pulls?state=closed&per_page=${Math.min(100, maxPrsLimit)}&sort=updated&direction=desc`, Math.ceil(maxPrsLimit / 100));
    let recentPRs = [];
    if (recentPRsRaw && Array.isArray(recentPRsRaw)) {
        recentPRs = recentPRsRaw.slice(0, maxPrsLimit);
    }

    if (recentPRs.length > 0) {
        stats["Last PR Date"] = recentPRs[0].closed_at;
    }

    const prAuthors = new Set();
    const metrics_accum = { duration: 0, review: 0, loc: 0, count: 0 };

    let totalReviewComments = 0;
    let totalWaitTimeHours = 0;
    let prsWithReviews = 0;
    let totalDescLength = 0;
    let prsAnalyzed = 0;
    let smallPRCount = 0;
    let largePRCount = 0;
    let totalTrueLeadTime = 0;
    let prsWithTrueLeadTime = 0;
    let totalLeadTimeToProd = 0;
    let prsWithLeadTimeToProd = 0;
    let totalCodeChurn = 0;

    let totalTestLOC = 0;
    let totalCoreLOC = 0;
    let prsWithFilesAnalyzed = 0;

    let totalActiveCodingTimeHours = 0;
    let totalActiveCodingLOC = 0;
    let prsWithCodingVelocity = 0;

    if (recentPRs.length > 0) {
        // Concurrency control: batch process PR reviews and deep metrics
        const BATCH_SIZE = 5;
        for (let i = 0; i < recentPRs.length; i += BATCH_SIZE) {
            const batch = recentPRs.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(async (item) => {
                if (lastPRDate && item.closed_at <= lastPRDate) return;

                const prNum = item.number;
                const isMerged = item.merged_at != null;
                const action = isMerged ? "Merge (PR)" : "Close (PR - Unmerged)";

                const createdAt = new Date(item.created_at);
                const closedAt = item.closed_at ? new Date(item.closed_at) : new Date();

                // We still need PR Detail for Additions/Deletions, but now we're bounded by maxPrsLimit!
                const prDetailRes = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/pulls/${prNum}`);
                const prDetail = prDetailRes ? prDetailRes.data : null;
                if (!prDetail) return;

                // --- 2a: Deep Metrics Extraction (Required early for Commit timestamps) ---
                let firstCommitTime = createdAt;
                let prCommitsRes = null;
                let reviewsRes = null;

                if (isMerged) {
                    prCommitsRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/pulls/${prNum}/commits?per_page=100`, 1);
                    if (prCommitsRes && Array.isArray(prCommitsRes) && prCommitsRes.length > 0) {
                        firstCommitTime = new Date(prCommitsRes[0].commit.committer.date);
                    }
                }

                // --- 2b: Activity Log Extraction ---
                let author = "Unknown";
                if (prDetail.user) {
                    author = prDetail.user.email || prDetail.user.login;
                }
                prAuthors.add(author);

                if (isMerged) stats["Total Merged PRs"]++;

                // Duration mathematically:
                // Coding Time = First Commit -> PR Creation
                // Review Time = PR Creation -> PR Merge
                // Branch Duration = First Commit -> PR Merge
                let codingHours = 0;
                let reviewHours = 0;
                let durationHours = 0;

                if (closedAt > createdAt) {
                    reviewHours = (closedAt - createdAt) / (1000 * 3600);
                }
                if (createdAt > firstCommitTime) {
                    codingHours = (createdAt - firstCommitTime) / (1000 * 3600);
                }
                durationHours = codingHours + reviewHours;

                const loc = (prDetail.additions || 0) + (prDetail.deletions || 0);

                if (isMerged) {
                    metrics_accum.duration += durationHours;
                    metrics_accum.review += reviewHours;
                    metrics_accum.loc += loc;
                    metrics_accum.count++;

                    // SPACE Metrics additions
                    prsAnalyzed++;
                    totalDescLength += (prDetail.body || "").length;
                    if (loc < 200) smallPRCount++;
                    else largePRCount++;
                }

                logs.push({
                    Timestamp: new Date().toISOString(),
                    Repository: repoName,
                    Capability: capability,
                    Action: action,
                    User: author,
                    Date: item.closed_at,
                    Environment: stats["Environment"] !== "Unknown" ? stats["Environment"] : getEnvironment(prDetail.base.ref),
                    "Cross-Ref ID": extractCrossRefID(item.title),
                    "Associated PR": `PR #${prNum}`,
                    ID: `PR #${prNum}`,
                    Message: item.title.substring(0, 100),
                    "Branch Duration (Hours)": durationHours.toFixed(2),
                    "Review Time (Hours)": reviewHours.toFixed(2),
                    "LOC Changed": loc,
                    "PR Size (Commits)": prDetail.commits || 0,
                    "Target Branch": prDetail.base.ref
                });

                // --- 2c: Deep Metrics Extraction Continued (Only for merged PRs) ---
                if (!isMerged) return;

                // AI Proxy 1: Test Code Ratio
                const prFilesRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/pulls/${prNum}/files?per_page=100`, 1);
                if (prFilesRes && Array.isArray(prFilesRes)) {
                    prsWithFilesAnalyzed++;
                    prFilesRes.forEach(file => {
                        const fileLoc = file.additions + file.deletions;
                        const fname = file.filename.toLowerCase();
                        if (fname.includes('test') || fname.includes('spec')) {
                            totalTestLOC += fileLoc;
                        } else {
                            totalCoreLOC += fileLoc;
                        }
                    });
                }

                // Reviews
                reviewsRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/pulls/${prNum}/reviews?per_page=100`, 2);

                if (prCommitsRes && Array.isArray(prCommitsRes) && prCommitsRes.length > 0) {
                    if (closedAt > firstCommitTime) {
                        totalTrueLeadTime += (closedAt - firstCommitTime) / (1000 * 3600);
                        prsWithTrueLeadTime++;

                        // DORA: Lead Time to Production (Days)
                        const firstDeploy = recentDeploys.find(d => d >= closedAt);
                        if (firstDeploy) {
                            totalLeadTimeToProd += (firstDeploy - firstCommitTime) / (1000 * 3600 * 24);
                            prsWithLeadTimeToProd++;
                        }
                    }

                    // AI Proxy 2: Coding Velocity
                    if (createdAt > firstCommitTime) {
                        const activeHours = (createdAt - firstCommitTime) / (1000 * 3600);
                        if (activeHours > 0.08 && loc > 0) {
                            totalActiveCodingTimeHours += activeHours;
                            totalActiveCodingLOC += loc;
                            prsWithCodingVelocity++;
                        }
                    }
                }

                if (reviewsRes && Array.isArray(reviewsRes) && reviewsRes.length > 0) {
                    prsWithReviews++;
                    totalReviewComments += reviewsRes.length;

                    // Wait time to first review
                    const sortedReviews = reviewsRes
                        .filter(r => r.submitted_at)
                        .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

                    if (sortedReviews.length > 0) {
                        const firstReviewTime = new Date(sortedReviews[0].submitted_at);
                        if (firstReviewTime > createdAt) {
                            totalWaitTimeHours += (firstReviewTime - createdAt) / (1000 * 3600);
                        }

                        if (prCommitsRes && Array.isArray(prCommitsRes)) {
                            const churn = prCommitsRes.filter(c => new Date(c.commit.committer.date) > firstReviewTime).length;
                            totalCodeChurn += churn;
                        }
                    }
                }
            }));
        }
    }

    if (prevState && prevState["Distinct PR Authors List"]) {
        prevState["Distinct PR Authors List"].split(', ').forEach(a => {
            if (a) prAuthors.add(a);
        });
    }
    stats["Distinct PR Authors Count"] = prAuthors.size;
    stats["Distinct PR Authors List"] = Array.from(prAuthors).sort().join(", ");

    if (metrics_accum.count > 0) {
        const cnt = metrics_accum.count;
        stats["Avg Branch Duration (Hours)"] = (metrics_accum.duration / cnt).toFixed(2);
        stats["Avg Review Time (Hours)"] = (metrics_accum.review / cnt).toFixed(2);
        stats["Avg LOC Changed"] = (metrics_accum.loc / cnt).toFixed(2);
        if (stats["Avg LOC Changed"] > 0) {
            stats["Avg Review Time / LOC"] = (stats["Avg Review Time (Hours)"] / stats["Avg LOC Changed"]).toFixed(4);
        }
        stats["Avg Coding Time (Hours)"] = Math.max(0, stats["Avg Branch Duration (Hours)"] - stats["Avg Review Time (Hours)"]).toFixed(2);
    } else if (prevState) {
        stats["Avg Branch Duration (Hours)"] = prevState["Avg Branch Duration (Hours)"] || 0;
        stats["Avg Review Time (Hours)"] = prevState["Avg Review Time (Hours)"] || 0;
        stats["Avg Coding Time (Hours)"] = prevState["Avg Coding Time (Hours)"] || 0;
        stats["Avg LOC Changed"] = prevState["Avg LOC Changed"] || 0;
        stats["Avg Review Time / LOC"] = prevState["Avg Review Time / LOC"] || 0;
        if (!stats["Last PR Date"]) stats["Last PR Date"] = prevState["Last PR Date"];
    }

    // Removed workflow fetching from here since it moved up
    if (prevState && !stats["Last Workflow Date"]) {
        stats["Last Workflow Date"] = prevState["Last Workflow Date"];
    }

    // 4. Repo Type (Languages)
    const langsRes = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/languages`);
    const langs = langsRes ? langsRes.data : null;
    if (langs) {
        if (langs["Terraform"] || langs["HCL"]) stats["Repo Type"] = "Infrastructure";
        else {
            const infraLangs = ['Shell', 'Dockerfile', 'Makefile', 'Smarty', 'Puppet'];
            let total = 0;
            let infra = 0;
            Object.keys(langs).forEach(l => {
                total += langs[l];
                if (infraLangs.includes(l)) infra += langs[l];
            });
            if (total > 0 && (infra / total) > 0.5) stats["Repo Type"] = "Infrastructure";
            else stats["Repo Type"] = "Application";
        }
    }

    // --- NEW DORA AND SPACE METRICS ---

    // 1. MTTR-Sec (Vulnerability Remediation)
    let mttrAccum = 0;
    let mttrCount = 0;
    // We only fetch 'closed' alerts
    const alerts = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/code-scanning/alerts?state=closed&per_page=100`, 5);
    if (alerts && Array.isArray(alerts)) {
        for (const alert of alerts) {
            if (alert.created_at && (alert.dismissed_at || alert.fixed_at)) {
                const t0 = new Date(alert.created_at);
                const t1 = new Date(alert.dismissed_at || alert.fixed_at);
                if (t1 > t0) {
                    mttrAccum += (t1 - t0) / (1000 * 3600);
                    mttrCount++;
                }
            }
        }
        stats["MTTR-Sec (Hours)"] = mttrCount > 0 ? (mttrAccum / mttrCount).toFixed(2) : 0;
    } else {
        // Fallback to previous state if API failed (e.g. 403)
        stats["MTTR-Sec (Hours)"] = (prevState && prevState["MTTR-Sec (Hours)"]) ? prevState["MTTR-Sec (Hours)"] : 0;
    }

    // 2. Deployment Frequency & Change Failure Rate
    // (successfulDeploys & recentDeploys are now extracted securely upstairs from the unified bounds)
    stats["Successful Deployments"] = successfulDeploys;
    recentDeploys.sort((a, b) => a - b); // Sort chronologically (oldest first) for lead time calculation

    let failureIssues = 0;
    // We fetch recent issues broadly if integration is enabled, to catch Jira tickets not labeled as bugs
    const hasIntegration = integrationConfig && (integrationConfig.jira?.enabled || integrationConfig.serviceNow?.enabled);
    const issuesQueryStr = hasIntegration ? `repo:${repoName} is:issue` : `repo:${repoName} is:issue label:bug,hotfix,incident`;
    const issuesQuery = encodeURIComponent(issuesQueryStr);

    // Instead of search API which is heavily rate-limited to 30 requests/min, we use the issues endpoint
    const issuesRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${repoName}/issues?state=all&per_page=100`, 2);

    if (issuesRes && Array.isArray(issuesRes)) {
        for (const issue of issuesRes) {
            if (issue.pull_request) continue; // Skip PRs, we want actual issues

            const issueDate = new Date(issue.created_at);
            const labels = issue.labels.map(l => l.name.toLowerCase());

            // --- NATIVE MTTR-SEC FALLBACK ---
            // If GHAS is disabled (403), calculate MTTR-Sec globally from standard closed security issues
            if (issue.state === 'closed' && issue.closed_at) {
                if (labels.some(l => ["security", "vulnerability", "cve"].includes(l))) {
                    const t0 = new Date(issue.created_at);
                    const t1 = new Date(issue.closed_at);
                    if (t1 > t0) {
                        mttrAccum += (t1 - t0) / (1000 * 3600);
                        mttrCount++;
                    }
                }
            }

            const causedByDeploy = recentDeploys.some(deployDate => {
                const diffHours = (issueDate - deployDate) / (1000 * 3600);
                return diffHours >= 0 && diffHours <= 48; // Issue created within 48h after deploy
            });

            if (causedByDeploy) {
                const payloadText = (issue.title || "") + " " + (issue.body || "");
                const defectData = await checkExternalDefect(payloadText);

                if (defectData === "Unverified" || defectData === null) {
                    // Fallback to GitHub labels for CFR
                    if (labels.some(l => ["bug", "hotfix", "incident"].includes(l))) {
                        failureIssues++;
                    }
                } else if (defectData && defectData.isDefect === true) {
                    failureIssues++;

                    // Factor into MTTR-Sec if we have creation and resolution times
                    if (defectData.createdAt && defectData.resolvedAt) {
                        const t0 = defectData.createdAt;
                        const t1 = defectData.resolvedAt;
                        if (t1 > t0) {
                            mttrAccum += (t1 - t0) / (1000 * 3600);
                            mttrCount++;
                        }
                    }
                }
            }
        }
    }
    stats["Change Failure Rate (%)"] = successfulDeploys > 0 ? ((failureIssues / successfulDeploys) * 100).toFixed(2) : 0;

    // Infrastructure: CT.yml Tracking
    let ctExists = "No";
    let ctHasRuns = "No";
    let ctLastRun = "N/A";

    const workflowsRes = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/actions/workflows`);
    if (workflowsRes && workflowsRes.data && workflowsRes.data.workflows) {
        // Find any workflow file that contains 'ct' in the name and ends with .yml or .yaml (case-insensitive)
        const ctWorkflows = workflowsRes.data.workflows.filter(wf => {
            if (!wf.path) return false;
            const filename = wf.path.split('/').pop().toLowerCase();
            return filename.includes('ct') && (filename.endsWith('.yml') || filename.endsWith('.yaml'));
        });

        if (ctWorkflows.length > 0) {
            ctExists = "Yes";
            let latestRunDate = null;

            for (const wf of ctWorkflows) {
                const ctRunsRes = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/actions/workflows/${wf.id}/runs?per_page=1`);
                if (ctRunsRes && ctRunsRes.data && ctRunsRes.data.workflow_runs && ctRunsRes.data.workflow_runs.length > 0) {
                    ctHasRuns = "Yes";
                    const runDate = new Date(ctRunsRes.data.workflow_runs[0].created_at);
                    if (!latestRunDate || runDate > latestRunDate) {
                        latestRunDate = runDate;
                        ctLastRun = ctRunsRes.data.workflow_runs[0].created_at;
                    }
                }
            }
        }
    }
    stats["CT.yml Exists"] = ctExists;
    stats["CT.yml Has Runs"] = ctHasRuns;
    stats["CT.yml Last Run"] = ctLastRun;

    // 3. True Lead Time, Review Cognitive Load, Code Churn & AI Proxies


    if (prsAnalyzed > 0) {
        stats["Avg PR Description Length (Chars)"] = Math.round(totalDescLength / prsAnalyzed);
        if (largePRCount > 0) {
            stats["Small to Large PR Ratio"] = (smallPRCount / largePRCount).toFixed(2);
        } else if (smallPRCount > 0) {
            stats["Small to Large PR Ratio"] = smallPRCount.toFixed(2); // If 0 large, treat ratio as count
        } else {
            stats["Small to Large PR Ratio"] = 0;
        }
    } else if (prevState) {
        stats["Avg PR Description Length (Chars)"] = prevState["Avg PR Description Length (Chars)"] || 0;
        stats["Small to Large PR Ratio"] = prevState["Small to Large PR Ratio"] || 0;
    }

    stats["True Lead Time for Changes (Hours)"] = prsWithTrueLeadTime > 0 ? (totalTrueLeadTime / prsWithTrueLeadTime).toFixed(2) : 0;
    stats["Lead Time to Production (Days)"] = prsWithLeadTimeToProd > 0 ? (totalLeadTimeToProd / prsWithLeadTimeToProd).toFixed(2) : 0;
    stats["Avg Code Churn (Commits)"] = prsWithReviews > 0 ? (totalCodeChurn / prsWithReviews).toFixed(2) : 0;

    // AI Proxies
    const totalLOC = totalTestLOC + totalCoreLOC;
    stats["Test Code Ratio (%)"] = totalLOC > 0 ? ((totalTestLOC / totalLOC) * 100).toFixed(2) : 0;
    stats["Coding Velocity (LOC/Hr)"] = (totalActiveCodingTimeHours > 0 && totalActiveCodingLOC > 0) ? (totalActiveCodingLOC / totalActiveCodingTimeHours).toFixed(2) : 0;

    // --- 4. SonarQube Metrics (SPACE & DevSecOps Validation) ---
    stats["SQ Security Rating"] = "N/A";
    stats["SQ Technical Debt (Days)"] = "N/A";
    stats["SQ Code Smells"] = "N/A";
    stats["SQ Vulnerabilities"] = "N/A";
    stats["SQ Unit Tests"] = "N/A";

    if (integrationConfig && integrationConfig.sonarQube && integrationConfig.sonarQube.enabled) {
        const sqMetrics = await fetchSonarQubeMetrics(repoName, sonarQubeKey);
        if (sqMetrics) {
            // Map SonarQube ratings (1=A, 2=B, etc.) to letter grades for readability where possible
            const ratingMap = { "1.0": "A", "2.0": "B", "3.0": "C", "4.0": "D", "5.0": "E" };
            stats["SQ Security Rating"] = ratingMap[sqMetrics.security_rating] || sqMetrics.security_rating || "N/A";

            // SQ returns sqale_index in minutes. Convert to 8-hour days.
            if (sqMetrics.sqale_index) {
                const debtMinutes = parseInt(sqMetrics.sqale_index, 10);
                stats["SQ Technical Debt (Days)"] = (debtMinutes / 60 / 8).toFixed(1);
            }
            stats["SQ Code Smells"] = sqMetrics.code_smells || "0";
            stats["SQ Vulnerabilities"] = sqMetrics.vulnerabilities || "0";
            stats["SQ Unit Tests"] = sqMetrics.tests || "0";
        } else if (prevState) {
            // Graceful degradation / cache hit
            stats["SQ Security Rating"] = prevState["SQ Security Rating"] || "N/A";
            stats["SQ Technical Debt (Days)"] = prevState["SQ Technical Debt (Days)"] || "N/A";
            stats["SQ Code Smells"] = prevState["SQ Code Smells"] || "N/A";
            stats["SQ Vulnerabilities"] = prevState["SQ Vulnerabilities"] || "N/A";
            stats["SQ Unit Tests"] = prevState["SQ Unit Tests"] || "N/A";
        }
    } else if (prevState) {
        stats["SQ Security Rating"] = prevState["SQ Security Rating"] || "N/A";
        stats["SQ Technical Debt (Days)"] = prevState["SQ Technical Debt (Days)"] || "N/A";
        stats["SQ Code Smells"] = prevState["SQ Code Smells"] || "N/A";
        stats["SQ Vulnerabilities"] = prevState["SQ Vulnerabilities"] || "N/A";
        stats["SQ Unit Tests"] = prevState["SQ Unit Tests"] || "N/A";
    }

    stats["Avg Review Comments per PR"] = prevState ? (prevState["Avg Review Comments per PR"] || 0) : 0;
    stats["Avg Wait Time for First Review (Hours)"] = prevState ? (prevState["Avg Wait Time for First Review (Hours)"] || 0) : 0;
    stats["True Lead Time for Changes (Hours)"] = prevState ? (prevState["True Lead Time for Changes (Hours)"] || 0) : 0;
    stats["Lead Time to Production (Days)"] = prevState ? (prevState["Lead Time to Production (Days)"] || 0) : 0;
    stats["Avg Code Churn (Commits)"] = prevState ? (prevState["Avg Code Churn (Commits)"] || 0) : 0;

    if (prsWithReviews > 0) {
        stats["Avg Review Comments per PR"] = (totalReviewComments / prsWithReviews).toFixed(2);
        stats["Avg Wait Time for First Review (Hours)"] = (totalWaitTimeHours / prsWithReviews).toFixed(2);
        stats["Avg Code Churn (Commits)"] = (totalCodeChurn / prsWithReviews).toFixed(2);
    }

    // Verification
    if (!prevState) stats["Timestamp Verification"] = "New Repository";
    else if (stats["Last Commit Date"] !== prevState["Last Commit Date"]) stats["Timestamp Verification"] = "Updated";
    else stats["Timestamp Verification"] = "Match";

    return { stats, logs };
}

// --- Main ---

async function main() {
    console.log("Starting GitHub Stats Collector (Node.js)...");

    // Load Input
    let inputData = [];
    if (fs.existsSync('github_input.csv')) {
        inputData = parseCSV(fs.readFileSync('github_input.csv', 'utf-8'));
    } else {
        logError("Error: github_input.csv not found");
        return;
    }

    // Load History
    const history = {};
    if (fs.existsSync('github_stats_history.csv')) {
        const histContent = fs.readFileSync('github_stats_history.csv', 'utf-8');
        let histData = parseCSV(histContent);

        if (histData.length > 0 && (!Object.keys(histData[0]).includes('Environment') || !Object.keys(histData[0]).includes('Change Failure Rate (%)'))) {
            console.log("Migrating schema: Adding Environment and DORA/SPACE columns...");
            histData = histData.map(row => {
                row.Environment = row.Environment || 'Unknown';
                row['MTTR-Sec (Hours)'] = row['MTTR-Sec (Hours)'] || 0;
                row['Successful Deployments'] = row['Successful Deployments'] || 0;
                row['Avg Review Comments per PR'] = row['Avg Review Comments per PR'] || 0;
                row['Avg Wait Time for First Review (Hours)'] = row['Avg Wait Time for First Review (Hours)'] || 0;
                row['Avg PR Description Length (Chars)'] = row['Avg PR Description Length (Chars)'] || 0;
                row['Small to Large PR Ratio'] = row['Small to Large PR Ratio'] || 0;
                row['Change Failure Rate (%)'] = row['Change Failure Rate (%)'] || 0;
                row['True Lead Time for Changes (Hours)'] = row['True Lead Time for Changes (Hours)'] || 0;
                row['Lead Time to Production (Days)'] = row['Lead Time to Production (Days)'] || 0;
                row['CI/CD Failure Rate (%)'] = row['CI/CD Failure Rate (%)'] || 0;
                row['CI/CD Avg Execution Time (Mins)'] = row['CI/CD Avg Execution Time (Mins)'] || 0;
                row['Avg Code Churn (Commits)'] = row['Avg Code Churn (Commits)'] || 0;
                row['CT.yml Exists'] = row['CT.yml Exists'] || 'No';
                row['CT.yml Has Runs'] = row['CT.yml Has Runs'] || 'No';
                row['CT.yml Last Run'] = row['CT.yml Last Run'] || 'N/A';
                return row;
            });
        }

        histData.sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
        histData.forEach(row => {
            if (row.Repository && !history[row.Repository]) {
                history[row.Repository] = row;
            }
        });
    }

    const results = [];
    let allLogs = [];
    let processed = 0;
    const totalRepos = inputData.filter(r => r.Repository).length;
    const startTime = Date.now();

    for (const row of inputData) {
        const repo = row.Repository;
        if (!repo) continue;
        const capability = row.Capability || "Unknown";
        const sonarQubeKey = row.SonarQubeProjectKey || null;

        writeStatus(processed, totalRepos, repo, startTime);

        try {
            const output = await processRepo(repo, capability, sonarQubeKey, history[repo]);
            results.push(output.stats);
            allLogs = allLogs.concat(output.logs);
        } catch (e) {
            logError(`Error processing ${repo} (Data dropped): \n${e.stack}`);
        }
        processed++;
        writeStatus(processed, totalRepos, repo, startTime);
    }

    // Clear status
    writeStatus(processed, totalRepos, null, startTime);

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    results.forEach(r => r.Timestamp = timestamp);

    // Save Output
    const cols = ['Repository', 'Capability', 'Repo Type', 'Verification Status', 'Timestamp Verification',
        'Total Commits', 'Total Merged PRs',
        'Distinct Committers Count', 'Distinct PR Authors Count',
        'Last Commit Date', 'Last PR Date', 'Last Workflow Date',
        'Avg Branch Duration (Hours)', 'Avg Coding Time (Hours)', 'Avg Review Time (Hours)', 'Avg LOC Changed', 'Avg Review Time / LOC',
        'MTTR-Sec (Hours)', 'Successful Deployments', 'Avg Review Comments per PR', 'Avg Wait Time for First Review (Hours)', 'Avg PR Description Length (Chars)', 'Small to Large PR Ratio',
        'Change Failure Rate (%)', 'True Lead Time for Changes (Hours)', 'Lead Time to Production (Days)', 'CI/CD Failure Rate (%)', 'CI/CD Avg Execution Time (Mins)', 'Avg Code Churn (Commits)',
        'Test Code Ratio (%)', 'Coding Velocity (LOC/Hr)',
        'SQ Security Rating', 'SQ Technical Debt (Days)', 'SQ Code Smells', 'SQ Vulnerabilities', 'SQ Unit Tests', 'CT.yml Exists', 'CT.yml Has Runs', 'CT.yml Last Run', 'Environment', 'Timestamp'];

    const csvContent = [cols.join(',')].concat(results.map(r => {
        return cols.map(c => {
            const val = r[c] === null || r[c] === undefined ? '' : String(r[c]);
            if (val.includes(',') || val.includes('"')) {
                return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
        }).join(',');
    })).join('\n');

    fs.writeFileSync('github_stats_output.csv', csvContent);
    console.log("Saved github_stats_output.csv");

    // Append History
    let append = true;
    if (fs.existsSync('github_stats_history.csv')) {
        const firstLine = fs.readFileSync('github_stats_history.csv', 'utf-8').split('\n')[0];
        if (!firstLine.includes('Environment') || !firstLine.includes('MTTR-Sec (Hours)')) {
            append = false;
        }
    } else {
        append = false; // New file
    }

    if (!append) {
        if (fs.existsSync('github_stats_history.csv')) {
            const oldContent = fs.readFileSync('github_stats_history.csv', 'utf-8');
            const oldData = parseCSV(oldContent);
            const migratedOldData = oldData.map(r => {
                r.Environment = r.Environment || 'Unknown';
                r['MTTR-Sec (Hours)'] = r['MTTR-Sec (Hours)'] || 0;
                r['Successful Deployments'] = r['Successful Deployments'] || 0;
                r['Avg Review Comments per PR'] = r['Avg Review Comments per PR'] || 0;
                r['Avg Wait Time for First Review (Hours)'] = r['Avg Wait Time for First Review (Hours)'] || 0;
                r['Avg PR Description Length (Chars)'] = r['Avg PR Description Length (Chars)'] || 0;
                r['Small to Large PR Ratio'] = r['Small to Large PR Ratio'] || 0;
                r['Change Failure Rate (%)'] = r['Change Failure Rate (%)'] || 0;
                r['True Lead Time for Changes (Hours)'] = r['True Lead Time for Changes (Hours)'] || 0;
                r['CI/CD Failure Rate (%)'] = r['CI/CD Failure Rate (%)'] || 0;
                r['CI/CD Avg Execution Time (Mins)'] = r['CI/CD Avg Execution Time (Mins)'] || 0;
                r['Avg Code Churn (Commits)'] = r['Avg Code Churn (Commits)'] || 0;
                r['Test Code Ratio (%)'] = r['Test Code Ratio (%)'] || 0;
                r['Coding Velocity (LOC/Hr)'] = r['Coding Velocity (LOC/Hr)'] || 0;
                r['CT.yml Exists'] = r['CT.yml Exists'] || 'No';
                r['CT.yml Has Runs'] = r['CT.yml Has Runs'] || 'No';
                r['CT.yml Last Run'] = r['CT.yml Last Run'] || 'N/A';
                return r;
            });

            const fullData = migratedOldData.concat(results);

            const fullContent = [cols.join(',')].concat(fullData.map(r => {
                return cols.map(c => {
                    const val = r[c] === null || r[c] === undefined ? '' : String(r[c]);
                    if (val.includes(',') || val.includes('"')) return `"${val.replace(/"/g, '""')}"`;
                    return val;
                }).join(',');
            })).join('\n');

            fs.writeFileSync('github_stats_history.csv', fullContent);
            console.log("Migrated and updated github_stats_history.csv");
        } else {
            fs.writeFileSync('github_stats_history.csv', csvContent);
            console.log("Created github_stats_history.csv");
        }
    } else {
        let historyContent = csvContent.split('\n').slice(1).join('\n');
        const currentHist = fs.readFileSync('github_stats_history.csv', 'utf-8');
        if (currentHist && !currentHist.endsWith('\n')) fs.appendFileSync('github_stats_history.csv', '\n');
        fs.appendFileSync('github_stats_history.csv', historyContent);
        console.log("Appended to github_stats_history.csv");
    }

    // Save Logs
    if (allLogs.length > 0) {
        const logCols = ['Timestamp', 'Repository', 'Capability', 'Action', 'User', 'Date', 'Environment', 'Cross-Ref ID', 'Associated PR', 'ID', 'Message',
            'Branch Duration (Hours)', 'Review Time (Hours)', 'LOC Changed', 'PR Size (Commits)', 'Target Branch'];

        allLogs.forEach(l => l.Timestamp = timestamp);

        const logContent = allLogs.map(r => {
            return logCols.map(c => {
                const val = r[c] === null || r[c] === undefined ? '' : String(r[c]);
                if (val.includes(',') || val.includes('"')) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            }).join(',');
        }).join('\n');

        if (!fs.existsSync('github_activity_log.csv')) {
            fs.writeFileSync('github_activity_log.csv', logCols.join(',') + '\n' + logContent);
        } else {
            const currentLog = fs.readFileSync('github_activity_log.csv', 'utf-8');
            if (currentLog && !currentLog.endsWith('\n')) fs.appendFileSync('github_activity_log.csv', '\n');
            fs.appendFileSync('github_activity_log.csv', logContent);
        }
        console.log(`Saved ${allLogs.length} events to github_activity_log.csv`);
    } else {
        console.log("No new activity logs.");
    }
}

main();
