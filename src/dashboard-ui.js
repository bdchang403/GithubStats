// Global Data
let historyData = [];
let activityData = []; // New: Full event log
let filteredData = []; // History filtered
let filteredActivityData = []; // Activity filtered
let latestData = [];   // Latest snapshot

// Chart Instances
const chartInstances = {};

// Initialization
window.onload = async () => {
    await loadData();
    document.getElementById('loading').style.display = 'none';
};

async function loadData() {
    try {
        // Fetch both History (Snapshots) and Activity (Events)
        const [histRes, actRes] = await Promise.all([
            fetch('github_stats_history.csv'),
            fetch('github_activity_log.csv')
        ]);

        if (!histRes.ok) throw new Error("Failed to load History CSV: " + histRes.status);

        const rawHistory = await histRes.text();
        const rawActivity = await actRes.text();

        if (!rawHistory || rawHistory.length < 10) throw new Error("History CSV is empty");

        historyData = parseCSV(rawHistory);
        activityData = parseCSV(rawActivity);

        console.log(`Loaded ${historyData.length} history rows, ${activityData.length} activity rows`);

        if (historyData.length === 0) {
            showError("No data parsed from History CSV.");
            return;
        }

        // Parse History Data (Snapshots)
        historyData.forEach(row => {
            // Normalize empty strings to 0
            row['Total Commits'] = parseInt(row['Total Commits']) || 0;
            row['Total Merged PRs'] = parseInt(row['Total Merged PRs']) || 0;
            row['Distinct Committers Count'] = parseInt(row['Distinct Committers Count']) || 0;
            row['Distinct PR Authors Count'] = parseInt(row['Distinct PR Authors Count']) || 0;
            row['Avg Branch Duration (Hours)'] = parseFloat(row['Avg Branch Duration (Hours)']) || 0;
            row['Avg Review Time (Hours)'] = parseFloat(row['Avg Review Time (Hours)']) || 0;
            row['Avg Coding Time (Hours)'] = parseFloat(row['Avg Coding Time (Hours)']) || 0;
            row['Avg LOC Changed'] = parseFloat(row['Avg LOC Changed']) || 0;
            row['Avg Review Time / LOC'] = parseFloat(row['Avg Review Time / LOC']) || 0;
            row['MTTR-Sec (Hours)'] = parseFloat(row['MTTR-Sec (Hours)']) || 0;
            row['Successful Deployments'] = parseInt(row['Successful Deployments']) || 0;
            row['Avg Review Comments per PR'] = parseFloat(row['Avg Review Comments per PR']) || 0;
            row['Avg Wait Time for First Review (Hours)'] = parseFloat(row['Avg Wait Time for First Review (Hours)']) || 0;
            row['Avg PR Description Length (Chars)'] = parseInt(row['Avg PR Description Length (Chars)']) || 0;
            row['Small to Large PR Ratio'] = parseFloat(row['Small to Large PR Ratio']) || 0;
            row['Change Failure Rate (%)'] = parseFloat(row['Change Failure Rate (%)']) || 0;
            row['True Lead Time for Changes (Hours)'] = parseFloat(row['True Lead Time for Changes (Hours)']) || 0;
            row['Lead Time to Production (Days)'] = parseFloat(row['Lead Time to Production (Days)']) || 0;
            row['CI/CD Failure Rate (%)'] = parseFloat(row['CI/CD Failure Rate (%)']) || 0;
            row['CI/CD Avg Execution Time (Mins)'] = parseFloat(row['CI/CD Avg Execution Time (Mins)']) || 0;
            row['Avg Code Churn (Commits)'] = parseFloat(row['Avg Code Churn (Commits)']) || 0;
            row['SQ Security Rating'] = row['SQ Security Rating'] || "N/A";
            row['SQ Technical Debt (Days)'] = parseFloat(row['SQ Technical Debt (Days)']) || 0;
            row['SQ Code Smells'] = parseInt(row['SQ Code Smells'] || 0, 10);
            row['SQ Vulnerabilities'] = parseInt(row['SQ Vulnerabilities'] || 0, 10);

            // Date parsing for filter (handle missing timestamp with fallback)
            let tsStr = row['Timestamp'] || row['Date'];
            if (tsStr && tsStr.trim()) {
                tsStr = tsStr.trim();
                // Force UTC parsing for "YYYY-MM-DD HH:mm:ss" format
                if (tsStr.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) {
                    tsStr = tsStr.replace(' ', 'T') + 'Z';
                }
                row._date = new Date(tsStr);
                if (isNaN(row._date)) row._date = new Date(0); // Epoch fallback
            } else {
                row._date = new Date(0); // Epoch fallback
            }
        });

        // Build map of Repository -> AppCode from history to join against activity logs
        const repoToApp = {};
        historyData.forEach(row => {
            if (row.Repository && row.AppCode) {
                repoToApp[row.Repository] = row.AppCode;
            }
        });

        // Parse Dates for Activity log and Inject AppCode
        activityData.forEach(row => {
            row.AppCode = repoToApp[row.Repository] || row.AppCode || 'Unknown';
            // "Date" column is the event time (Commit/PR/Run)
            if (row['Date'] && row['Date'].trim()) {
                row._eventDate = new Date(row['Date']);
            } else {
                row._eventDate = new Date(0); // Unknown date
            }
        });

        initFilters();
        applyFilters(); // Initial render
    } catch (e) {
        console.error("Load Error", e);
        showError("Error loading data: " + e.message + ". Check console for details.");
    }
}

