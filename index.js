const fs = require('fs');
const { API_BASE_URL, maxPrsLimit, integrationConfig } = require('./src/config');
const { setupLogging, writeStatus, logError, parseCSV } = require('./src/utils');
const { fetchGitHubPaginated, fetchGitHub, fetchUserEmail } = require('./src/github_api');
const { checkExternalDefect, fetchSonarQubeMetrics } = require('./src/integrations');

// Initialize logging based on config
setupLogging();

// Function for dashboard ETA reporting
// Reset status immediately on startup
writeStatus(0, 0, "Initializing Extractor...", Date.now());

// --- Imports ---
const { processRepo } = require('./src/repo_processor');

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

        if (histData.length > 0 && (!Object.keys(histData[0]).includes('AppCode') || !Object.keys(histData[0]).includes('Environment'))) {
            console.log("Migrating schema: Adding Environment and DORA/SPACE columns...");
            histData = histData.map(row => {
                row.AppCode = row.AppCode || 'Unknown';
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
        const appCode = row.AppCode || "Unknown";
        const cdRepo = row.CDRepository || row.CDRepo || null;

        writeStatus(processed, totalRepos, repo, startTime);

        try {
            const output = await processRepo(repo, capability, sonarQubeKey, history[repo], appCode, cdRepo);
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
    const cols = ['Repository', 'AppCode', 'Capability', 'Repo Type', 'Verification Status', 'Timestamp Verification',
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
        if (!firstLine.includes('AppCode') || !firstLine.includes('Environment')) {
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
                r.AppCode = r.AppCode || 'Unknown';
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
            'Branch Duration (Hours)', 'Review Time (Hours)', 'LOC Changed', 'PR Size (Commits)', 'Target Branch',
            'Time to First Review (Hours)', 'Review Comments Count', 'Requested Reviewers'];

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
            let currentLog = fs.readFileSync('github_activity_log.csv', 'utf-8');
            const firstLine = currentLog.split('\n')[0];

            // Schema Migration: If the old CSV header doesn't have the new PR columns, replace the header line entirely.
            if (!firstLine.includes('Time to First Review (Hours)')) {
                const lines = currentLog.split('\n');
                lines[0] = logCols.join(',');
                currentLog = lines.join('\n');
                fs.writeFileSync('github_activity_log.csv', currentLog);
                console.log("Migrated github_activity_log.csv headers to include new PR metrics");
            }

            if (currentLog && !currentLog.endsWith('\n')) fs.appendFileSync('github_activity_log.csv', '\n');
            fs.appendFileSync('github_activity_log.csv', logContent);
        }
        console.log(`Saved ${allLogs.length} events to github_activity_log.csv`);
    } else {
        console.log("No new activity logs.");
    }

    // Run verification step
    try {
        require('./src/verify-dashboard-math.js');
    } catch (e) {
        console.error("Forensics QA check failed to execute:", e);
    }
}

main();
