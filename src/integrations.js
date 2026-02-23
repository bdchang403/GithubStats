const { API_BASE_URL, integrationConfig } = require('./config');
const { logError } = require('./utils');

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

module.exports = {
    checkExternalDefect,
    fetchSonarQubeMetrics
};
