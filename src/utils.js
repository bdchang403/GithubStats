const fs = require('fs');
const path = require('path');
const { ENABLE_DEBUG_LOGGING } = require('./config');
const { parse } = require('csv-parse/sync');

// Optionally hijack console.log and console.warn to suppress noise unless debugging
const originalLog = console.log;
const originalWarn = console.warn;

function setupLogging() {
    console.log = function (...args) {
        if (ENABLE_DEBUG_LOGGING) originalLog.apply(console, args);
    };
    console.warn = function (...args) {
        if (ENABLE_DEBUG_LOGGING) originalWarn.apply(console, args);
    };
}

// Ensure original log functions are accessible if needed
function logOriginal(...args) {
    originalLog.apply(console, args);
}

// Function for dashboard ETA reporting
function writeStatus(processed, total, currentRepo, startTime) {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const avgSecPerRepo = processed > 0 ? elapsedSec / processed : 0;
    const remainingSec = avgSecPerRepo * (total - processed);
    const statusData = {
        status: currentRepo ? `Processing ${currentRepo}...` : "Idle",
        processed,
        total,
        etaSeconds: Math.round(remainingSec)
    };
    try {
        fs.writeFileSync(path.join(__dirname, '..', 'status.json'), JSON.stringify(statusData));
    } catch (e) { }
}

function logError(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ERROR: ${message}\n`;
    try {
        fs.appendFileSync(path.join(__dirname, '..', 'run_errors.log'), logMessage);
    } catch (e) {
        // Fallback to console only
    }
    console.error(message);
}

// Robust CSV Parser using csv-parse library (vendored via npm)
function parseCSV(text) {
    if (!text || text.trim().length === 0) return [];
    try {
        return parse(text, {
            columns: true,          // Use the first line as object keys
            skip_empty_lines: true,
            relax_quotes: true      // Forgiving of ill-formed quotes from external editors
        });
    } catch (e) {
        logError("CSV Parsing error: " + e.message);
        return [];
    }
}

module.exports = {
    setupLogging,
    logOriginal,
    writeStatus,
    logError,
    parseCSV
};
