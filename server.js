const http = require('http');
const fs = require('fs');
const path = require('path');

const port = 8080; // Changed PORT to port

// Renamed MIME_TYPES to mimeTypes and updated its content
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg', // Changed from image/jpeg
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml', // Added
    '.wav': 'audio/wav', // Added
    '.mp4': 'video/mp4', // Added
    '.woff': 'application/font-woff', // Added
    '.ttf': 'application/font-ttf', // Added
    '.eot': 'application/vnd.ms-fontobject', // Added
    '.otf': 'application/font-otf', // Added
    '.wasm': 'application/wasm', // Added
    '.csv': 'text/csv' // Added CSV support
};

http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);

    // API: Trigger Update (Local only)
    if (req.url === '/api/trigger-update' && req.method === 'POST') {
        const { spawn } = require('child_process');
        console.log("Triggering update via API...");

        const child = spawn('node', ['index.js']);

        child.stdout.on('data', (data) => {
            // Stream output directly to the server terminal
            process.stdout.write(data);
        });

        child.stderr.on('data', (data) => {
            // Stream errors directly to the server terminal
            process.stderr.write(data);
        });

        child.on('error', (error) => {
            console.error(`spawn error: ${error}`);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });

        child.on('close', (code) => {
            console.log(`\nUpdate process exited with code ${code}`);
            if (!res.headersSent) {
                if (code === 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        log: "Update complete. Check server terminal for full details."
                    }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: `Process exited with code ${code}`
                    }));
                }
            }
        });
        return;
    }

    // Default to index.html if root is requested
    let filePath = req.url === '/' ? './index.html' : '.' + req.url; // Changed logic and dashboard.html to index.html

    const extname = String(path.extname(filePath)).toLowerCase(); // Added String() and toLowerCase()
    const contentType = mimeTypes[extname] || 'application/octet-stream'; // Using new mimeTypes

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code == 'ENOENT') {
                // Serve 404.html if file not found
                fs.readFile('./404.html', (error, content) => {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(content, 'utf-8');
                });
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n'); // Changed error message
                res.end(); // Added an extra res.end()
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });

}).listen(port); // Changed PORT to port

console.log(`Server running at http://localhost:${port}/`); // Changed PORT to port
console.log(`Serving index.html by default.`); // Changed console log message