function showError(msg) {
    const el = document.getElementById('error-msg');
    el.innerText = msg;
    el.style.display = 'block';
}

// CSV Parser using PapaParse
function parseCSV(text) {
    if (!text || text.trim().length === 0) return [];
    try {
        const result = Papa.parse(text.trim(), {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: false
        });
        if (result.errors && result.errors.length > 0) {
            console.warn("CSV Parsing warning:", result.errors);
        }
        return result.data;
    } catch (e) {
        console.error("CSV Parsing error:", e);
        return [];
    }
}

// Filters
function initFilters() {
    // Capabilities
    const caps = [...new Set(historyData.map(d => d.Capability).filter(x => x))].sort();
    const capSel = document.getElementById('filter-capability');
    capSel.innerHTML = '';
    caps.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c; opt.text = c; opt.selected = true;
        capSel.appendChild(opt);
    });
    if (caps.length === 0) {
        const opt = document.createElement('option');
        opt.text = "No Capabilities Found";
        capSel.appendChild(opt);
    }

    // Repos (Migrated to AppCode)
    const repos = [...new Set(historyData.map(d => d.AppCode || d.Repository).filter(x => x))].sort();
    const repSel = document.getElementById('filter-repo');
    repSel.innerHTML = '';
    repos.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r; opt.text = r; opt.selected = true;
        repSel.appendChild(opt);
    });
    if (repos.length === 0) {
        const opt = document.createElement('option');
        opt.text = "No Apps Found";
        repSel.appendChild(opt);
    }


    // Dates
    // Default End Date to Tomorrow 
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const endStr = tomorrow.toISOString().split('T')[0];

    // Filter invalid dates for Range
    const dates = historyData.map(d => d._date).filter(d => !isNaN(d)).sort((a, b) => a - b);
    if (dates.length > 0) {
        // Format YYYY-MM-DD
        const toInput = (d) => d.toISOString().split('T')[0];
        document.getElementById('filter-start-date').value = toInput(dates[0]);
        document.getElementById('filter-end-date').value = endStr;
    } else {
        const now = new Date().toISOString().split('T')[0];
        document.getElementById('filter-start-date').value = now;
        document.getElementById('filter-end-date').value = endStr;
    }
}

function getSelectedValues(id) {
    return Array.from(document.getElementById(id).selectedOptions).map(o => o.value);
}

function applyFilters() {
    const selCaps = getSelectedValues('filter-capability');
    const selRepos = getSelectedValues('filter-repo');
    const startStr = document.getElementById('filter-start-date').value;
    const endStr = document.getElementById('filter-end-date').value;

    const start = startStr ? new Date(startStr) : new Date(0);
    const end = endStr ? new Date(endStr) : new Date();
    end.setHours(23, 59, 59, 999);

    // Debug Logic
    console.log("Filter Range:", start, "to", end);

    // Filter Raw Data
    filteredData = historyData.filter(d => {
        const capMatch = selCaps.length === 0 || selCaps.includes(d.Capability || 'Unknown');
        const repoMatch = selRepos.length === 0 || selRepos.includes(d.AppCode || d.Repository);

        let dateMatch = true;
        if (!isNaN(d._date)) {
            dateMatch = d._date >= start && d._date <= end;
        }
        return capMatch && repoMatch && dateMatch;
    });

    // Filter Activity Data (Events)
    filteredActivityData = activityData.filter(d => {
        const capMatch = selCaps.length === 0 || selCaps.includes(d.Capability || 'Unknown');
        const repoMatch = selRepos.length === 0 || selRepos.includes(d.AppCode || d.Repository);

        let dateMatch = true;
        if (!isNaN(d._eventDate)) {
            dateMatch = d._eventDate >= start && d._eventDate <= end;
        }
        return capMatch && repoMatch && dateMatch;
    });

    if (filteredData.length === 0 && historyData.length > 0) {
        console.warn("Filters excluded all data");
        showError("No data matches the selected filters.");
    } else {
        showError(""); // clear error
    }

    // Compute Latest Snapshot: Group by Repo, find max Date
    const repoMap = {};
    filteredData.forEach(d => {
        if (!repoMap[d.Repository] || d._date > repoMap[d.Repository]._date) {
            repoMap[d.Repository] = d;
        }
    });
    latestData = Object.values(repoMap);

    updateKPIs();
    updateCharts();
    updateTable();

    // Last updated text
    if (filteredData.length > 0) {
        const maxDate = new Date(Math.max(...filteredData.map(d => d._date)));
        document.getElementById('last-updated').innerText = "Last Updated: " + maxDate.toLocaleString();
    } else {
        document.getElementById('last-updated').innerText = "No Data Selected";
    }
}

