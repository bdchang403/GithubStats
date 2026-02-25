const { API_BASE_URL, maxPrsLimit, integrationConfig } = require('./config');
const { fetchGitHubPaginated, fetchGitHub, fetchUserEmail } = require('./github_api');
const { checkExternalDefect, fetchSonarQubeMetrics } = require('./integrations');

function getEnvironment(branch) {
    if (!branch) return "Unknown";
    const b = branch.toLowerCase();

    // Development / Feature / Fixes / Bots
    if (["develop", "dev", "feature", "bug", "fix", "poc", "exp", "sandbox", "wip", "draft", "dependabot", "renovate", "snyk"].some(x => b.includes(x))) return "Development";
    // Testing / Integration
    if (["sit", "test", "staging", "stg", "qa", "integration", "int"].some(x => b.includes(x))) return "SIT";
    // UAT / Pre-prod
    if (["pat", "uat", "release", "pre-prod", "preprod", "rc"].some(x => b.includes(x))) return "PAT";
    // Production / Live / Docs
    if (["main", "master", "prod", "trunk", "live", "hotfix", "gh-pages", "docs"].some(x => b.includes(x))) return "Production";

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

async function processRepo(repoName, capability, sonarQubeKey, prevState, appCode, cdRepo) {
    console.log(`Processing ${repoName}...`);
    const stats = {
        Repository: repoName,
        AppCode: appCode,
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

    // --- Cross-Repo DORA Tracking (Fetch CD logs if CD Repository provided) ---
    let cdCommits = [];
    let cdRunsRaw = [];

    if (cdRepo && cdRepo !== "Unknown") {
        console.log(`  Fetching CD Infrastructure from ${cdRepo}`);
        // Fetch recent CD commits
        const cdCommitsRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${cdRepo}/commits?per_page=100`, 3);
        if (cdCommitsRes && Array.isArray(cdCommitsRes)) cdCommits = cdCommitsRes;

        // Fetch recent CD workflow runs
        const cdRunsRes = await fetchGitHubPaginated(`${API_BASE_URL}/repos/${cdRepo}/actions/runs?per_page=100&sort=created_at&direction=desc`, 3);
        if (cdRunsRes && cdRunsRes.workflow_runs && Array.isArray(cdRunsRes.workflow_runs)) {
            cdRunsRaw = cdRunsRes.workflow_runs.filter(r => r.conclusion === "success" && ["main", "master", "prod"].some(b => (r.head_branch || "").toLowerCase().includes(b)));
        }
    }

    // 1. Commits
    let sinceParam = "";
    if (prevState && prevState["Last Commit Date"]) {
        sinceParam = `&since=${prevState["Last Commit Date"]}`;
        console.log(`  Fetching commits since ${prevState["Last Commit Date"]}`);
    }

    // Multiply the PR limit by 10 to give commits a far healthier buffer (e.g., 1000 commits) to prevent the 200 commit ceiling
    const maxCommitPages = Math.ceil(maxPrsLimit / 100) * 10;
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

            // User: Try Head Commit Email, else Profile API Email (skip `.login` fallback)
            let runUser = "Unknown";
            if (run.head_commit && run.head_commit.author && run.head_commit.author.email) {
                runUser = run.head_commit.author.email;
            } else if (run.triggering_actor) {
                const fetchedEmail = await fetchUserEmail(run.triggering_actor.login);
                if (fetchedEmail) runUser = fetchedEmail;
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
                    let prEmail = prDetail.user.email;
                    if (!prEmail) prEmail = await fetchUserEmail(prDetail.user.login);

                    // Fallback to extraction from PR Commits using the first commit's git-author string
                    if (!prEmail && prCommitsRes && prCommitsRes.length > 0) {
                        prEmail = prCommitsRes[0].commit.author.email;
                    }

                    // Strict user preference: Only emit explicit Email strings instead of `.login` fallback
                    author = prEmail || "Unknown";
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

                // Extract requested reviewers:
                const requestedReviewersObj = prDetail.requested_reviewers || [];
                const requestedReviewers = requestedReviewersObj.map(r => r.login).join(', ');

                let logEntry = {
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
                    "Target Branch": prDetail.base.ref,
                    "Time to First Review (Hours)": "",
                    "Review Comments Count": 0,
                    "Requested Reviewers": requestedReviewers
                };

                // --- 2c: Deep Metrics Extraction Continued (Only for merged PRs) ---
                if (!isMerged) {
                    logs.push(logEntry);
                    return;
                }

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
                        // Cross-Repo Tracking: If cdRepo is provided, search the CD commit history for the PR's merge_commit_sha
                        let firstDeploy = null;
                        if (cdRepo && cdRepo !== "Unknown" && prDetail.merge_commit_sha) {
                            const sha = prDetail.merge_commit_sha;
                            // Does the CD repo contain a commit that explicitly references this App's PR merge SHA?
                            const correlatedCdCommit = cdCommits.find(cdc => cdc.commit.message.includes(sha));

                            if (correlatedCdCommit) {
                                const cdCommitDate = new Date(correlatedCdCommit.commit.committer.date);
                                // Find the first successful CD deploy that occurred AFTER this CD commit was pushed
                                const subsequentCdDeploy = cdRunsRaw.find(cdr => new Date(cdr.created_at) >= cdCommitDate);

                                if (subsequentCdDeploy) {
                                    firstDeploy = new Date(subsequentCdDeploy.created_at);
                                } else {
                                    // Fallback: If no workflow exists, just use the CD commit timestamp itself
                                    firstDeploy = cdCommitDate;
                                }
                            }
                        } else {
                            // Standard Monorepo tracking
                            firstDeploy = recentDeploys.find(d => d >= closedAt);
                        }

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
                    logEntry["Review Comments Count"] = reviewsRes.length;

                    // Wait time to first review
                    const sortedReviews = reviewsRes
                        .filter(r => r.submitted_at)
                        .sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));

                    if (sortedReviews.length > 0) {
                        const firstReviewTime = new Date(sortedReviews[0].submitted_at);
                        if (firstReviewTime > createdAt) {
                            const waitTime = (firstReviewTime - createdAt) / (1000 * 3600);
                            totalWaitTimeHours += waitTime;
                            logEntry["Time to First Review (Hours)"] = waitTime.toFixed(2);
                        }

                        if (prCommitsRes && Array.isArray(prCommitsRes)) {
                            const churn = prCommitsRes.filter(c => new Date(c.commit.committer.date) > firstReviewTime).length;
                            totalCodeChurn += churn;
                        }
                    }
                }
                
                logs.push(logEntry);
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
    if (langs && Object.keys(langs).length > 0) {
        if (langs["Terraform"] || langs["HCL"] || langs["Bicep"] || langs["CloudFormation"] || langs["Dockerfile"] === Object.values(langs).reduce((a, b) => a + b, 0)) {
            stats["Repo Type"] = "Infrastructure";
        } else {
            const infraLangs = ['Shell', 'Dockerfile', 'Makefile', 'Smarty', 'Puppet', 'Ansible', 'Chef', 'Vagrantfile', 'PowerShell', 'Batchfile', 'HCL', 'Nix', 'Groovy', 'Ruby'];
            let total = 0;
            let infra = 0;
            Object.keys(langs).forEach(l => {
                total += langs[l];
                if (infraLangs.includes(l)) infra += langs[l];
            });
            // If more than 40% of the repo code is infrastructure/automation code, classify as Infrastructure
            if (total > 0 && (infra / total) >= 0.4) stats["Repo Type"] = "Infrastructure";
            else stats["Repo Type"] = "Application";
        }
    } else {
        // Empty repo, markdown-only, or no recognized language
        stats["Repo Type"] = "Other";
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

module.exports = { processRepo };