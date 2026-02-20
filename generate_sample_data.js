const fs = require('fs');

const rawData = `Repository,Capability,Repo Type,Verification,Status,Total Comm,Total Merge,Distinct Co,Distinct PR,Avg Branch,Avg Review,Avg LOC Ch,Distinct Committer,Distinct PR User
Repo-Alpha-01,Cap-Core,Application,OK,New Repos,74,5,9,1,2.72,2.72,132.8,User_8472,dev_acc_1
Repo-Alpha-02,Cap-Core,Infrastructure,OK,New Repos,100,5,9,2,0.68,0.68,347.6,User_9122,dev_acc_2
Repo-Alpha-03,Cap-Core,Infrastructure,OK,New Repos,100,5,10,2,0.32,0.32,18.8,User_9122,dev_acc_2
Repo-Alpha-04,Cap-Core,Application,OK,New Repos,4,0,2,0,0.00,0.00,0.0,EDP_Team,svc_bot_3
Repo-Beta-01,Cap-Storage,Infrastructure,OK,New Repos,100,5,12,3,1.93,1.93,64.6,User_1055,dev_acc_4
Repo-Beta-02,Cap-Storage,Unknown,OK,New Repos,0,0,0,0,0.00,0.00,0.0,None,Unknown
Repo-Beta-03,Cap-Storage,Infrastructure,OK,New Repos,100,5,4,2,12.63,12.63,11.4,User_3341,dev_acc_5
Repo-Gamma-01,Cap-Ingestion,Infrastructure,OK,New Repos,100,5,7,1,0.13,0.13,72.8,User_7761,dev_acc_6
Repo-Gamma-02,Cap-Ingestion,Application,OK,New Repos,7,2,5,2,9.60,9.60,275.0,User_2290,dev_acc_7
Repo-Delta-01,Cap-Reporting,Infrastructure,OK,Match,100,5,9,1,0.29,0.29,11.2,User_4431,dev_acc_8
Repo-Alpha-05,Cap-Core,Infrastructure,OK,Match,1,0,13,2,0.68,0.68,347.6,User_9122,dev_acc_2
Repo-Alpha-06,Cap-Core,Infrastructure,OK,Match,1,0,18,2,0.32,0.32,18.8,User_9122,dev_acc_2`;

const historyHeaders = [
    'Repository', 'Capability', 'Repo Type', 'Verification Status', 'Timestamp Verification',
    'Total Commits', 'Total Merged PRs',
    'Distinct Committers Count', 'Distinct PR Authors Count',
    'Last Commit Date', 'Last PR Date', 'Last Workflow Date',
    'Avg Branch Duration (Hours)', 'Avg Coding Time (Hours)', 'Avg Review Time (Hours)', 'Avg LOC Changed', 'Avg Review Time / LOC',
    'MTTR-Sec (Hours)', 'Successful Deployments', 'Avg Review Comments per PR', 'Avg Wait Time for First Review (Hours)', 'Avg PR Description Length (Chars)', 'Small to Large PR Ratio',
    'Change Failure Rate (%)', 'True Lead Time for Changes (Hours)', 'Lead Time to Production (Days)', 'CI/CD Failure Rate (%)', 'CI/CD Avg Execution Time (Mins)', 'Avg Code Churn (Commits)',
    'Test Code Ratio (%)', 'Coding Velocity (LOC/Hr)',
    "SQ Security Rating",
    "SQ Technical Debt (Days)",
    "SQ Code Smells",
    "SQ Vulnerabilities",
    "SQ Unit Tests",
    "_date",
    'Distinct Committers List', 'Distinct PR Authors List', 'Environment', 'Timestamp'
];

const activityHeaders = [
    'Timestamp', 'Repository', 'Capability', 'Action', 'User', 'Date', 'Environment', 'Cross-Ref ID', 'Associated PR', 'ID', 'Message',
    'Branch Duration (Hours)', 'Review Time (Hours)', 'LOC Changed', 'PR Size (Commits)', 'Target Branch'
];

