// WDA Runner Frontend Application
class WDARunner {
    constructor() {
        this.selectedDevice = null;
        this.deviceType = 'simulator';
        this.autoScroll = true;
        this.ws = null;
        this.config = {};
        this.wdaRunning = false;

        this.init();
    }

    init() {
        this.bindEvents();
        this.connectWebSocket();
        this.loadDevices();
        this.loadConfig();
        this.checkWDAStatus();
        this.checkWDAProject();

        // Poll status every 5 seconds
        setInterval(() => this.checkWDAStatus(), 5000);
    }

    bindEvents() {
        // Device type tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchDeviceType(e.target.dataset.type));
        });

        // Refresh devices
        document.getElementById('refreshDevices').addEventListener('click', () => this.loadDevices());

        // Save config
        document.getElementById('saveConfig').addEventListener('click', () => this.saveConfig());

        // WDA Controls
        document.getElementById('installWda').addEventListener('click', () => this.installWDA());
        document.getElementById('startWda').addEventListener('click', () => this.startWDA());
        document.getElementById('stopWda').addEventListener('click', () => this.stopWDA());

        // Quick Actions
        document.getElementById('installDriver').addEventListener('click', () => this.installDriver());
        document.getElementById('checkWdaProject').addEventListener('click', () => this.checkWDAProject());

        // Log controls
        document.getElementById('clearLogs').addEventListener('click', () => this.clearLogs());
        document.getElementById('toggleAutoScroll').addEventListener('click', () => this.toggleAutoScroll());
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.ws = new WebSocket(`${protocol}//${window.location.host}`);

        this.ws.onopen = () => {
            this.addLog('Connected to WDA Runner server', 'success');
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.addLog(data.message, data.type);
            } catch (e) {
                this.addLog(event.data, 'info');
            }
        };

        this.ws.onclose = () => {
            this.addLog('Disconnected from server. Reconnecting...', 'warning');
            setTimeout(() => this.connectWebSocket(), 3000);
        };

        this.ws.onerror = () => {
            this.addLog('WebSocket error', 'error');
        };
    }

    async loadDevices() {
        const deviceList = document.getElementById('deviceList');
        deviceList.innerHTML = '<div class="loading-spinner">Loading devices...</div>';

        try {
            const endpoint = this.deviceType === 'simulator' ? '/api/simulators' : '/api/devices';
            const response = await fetch(endpoint);
            const data = await response.json();

            const devices = this.deviceType === 'simulator' ? data.simulators : data.devices;

            if (!devices || devices.length === 0) {
                deviceList.innerHTML = `
                    <div class="empty-state">
                        <span>${this.deviceType === 'simulator' ? '📱' : '🔌'}</span>
                        <p>No ${this.deviceType === 'simulator' ? 'simulators' : 'devices'} found</p>
                    </div>
                `;
                return;
            }

            deviceList.innerHTML = devices.map(device => `
                <div class="device-item" data-udid="${device.udid}" data-type="${device.type}">
                    <span class="device-icon">${device.type === 'simulator' ? '📱' : '📲'}</span>
                    <div class="device-info">
                        <div class="device-name">${device.name}</div>
                        <div class="device-udid">${device.udid.substring(0, 20)}...</div>
                    </div>
                    <span class="device-status ${device.status}">${device.status}</span>
                </div>
            `).join('');

            // Bind click events
            deviceList.querySelectorAll('.device-item').forEach(item => {
                item.addEventListener('click', () => this.selectDevice(item));
            });

        } catch (error) {
            deviceList.innerHTML = `
                <div class="empty-state">
                    <span>⚠️</span>
                    <p>Failed to load devices</p>
                </div>
            `;
            this.addLog('Failed to load devices: ' + error.message, 'error');
        }
    }

    selectDevice(element) {
        // Remove previous selection
        document.querySelectorAll('.device-item').forEach(item => {
            item.classList.remove('selected');
        });

        // Select new device
        element.classList.add('selected');
        this.selectedDevice = {
            udid: element.dataset.udid,
            type: element.dataset.type,
            name: element.querySelector('.device-name').textContent
        };

        // Update UI
        document.getElementById('selectedDeviceName').textContent = this.selectedDevice.name;
        document.getElementById('installWda').disabled = false;
        document.getElementById('stopWda').disabled = false;

        // Only enable Start WDA if not already running
        this.updateStartButton();

        // Show/hide config panel based on device type
        const configPanel = document.getElementById('configPanel');
        if (this.selectedDevice.type === 'physical') {
            configPanel.style.display = 'block';
        }

        this.addLog(`Selected device: ${this.selectedDevice.name}`, 'info');
    }

    updateStartButton() {
        const startBtn = document.getElementById('startWda');
        if (this.wdaRunning) {
            startBtn.disabled = true;
            startBtn.innerHTML = '<span>✓</span> WDA Running';
        } else if (this.selectedDevice) {
            startBtn.disabled = false;
            startBtn.innerHTML = '<span>▶️</span> Start WDA';
        } else {
            startBtn.disabled = true;
            startBtn.innerHTML = '<span>▶️</span> Start WDA';
        }
    }

    switchDeviceType(type) {
        this.deviceType = type;
        this.selectedDevice = null;

        // Update tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === type);
        });

        // Reset selection UI
        document.getElementById('selectedDeviceName').textContent = 'No device selected';
        document.getElementById('installWda').disabled = true;
        document.getElementById('startWda').disabled = true;
        document.getElementById('stopWda').disabled = true;

        this.loadDevices();
    }

    async loadConfig() {
        try {
            const response = await fetch('/api/config');
            const data = await response.json();

            if (data.success) {
                this.config = data.config;
                document.getElementById('teamId').value = data.config.teamId || '';
                document.getElementById('wdaPort').value = data.config.wdaPort || 8100;
                document.getElementById('appiumHome').value = data.config.appiumHome || '';
                document.getElementById('serverUrl').textContent = `http://127.0.0.1:${data.config.wdaPort || 8100}`;
            }
        } catch (error) {
            this.addLog('Failed to load config: ' + error.message, 'error');
        }
    }

    async saveConfig() {
        const config = {
            teamId: document.getElementById('teamId').value,
            wdaPort: parseInt(document.getElementById('wdaPort').value) || 8100,
            appiumHome: document.getElementById('appiumHome').value
        };

        try {
            const response = await fetch('/api/config/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            const data = await response.json();

            if (data.success) {
                this.addLog('Configuration saved!', 'success');
                document.getElementById('serverUrl').textContent = `http://127.0.0.1:${config.wdaPort}`;
            } else {
                this.addLog('Failed to save config: ' + data.error, 'error');
            }
        } catch (error) {
            this.addLog('Failed to save config: ' + error.message, 'error');
        }
    }

    async installWDA() {
        if (!this.selectedDevice) {
            this.addLog('Please select a device first', 'warning');
            return;
        }

        this.addLog('Starting WDA installation...', 'info');

        try {
            const response = await fetch('/api/wda/install', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    udid: this.selectedDevice.udid,
                    deviceType: this.selectedDevice.type
                })
            });
            const data = await response.json();

            if (!data.success) {
                this.addLog('Failed to start WDA installation: ' + data.error, 'error');
            }
        } catch (error) {
            this.addLog('Failed to install WDA: ' + error.message, 'error');
        }
    }

    async startWDA() {
        if (!this.selectedDevice) {
            this.addLog('Please select a device first', 'warning');
            return;
        }

        if (this.wdaRunning) {
            this.addLog('WDA is already running!', 'warning');
            return;
        }

        this.addLog('Starting WDA...', 'info');

        try {
            const response = await fetch('/api/wda/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    udid: this.selectedDevice.udid,
                    deviceType: this.selectedDevice.type
                })
            });
            const data = await response.json();

            if (!data.success) {
                this.addLog('Failed to start WDA: ' + data.error, 'error');
            }
        } catch (error) {
            this.addLog('Failed to start WDA: ' + error.message, 'error');
        }
    }

    async stopWDA() {
        try {
            const response = await fetch('/api/wda/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();

            if (data.success) {
                this.addLog('WDA stopped', 'info');
                this.wdaRunning = false;
                this.updateStartButton();
                this.updateStatusBadge(false, false);
            }
        } catch (error) {
            this.addLog('Failed to stop WDA: ' + error.message, 'error');
        }
    }

    async checkWDAStatus() {
        try {
            const response = await fetch('/api/wda/status');
            const data = await response.json();

            this.wdaRunning = data.running;
            this.updateStatusBadge(data.running, data.processActive);
            this.updateStartButton();

        } catch (error) {
            // Silently fail for status checks
        }
    }

    updateStatusBadge(running, processActive) {
        const badge = document.getElementById('wdaStatusBadge');
        const statusText = badge.querySelector('.status-text');

        if (running) {
            badge.className = 'status-badge running';
            statusText.textContent = 'Running';
        } else if (processActive) {
            badge.className = 'status-badge connecting';
            statusText.textContent = 'Starting...';
        } else {
            badge.className = 'status-badge stopped';
            statusText.textContent = 'Stopped';
        }
    }

    async checkWDAProject() {
        try {
            const response = await fetch('/api/wda/check');
            const data = await response.json();

            const checkDiv = document.getElementById('wdaCheck');
            if (data.exists) {
                checkDiv.innerHTML = `<span class="check-status" style="color: var(--success)">✓ WDA project found</span>`;
                this.addLog('WDA project found at: ' + data.path, 'success');
            } else {
                checkDiv.innerHTML = `<span class="check-status" style="color: var(--warning)">⚠ ${data.message}</span>`;
                this.addLog(data.message, 'warning');
            }
        } catch (error) {
            this.addLog('Failed to check WDA project: ' + error.message, 'error');
        }
    }

    async installDriver() {
        this.addLog('Installing/Updating XCUITest driver...', 'info');

        try {
            const response = await fetch('/api/appium/install-driver', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();

            if (!data.success) {
                this.addLog('Failed to install driver: ' + data.error, 'error');
            }
        } catch (error) {
            this.addLog('Failed to install driver: ' + error.message, 'error');
        }
    }

    addLog(message, type = 'info') {
        const terminal = document.getElementById('logTerminal');
        const now = new Date();
        const time = now.toTimeString().split(' ')[0];

        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.innerHTML = `
            <span class="log-time">[${time}]</span>
            <span class="log-message">${this.escapeHtml(message)}</span>
        `;

        terminal.appendChild(entry);

        if (this.autoScroll) {
            terminal.scrollTop = terminal.scrollHeight;
        }

        // Keep only last 500 entries
        while (terminal.children.length > 500) {
            terminal.removeChild(terminal.firstChild);
        }
    }

    clearLogs() {
        const terminal = document.getElementById('logTerminal');
        terminal.innerHTML = '';
        this.addLog('Logs cleared', 'info');
    }

    toggleAutoScroll() {
        this.autoScroll = !this.autoScroll;
        const btn = document.getElementById('toggleAutoScroll');
        btn.style.opacity = this.autoScroll ? 1 : 0.5;
        this.addLog(`Auto-scroll ${this.autoScroll ? 'enabled' : 'disabled'}`, 'info');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    window.wdaRunner = new WDARunner();
});