// Updates
function updateKPIs() {
    document.getElementById('kpi-repos').innerText = new Set(latestData.map(d => d.AppCode || d.Repository).filter(Boolean)).size;
    document.getElementById('kpi-commits').innerText = latestData.reduce((acc, d) => acc + (parseInt(d['Total Commits']) || 0), 0);
    document.getElementById('kpi-prs').innerText = latestData.reduce((acc, d) => acc + (parseInt(d['Total Merged PRs']) || 0), 0);

    // Calculate Unique Developers across all visible repos
    const uniqueCommitters = new Set();
    const uniquePRAuthors = new Set();
    let fallbackCommitters = 0;
    let fallbackAuthors = 0;

    latestData.forEach(d => {
        // Parse Comma Separated Lists
        let hasCommitters = false;
        if (d['Distinct Committers List']) {
            const list = d['Distinct Committers List'];
            // Handle case where list might be wrapped in quotes or have extra whitespace
            const names = list.replace(/^"|"$/g, '').split(',');
            names.forEach(name => {
                const trimmed = name.trim();
                if (trimmed && trimmed.length > 0) {
                    uniqueCommitters.add(trimmed);
                    hasCommitters = true;
                }
            });
        }
        if (!hasCommitters) {
            fallbackCommitters += (parseInt(d['Distinct Committers Count']) || 0);
        }

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
        if (!hasAuthors) {
            fallbackAuthors += (parseInt(d['Distinct PR Authors Count']) || 0);
        }
    });

    document.getElementById('kpi-devs').innerText = uniqueCommitters.size + fallbackCommitters;
    document.getElementById('kpi-pr-authors').innerText = uniquePRAuthors.size + fallbackAuthors;

    // New KPIs
    const mttrTotal = latestData.reduce((acc, d) => acc + (parseFloat(d['MTTR-Sec (Hours)']) || 0), 0);
    document.getElementById('kpi-mttr').innerText = latestData.length > 0 ? (mttrTotal / latestData.length).toFixed(1) : "0.0";

    // Calculate Averages for Rates
    let totalCFR = 0;
    let reposWithDeploys = 0;

    latestData.forEach(d => {
        if ((parseInt(d['Successful Deployments']) || 0) > 0) {
            reposWithDeploys++;
            totalCFR += (parseFloat(d['Change Failure Rate (%)']) || 0);
        }
    });
    document.getElementById('kpi-cfr').innerText = reposWithDeploys > 0 ? (totalCFR / reposWithDeploys).toFixed(1) + "%" : "0.0%";

    const totalCIFail = latestData.reduce((acc, d) => acc + (parseFloat(d['CI/CD Failure Rate (%)']) || 0), 0);
    document.getElementById('kpi-ci-fail').innerText = latestData.length > 0 ? (totalCIFail / latestData.length).toFixed(1) + "%" : "0.0%";

    const revReqTotal = latestData.reduce((acc, d) => acc + (parseFloat(d['Avg Review Comments per PR']) || 0), 0);
    document.getElementById('kpi-review-comments').innerText = latestData.length > 0 ? (revReqTotal / latestData.length).toFixed(1) : "0.0";

    const rRatio = latestData.reduce((acc, d) => acc + (parseFloat(d['Small to Large PR Ratio']) || 0), 0);
    document.getElementById('kpi-pr-ratio').innerText = latestData.length > 0 ? (rRatio / latestData.length).toFixed(2) : "0.0";
}

