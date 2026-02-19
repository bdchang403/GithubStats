const fs = require('fs');

const repos = [
    { name: "facebook/react", cap: "Frontend", type: "Application" },
    { name: "hashicorp/terraform", cap: "Infrastructure", type: "Infrastructure" },
    { name: "expressjs/express", cap: "Backend", type: "Application" },
    { name: "google/guava", cap: "Backend", type: "Application" },
    { name: "vuejs/vue", cap: "Frontend", type: "Application" }
];

const users = ["alice", "bob", "charlie", "dave", "eve", "frank", "grace"];

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomFloat(min, max) { return (Math.random() * (max - min) + min).toFixed(2); }

const headers = [
    'Repository', 'Capability', 'Repo Type', 'Verification Status', 'Timestamp Verification',
    'Total Commits', 'Total Merged PRs',
    'Distinct Committers Count', 'Distinct PR Authors Count',
    'Last Commit Date', 'Last PR Date', 'Last Workflow Date',
    'Avg Branch Duration (Hours)', 'Avg Coding Time (Hours)', 'Avg Review Time (Hours)',
    'Avg LOC Changed', 'Avg Review Time / LOC',
    'Distinct Committers List', 'Distinct PR Authors List',
    'Timestamp'
];

const rows = [];
const today = new Date();

// Generate data for last 7 days to show trends
for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const timestamp = date.toISOString().replace('T', ' ').substring(0, 19);

    repos.forEach(repo => {
        const commits = randomInt(5, 50);
        const prs = randomInt(1, 10);
        const committers = randomInt(3, 15);
        const prAuthors = randomInt(1, 5);

        const row = {
            Repository: repo.name,
            Capability: repo.cap,
            "Repo Type": repo.type,
            "Verification Status": "OK",
            "Timestamp Verification": "Match",
            "Total Commits": commits,
            "Total Merged PRs": prs,
            "Distinct Committers Count": committers,
            "Distinct PR Authors Count": prAuthors,
            "Last Commit Date": timestamp,
            "Last PR Date": timestamp,
            "Last Workflow Date": timestamp,
            "Avg Branch Duration (Hours)": randomFloat(10, 72),
            "Avg Coding Time (Hours)": randomFloat(5, 48),
            "Avg Review Time (Hours)": randomFloat(2, 24),
            "Avg LOC Changed": randomFloat(50, 500),
            "Avg Review Time / LOC": randomFloat(0.01, 0.5),
            "Distinct Committers List": "",
            "Distinct PR Authors List": "",
            "Timestamp": timestamp
        };

        // CSV formatting
        const csvRow = headers.map(h => row[h] || '').join(',');
        rows.push(csvRow);
    });
}

const csvContent = headers.join(',') + '\n' + rows.join('\n');
fs.writeFileSync('github_stats_history.csv', csvContent);
console.log("Generated sample data in github_stats_history.csv");
