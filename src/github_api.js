const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { API_CACHE_DIR, GITHUB_TOKEN, API_BASE_URL } = require('./config');
const { logError } = require('./utils');

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
                // Suppress 404 console noise ONLY for optional config files or dynamic workflow discovery
                const isOptionalFile = url.includes('.yml') || url.includes('.yaml') || url.includes('/actions/workflows');

                if (response.status === 404 && !isOptionalFile) {
                    const err = new Error(`HTTP 404: Not Found for ${url}`);
                    err.status = 404;
                    throw err; // Break out to the catch block
                }

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
            if (e.status === 404) throw e; // Do not retry 404s, bubble up to fail the repo

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

// --- User Email Extraction ---
const userEmailCache = {};

async function fetchUserEmail(login) {
    if (!login || login.includes('[bot]') || login === 'dependabot') return null;
    if (userEmailCache[login] !== undefined) return userEmailCache[login];

    try {
        const userRes = await fetchGitHub(`${API_BASE_URL}/users/${login}`);
        if (userRes && userRes.data && userRes.data.email) {
            userEmailCache[login] = userRes.data.email;
            return userRes.data.email;
        }
    } catch (e) { }

    userEmailCache[login] = null;
    return null;
}

module.exports = {
    fetchGitHub,
    fetchGitHubPaginated,
    fetchUserEmail
};
