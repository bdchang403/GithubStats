const fs = require('fs');
const https = require('https');
const path = require('path');

// --- Configuration ---
const CONFIG_path = path.join(__dirname, 'config', '.env');
const ENV = process.env;

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

// --- Helpers ---

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
    const headers = {
        'User-Agent': 'NodeJS-Collector',
        'Accept': 'application/vnd.github.v3+json'
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    else console.warn("Warning: GITHUB_TOKEN not set. Rate limits apply.");

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            console.error(`Error ${response.status} fetch ${url}`);
            return null;
        }
        return await response.json();
    } catch (e) {
        console.error(`Fetch error: ${e.message}`);
        return null;
    }
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

async function fetchCICDConfig(repoName, sha = null) {
    try {
        let url = `${API_BASE_URL}/repos/${repoName}/contents/CICD.yml`;
        if (sha) url += `?ref=${sha}`;

        const data = await fetchGitHub(url);
        if (data && data.content) {
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            if (!sha) console.log(`  Found CICD.yml in ${repoName}`);

            // Simple parser for boolean flags
            const lines = content.split('\n');
            for (const line of lines) {
                const match = line.match(/^\s*([a-zA-Z0-9_-]+)\s*:\s*(true|false)/i);
                if (match) {
                    const key = match[1].toLowerCase();
                    const val = match[2].toLowerCase() === 'true';

                    if (val) {
                        if (['prod', 'production', 'release'].includes(key)) return "Production";
                        if (['sit', 'staging', 'test'].includes(key)) return "SIT";
                        if (['dev', 'develop'].includes(key)) return "Development";
                        if (['pat', 'uat', 'pre-prod'].includes(key)) return "PAT";
                        if (['trust', 'trusted'].includes(key)) return "Trusted";
                    }
                }
            }
        }
    } catch (e) {
        // Ignore errors
    }
    return null;
}

async function processRepo(repoName, capability, prevState) {
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
        "Avg Review Time / LOC": 0
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

    const commits = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/commits?per_page=100${sinceParam}`);
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

    // 2. PRs
    let lastPRDate = null;
    if (prevState) lastPRDate = prevState["Last PR Date"];

    let prQuery = `q=repo:${repoName}+is:pr+is:closed`;
    if (lastPRDate) prQuery += `+closed:>${lastPRDate}`;

    const prs = await fetchGitHub(`${API_BASE_URL}/search/issues?${prQuery}&sort=updated&order=desc&per_page=5`);
    const prAuthors = new Set();

    const metrics_accum = { duration: 0, review: 0, loc: 0, count: 0 };

    if (prs && prs.items) {
        if (prs.items.length > 0) {
            stats["Last PR Date"] = prs.items[0].closed_at;
        }

        for (const item of prs.items) {
            if (lastPRDate && item.closed_at <= lastPRDate) continue;

            const prNum = item.number;
            const isMerged = item.pull_request && item.pull_request.merged_at;
            const action = isMerged ? "Merge (PR)" : "Close (PR - Unmerged)";

            const prDetail = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/pulls/${prNum}`);
            if (!prDetail) continue;

            // Try to get email, fallback to login
            let author = "Unknown";
            if (prDetail.user) {
                // Note: user.email is often null unless authenticated with correct scopes/permission
                author = prDetail.user.email || prDetail.user.login;
            }
            prAuthors.add(author);

            if (isMerged) stats["Total Merged PRs"]++;

            const createdAt = new Date(prDetail.created_at);
            const closedAt = new Date(prDetail.closed_at);

            let durationHours = 0;
            if (closedAt > createdAt) {
                durationHours = (closedAt - createdAt) / (1000 * 3600);
            }

            let reviewHours = durationHours;
            const loc = (prDetail.additions || 0) + (prDetail.deletions || 0);

            if (isMerged) {
                metrics_accum.duration += durationHours;
                metrics_accum.review += reviewHours;
                metrics_accum.loc += loc;
                metrics_accum.count++;
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
                "PR Size (Commits)": prDetail.commits,
                "Target Branch": prDetail.base.ref
            });
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

    // 3. Workflow Runs
    let lastRunDate = prevState ? prevState["Last Workflow Date"] : null;
    const runs = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/actions/runs?per_page=5&sort=created_at&direction=desc`);
    if (runs && runs.workflow_runs && runs.workflow_runs.length > 0) {
        stats["Last Workflow Date"] = runs.workflow_runs[0].created_at;

        for (const run of runs.workflow_runs) {
            if (lastRunDate && run.created_at <= lastRunDate) continue;

            const outcome = run.conclusion || run.status;

            // Get Environment from CICD.yml at that SHA
            let runEnv = "Unknown";
            if (run.head_sha) {
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
                ID: `Run #${run.id}`,
                Message: `${run.name} - ${run.display_title}`.substring(0, 100),
                "Branch Duration (Hours)": null,
                "Review Time (Hours)": null,
                "LOC Changed": null,
                "PR Size (Commits)": null,
                "Target Branch": run.head_branch
            });
        }
    } else if (prevState && !stats["Last Workflow Date"]) {
        stats["Last Workflow Date"] = prevState["Last Workflow Date"];
    }

    // 4. Repo Type (Languages)
    const langs = await fetchGitHub(`${API_BASE_URL}/repos/${repoName}/languages`);
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
        console.error("Error: github_input.csv not found");
        return;
    }

    // Load History
    const history = {};
    if (fs.existsSync('github_stats_history.csv')) {
        const histContent = fs.readFileSync('github_stats_history.csv', 'utf-8');
        let histData = parseCSV(histContent);

        if (histData.length > 0 && !Object.keys(histData[0]).includes('Environment')) {
            console.log("Migrating schema: Adding Environment column...");
            histData = histData.map(row => ({ ...row, Environment: 'Unknown' }));
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

    for (const row of inputData) {
        const repo = row.Repository;
        if (!repo) continue;
        const capability = row.Capability || "Unknown";

        try {
            const output = await processRepo(repo, capability, history[repo]);
            results.push(output.stats);
            allLogs = allLogs.concat(output.logs);
        } catch (e) {
            console.error(`Error processing ${repo}: ${e.message}`);
        }
    }

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    results.forEach(r => r.Timestamp = timestamp);

    // Save Output
    const cols = ['Repository', 'Capability', 'Repo Type', 'Verification Status', 'Timestamp Verification',
        'Total Commits', 'Total Merged PRs',
        'Distinct Committers Count', 'Distinct PR Authors Count',
        'Last Commit Date', 'Last PR Date', 'Last Workflow Date',
        'Avg Branch Duration (Hours)', 'Avg Coding Time (Hours)', 'Avg Review Time (Hours)', 'Avg LOC Changed', 'Avg Review Time / LOC',
        'Distinct Committers List', 'Distinct PR Authors List', 'Environment', 'Timestamp'];

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
        if (!firstLine.includes('Environment')) {
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
