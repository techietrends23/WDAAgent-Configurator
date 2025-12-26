const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const app = express();
const PORT = 3456;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create HTTP server for WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store active processes
let wdaProcess = null;
let iproxyProcess = null;
let activeWsClients = new Set();

// Configuration storage
let config = {
    teamId: '',
    signingCertificate: '',
    provisioningProfile: '',
    wdaPort: 8100,
    appiumHome: path.join(os.homedir(), '.appium')
};

// Config file path
const configPath = path.join(__dirname, 'wda-config.json');

// Load config on startup
if (fs.existsSync(configPath)) {
    try {
        config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) {
        console.error('Failed to load config:', e.message);
    }
}

// WebSocket handling
wss.on('connection', (ws) => {
    activeWsClients.add(ws);
    ws.on('close', () => activeWsClients.delete(ws));
    ws.on('error', () => activeWsClients.delete(ws));
});

function broadcastLog(message, type = 'info') {
    const payload = JSON.stringify({ type, message, timestamp: new Date().toISOString() });
    activeWsClients.forEach(client => {
        if (client.readyState === 1) client.send(payload);
    });
}

// Get WDA project path
function getWDAPath() {
    const wdaPath = path.join(
        config.appiumHome,
        'node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj'
    );
    return wdaPath;
}

// API Routes

