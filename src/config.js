const path = require('path');
const fs = require('fs');

const CONFIG_path = path.join(__dirname, '..', 'config', '.env');
const ENV = process.env;

const API_CACHE_DIR = path.join(__dirname, '..', '.api_cache');
if (!fs.existsSync(API_CACHE_DIR)) {
    fs.mkdirSync(API_CACHE_DIR);
}

function loadEnv() {
    const paths = [
        path.join(__dirname, '..', 'config', '.env'),
        path.join(__dirname, '..', '.env')
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

// The maximum number of recent PRs to query per repository.
const maxPrsLimit = parseInt(ENV.MAX_PRS_TO_ANALYZE || "30", 10);

// --- External Integration Config ---
let integrationConfig = null;
try {
    const configPath = path.join(__dirname, '..', 'integration_config.json');
    if (fs.existsSync(configPath)) {
        integrationConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log("Loaded external integration config for Jira/ServiceNow.");
    }
} catch (e) {
    console.warn("Failed to load integration_config.json:", e.message);
}

module.exports = {
    API_CACHE_DIR,
    GITHUB_TOKEN,
    API_BASE_URL,
    ENABLE_DEBUG_LOGGING,
    maxPrsLimit,
    integrationConfig
};