function updateCharts() {
    // Colors
    const colors = ['#2da44e', '#0969da', '#cf222e', '#f8c555', '#6e5494', '#d29922', '#8b949e'];

    // 1. Capability (Pie)
    const capCount = {};
    latestData.forEach(d => { capCount[d.Capability] = (capCount[d.Capability] || 0) + 1; });
    renderChart('chart-capability', 'doughnut', Object.keys(capCount), [{ data: Object.values(capCount), backgroundColor: colors }]);

    // 2. Type (Pie)
    const typeCount = {};
    latestData.forEach(d => { typeCount[d['Repo Type']] = (typeCount[d['Repo Type']] || 0) + 1; });
    renderChart('chart-type', 'pie', Object.keys(typeCount), [{ data: Object.values(typeCount), backgroundColor: ['#f8c555', '#0969da', '#8b949e'] }]);

    // Pre-calculate Capability aggregations for Bar Charts
    const capabilities = [...new Set(latestData.map(d => d.Capability || 'Unknown'))];
    const capDevs = { committers: [], authors: [] };
    const capTime = { coding: [], review: [] };

    capabilities.forEach(cap => {
        const reposInCap = latestData.filter(d => (d.Capability || 'Unknown') === cap);

        // Sum developers working across the capability
        capDevs.committers.push(reposInCap.reduce((acc, d) => acc + (parseInt(d['Distinct Committers Count']) || 0), 0));
        capDevs.authors.push(reposInCap.reduce((acc, d) => acc + (parseInt(d['Distinct PR Authors Count']) || 0), 0));

        // Average time metrics across repos in the capability
        capTime.coding.push(reposInCap.reduce((acc, d) => acc + (parseFloat(d['Avg Coding Time (Hours)']) || 0), 0) / (reposInCap.length || 1));
        capTime.review.push(reposInCap.reduce((acc, d) => acc + (parseFloat(d['Avg Review Time (Hours)']) || 0), 0) / (reposInCap.length || 1));
    });

    // 5. Devs vs Authors (Grouped Bar - Aggregated by Capability)
    renderChart('chart-devs', 'bar', capabilities, [
        { label: 'Committers', data: capDevs.committers, backgroundColor: '#2da44e' },
        { label: 'PR Authors', data: capDevs.authors, backgroundColor: '#cf222e' }
    ], {}, 'Capability', 'Total Developers');

    // 6. Time Analysis (Stacked - Aggregated by Capability)
    renderChart('chart-time', 'bar', capabilities, [
        { label: 'Avg Coding Time (Hr)', data: capTime.coding, backgroundColor: '#0969da', stack: 'Stack 0' },
        { label: 'Avg Review Time (Hr)', data: capTime.review, backgroundColor: '#f8c555', stack: 'Stack 0' }
    ], {}, 'Capability', 'Average Time (Hours)');

    // 7. Scatter (Review vs LOC)
    const scatterData = latestData.map(d => ({
        x: parseFloat(d['Avg LOC Changed']) || 0,
        y: parseFloat(d['Avg Review Time (Hours)']) || 0,
        r: Math.min(20, Math.max(5, ((parseFloat(d['Avg Review Time / LOC']) || 0) * 100))) // Radius based on efficiency
    })).filter(d => d.x > 0 || d.y > 0);

    // ChartJS Scatter needs destroy
    const ctxScatter = document.getElementById('chart-scatter');
    if (ctxScatter) {
        if (chartInstances['chart-scatter']) chartInstances['chart-scatter'].destroy();
        chartInstances['chart-scatter'] = new Chart(ctxScatter, {
            type: 'bubble',
            data: {
                datasets: [{
                    label: 'Review Time vs LOC',
                    data: scatterData,
                    backgroundColor: 'rgba(255, 99, 132, 0.6)'
                }]
            },
            options: {
                maintainAspectRatio: false,
                responsive: true,
                scales: {
                    x: { title: { display: true, text: 'Avg LOC Changed' } },
                    y: { title: { display: true, text: 'Avg Review Hrs' } }
                }
            }
        });
    }

    // New: Code Churn vs First Review 
    const churnData = latestData.map(d => ({
        x: parseFloat(d['Avg Wait Time for First Review (Hours)']) || 0,
        y: parseFloat(d['Avg Code Churn (Commits)']) || 0,
        r: Math.min(25, Math.max(5, ((parseFloat(d['Small to Large PR Ratio']) || 0) * 5))) // Radius based on PR sizes
    })).filter(d => d.x > 0 || d.y > 0);

    const ctxChurn = document.getElementById('chart-churn');
    if (ctxChurn) {
        if (chartInstances['chart-churn']) chartInstances['chart-churn'].destroy();
        chartInstances['chart-churn'] = new Chart(ctxChurn, {
            type: 'bubble',
            data: {
                datasets: [{
                    label: 'Wait Time vs Code Churn',
                    data: churnData,
                    backgroundColor: 'rgba(54, 162, 235, 0.6)'
                }]
            },
            options: {
                maintainAspectRatio: false,
                responsive: true,
                scales: {
                    x: { title: { display: true, text: 'First Review Wait (Hrs)' }, max: 24 }, // Bounded 
                    y: { title: { display: true, text: 'Rework (Commits Added)' }, max: 10 }
                },
                plugins: {
                    annotation: {
                        annotations: {
                            boxElite: {
                                type: 'box',
                                xMin: -1, xMax: 4,
                                yMin: -1, yMax: 2,
                                backgroundColor: 'rgba(45, 164, 78, 0.15)', // Green Elite
                                borderWidth: 0
                            },
                            boxWarning: {
                                type: 'box',
                                xMin: 4, xMax: 12,
                                yMin: -1, yMax: 10,
                                backgroundColor: 'rgba(248, 197, 85, 0.15)', // Yellow Warning
                                borderWidth: 0
                            },
                            boxWarning2: {
                                type: 'box',
                                xMin: -1, xMax: 4,
                                yMin: 2, yMax: 10,
                                backgroundColor: 'rgba(248, 197, 85, 0.15)', // Yellow Warning bounds
                                borderWidth: 0
                            },
                            boxPoor: {
                                type: 'box',
                                xMin: 12, xMax: 100,
                                yMin: 0, yMax: 100,
                                backgroundColor: 'rgba(207, 34, 46, 0.1)', // Red Poor
                                borderWidth: 0
                            }
                        }
                    }
                }
            }
        });
    }

    // New: AI Proxy Scatter 
    const aiProxyData = latestData.map(d => ({
        x: parseInt(d['SQ Unit Tests']) || 0,
        y: parseFloat(d['Change Failure Rate (%)']) || 0,
        r: Math.min(25, Math.max(5, ((parseFloat(d['Coding Velocity (LOC/Hr)']) || 0) / 5))) // Radius based on coding velocity
    })).filter(d => d.x > 0 || d.y > 0 || d.r > 5);

    const ctxAI = document.getElementById('chart-ai-proxy');
    if (ctxAI) {
        if (chartInstances['chart-ai-proxy']) chartInstances['chart-ai-proxy'].destroy();
        chartInstances['chart-ai-proxy'] = new Chart(ctxAI, {
            type: 'bubble',
            data: {
                datasets: [{
                    label: 'Unit Tests vs CFR',
                    data: aiProxyData,
                    backgroundColor: 'rgba(153, 102, 255, 0.6)'
                }]
            },
            options: {
                maintainAspectRatio: false,
                responsive: true,
                scales: {
                    x: { title: { display: true, text: 'Total Unit Tests' } },
                    y: { title: { display: true, text: 'Change Failure Rate (%)' } }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function (ctx) {
                                // Rough reverse-math to display LOC velocity realistically
                                const trueVel = (ctx.raw.r * 5).toFixed(1);
                                return `Tests: ${ctx.raw.x} | CFR: ${ctx.raw.y}% | Vel: ~${trueVel} LOC/Hr`;
                            }
                        }
                    }
                }
            }
        });
    }

    // 8. Trends (Line)
    // Force X-Axis to match selected range
    const startDateStr = document.getElementById('filter-start-date').value;
    const endDateStr = document.getElementById('filter-end-date').value;

    const trendGrouping = document.getElementById('trend-grouping') ? document.getElementById('trend-grouping').value : 'Repository';
    const distinctGroups = [...new Set(filteredData.map(d => d[trendGrouping]))].filter(Boolean);

    // Generate full date range labels
    const dateLabels = [];
    let curDate = new Date(startDateStr + 'T00:00:00'); // Force local midnight to avoid timezone shifts
    const stopDate = new Date(endDateStr + 'T00:00:00');

    // Safety: Limit range generation
    const maxDays = 365 * 5;
    let dayCount = 0;

    while (curDate <= stopDate && dayCount < maxDays) {
        dateLabels.push(curDate.toISOString().split('T')[0]); // YYYY-MM-DD
        curDate.setDate(curDate.getDate() + 1);
        dayCount++;
    }

    const createTrendDatasets = (metricType) => {
        return distinctGroups.map((groupVal, idx) => {
            // Aggregate counts per day from filteredActivityData
            const dailyCounts = {};

            filteredActivityData.forEach(d => {
                if (d[trendGrouping] !== groupVal) return;

                // Check Action type
                let match = false;
                if (metricType === 'Commits' && d.Action === 'Commit') match = true;
                if (metricType === 'PRs' && d.Action === 'Merge (PR)') match = true;

                if (match) {
                    const dateKey = d._eventDate.toISOString().split('T')[0];
                    dailyCounts[dateKey] = (dailyCounts[dateKey] || 0) + 1;
                }
            });

            // Map to full date range
            // For activity, 0 is better than null for missing days (no activity = 0 commits)
            const data = dateLabels.map(date => dailyCounts[date] || 0);

            return {
                label: groupVal,
                data: data,
                borderColor: colors[idx % colors.length],
                fill: false,
                tension: 0.2,
                spanGaps: true
            };
        });
    };

    const createMetricTrendDatasets = (metricName) => {
        return distinctGroups.map((groupVal, idx) => {
            const data = dateLabels.map(date => {
                const snapshots = filteredData.filter(d =>
                    d[trendGrouping] === groupVal &&
                    d._date.toISOString().split('T')[0] === date
                );
                if (snapshots.length > 0) {
                    return snapshots.reduce((acc, s) => acc + (parseFloat(s[metricName]) || 0), 0) / snapshots.length;
                }
                return null;
            });

            return {
                label: groupVal,
                data: data,
                borderColor: colors[idx % colors.length],
                fill: false,
                tension: 0.2,
                spanGaps: true
            };
        });
    };

    const createActivityAverageTrendDatasets = (metricName) => {
        return distinctGroups.map((groupVal, idx) => {
            const data = dateLabels.map(date => {
                const activities = filteredActivityData.filter(d =>
                    d[trendGrouping] === groupVal &&
                    d._eventDate && d._eventDate.toISOString().split('T')[0] === date &&
                    (d.Action || '').includes('Merge')
                );
                if (activities.length > 0) {
                    let total = 0;
                    let count = 0;
                    activities.forEach(a => {
                        const val = parseFloat(a[metricName]);
                        if (!isNaN(val)) {
                            total += val;
                            count++;
                        }
                    });
                    return count > 0 ? (total / count) : null;
                }
                return null;
            });

            return {
                label: groupVal,
                data: data,
                borderColor: colors[idx % colors.length],
                fill: false,
                tension: 0.2,
                spanGaps: true
            };
        });
    };

    // Annotations for thresholds
    const leadTimePlugins = {
        annotation: {
            annotations: {
                lineElite: {
                    type: 'line', yMin: 14, yMax: 14, borderColor: 'rgba(45, 164, 78, 0.8)', borderWidth: 2, borderDash: [5, 5],
                    label: { content: 'Elite (<14d)', display: true, position: 'end', backgroundColor: 'rgba(45, 164, 78, 0.8)', color: 'white' }
                },
                linePoor: {
                    type: 'line', yMin: 30, yMax: 30, borderColor: 'rgba(207, 34, 46, 0.8)', borderWidth: 2, borderDash: [5, 5],
                    label: { content: 'Poor (>30d)', display: true, position: 'start', backgroundColor: 'rgba(207, 34, 46, 0.8)', color: 'white' }
                }
            }
        }
    };

    const mttrPlugins = {
        annotation: {
            annotations: {
                lineSLA: {
                    type: 'line', yMin: 96, yMax: 96, borderColor: 'rgba(207, 34, 46, 0.8)', borderWidth: 2, borderDash: [5, 5],
                    label: { content: 'Target (96h)', display: true, position: 'end', backgroundColor: 'rgba(207, 34, 46, 0.8)', color: 'white' }
                }
            }
        }
    };

    // Use dateLabels for X-axis
    renderChart('chart-trend-commits', 'line', dateLabels, createTrendDatasets('Commits'), {}, 'Date', 'Number of Commits');
    renderChart('chart-trend-prs', 'line', dateLabels, createTrendDatasets('PRs'), {}, 'Date', 'Number of PRs');

    const leadTimeDatasets = createMetricTrendDatasets('Lead Time to Production (Days)');
    renderChart('chart-trend-leadtime', 'line', dateLabels, leadTimeDatasets, leadTimePlugins, 'Date', 'Days (<14 is Elite)');

    const mttrDatasets = createMetricTrendDatasets('MTTR-Sec (Hours)');
    renderChart('chart-trend-mttr', 'line', dateLabels, mttrDatasets, mttrPlugins, 'Date', 'Hours (<96 is Target)');

    const prReviewDatasets = createActivityAverageTrendDatasets('Time to First Review (Hours)');
    renderChart('chart-trend-pr-review', 'line', dateLabels, prReviewDatasets, {}, 'Date', 'Avg Wait Hrs');
}