// Get connected physical devices
app.get('/api/devices', async (req, res) => {
    try {
        const devices = [];

        // Try idevice_id first (libimobiledevice)
        try {
            const output = execSync('idevice_id -l 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
            const udids = output.trim().split('\n').filter(Boolean);

            for (const udid of udids) {
                try {
                    const nameOutput = execSync(`idevicename -u ${udid} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 });
                    devices.push({
                        udid: udid.trim(),
                        name: nameOutput.trim() || 'iOS Device',
                        type: 'physical',
                        status: 'connected'
                    });
                } catch {
                    devices.push({
                        udid: udid.trim(),
                        name: 'iOS Device',
                        type: 'physical',
                        status: 'connected'
                    });
                }
            }
        } catch {
            // idevice_id not available, try system_profiler
            try {
                const output = execSync('system_profiler SPUSBDataType 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
                const iPhoneMatch = output.match(/iPhone[\s\S]*?Serial Number:\s*([A-F0-9-]+)/gi);
                const iPadMatch = output.match(/iPad[\s\S]*?Serial Number:\s*([A-F0-9-]+)/gi);

                if (iPhoneMatch || iPadMatch) {
                    broadcastLog('Found iOS device via system_profiler (install libimobiledevice for better detection)', 'warning');
                }
            } catch (e) {
                broadcastLog('Failed to detect physical devices: ' + e.message, 'error');
            }
        }

        res.json({ success: true, devices });
    } catch (error) {
        res.json({ success: false, error: error.message, devices: [] });
    }
});

// Get available simulators
app.get('/api/simulators', async (req, res) => {
    try {
        const output = execSync('xcrun simctl list devices --json', { encoding: 'utf8', timeout: 10000 });
        const data = JSON.parse(output);
        const simulators = [];

        for (const [runtime, deviceList] of Object.entries(data.devices)) {
            if (runtime.includes('iOS')) {
                const iosVersion = runtime.replace(/.*iOS-?/, 'iOS ').replace(/-/g, '.');
                for (const device of deviceList) {
                    if (device.isAvailable) {
                        simulators.push({
                            udid: device.udid,
                            name: `${device.name} (${iosVersion})`,
                            type: 'simulator',
                            status: device.state.toLowerCase()
                        });
                    }
                }
            }
        }

        res.json({ success: true, simulators });
    } catch (error) {
        res.json({ success: false, error: error.message, simulators: [] });
    }
});

// Get current configuration
app.get('/api/config', (req, res) => {
    res.json({ success: true, config: { ...config, signingCertificate: config.signingCertificate ? '****' : '' } });
});

// Save configuration
app.post('/api/config/save', (req, res) => {
    try {
        const { teamId, signingCertificate, provisioningProfile, wdaPort, appiumHome } = req.body;

        if (teamId !== undefined) config.teamId = teamId;
        if (signingCertificate !== undefined) config.signingCertificate = signingCertificate;
        if (provisioningProfile !== undefined) config.provisioningProfile = provisioningProfile;
        if (wdaPort !== undefined) config.wdaPort = parseInt(wdaPort) || 8100;
        if (appiumHome !== undefined) config.appiumHome = appiumHome;

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        broadcastLog('Configuration saved successfully', 'success');
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Check WDA project exists
app.get('/api/wda/check', (req, res) => {
    const wdaPath = getWDAPath();
    const exists = fs.existsSync(wdaPath);
    res.json({
        success: true,
        exists,
        path: wdaPath,
        message: exists ? 'WDA project found' : 'WDA project not found. Run: appium driver install xcuitest'
    });
});

// Build and install WDA
app.post('/api/wda/install', async (req, res) => {
    const { udid, deviceType } = req.body;

    if (!udid) {
        return res.json({ success: false, error: 'Device UDID is required' });
    }

    const wdaPath = getWDAPath();
    if (!fs.existsSync(wdaPath)) {
        return res.json({ success: false, error: 'WDA project not found. Install xcuitest driver first.' });
    }

    broadcastLog(`Starting WDA build for device: ${udid}`, 'info');

    // Build xcodebuild command
    const args = [
        'clean', 'build-for-testing', 'test-without-building',
        '-project', wdaPath,
        '-scheme', 'WebDriverAgentRunner',
        '-destination', `id=${udid}`,
        '-configuration', 'Debug',
        '-allowProvisioningUpdates'
    ];

    // Add signing for real devices
    if (deviceType === 'physical' && config.teamId) {
        args.push(`DEVELOPMENT_TEAM=${config.teamId}`);
        args.push('CODE_SIGN_IDENTITY=iPhone Developer');
    }

    broadcastLog(`Command: xcodebuild ${args.join(' ')}`, 'info');

    try {
        wdaProcess = spawn('xcodebuild', args, {
            env: { ...process.env, USE_PORT: config.wdaPort.toString() }
        });

        wdaProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) broadcastLog(line, 'stdout');
            });
        });

        wdaProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) broadcastLog(line, 'stderr');
            });
        });

        wdaProcess.on('close', (code) => {
            broadcastLog(`WDA build process exited with code ${code}`, code === 0 ? 'success' : 'error');
            wdaProcess = null;
        });

        wdaProcess.on('error', (err) => {
            broadcastLog(`WDA build error: ${err.message}`, 'error');
            wdaProcess = null;
        });

        res.json({ success: true, message: 'WDA build started' });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Start WDA (for already installed WDA)
app.post('/api/wda/start', async (req, res) => {
    const { udid, deviceType } = req.body;

    if (!udid) {
        return res.json({ success: false, error: 'Device UDID is required' });
    }

    // For real devices, start iproxy first
    if (deviceType === 'physical') {
        broadcastLog(`Starting iproxy for port forwarding on port ${config.wdaPort}...`, 'info');

        try {
            iproxyProcess = spawn('iproxy', [
                config.wdaPort.toString(),
                config.wdaPort.toString(),
                udid
            ]);

            iproxyProcess.stdout.on('data', (data) => {
                broadcastLog(`iproxy: ${data.toString().trim()}`, 'stdout');
            });

            iproxyProcess.stderr.on('data', (data) => {
                broadcastLog(`iproxy: ${data.toString().trim()}`, 'stderr');
            });

            iproxyProcess.on('error', (err) => {
                broadcastLog(`iproxy error: ${err.message}`, 'error');
            });
        } catch (error) {
            broadcastLog(`Failed to start iproxy: ${error.message}. Install with: npm install -g iproxy`, 'error');
        }
    }

    // Boot simulator if needed
    if (deviceType === 'simulator') {
        try {
            broadcastLog(`Booting simulator ${udid}...`, 'info');
            execSync(`xcrun simctl boot ${udid} 2>/dev/null || true`, { encoding: 'utf8' });
        } catch (e) {
            // Simulator might already be booted
        }
    }

    const wdaPath = getWDAPath();

    broadcastLog(`Starting WDA on device: ${udid}`, 'info');

    const args = [
        'test-without-building',
        '-project', wdaPath,
        '-scheme', 'WebDriverAgentRunner',
        '-destination', `id=${udid}`,
        '-configuration', 'Debug'
    ];

    if (deviceType === 'physical' && config.teamId) {
        args.push(`DEVELOPMENT_TEAM=${config.teamId}`);
    }

    try {
        wdaProcess = spawn('xcodebuild', args, {
            env: { ...process.env, USE_PORT: config.wdaPort.toString() }
        });

        wdaProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) {
                    broadcastLog(line, 'stdout');
                    if (line.includes('ServerURLHere')) {
                        broadcastLog('🎉 WDA server is running!', 'success');
                    }
                }
            });
        });

        wdaProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.trim()) broadcastLog(line, 'stderr');
            });
        });

        wdaProcess.on('close', (code) => {
            broadcastLog(`WDA process exited with code ${code}`, code === 0 ? 'info' : 'error');
            wdaProcess = null;
        });

        res.json({ success: true, message: 'WDA start initiated' });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Stop WDA
app.post('/api/wda/stop', (req, res) => {
    let stopped = false;

    if (wdaProcess) {
        wdaProcess.kill('SIGTERM');
        wdaProcess = null;
        stopped = true;
        broadcastLog('WDA process stopped', 'info');
    }

    if (iproxyProcess) {
        iproxyProcess.kill('SIGTERM');
        iproxyProcess = null;
        broadcastLog('iproxy process stopped', 'info');
    }

    // Kill any lingering processes
    try {
        execSync('pkill -f "xcodebuild.*WebDriverAgent" 2>/dev/null || true');
        execSync('pkill -f iproxy 2>/dev/null || true');
    } catch (e) {
        // Ignore errors
    }

    res.json({ success: true, stopped });
});

// Check WDA status
app.get('/api/wda/status', async (req, res) => {
    try {
        // Check if WDA is responding
        const url = `http://127.0.0.1:${config.wdaPort}/status`;

        const checkStatus = () => new Promise((resolve) => {
            const request = http.get(url, { timeout: 2000 }, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        const status = JSON.parse(data);
                        resolve({ running: true, status });
                    } catch {
                        resolve({ running: false });
                    }
                });
            });
            request.on('error', () => resolve({ running: false }));
            request.on('timeout', () => {
                request.destroy();
                resolve({ running: false });
            });
        });

        const { running, status } = await checkStatus();

        res.json({
            success: true,
            running,
            processActive: wdaProcess !== null,
            iproxyActive: iproxyProcess !== null,
            port: config.wdaPort,
            status
        });
    } catch (error) {
        res.json({ success: false, running: false, error: error.message });
    }
});

// Install or update xcuitest driver
app.post('/api/appium/install-driver', async (req, res) => {
    broadcastLog('Checking XCUITest driver status...', 'info');

    // First check if driver is already installed
    try {
        const listOutput = execSync('appium driver list --installed --json 2>/dev/null', { encoding: 'utf8', timeout: 30000 });
        const installedDrivers = JSON.parse(listOutput);

        if (installedDrivers.xcuitest) {
            // Driver is installed, let's update it
            broadcastLog('XCUITest driver is already installed. Updating...', 'info');

            const updateProcess = spawn('appium', ['driver', 'update', 'xcuitest']);

            updateProcess.stdout.on('data', (data) => {
                broadcastLog(data.toString().trim(), 'stdout');
            });

            updateProcess.stderr.on('data', (data) => {
                broadcastLog(data.toString().trim(), 'stderr');
            });

            updateProcess.on('close', (code) => {
                if (code === 0) {
                    broadcastLog('XCUITest driver updated successfully!', 'success');
                } else {
                    broadcastLog(`Driver update completed with code ${code}`, 'info');
                }
            });

            return res.json({ success: true, message: 'Driver update started' });
        }
    } catch (e) {
        // Driver not installed or error checking, proceed with install
        broadcastLog('Installing XCUITest driver for the first time...', 'info');
    }

    // Driver not installed, install it
    const installProcess = spawn('appium', ['driver', 'install', 'xcuitest']);

    installProcess.stdout.on('data', (data) => {
        broadcastLog(data.toString().trim(), 'stdout');
    });

    installProcess.stderr.on('data', (data) => {
        broadcastLog(data.toString().trim(), 'stderr');
    });

    installProcess.on('close', (code) => {
        if (code === 0) {
            broadcastLog('XCUITest driver installed successfully!', 'success');
        } else {
            broadcastLog(`Driver installation failed with code ${code}`, 'error');
        }
    });

    res.json({ success: true, message: 'Driver installation started' });
});

// Start server
server.listen(PORT, () => {
    console.log(`\n🚀 WDA Runner is running at http://localhost:${PORT}\n`);
    console.log('Open this URL in your browser to manage WebDriverAgent.');
});
