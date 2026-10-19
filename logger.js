// =============================================
// logger.js — Sistema de logging para diagnóstico
// =============================================

const AGXLogger = {
    // Retenção ampliada para coletar mais tempo de sessão em campo.
    // ~1 heartbeat de polling a cada ~5s + amostras de BLE/ELM => ~8h de histórico.
    MAX_ENTRIES: 8000,
    STORAGE_KEY: 'agx_logs',
    FLUSH_MS: 4000,
    // Amostragem: evita que respostas cruas e comandos enviados encham o buffer.
    BLE_DATA_EVERY: 20,
    ELM_SEND_EVERY: 20,
    sessionId: null,
    enabled: true,
    sessionActive: false,
    _bleDataCount: 0,
    _elmSendCount: 0,
    _entries: null,
    _flushTimer: null,
    _dirty: false,

    // Mantém as entradas em memória e persiste de forma diferida (flush).
    // Evita um localStorage.setItem síncrono a cada comando ELM.
    _loadEntries() {
        if (this._entries) return this._entries;
        try {
            this._entries = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
        } catch (e) {
            this._entries = [];
        }
        return this._entries;
    },

    _scheduleFlush() {
        if (this._flushTimer) return;
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            this.flush();
        }, this.FLUSH_MS);
    },

    flush() {
        if (!this._dirty || !this._entries) return;
        this._dirty = false;
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._entries));
        } catch (e) {
            this._entries.splice(0, 200);
            try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._entries)); } catch (e2) {}
        }
    },

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
            if (this._bleDataCount % this.BLE_DATA_EVERY !== 0) return;
        }
        if (type === 'ELM_SEND') {
            this._elmSendCount++;
            if (this._elmSendCount % this.ELM_SEND_EVERY !== 0) return;
        }

        const entries = this._loadEntries();
        // Trim em lote (evita splice a cada entrada, que é O(n) e trava a main thread).
        if (entries.length >= this.MAX_ENTRIES + 500) {
            entries.splice(0, entries.length - this.MAX_ENTRIES);
        }

        entries.push({
            t: Date.now(),
            type: type,
            msg: msg,
            data: data || null
        });

        this._dirty = true;
        this._scheduleFlush();
    },

    getEntries() {
        return this._loadEntries();
    },

    getEntryCount() {
        return this._loadEntries().length;
    },

    clear() {
        this._entries = [];
        this._dirty = false;
        if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
        localStorage.removeItem(this.STORAGE_KEY);
        this.log('LOG_CLEARED', 'Logs limpos pelo usuário');
    },

    exportJSON() {
        this.flush();
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
    dtcScan(detail) { this.log('DTC_SCAN', 'Varredura de DTCs (modo 03)', detail); },
    dtcIncompativel(codigo, detail) { this.log('DTC_INCOMPATIVEL', `DTC ${codigo} ocultado (incompativel com o veiculo)`, detail); },
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

// Garante persistência dos logs ao sair/ocultar a página
window.addEventListener('beforeunload', () => AGXLogger.flush());
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') AGXLogger.flush();
});