function randomFloat(min, max) { return (Math.random() * (max - min) + min).toFixed(2); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const lines = rawData.trim().split('\n');
const parsed = lines.slice(1).map(line => {
    const parts = line.split(',');
    return {
        Repository: parts[0],
        Capability: parts[1],
        RepoType: parts[2],
        VerificationStatus: parts[3],
        TimestampVerification: parts[4],
        TotalCommits: parseInt(parts[5]),
        TotalMergedPRs: parseInt(parts[6]),
        DistinctCommittersCount: parseInt(parts[7]),
        DistinctPRAuthorsCount: parseInt(parts[8]),
        AvgBranch: parseFloat(parts[9]),
        AvgReview: parseFloat(parts[10]),
        AvgLOC: parseFloat(parts[11]),
        DistinctCommitter: parts[12],
        DistinctPRUser: parts[13]
    };
});

const today = new Date();

// Generate History / Output rows
const historyRows = [];
const outputRows = [];
const inputRows = ['Repository,Capability'];
const activityRows = [];

// Generate data for the last 7 days
for (let i = 0; i < 7; i++) {
    const dDate = new Date(today);
    dDate.setDate(dDate.getDate() - (6 - i)); // i=6 is today
    const timestamp = dDate.toISOString().replace('T', ' ').substring(0, 19);
    const recentDate = dDate.toISOString();

    parsed.forEach(p => {
        if (i === 6) {
            inputRows.push(p.Repository + ',' + p.Capability);
        }

        // Slight daily randomization so charts aren't flat
        const variance = (Math.random() * 0.4) - 0.2; // +/- 20%
        const mult = 1 + variance;

        const codingTime = Math.max(0, p.AvgBranch - p.AvgReview).toFixed(2);
        const revLocRatio = p.AvgLOC > 0 ? (p.AvgReview / p.AvgLOC).toFixed(4) : "0.0000";

        const dailyCommits = Math.max(0, Math.round(p.TotalCommits * mult));
        const mttr = p.TotalCommits > 0 ? Math.max(0, randomFloat(1, 48) * mult).toFixed(2) : 0;
        const deploys = p.TotalCommits > 0 ? Math.round(randomInt(1, 20) * mult) : 0;
        const reviewComments = p.DistinctPRAuthorsCount > 0 ? Math.max(0, randomFloat(1, 5) * mult).toFixed(2) : 0;
        const waitTime = p.DistinctPRAuthorsCount > 0 ? Math.max(0, randomFloat(0.5, 12) * mult).toFixed(2) : 0;
        const descLen = p.DistinctPRAuthorsCount > 0 ? Math.round(randomInt(50, 500) * mult) : 0;
        const prRatio = p.DistinctPRAuthorsCount > 0 ? Math.max(0, randomFloat(0.5, 3.0) * mult).toFixed(2) : 0;

        const avgBranch = Math.max(0, p.AvgBranch * mult).toFixed(2);
        const avgReview = Math.max(0, p.AvgReview * mult).toFixed(2);
        const avgLoc = Math.max(0, p.AvgLOC * mult).toFixed(1);

        const cfr = p.TotalCommits > 0 ? Math.max(0, randomFloat(0, 5) * mult).toFixed(2) : 0;
        const trueLead = p.TotalMergedPRs > 0 ? Math.max(0, p.AvgBranch * mult * 1.5).toFixed(2) : 0;

        // Simulate a downward trend from ~60 days to ~40 days as requested by user
        // i=0 is oldest, i=6 is newest
        const leadProdBase = p.TotalMergedPRs > 0 ? (60 - (i * 3.3)) : 0;
        const leadProd = leadProdBase > 0 ? Math.max(0, leadProdBase * mult).toFixed(2) : 0;

        const ciFail = Math.max(0, randomFloat(0, 10) * mult).toFixed(2);
        const ciExec = Math.max(0, randomFloat(1, 15) * mult).toFixed(2);
        const churn = p.DistinctPRAuthorsCount > 0 ? Math.max(0, randomFloat(0.1, 2.5) * mult).toFixed(2) : 0;

        // Mock AI Proxy data over the 7 days (i=0 to 6)
        // Test Code Ratio climbs from ~10% to ~45%
        const testRatioBase = p.TotalMergedPRs > 0 ? (10 + (i * 5.8)) : 0;
        const testRatio = testRatioBase > 0 ? Math.max(0, testRatioBase * mult).toFixed(2) : 0;

        // Velocity leaps from ~40 LOC/Hr to ~160 LOC/Hr
        const velocityBase = p.TotalMergedPRs > 0 ? (40 + (i * 20)) : 0;
        const velocity = velocityBase > 0 ? Math.max(0, velocityBase * mult).toFixed(2) : 0;

        const row = [
            p.Repository, p.Capability, p.RepoType, p.VerificationStatus, p.TimestampVerification,
            dailyCommits, p.TotalMergedPRs,
            p.DistinctCommittersCount, p.DistinctPRAuthorsCount,
            dailyCommits > 0 ? recentDate : '',
            p.TotalMergedPRs > 0 ? recentDate : '',
            recentDate, // Workflow date
            avgBranch, codingTime, avgReview, avgLoc, revLocRatio,
            mttr, deploys, reviewComments, waitTime, descLen, prRatio,
            cfr, trueLead, leadProd, ciFail, ciExec, churn,
            testRatio, velocity,
            '"' + p.DistinctCommitter + '"', '"' + p.DistinctPRUser + '"', "Production", timestamp
        ];

        const cvss = Math.random() < 0.2 ? "C" : (Math.random() < 0.5 ? "B" : "A");
        const sqUnitTests = Math.floor(Math.random() * 500) + 50;

        row.splice(row.length - 4, 0, // Insert before DistinctCommittersList, DistinctPRAuthorsList, Environment, Timestamp
            cvss,                            // SQ Security Rating
            (Math.random() * 40).toFixed(1), // SQ Technical Debt (Days)
            Math.floor(Math.random() * 200), // SQ Code Smells
            cvss === "A" ? 0 : Math.floor(Math.random() * 5) + 1, // SQ Vulnerabilities
            sqUnitTests,                     // SQ Unit Tests
            dDate.toISOString() // _date
        );

        const csvLine = row.join(',');

        // Push to history for every day
        historyRows.push(csvLine);

        // Only push to output/current for today
        if (i === 6) {
            outputRows.push(csvLine);
        }

        // Generate Mock Activity Logs for the last 3 days to populate the feed
        if (i >= 4) {
            if (dailyCommits > 0) {
                activityRows.push([
                    timestamp, p.Repository, p.Capability, "Commit", p.DistinctCommitter, recentDate, "Production",
                    "CHG1234", "", "a1b2c3d", "Mock commit message", "", "", "", "", ""
                ].join(','));
            }
            if (p.TotalMergedPRs > 0) {
                activityRows.push([
                    timestamp, p.Repository, p.Capability, "Merge (PR)", p.DistinctPRUser, recentDate, "Production",
                    "CHG1234", "PR #" + randomInt(1, 100), "PR #" + randomInt(1, 100), "Mock PR message", avgBranch, avgReview, avgLoc, dailyCommits, "main"
                ].join(','));
            }
            if (deploys > 0) {
                activityRows.push([
                    timestamp, p.Repository, p.Capability, "Workflow Run (success)", "svc_bot", recentDate, "Production",
                    "", "", "Run #" + randomInt(100, 999), "Deploy to Prod", "", "", "", "", "main"
                ].join(','));
            }
        }
    });
}

fs.writeFileSync('github_stats_history.csv', historyHeaders.join(',') + '\n' + historyRows.join('\n'));
fs.writeFileSync('github_stats_output.csv', historyHeaders.join(',') + '\n' + outputRows.join('\n'));
fs.writeFileSync('github_input.csv', inputRows.join('\n'));
fs.writeFileSync('github_activity_log.csv', activityHeaders.join(',') + '\n' + activityRows.join('\n'));

console.log("Successfully generated multi-day test data based on user constraints.");
