// =============================================
// logger.js — Sistema de logging para diagnóstico
// =============================================

const AGXLogger = {
    MAX_ENTRIES: 2000,
    STORAGE_KEY: 'agx_logs',
    sessionId: null,
    enabled: true,
    sessionActive: false,
    _bleDataCount: 0,

    init() {
        this.sessionId = new Date().toISOString().replace(/[:.]/g, '-');
        this.sessionActive = true;
        this.log('SESSION_START', 'Sessão de log iniciada', {
            device: navigator.userAgent,
            screen: `${screen.width}x${screen.height}`,
            platform: navigator.platform
        });
    },

    log(type, msg, data) {
        if (!this.enabled || !this.sessionActive) return;
        if (type === 'BLE_DATA') {
            this._bleDataCount++;
            if (this._bleDataCount % 5 !== 0) return;
        }

        const entries = this.getEntries();
        if (entries.length >= this.MAX_ENTRIES) {
            entries.splice(0, entries.length - this.MAX_ENTRIES + 1);
        }

        entries.push({
            t: Date.now(),
            type: type,
            msg: msg,
            data: data || null
        });

        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(entries));
        } catch (e) {
            entries.splice(0, 100);
            try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(entries)); } catch(e2) {}
        }
    },

    getEntries() {
        try {
            return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
        } catch (e) {
            return [];
        }
    },

    getEntryCount() {
        return this.getEntries().length;
    },

    clear() {
        localStorage.removeItem(this.STORAGE_KEY);
        this.log('LOG_CLEARED', 'Logs limpos pelo usuário');
    },

    exportJSON() {
        const entries = this.getEntries();
        const payload = {
            sessionId: this.sessionId,
            exportDate: new Date().toISOString(),
            appVersion: 'AutoGestaoX-v1',
            device: navigator.userAgent,
            screen: `${screen.width}x${screen.height}`,
            totalEntries: entries.length,
            logs: entries
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `agx_log_${this.sessionId}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.log('LOG_EXPORTED', `Exportado ${entries.length} entradas`);
    },

    // Atalhos para tipos comuns de log
    bleConnect(msg, data) { this.log('BLE_CONNECT', msg, data); },
    bleDisconnect(msg, data) { this.log('BLE_DISCONNECT', msg, data); },
    bleError(msg, data) { this.log('BLE_ERROR', msg, data); },
    serialConnect(msg, data) { this.log('SERIAL_CONNECT', msg, data); },
    serialDisconnect(msg, data) { this.log('SERIAL_DISCONNECT', msg, data); },
    elmCmd(cmd, response, timeMs) { this.log('ELM_CMD', `${cmd} → ${response}`, { cmd, response, timeMs }); },
    elmError(cmd, error) { this.log('ELM_ERROR', `${cmd} falhou: ${error}`, { cmd, error }); },
    sensorReadings(data) { this.log('SENSOR', 'Leitura de sensores', data); },
    userAction(action, detail) { this.log('USER', action, detail); },
    funcCall(funcName, result) { this.log('FUNC', funcName, result); },
    error(funcName, errorMsg, stack) { this.log('ERROR', `${funcName}: ${errorMsg}`, { stack }); }
};

AGXLogger.init();

// Global error handler
window.addEventListener('error', (e) => {
    AGXLogger.error('window.error', e.message, { filename: e.filename, lineno: e.lineno, colno: e.colno });
});

window.addEventListener('unhandledrejection', (e) => {
    AGXLogger.error('unhandledrejection', e.reason?.message || String(e.reason));
});