function renderChart(id, type, labels, datasets, customPlugins = {}, xAxisTitle = '', yAxisTitle = '') {
    const ctx = document.getElementById(id);
    if (!ctx) return;

    if (chartInstances[id]) chartInstances[id].destroy();

    const scalesConfig = {
        y: {
            beginAtZero: true,
            title: { display: !!yAxisTitle, text: yAxisTitle }
        },
        x: {
            ticks: { autoSkip: true, maxTicksLimit: 10 },
            title: { display: !!xAxisTitle, text: xAxisTitle }
        }
    };

    // Force static scales on specific threshold graphs to prevent blank rendering on sparse data
    if (id === 'chart-trend-leadtime') {
        scalesConfig.y.max = 45;
    } else if (id === 'chart-trend-mttr') {
        scalesConfig.y.max = 120;
    }

    // Pie and Doughnut charts don't use X/Y axes
    const useScales = type !== 'pie' && type !== 'doughnut';

    chartInstances[id] = new Chart(ctx, {
        type: type,
        data: { labels: labels, datasets: datasets },
        options: {
            maintainAspectRatio: false,
            responsive: true,
            plugins: { legend: { position: 'bottom' }, ...customPlugins },
            scales: useScales ? scalesConfig : undefined
        }
    });
}

function updateTable() {
    const tbody = document.querySelector('#data-table tbody');
    tbody.innerHTML = '';

    // Group by AppCode
    const apps = {};
    latestData.forEach(d => {
        const app = d.AppCode || 'Unknown';
        if (!apps[app]) apps[app] = [];
        apps[app].push(d);
    });

    Object.keys(apps).forEach(appName => {
        const repos = apps[appName];
        const count = repos.length;

        // Aggregations
        const totalCommits = repos.reduce((acc, d) => acc + (parseFloat(d['Total Commits']) || 0), 0);
        const totalPRs = repos.reduce((acc, d) => acc + (parseFloat(d['Total Merged PRs']) || 0), 0);
        const avgLeadTime = repos.reduce((acc, d) => acc + (parseFloat(d['Lead Time to Production (Days)']) || 0), 0) / count;
        const avgCFR = repos.reduce((acc, d) => acc + (parseFloat(d['Change Failure Rate (%)']) || 0), 0) / count;
        const avgReview = repos.reduce((acc, d) => acc + (parseFloat(d['Avg Review Time (Hours)']) || 0), 0) / count;
        const avgChurn = repos.reduce((acc, d) => acc + (parseFloat(d['Avg Code Churn (Commits)']) || 0), 0) / count;
        const avgTechDebt = repos.reduce((acc, d) => acc + (parseFloat(d['SQ Technical Debt (Days)']) || 0), 0) / count;
        const totalUnitTests = repos.reduce((acc, d) => acc + (parseFloat(d['SQ Unit Tests']) || 0), 0);
        const avgTrueLead = repos.reduce((acc, d) => acc + (parseFloat(d['True Lead Time for Changes (Hours)']) || 0), 0) / count;
        const avgCICD = repos.reduce((acc, d) => acc + (parseFloat(d['CI/CD Failure Rate (%)']) || 0), 0) / count;

        // Logic Aggregations
        const hasCT = repos.some(d => d['CT.yml Exists'] === 'Yes') ? 'Yes' : 'No';
        const hasCTRuns = repos.some(d => d['CT.yml Has Runs'] === 'Yes') ? 'Yes' : 'No';

        // Grab the best security rating or default to N/A
        const secRatings = repos.map(d => d['SQ Security Rating']).filter(r => r !== 'N/A' && r);
        const bestSecRating = secRatings.length > 0 ? secRatings.sort()[0] : 'N/A';

        // Use the most recent date of the cluster
        const newestDate = new Date(Math.max(...repos.map(d => new Date(d._date))));

        // Assume capability matches the first repo in app if not identical
        const capability = repos[0].Capability || 'N/A';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${appName}</strong> <br><small>(${count} Repos)</small></td>
            <td>${capability}</td>
            <td>${totalCommits}</td>
            <td>${avgTrueLead.toFixed(1)}</td>
            <td style="font-weight: bold; color: ${avgLeadTime < 14 ? 'green' : 'var(--danger-color)'}">${avgLeadTime.toFixed(1)}</td>
            <td>${avgCICD.toFixed(1)}%</td>
            <td>${avgCFR.toFixed(1)}%</td>
            <td>${avgReview.toFixed(1)}</td>
            <td>${avgChurn.toFixed(1)}</td>
            <td style="font-weight: bold; color: ${bestSecRating === 'A' ? 'green' : bestSecRating === 'B' ? 'var(--primary-color)' : 'var(--danger-color)'}">${bestSecRating}</td>
            <td>${avgTechDebt.toFixed(1)}</td>
            <td>${totalUnitTests}</td>
            <td style="font-weight: bold; color: ${hasCT === 'Yes' ? 'green' : 'var(--danger-color)'}">${hasCT}</td>
            <td>${hasCTRuns}</td>
            <td>N/A</td>
            <td>${newestDate.toLocaleString()}</td>
        `;
        tbody.appendChild(tr);
    });
}
async function triggerUpdate() {
    const btn = document.getElementById('btn-update');
    const statusDiv = document.getElementById('update-status');
    const originalText = btn.innerText;

    btn.disabled = true;
    btn.innerText = "⏳ Updating...";
    if (statusDiv) {
        statusDiv.innerText = "Job sent. Waiting for response...";
        statusDiv.style.color = "#666";
    }

    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    try {
        if (isLocal) {
            // Local Mode: Call Internal API
            if (statusDiv) statusDiv.innerText = "Running 'node index.js'...";

            const statusInterval = setInterval(async () => {
                try {
                    const sRes = await fetch('/api/status');
                    const sData = await sRes.json();
                    if (sData.status !== "Idle" && statusDiv) {
                        const mins = Math.floor(sData.etaSeconds / 60);
                        const secs = Math.floor(sData.etaSeconds % 60);
                        const etaStr = sData.etaSeconds > 0 ? `[ETA: ~${mins}m ${secs}s]` : '';
                        statusDiv.innerText = `${sData.status} (${sData.processed}/${sData.total}) ${etaStr}`;
                    }
                } catch (e) { }
            }, 1500);

            const res = await fetch('/api/trigger-update', {
                method: 'POST'
            });

            clearInterval(statusInterval);

            const data = await res.json();
            if (data.success) {
                if (statusDiv) {
                    statusDiv.innerText = "Success! Reloading...";
                    statusDiv.style.color = "green";
                }
                setTimeout(() => window.location.reload(), 1000);
            } else {
                throw new Error(data.error || "Unknown server error");
            }
        } else {
            // GitHub Pages Mode: Trigger Workflow
            const token = prompt("Enter GitHub PAT (repo scope) to trigger update:");
            if (!token) {
                btn.disabled = false;
                btn.innerText = originalText;
                if (statusDiv) statusDiv.innerText = "";
                return;
            }

            if (statusDiv) statusDiv.innerText = "Triggering GitHub Action...";

            let owner, repo;
            const pathParts = window.location.pathname.split('/').filter(p => p);
            const hostParts = window.location.hostname.split('.');

            if (hostParts.length === 3 && hostParts[1] === 'github' && hostParts[2] === 'io') {
                owner = hostParts[0];
                repo = pathParts[0] || '';
            }

            if (!owner || !repo) {
                const repoInput = prompt("Could not detect repo. Enter 'owner/repo':", "bdchang/GithubStats");
                if (!repoInput) throw new Error("Repo required");
                [owner, repo] = repoInput.split('/');
            }

            const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/update_stats.yml/dispatches`, {
                method: 'POST',
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    ref: 'main'
                }) // Assuming main branch
            });

            if (response.ok) {
                if (statusDiv) {
                    statusDiv.innerText = "Workflow Triggered! Data will update in ~2 mins.";
                    statusDiv.style.color = "green";
                }
                alert("Workflow triggered! It may take a few minutes for new data to appear. Refresh manually later.");
            } else {
                const errText = await response.text();
                throw new Error(`GitHub API Error: ${response.status} ${errText}`);
            }
        }
    } catch (e) {
        console.error(e);
        if (statusDiv) {
            statusDiv.innerText = "Error: " + e.message;
            statusDiv.style.color = "red";
        }
        alert("Error: " + e.message);
    } finally {
        if (statusDiv && statusDiv.style.color !== "green") {
            btn.disabled = false;
            btn.innerText = originalText;
        }
    }
}
