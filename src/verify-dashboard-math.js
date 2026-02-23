const fs = require('fs');
const path = require('path');
const { parseCSV, logError } = require('./utils');

// ANSI Escape Codes for formatting console output
const colors = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    bold: "\x1b[1m"
};

console.log(`${colors.cyan}${colors.bold}--- Starting Forensic QA Verification ---${colors.reset}`);

// Paths relative to project root
const OUTPUT_CSV = path.join(__dirname, '..', 'github_stats_output.csv');
const HISTORY_CSV = path.join(__dirname, '..', 'github_stats_history.csv');

function loadData(filePath) {
    if (!fs.existsSync(filePath)) {
        console.warn(`${colors.yellow}Warning: ${filePath} not found. Skipping...${colors.reset}`);
        return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseCSV(content);
}

function verifyMetrics(data, sourceName) {
    if (!data || data.length === 0) return;

    console.log(`\n${colors.bold}Verifying ${sourceName} (${data.length} records)...${colors.reset}`);
    let errorsFound = 0;

    // 1. Check for expected columns
    const record = data[0];
    const expectedCols = [
        'Repository', 'Total Commits', 'Total Merged PRs',
        'Avg Review Time (Hours)', 'Lead Time to Production (Days)',
        'MTTR-Sec (Hours)', 'Change Failure Rate (%)', 'SQ Unit Tests'
    ];

    expectedCols.forEach(col => {
        if (!(col in record)) {
            const msg = `QA ALERT: Missing expected column '${col}' in ${sourceName}`;
            console.error(`${colors.red}${msg}${colors.reset}`);
            logError(msg);
            errorsFound++;
        }
    });

    // 2. Data Type & Boundary Verification
    data.forEach((row, i) => {
        const repo = row['Repository'] || `Row ${i + 2}`;

        // Ensure numerics are actually parseable numbers (not unparsed objects or weird strings)
        const numericCols = [
            'Total Commits', 'Total Merged PRs', 'Lead Time to Production (Days)',
            'MTTR-Sec (Hours)', 'Change Failure Rate (%)', 'SQ Unit Tests'
        ];

        numericCols.forEach(col => {
            if (col in row) {
                const val = row[col];
                if (val === 'N/A' || val === '') return; // Acceptable null states

                const num = parseFloat(val);
                if (isNaN(num)) {
                    const msg = `QA ALERT [${repo}]: '${col}' contains non-numeric value: "${val}"`;
                    console.error(`${colors.red}${msg}${colors.reset}`);
                    logError(msg);
                    errorsFound++;
                }

                // specific logic checks
                if (col === 'Change Failure Rate (%)' && num > 100) {
                    const msg = `QA ALERT [${repo}]: '${col}' is astronomically high (>100%): ${num}%`;
                    console.warn(`${colors.yellow}${msg}${colors.reset}`);
                    // logError(msg); // Not a hard break, but highly suspect
                }

                if (col === 'Total Commits' && num < 0) {
                    const msg = `QA ALERT [${repo}]: '${col}' cannot be negative: ${num}`;
                    console.error(`${colors.red}${msg}${colors.reset}`);
                    logError(msg);
                    errorsFound++;
                }
            }
        });

        // 3. Logic Relationship Verification
        const totalCommits = parseInt(row['Total Commits']) || 0;
        const totalPRs = parseInt(row['Total Merged PRs']) || 0;

        // This is a soft check - sometimes repos have PRs pushed to them without commits being registered in the same timeframe, but it is rare.
        if (totalPRs > totalCommits && totalCommits > 0) {
            console.warn(`${colors.yellow}QA NOTICE [${repo}]: Total PRs (${totalPRs}) exceeds Total Commits (${totalCommits}). This is mathematically possible but highly unusual. Check data source bounds.${colors.reset}`);
        }
    });

    if (errorsFound === 0) {
        console.log(`${colors.green}✔ ${sourceName} passed type and boundary verification.${colors.reset}`);
    } else {
        console.log(`${colors.red}✘ ${sourceName} failed verification with ${errorsFound} errors. Check run_errors.log.${colors.reset}`);
    }
}

// Ensure the UI Mathematical Logic can aggregate properly 
function simulateDashboardAggregation(data) {
    if (!data || data.length === 0) return;
    console.log(`\n${colors.bold}Simulating Dashboard Aggregations...${colors.reset}`);

    // Group by Repos to simulate the "Latest Data" snapshot the UI does
    const repoMap = {};
    data.forEach(d => {
        const dDate = new Date(d._date || d.Timestamp || 0);
        if (!repoMap[d.Repository] || dDate > new Date(repoMap[d.Repository]._date || repoMap[d.Repository].Timestamp || 0)) {
            repoMap[d.Repository] = d;
        }
    });

    const latestData = Object.values(repoMap);

    // Summation simulation (to catch the NaN / String Concatenation bugs)
    let totalCommits = 0;
    let totalPRs = 0;

    // Developer uniqueness arrays
    const uniqueCommitters = new Set();
    const uniquePRAuthors = new Set();
    let fallbackCommitters = 0;
    let fallbackAuthors = 0;

    // Averages
    let mttrTotal = 0;
    let totalCFR = 0;
    let reposWithDeploys = 0;

    // AI & DevSecOps Table Metrics
    let totalCICDFail = 0;
    let totalTechDebt = 0;
    let totalUnitTests = 0;
    let totalChurn = 0;
    let totalReviewHours = 0;
    let totalTrueLead = 0;
    let totalPRRatio = 0;
    let totalCodeVelocity = 0;
    let totalReviewComments = 0;

    let errorsFound = 0;

    latestData.forEach(d => {
        totalCommits += (parseInt(d['Total Commits']) || 0);
        totalPRs += (parseInt(d['Total Merged PRs']) || 0);

        // Dev parsing logic test (mirroring dashboard-ui.js)
        let hasCommitters = false;
        if (d['Distinct Committers List']) {
            const list = d['Distinct Committers List'];
            const names = list.replace(/^"|"$/g, '').split(',');
            names.forEach(name => {
                const trimmed = name.trim();
                if (trimmed && trimmed.length > 0) {
                    uniqueCommitters.add(trimmed);
                    hasCommitters = true;
                }
            });
        }
        if (!hasCommitters) fallbackCommitters += (parseInt(d['Distinct Committers Count']) || 0);

        let hasAuthors = false;
        if (d['Distinct PR Authors List']) {
            const list = d['Distinct PR Authors List'];
            const names = list.replace(/^"|"$/g, '').split(',');
            names.forEach(name => {
                const trimmed = name.trim();
                if (trimmed && trimmed.length > 0) {
                    uniquePRAuthors.add(trimmed);
                    hasAuthors = true;
                }
            });
        }
        if (!hasAuthors) fallbackAuthors += (parseInt(d['Distinct PR Authors Count']) || 0);

        // Averages logic test
        mttrTotal += (parseFloat(d['MTTR-Sec (Hours)']) || 0);
        if ((parseInt(d['Successful Deployments']) || 0) > 0) {
            reposWithDeploys++;
            totalCFR += (parseFloat(d['Change Failure Rate (%)']) || 0);
        }

        // AI Metrics / Table Metrics
        totalCICDFail += (parseFloat(d['CI/CD Failure Rate (%)']) || 0);
        totalTechDebt += (parseFloat(d['SQ Technical Debt (Days)']) || 0);
        totalUnitTests += (parseFloat(d['SQ Unit Tests']) || 0);
        totalChurn += (parseFloat(d['Avg Code Churn (Commits)']) || 0);
        totalReviewHours += (parseFloat(d['Avg Review Time (Hours)']) || 0);
        totalTrueLead += (parseFloat(d['True Lead Time for Changes (Hours)']) || 0);
        totalPRRatio += (parseFloat(d['Small to Large PR Ratio']) || 0);
        totalCodeVelocity += (parseFloat(d['Coding Velocity (LOC/Hr)']) || 0);
        totalReviewComments += (parseFloat(d['Avg Review Comments per PR']) || 0);
    });

    const activeCommitters = uniqueCommitters.size + fallbackCommitters;
    const activeAuthors = uniquePRAuthors.size + fallbackAuthors;

    const count = latestData.length > 0 ? latestData.length : 1;
    const finalMTTR = latestData.length > 0 ? (mttrTotal / count).toFixed(1) : "0.0";
    const finalCFR = reposWithDeploys > 0 ? (totalCFR / reposWithDeploys).toFixed(1) : "0.0";

    const avgCICD = (totalCICDFail / count).toFixed(1);
    const avgTechDebt = (totalTechDebt / count).toFixed(1);
    const avgChurn = (totalChurn / count).toFixed(1);
    const avgReviewHrs = (totalReviewHours / count).toFixed(1);
    const avgTrueLead = (totalTrueLead / count).toFixed(1);
    const avgPRRatio = (totalPRRatio / count).toFixed(2);
    const avgVelocity = (totalCodeVelocity / count).toFixed(1);
    const avgRevComments = (totalReviewComments / count).toFixed(1);

    const runMathCheck = (val, name) => {
        if (isNaN(val) || typeof val === 'string' && val.includes('NaN')) {
            const msg = `QA ALERT: Dashboard '${name}' aggregation failed. Result: ${val}`;
            console.error(`${colors.red}${msg}${colors.reset}`);
            logError(msg);
            errorsFound++;
        }
    };

    runMathCheck(totalCommits, 'Total Commits');
    runMathCheck(totalPRs, 'Total PRs');
    runMathCheck(activeCommitters, 'Active Committers');
    runMathCheck(activeAuthors, 'Active PR Authors');
    runMathCheck(parseFloat(finalMTTR), 'MTTR'); // Need to parse the string to check for string-embedded NaN
    runMathCheck(parseFloat(finalCFR), 'CFR');

    runMathCheck(totalUnitTests, 'Total Unit Tests');
    runMathCheck(parseFloat(avgCICD), 'CI/CD Failure Rate');
    runMathCheck(parseFloat(avgTechDebt), 'Technical Debt');
    runMathCheck(parseFloat(avgChurn), 'Code Churn');
    runMathCheck(parseFloat(avgReviewHrs), 'Review Hours');
    runMathCheck(parseFloat(avgTrueLead), 'True Lead Time');
    runMathCheck(parseFloat(avgPRRatio), 'PR Ratio');
    runMathCheck(parseFloat(avgVelocity), 'Code Velocity');
    runMathCheck(parseFloat(avgRevComments), 'Review Comments per PR');

    if (errorsFound === 0) {
        console.log(`${colors.green}✔ Simulated Dashboard UI logic passed flawlessly.${colors.reset}`);
        console.log(`   - Simulated Commits: ${totalCommits}`);
        console.log(`   - Simulated Merged PRs: ${totalPRs}`);
        console.log(`   - Simulated Active Committers: ${activeCommitters}`);
        console.log(`   - Simulated Active PR Authors: ${activeAuthors}`);
        console.log(`   - Simulated MTTR: ${finalMTTR} hrs`);
        console.log(`   - Simulated CFR: ${finalCFR}%`);
        console.log(`   - Simulated CI/CD Fail Rate: ${avgCICD}%`);
        console.log(`   - Simulated Tech Debt: ${avgTechDebt} days`);
        console.log(`   - Simulated Unit Tests: ${totalUnitTests}`);
        console.log(`   - Simulated Churn: ${avgChurn} commits/PR`);
        console.log(`   - Simulated Velocity: ${avgVelocity} LOC/Hr`);
        console.log(`   - Simulated PR Ratio: ${avgPRRatio}`);
    }
}

function runVerification() {
    const outputData = loadData(OUTPUT_CSV);
    const historyData = loadData(HISTORY_CSV);

    verifyMetrics(outputData, 'github_stats_output.csv');
    verifyMetrics(historyData, 'github_stats_history.csv');

    if (historyData) {
        simulateDashboardAggregation(historyData);
    }

    console.log(`\n${colors.cyan}${colors.bold}--- Forensic QA Verification Complete ---${colors.reset}\n`);
}

runVerification();
