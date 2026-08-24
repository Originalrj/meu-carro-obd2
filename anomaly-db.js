// =============================================
// anomaly-db.js — Detector de anomalias + armazenamento persistente IndexedDB
// Registra SOMENTE leituras fora dos ranges normais. Sobrevive a recarregamentos.
// =============================================

const AnomalyDB = {
    DB_NAME: 'AutoGestaoX_Anomalies',
    STORE: 'anomalies',
    MAX_ENTRIES: 10000,
    _db: null,

    open() {
        if (this._db) return Promise.resolve(this._db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE)) {
                    const store = db.createObjectStore(this.STORE, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('timestamp', 't', { unique: false });
                    store.createIndex('sensor', 'sensor', { unique: false });
                    store.createIndex('severity', 'severity', { unique: false });
                }
            };
            req.onsuccess = () => { this._db = req.result; resolve(this._db); };
            req.onerror = () => reject(req.error);
        });
    },

    async add(anomaly) {
        try {
            const db = await this.open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE, 'readwrite');
                tx.objectStore(this.STORE).add(anomaly);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            this._prune();
        } catch (e) {
            console.warn('[AnomalyDB] Falha ao salvar:', e);
        }
    },

    async _prune() {
        try {
            const count = await this.count();
            if (count <= this.MAX_ENTRIES) return;
            const excesso = count - this.MAX_ENTRIES;
            const db = await this.open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE, 'readwrite');
                const idx = tx.objectStore(this.STORE).index('timestamp');
                let removidos = 0;
                const cursorReq = idx.openCursor();
                cursorReq.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor && removidos < excesso) {
                        cursor.delete();
                        removidos++;
                        cursor.continue();
                    }
                };
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('[AnomalyDB] Falha no prune:', e);
        }
    },

    async getAll(limit = 200) {
        try {
            const db = await this.open();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE, 'readonly');
                const req = tx.objectStore(this.STORE).index('timestamp').openCursor(null, 'prev');
                const results = [];
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor && results.length < limit) {
                        results.push(cursor.value);
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn('[AnomalyDB] Falha ao ler:', e);
            return [];
        }
    },

    async count() {
        try {
            const db = await this.open();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE, 'readonly');
                const req = tx.objectStore(this.STORE).count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            return 0;
        }
    },

    async clear() {
        try {
            const db = await this.open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE, 'readwrite');
                tx.objectStore(this.STORE).clear();
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            estadoAnomalias = {};
        } catch (e) {
            console.warn('[AnomalyDB] Falha ao limpar:', e);
        }
    },

    async exportJSON() {
        const all = await this.getAll(100000);
        const payload = {
            exportDate: new Date().toISOString(),
            appVersion: 'AutoGestaoX-v1',
            totalAnomalias: all.length,
            anomalias: all
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `agx_anomalias_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
};

// --- DETECTOR DE ANOMALIAS ---
// Estado por sensor: 'normal' | 'alerta' | 'critico'
// Só registra TRANSIÇÕES (normal→alerta, alerta→critico) e recuperações.
const estadoAnomalias = {};
const ANOMALIA_DEBOUNCE_MS = 60000; // não re-registra mesma anomalia em <1min

function avaliarSeveridadeSensor(sensorDef, valor) {
    if (valor === null || valor === undefined || isNaN(valor)) return null;
    // Range alto (criticoAlto/alertaAlto) tem prioridade se existir
    if (sensorDef.criticoAlto && valor >= sensorDef.criticoAlto[0]) return 'critico';
    if (sensorDef.alertaAlto && valor >= sensorDef.alertaAlto[0] && valor < (sensorDef.criticoAlto ? sensorDef.criticoAlto[0] : Infinity)) return 'alerta';
    if (sensorDef.critico && sensorDef.critico.length && valor >= sensorDef.critico[0] && valor <= sensorDef.critico[1]) return 'critico';
    if (sensorDef.alerta && sensorDef.alerta.length && valor >= sensorDef.alerta[0] && valor <= sensorDef.alerta[1]) return 'alerta';
    // Fora do range min/max absoluto também é anomalia
    if (valor > sensorDef.max || valor < sensorDef.min) return 'critico';
    return 'normal';
}

// Mapa reverso: id do sensor -> chave pidSupport
let _sensorSuporteMap = null;
function getSensorSuporteMap() {
    if (_sensorSuporteMap) return _sensorSuporteMap;
    _sensorSuporteMap = {};
    try {
        for (const [cmd, key] of Object.entries(pidToKey)) {
            _sensorSuporteMap[key] = true;
        }
    } catch (e) { /* pidToKey ainda não definido */ }
    return _sensorSuporteMap;
}

function detectarAnomalias() {
    if (modoSimulacao) return;
    const suporteMap = getSensorSuporteMap();

    for (const def of SENSORES_OBD) {
        // Pula sensores marcados como não suportados pelo veículo
        if (suporteMap[def.id] && typeof pidSupport !== 'undefined' && pidSupport[def.id] === false) continue;

        const valor = leiturasOBD[def.id];
        const sev = avaliarSeveridadeSensor(def, valor);
        if (!sev) continue;

        const anterior = estadoAnomalias[def.id] || { sev: 'normal', t: 0 };

        if (sev === anterior.sev) continue; // sem transição

        const agora = Date.now();

        // Transição para pior OU recuperação de crítico → registrar
        const piorou = (anterior.sev === 'normal' && sev === 'alerta') ||
                       (anterior.sev === 'normal' && sev === 'critico') ||
                       (anterior.sev === 'alerta' && sev === 'critico');
        const recuperou = (anterior.sev === 'critico' && sev === 'normal');

        if ((piorou || recuperou) && (agora - anterior.t > ANOMALIA_DEBOUNCE_MS || piorou)) {
            AnomalyDB.add({
                t: agora,
                sensor: def.id,
                label: def.label,
                unit: def.unit,
                valor: parseFloat(valor.toFixed(def.decimals)),
                severidade: sev,
                tipo: recuperou ? 'recuperacao' : 'anomalia',
                velocidade: Math.round(leiturasOBD.velocidade || 0),
                rpm: Math.round(leiturasOBD.rpm || 0)
            });

            if (sev === 'critico') {
                AGXLogger.log('ANOMALIA_CRITICA', `${def.label}: ${parseFloat(valor.toFixed(def.decimals))} ${def.unit}`, { sensor: def.id, valor });
                showToast(`${def.icon} ${def.label} CRÍTICO: ${parseFloat(valor.toFixed(def.decimals))}${def.unit ? ' ' + def.unit : ''}`, 'danger');
            } else if (piorou) {
                AGXLogger.log('ANOMALIA_ALERTA', `${def.label}: ${parseFloat(valor.toFixed(def.decimals))} ${def.unit}`, { sensor: def.id, valor });
            }
        }

        estadoAnomalias[def.id] = { sev, t: agora };
    }
}

async function renderizarHistoricoAnomalias() {
    const container = document.getElementById('diag-anomalias');
    if (!container) return;

    const total = await AnomalyDB.count();
    const recentes = await AnomalyDB.getAll(50);

    let html = `
        <div class="card" style="padding:12px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <div style="font-size:11px; font-weight:800; color:var(--accent); text-transform:uppercase;">
                    <i class="fas fa-triangle-exclamation"></i> Histórico de Anomalias
                </div>
                <div style="font-size:10px; color:#94a3b8;">${total} registro${total === 1 ? '' : 's'} · persistente</div>
            </div>`;

    if (total === 0) {
        html += `<p style="font-size:11px; color:#94a3b8; margin:8px 0;">Nenhuma anomalia registrada até agora. Leituras fora do normal aparecerão aqui automaticamente.</p>`;
    } else {
        // Resumo por severidade
        const criticos = recentes.filter(a => a.severidade === 'critico').length;
        const alertas = recentes.filter(a => a.severidade === 'alerta').length;
        const recuperacoes = recentes.filter(a => a.tipo === 'recuperacao').length;
        html += `
            <div style="display:flex; gap:6px; margin-bottom:10px;">
                <span style="flex:1; text-align:center; padding:6px; background:rgba(255,0,85,0.1); border-radius:6px; font-size:10px;"><strong style="color:#ff0055">${criticos}</strong><br><span style="color:#94a3b8">críticos</span></span>
                <span style="flex:1; text-align:center; padding:6px; background:rgba(255,170,0,0.1); border-radius:6px; font-size:10px;"><strong style="color:#ffaa00">${alertas}</strong><br><span style="color:#94a3b8">alertas</span></span>
                <span style="flex:1; text-align:center; padding:6px; background:rgba(0,255,136,0.08); border-radius:6px; font-size:10px;"><strong style="color:#00ff88">${recuperacoes}</strong><br><span style="color:#94a3b8">recuper.</span></span>
            </div>
            <div style="max-height:220px; overflow-y:auto;">`;
        html += recentes.map(a => {
            const cor = a.severidade === 'critico' ? '#ff0055' : '#ffaa00';
            const icone = a.tipo === 'recuperacao' ? 'fa-arrow-rotate-left' : (a.severidade === 'critico' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation');
            const data = new Date(a.t);
            const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return `
                <div style="display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                    <i class="fas ${icone}" style="color:${cor}; width:14px;"></i>
                    <div style="flex:1;">
                        <div style="font-size:11px; font-weight:700; color:#fff;">${a.label}: ${a.valor}${a.unit ? ' ' + a.unit : ''}</div>
                        <div style="font-size:9px; color:#666;">${hora} · ${a.velocidade || 0} km/h · ${a.rpm || 0} RPM</div>
                    </div>
                    <span style="font-size:8px; font-weight:800; color:${cor}; text-transform:uppercase;">${a.tipo === 'recuperacao' ? 'OK' : a.severidade}</span>
                </div>`;
        }).join('');
        html += `</div>`;
    }

    html += `
        <div style="display:flex; gap:6px; margin-top:10px;">
            <button onclick="AnomalyDB.exportJSON()" style="flex:1; padding:8px; background:rgba(0,242,255,0.1); border:1px solid rgba(0,242,255,0.3); border-radius:8px; color:var(--accent); font-size:10px; font-weight:700; cursor:pointer;">
                <i class="fas fa-download"></i> Exportar JSON
            </button>
            <button onclick="limparAnomalias()" style="padding:8px 12px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:8px; color:#94a3b8; font-size:10px; cursor:pointer;">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    </div>`;
    container.innerHTML = html;
}

function limparAnomalias() {
    if (confirm('Apagar todo o histórico de anomalias?')) {
        AnomalyDB.clear().then(() => renderizarHistoricoAnomalias());
    }
}
