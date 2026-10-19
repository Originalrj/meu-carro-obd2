// =============================================
// obd2.js — Conexão ELM327, simulação e leitura de dados OBD2
// =============================================

// --- MODO SIMULADOR DE DADOS E CONEXÃO REAL ---
let modoSimulacao = true; 
let simulationIntervalId;
let pollingTelemetriaId;
let port;
let reader;
let writer;
let bleCharacteristic = null;
let bleTxCharacteristic = null;
let bleWriteType = 'writeWithoutResponse';
let _obdexCache = null;
let _obdexLoading = false;
let noDataCount = 0;
const NO_DATA_THRESHOLD = 10;
const pidFailures = {};
const PID_FAIL_THRESHOLD = 3;
// PIDs marcados como não suportados pelo veículo (por comando). Auto-skip no polling.
const pidUnsupported = {};
// PIDs essenciais: nunca "aposentar" (um hiccup do adaptador não deve congelar o painel).
const PIDS_ESSENCIAIS = new Set(['010C', '010D', '0104', '0105', '0142', '012F']);
let lastPidSent = null;
let bleDataCount = 0;
let _scanNoDataShown = false;
let _desconexaoManual = false;

// Inicia o modo simulado garantindo UM ÚNICO intervalo. Evita empilhamento
// quando caminhos de erro/reconexão reatribuem simulationIntervalId sem
// limpar o anterior (intervalos sobrepostos degradam a UI ao longo do tempo).
function iniciarSimulacao() {
    if (simulationIntervalId) clearInterval(simulationIntervalId);
    simulationIntervalId = setInterval(simularDadosOBD, 3000);
}

// Escapa texto para uso em innerHTML e atributos HTML — evita XSS com dados
// do usuário (manutenção, veículo, checklist) ou externos (postos do OSM,
// Nominatim, FIPE, dicionário OBDex baixado por fetch).
// Definido aqui porque obd2.js é carregado antes de ui.js (index.html).
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function atualizarBadgeconexao() {
    const el = document.getElementById('stat-conexao');
    const elTipo = document.getElementById('stat-tipo-conexao');
    if (el) {
        if (modoSimulacao) {
            el.innerHTML = '<i class="fas fa-play-circle"></i> Simulado';
            el.style.borderColor = 'rgba(255,255,255,0.15)';
            el.style.color = '#94a3b8';
            el.style.fontWeight = '400';
        } else {
            el.innerHTML = '<i class="fas fa-satellite-dish"></i> AO VIVO';
            el.style.borderColor = 'var(--accent)';
            el.style.color = 'var(--accent)';
            el.style.fontWeight = '800';
        }
    }
    if (elTipo) {
        if (modoSimulacao) {
            elTipo.innerHTML = '<i class="fas fa-vial"></i> Dados simulados';
            elTipo.style.borderColor = 'rgba(255,255,255,0.15)';
            elTipo.style.color = '#94a3b8';
        } else {
            const tipo = tipoConexao === 'ble' ? 'Bluetooth' : 'Serial USB';
            elTipo.innerHTML = `<i class="fas fa-satellite-dish"></i> ${tipo}`;
            elTipo.style.borderColor = 'rgba(0,242,255,0.2)';
            elTipo.style.color = 'var(--accent)';
        }
    }
}

function setModoSimulacao(valor) {
    modoSimulacao = valor;
    atualizarBadgeconexao();
}
let bleBuffer = '';
let bleDevice = null;
let tipoConexao = null; // 'serial' ou 'ble'

// Pre-load OBDex DTC database (lazy, non-blocking).
// ADIADO com setTimeout: DICIONARIO_DTC_FALLBACK é declarado no fim do arquivo;
// chamar loadOBDex() aqui no topo causava "Cannot access 'DICIONARIO_DTC_FALLBACK'
// before initialization" (TDZ) sempre que o fetch falhava (offline/CSP).
setTimeout(() => { loadOBDex().catch(() => {}); }, 0);

function hexToAscii(hex) {
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
        let charCode = parseInt(hex.substr(i, 2), 16);
        if (charCode > 0) str += String.fromCharCode(charCode);
    }
    return str;
}

let leiturasOBD = {
    rpm: 0, velocidade: 0, tempMotor: 0, tensaoBateria: 0,
    cargaMotor: 0, posAcelerador: 0, tempArAdmissao: 0,
    pressaoMAP: 0, consumoInstantaneo: 0, nivelO2: 0,
    pontoIgnicao: 0, statusCombustivel: '--',
    fuelTrimSTFT: 0, fuelTrimLTFT: 0, pressaoCombustivel: 0,
    tempPosCatalisador: 0, tempAmbiente: 0, deslizamentoEmbreagem: 0,
    nivelCombustivel: 50, consumoEsperado: 0,
    statusMIL: false, qtdDTCs: 0,
    statusSistemaComb: '--',
    distDesdeDTC: 0, tempoDesdeUltimaPartida: 0, tempoDesdeDTC: 0,
    o2Sensor1: 0, o2Sensor2: 0, o2Sensor3: 0, o2Sensor4: 0,
    maf: 0, etanolPercent: 0, tempOleo: 0, consumoRealLh: 0,
    pressaoBarometrica: 0, tempCatalisador: 0,
    torqueSolicitado: 0, torqueReal: 0
};

// Track which PIDs are supported by this vehicle (NO DATA = unsupported)
const pidSupport = {
    maf: true,        // PID 0110
    fuelTrimSTFT: true, // PID 0106
    fuelTrimLTFT: true, // PID 0107
    pressaoCombustivel: true, // PID 010A
    pressaoMAP: true, // PID 010B
    tempOleo: true,    // PID 015C
    tempAmbiente: true, // PID 0146
    o2Sensor1: true,   // PID 0114
    o2Sensor2: true,   // PID 0115
};

// Map PID commands to pidSupport keys
const pidToKey = {
    '0110': 'maf', '0106': 'fuelTrimSTFT', '0107': 'fuelTrimLTFT',
    '010A': 'pressaoCombustivel', '010B': 'pressaoMAP', '015C': 'tempOleo',
    '0146': 'tempAmbiente', '0114': 'o2Sensor1', '0115': 'o2Sensor2'
};

// Sensor history for correlation analysis (max 60 samples = ~60 seconds)
const sensorHistory = {
    fuelTrimSTFT: [],
    fuelTrimLTFT: [],
    pressaoMAP: [],
    pressaoCombustivel: [],
    nivelO2: [],
    maf: [],
    tempArAdmissao: [],
    tempAmbiente: [],
    rpm: [],
    cargaMotor: [],
    timestamps: []
};
const MAX_HISTORY = 60;

// --- Trip accumulators (real-time distance + fuel) ---
let lastUpdateTime = null;        // Timestamp of last OBD2 update (ms)
let distanciaAcumulada = 0;       // Distance accumulated since trip start (km)
let combustivelAcumulado = 0;     // Fuel consumed since trip start (liters)
let tripStartTime = null;         // When current trip started

// MAP key-on tracking (chave ligada, motor desligado)
let mapKeyOn = null;          // MAP when RPM=0 (key on, engine off)
let mapIdleEstabilizado = null; // MAP at idle after engine warms up
let engineStarted = false;
let engineStartMap = null;

function atualizarAcumuladores() {
    const now = Date.now();
    if (lastUpdateTime === null) {
        lastUpdateTime = now;
        if (!tripStartTime) tripStartTime = now;
        return;
    }

    const dtSeg = (now - lastUpdateTime) / 1000;
    lastUpdateTime = now;

    if (dtSeg <= 0 || dtSeg > 30) return;

    const vel = leiturasOBD.velocidade || 0;
    const consLh = leiturasOBD.consumoInstantaneo || 0;

    const deltaKm = (vel / 3600) * dtSeg;
    distanciaAcumulada += deltaKm;

    const deltaLitros = (consLh / 3600) * dtSeg;
    combustivelAcumulado += deltaLitros;
}

function resetarAcumuladores() {
    distanciaAcumulada = 0;
    combustivelAcumulado = 0;
    lastUpdateTime = null;
    tripStartTime = null;
}

function getConsumoMedioReal() {
    if (combustivelAcumulado < 0.1) return null;
    const kmL = distanciaAcumulada / combustivelAcumulado;
    if (kmL < 2 || kmL > 30) return null;
    return parseFloat(kmL.toFixed(1));
}

function addSensorHistory() {
    const now = Date.now();
    sensorHistory.fuelTrimSTFT.push(leiturasOBD.fuelTrimSTFT);
    sensorHistory.fuelTrimLTFT.push(leiturasOBD.fuelTrimLTFT);
    sensorHistory.pressaoMAP.push(leiturasOBD.pressaoMAP);
    sensorHistory.pressaoCombustivel.push(leiturasOBD.pressaoCombustivel);
    sensorHistory.nivelO2.push(leiturasOBD.nivelO2);
    sensorHistory.maf.push(leiturasOBD.maf);
    sensorHistory.tempArAdmissao.push(leiturasOBD.tempArAdmissao);
    sensorHistory.tempAmbiente.push(leiturasOBD.tempAmbiente);
    sensorHistory.rpm.push(leiturasOBD.rpm);
    sensorHistory.cargaMotor.push(leiturasOBD.cargaMotor);
    sensorHistory.timestamps.push(now);
    if (sensorHistory.timestamps.length > MAX_HISTORY) {
        for (const key in sensorHistory) sensorHistory[key].shift();
    }

    // MAP key-on/engine-off tracking
    if (leiturasOBD.rpm < 50 && leiturasOBD.pressaoMAP > 50) {
        mapKeyOn = leiturasOBD.pressaoMAP;
        engineStarted = false;
        mapIdleEstabilizado = null;
        engineStartMap = null;
    }

    // Detect engine start (RPM goes from 0 to >300)
    if (!engineStarted && leiturasOBD.rpm > 300) {
        engineStarted = true;
        engineStartMap = leiturasOBD.pressaoMAP;
    }

    // Capture idle MAP after engine stabilizes (RPM < 1200, tempMotor > 70)
    if (engineStarted && leiturasOBD.rpm < 1200 && leiturasOBD.tempMotor > 70) {
        if (mapIdleEstabilizado === null) {
            mapIdleEstabilizado = leiturasOBD.pressaoMAP;
        } else {
            // Running average for stability
            mapIdleEstabilizado = (mapIdleEstabilizado * 0.8) + (leiturasOBD.pressaoMAP * 0.2);
        }
    }
}

function analyzeSensorDiagnostics() {
    const container = document.getElementById('diag-sensores');
    if (!container) return;

    const L = leiturasOBD;
    const H = sensorHistory;
    const tests = [];
    let diagnosticoFinal = null;

    const stft = L.fuelTrimSTFT;
    const ltft = L.fuelTrimLTFT;
    const map = L.pressaoMAP;
    const o2 = L.nivelO2;
    const fuelPress = L.pressaoCombustivel;
    const rpm = L.rpm;
    const carga = L.cargaMotor;
    const iat = L.tempArAdmissao;
    const tempAmb = L.tempAmbiente;

    // Helper: calculate RPM stability (standard deviation)
    function calcRpmStability() {
        if (H.rpm.length < 10) return null;
        const idleReadings = H.rpm.filter((v, i) => H.cargaMotor[i] < 20 && H.rpm[i] > 500 && H.rpm[i] < 1200);
        if (idleReadings.length < 5) return null;
        const avg = idleReadings.reduce((a, b) => a + b, 0) / idleReadings.length;
        const variance = idleReadings.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / idleReadings.length;
        return { avg: avg, stdDev: Math.sqrt(variance) };
    }

    // Helper: calculate average fuel pressure
    function calcAvgFuelPressure() {
        const valid = H.pressaoCombustivel.filter(v => v > 0);
        if (valid.length === 0) return null;
        return valid.reduce((a, b) => a + b, 0) / valid.length;
    }

    // Helper: calculate O2 stats
    function calcO2Stats() {
        if (H.nivelO2.length < 5) return null;
        const recent = H.nivelO2.slice(-15);
        const min = Math.min(...recent);
        const max = Math.max(...recent);
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
        return { min, max, avg, amplitude: max - min };
    }

    // Helper: calculate MAP stats at idle
    function calcMapIdleStats() {
        const idleReadings = H.pressaoMAP.filter((v, i) => H.cargaMotor[i] < 20 && H.rpm[i] > 500 && H.rpm[i] < 1200);
        if (idleReadings.length < 3) return null;
        const avg = idleReadings.reduce((a, b) => a + b, 0) / idleReadings.length;
        return { avg, count: idleReadings.length };
    }

    // Helper: calculate MAP at high load
    function calcMapHighLoadStats() {
        const highLoadReadings = H.pressaoMAP.filter((v, i) => H.cargaMotor[i] > 60);
        if (highLoadReadings.length < 2) return null;
        return highLoadReadings.reduce((a, b) => a + b, 0) / highLoadReadings.length;
    }

    const rpmStab = calcRpmStability();
    const avgFuelPress = calcAvgFuelPressure();
    const o2Stats = calcO2Stats();
    const mapIdleStats = calcMapIdleStats();
    const mapHighLoad = calcMapHighLoadStats();

    // ============================================================
    // CRUZAMENTO 1: STFT + MAP + O₂ + Pressão Combustível
    // ============================================================
    const isLean = stft > 5 || ltft > 5;
    const isRich = stft < -5 || ltft < -5;
    const mapHigh = map > 65;
    const mapNormal = map >= 30 && map <= 65;
    const mapLow = map < 30;
    const o2Rich = o2 > 0.6;
    const o2Lean = o2 < 0.3;
    const o2Normal = o2 >= 0.3 && o2 <= 0.6;
    const fuelPressLow = fuelPress < 250;
    const fuelPressNormal = fuelPress >= 250 && fuelPress <= 500;
    const fuelPressHigh = fuelPress > 500;
    const mapKeyOnInfo = mapKeyOn !== null ? ` | Chave-ON: ${mapKeyOn.toFixed(0)}` : '';

    if (isLean) {
        let diagnostico = '';
        let recomendacao = '';
        let nivel = 'alerta';
        let icon = '🔧';

        // DECISION TREE: STFT + MAP + O₂ + Fuel Pressure
        if (o2Lean) {
            // O₂ confirms lean mixture — real lean condition
            if (mapHigh) {
                if (fuelPressNormal) {
                    nivel = 'critico';
                    icon = '🚨';
                    diagnostico = 'VAZAMENTO DE AR NA ADMISSÃO';
                    recomendacao = 'Confirmação por 4 sensores: STFT pobre + MAP alta + O₂ pobre + Pressão OK = ar entrando no sistema. Verifique: (1) Antichamas e mangueiras, (2) Junta do coletor, (3) Tubo do MAP, (4) Conexão filtro de ar. Use spray de partida.';
                } else if (fuelPressLow) {
                    nivel = 'critico';
                    icon = '🚨';
                    diagnostico = 'VAZAMENTO + PRESSÃO BAIXA (Combustível)';
                    recomendacao = 'STFT pobre + MAP alta + O₂ pobre + Pressão BAIXA = dois problemas: (1) Vazamento de ar na admissão E (2) Bomba/filtro de combustível fraco. Resolva ambos.';
                } else {
                    nivel = 'alerta';
                    icon = '⚠️';
                    diagnostico = 'VAZAMENTO DE AR + PRESSÃO ALTA';
                    recomendacao = 'STFT pobre + MAP alta + O₂ pobre + Pressão alta = vazamento de ar + possível regulador de pressão travado.';
                }
            } else if (mapNormal) {
                if (fuelPressNormal) {
                    nivel = 'critico';
                    icon = '⚠️';
                    diagnostico = 'SENSOR MAP DESCALIBRADO';
                    recomendacao = 'STFT pobre + MAP normal + O₂ pobre + Pressão OK = sensor MAP reportando valor incorreto à ECU. Substitua o sensor MAP.';
                } else if (fuelPressLow) {
                    nivel = 'critico';
                    icon = '🚨';
                    diagnostico = 'BOMBA/FILTRO DE COMBUSTÍVEL FRACO';
                    recomendacao = 'STFT pobre + MAP normal + O₂ pobre + Pressão BAIXA = combustível insuficiente. Substitua filtro e verifique bomba.';
                } else {
                    nivel = 'alerta';
                    icon = '⚠️';
                    diagnostico = 'COMBUSTÍVEL + SENSOR';
                    recomendacao = 'STFT pobre + MAP normal + O₂ pobre + Pressão alta = possível regulador de pressão com defeito.';
                }
            } else if (mapLow) {
                nivel = 'alerta';
                icon = '🔍';
                diagnostico = 'ANÁLISE EM ANDAMENTO';
                recomendacao = 'MAP muito baixa — aguardando leituras estáveis para diagnóstico.';
            }
        } else if (o2Rich) {
            // O₂ says rich but STFT says lean — contradiction
            nivel = 'alerta';
            icon = '🔍';
            if (fuelPressNormal) {
                diagnostico = 'SENSOR O₂ DESCALIBRADO';
                recomendacao = 'STFT pobre + O₂ rico = contradição. O sensor O₂ está reportando rico quando a mistura é pobre. Verifique fiação e substitua o sensor O₂.';
            } else if (fuelPressLow) {
                diagnostico = 'PRESSÃO BAIXA + SENSOR O₂';
                recomendacao = 'STFT pobre + O₂ rico + Pressão baixa = pressão insuficiente pode estar confundindo o sensor. Verifique bomba/filtro primeiro.';
            }
        } else if (o2Normal) {
            nivel = 'alerta';
            icon = '🔍';
            diagnostico = 'ANÁLISE PARCIAL — O₂ NEUTRO';
            recomendacao = 'STFT pobre mas O₂ neutro — aguardando mais leituras. O sensor O₂ pode estar entre rico/pobre.';
        }
        if (Math.abs(stft) > 15 || Math.abs(ltft) > 15) nivel = 'critico';
        if (diagnostico) {
            tests.push({
                nivel, icon,
                titulo: `Diagnóstico Principal: ${diagnostico}`,
                detalhe: `STFT: ${stft > 0 ? '+' : ''}${stft.toFixed(1)}% | LTFT: ${ltft > 0 ? '+' : ''}${ltft.toFixed(1)}% | MAP: ${map.toFixed(0)}${mapKeyOnInfo} kPa | O₂: ${o2.toFixed(2)}V | Comb: ${fuelPress.toFixed(0)} kPa`,
                recomendacao
            });
            diagnosticoFinal = diagnostico;
        }
    } else if (isRich) {
        let diagnostico = '';
        let recomendacao = '';
        let nivel = 'alerta';
        let icon = '🔧';

        if (o2Rich) {
            nivel = 'critico';
            icon = '🚨';
            if (fuelPressNormal) {
                diagnostico = 'INJETOR VAZANDO OU REGULADOR';
                recomendacao = 'STFT negativo + O₂ rico + Pressão OK = excesso de combustível. Verifique: (1) Injetores (equalização), (2) Regulador de pressão, (3) Sensor O₂.';
            } else if (fuelPressHigh) {
                diagnostico = 'REGULADOR DE PRESSÃO TRAVADO';
                recomendacao = 'STFT negativo + O₂ rico + Pressão ALTA = regulador não está reduzindo pressão. Substitua o regulador.';
            } else if (fuelPressLow) {
                diagnostico = 'INJETOR VAZANDO + PRESSÃO BAIXA';
                recomendacao = 'STFT negativo + O₂ rico + Pressão baixa = combinção rara. Verifique injetores E bomba/filtro.';
            }
        } else if (o2Lean) {
            nivel = 'alerta';
            icon = '🔍';
            diagnostico = 'SENSOR O₂ DESCALIBRADO';
            recomendacao = 'STFT negativo + O₂ pobre = contradição. O sensor O₂ pode estar descalibrado. Teste com multímetro.';
        }
        if (Math.abs(stft) > 15 || Math.abs(ltft) > 15) nivel = 'critico';
        if (diagnostico) {
            tests.push({
                nivel, icon,
                titulo: `Diagnóstico Principal: ${diagnostico}`,
                detalhe: `STFT: ${stft.toFixed(1)}% | LTFT: ${ltft.toFixed(1)}% | MAP: ${map.toFixed(0)} kPa | O₂: ${o2.toFixed(2)}V | Comb: ${fuelPress.toFixed(0)} kPa`,
                recomendacao
            });
            diagnosticoFinal = diagnostico;
        }
    }

    // ============================================================
    // CRUZAMENTO 2: MAP Key-ON vs Idle + RPM Stability
    // ============================================================
    if (rpm > 0) {
        let mapStatus = '';
        let mapNivel = 'ok';
        let mapIcon = '✅';

        if (mapKeyOn !== null && mapIdleEstabilizado !== null && mapKeyOn > 0) {
            const deltaKOvsIdle = mapKeyOn - mapIdleEstabilizado;
            const pctDrop = ((deltaKOvsIdle / mapKeyOn) * 100).toFixed(0);

            if (deltaKOvsIdle < 15) {
                mapNivel = 'critico';
                mapIcon = '❌';
                mapStatus = `SENSOR MAP TRAVADO! Chave-ON: ${mapKeyOn.toFixed(0)} → Idle: ${mapIdleEstabilizado.toFixed(0)} kPa (queda apenas ${deltaKOvsIdle.toFixed(0)} kPa)`;
                if (rpmStab && rpmStab.stdDev > 80) {
                    mapStatus += ` + RPM instável (σ=${rpmStab.stdDev.toFixed(0)}) = vazamento GRANDE ou sensor travado`;
                }
            } else if (deltaKOvsIdle < 30) {
                mapNivel = 'alerta';
                mapIcon = '⚠️';
                mapStatus = `MAP queda parcial: ${mapKeyOn.toFixed(0)} → ${mapIdleEstabilizado.toFixed(0)} kPa (queda ${deltaKOvsIdle.toFixed(0)} kPa, ${pctDrop}%)`;
                if (rpmStab && rpmStab.stdDev > 80) {
                    mapStatus += ` + RPM instável = possível vazamento`;
                } else {
                    mapStatus += ` — possível vazamento pequeno ou sensor`;
                }
            } else {
                mapStatus = `MAP OK: Chave-ON ${mapKeyOn.toFixed(0)} → Idle ${mapIdleEstabilizado.toFixed(0)} kPa (queda ${deltaKOvsIdle.toFixed(0)} kPa, ${pctDrop}%)`;
            }

            // Idle vs High Load test
            if (mapHighLoad !== null) {
                const deltaIdleLoad = mapHighLoad - mapIdleEstabilizado;
                if (deltaIdleLoad < 20) {
                    mapNivel = 'critico';
                    mapIcon = '❌';
                    mapStatus += ` | Sem variação idle→carga (${mapIdleEstabilizado.toFixed(0)} → ${mapHighLoad.toFixed(0)} kPa)`;
                } else {
                    mapStatus += ` | Carga: ${mapHighLoad.toFixed(0)} kPa (Δ${deltaIdleLoad.toFixed(0)})`;
                }
            }
        } else if (mapIdleEstabilizado !== null) {
            if (mapIdleEstabilizado > 55) {
                mapNivel = 'alerta';
                mapIcon = '⚠️';
                mapStatus = `MAP ociosa alta (${mapIdleEstabilizado.toFixed(0)} kPa) — aguardando chave-ON`;
            } else {
                mapStatus = `MAP ociosa: ${mapIdleEstabilizado.toFixed(0)} kPa — aguardando chave-ON + carga`;
            }
        } else {
            mapStatus = 'Coletando dados do sensor MAP...';
        }

        // RPM Stability info
        if (rpmStab) {
            const rpmLabel = rpmStab.stdDev > 80 ? ' ⚠️ Instável' : ' ✅ Estável';
            mapStatus += ` | RPM idle: ${rpmStab.avg.toFixed(0)} ± ${rpmStab.stdDev.toFixed(0)}${rpmLabel}`;
        }

        tests.push({
            nivel: mapNivel, icon: mapIcon,
            titulo: 'Sensor MAP — Teste Completo',
            detalhe: mapStatus,
            recomendacao: mapNivel === 'critico' ? 'Substitua o sensor MAP ou verifique vazamentos de admissão.' :
                         mapNivel === 'alerta' ? 'Verifique mangueiras de vácuo, junta do coletor e conexões.' :
                         'Sensor MAP operando corretamente.'
        });
    }

    // ============================================================
    // CRUZAMENTO 3: Fuel Trim STFT vs LTFT (permanente vs intermitente)
    // ============================================================
    if (Math.abs(stft) > 5 || Math.abs(ltft) > 5) {
        let ftNivel = 'ok';
        let ftIcon = '✅';
        let ftStatus = '';
        let ftRecomendacao = '';

        const bothHigh = Math.abs(stft) > 10 && Math.abs(ltft) > 10;
        const stftOnly = Math.abs(stft) > 10 && Math.abs(ltft) <= 10;
        const bothHighSameDir = (stft > 10 && ltft > 10) || (stft < -10 && ltft < -10);

        if (bothHighSameDir) {
            ftNivel = 'alerta';
            ftIcon = '⚠️';
            ftStatus = `Problema PERMANENTE: STFT ${stft > 0 ? '+' : ''}${stft.toFixed(1)}% + LTFT ${ltft > 0 ? '+' : ''}${ltft.toFixed(1)}%`;
            ftRecomendacao = stft > 0 ? 'Ambos altos positivos = problema persistente (vazamento grande, filtro entupido, bomba fraca).' : 'Ambos altos negativos = problema persistente (injetor vazando, regulador travado).';
        } else if (stftOnly) {
            ftNivel = 'alerta';
            ftIcon = '🔍';
            ftStatus = `Problema INTERMITENTE: STFT ${stft > 0 ? '+' : ''}${stft.toFixed(1)}% mas LTFT ${ltft > 0 ? '+' : ''}${ltft.toFixed(1)}%`;
            ftRecomendacao = 'STFT alto mas LTFT normal = problema pode ser intermitente (mangueira frouxa, vazamento pequeno).';
        } else if (Math.abs(stft) > 15 || Math.abs(ltft) > 15) {
            ftNivel = 'critico';
            ftIcon = '🚨';
            ftStatus = `Fuel Trim CRÍTICO: STFT ${stft > 0 ? '+' : ''}${stft.toFixed(1)}% | LTFT ${ltft > 0 ? '+' : ''}${ltft.toFixed(1)}%`;
            ftRecomendacao = 'Valores extremos — diagnóstico imediato necessário.';
        } else {
            ftStatus = `STFT ${stft > 0 ? '+' : ''}${stft.toFixed(1)}% | LTFT ${ltft > 0 ? '+' : ''}${ltft.toFixed(1)}%`;
            ftRecomendacao = 'Valores moderados — monitorar evolução.';
        }

        tests.push({
            nivel: ftNivel, icon: ftIcon,
            titulo: `Fuel Trim: ${ftStatus}`,
            detalhe: `STFT: ${stft > 0 ? '+' : ''}${stft.toFixed(1)}% (curto prazo) | LTFT: ${ltft > 0 ? '+' : ''}${ltft.toFixed(1)}% (longo prazo)`,
            recomendacao: ftRecomendacao
        });
    }

    // ============================================================
    // CRUZAMENTO 4: O₂ Oscilação vs Fuel Trim
    // ============================================================
    if (pidSupport.o2Sensor1 && o2Stats) {
        let o2Nivel = 'ok';
        let o2Icon = '✅';
        let o2Status = '';
        let o2Recomendacao = '';

        if (o2Stats.amplitude < 0.1) {
            o2Nivel = 'alerta';
            o2Icon = '⚠️';
            if (stft > 10) {
                o2Status = `Sensor O₂ SEM oscilação (${o2Stats.amplitude.toFixed(2)}V) + STFT pobre`;
                o2Recomendacao = 'O₂ travado pobre + fuel trim alto = sensor O₂ descalibrado. Substitua.';
            } else if (stft < -10) {
                o2Status = `Sensor O₂ SEM oscilação (${o2Stats.amplitude.toFixed(2)}V) + STFT rico`;
                o2Recomendacao = 'O₂ travado rico + fuel trim baixo = sensor O₂ ou injetor.';
            } else {
                o2Status = `Sensor O₂ sem oscilação (${o2Stats.amplitude.toFixed(2)}V)`;
                o2Recomendacao = 'Verifique fiação e conectores do sensor O₂.';
            }
        } else if (o2Stats.avg > 0.7) {
            o2Nivel = 'alerta';
            o2Icon = '⚠️';
            o2Status = `O₂ tendendo rico (média ${o2Stats.avg.toFixed(2)}V, amp ${o2Stats.amplitude.toFixed(2)}V)`;
            o2Recomendacao = 'Mistura rica persistente — verifique injetores e regulador.';
        } else if (o2Stats.avg < 0.3) {
            o2Nivel = 'alerta';
            o2Icon = '⚠️';
            o2Status = `O₂ tendendo pobre (média ${o2Stats.avg.toFixed(2)}V, amp ${o2Stats.amplitude.toFixed(2)}V)`;
            o2Recomendacao = 'Mistura pobre persistente — verifique vazamentos e MAP.';
        } else {
            o2Status = `O₂ oscilando normalmente (média ${o2Stats.avg.toFixed(2)}V, amp ${o2Stats.amplitude.toFixed(2)}V)`;
            o2Recomendacao = 'Sensor O₂ operando corretamente.';
        }

        tests.push({
            nivel: o2Nivel, icon: o2Icon,
            titulo: 'Sensor O₂ — Resposta',
            detalhe: o2Status,
            recomendacao: o2Recomendacao
        });
    } else if (!pidSupport.o2Sensor1) {
        tests.push({
            nivel: 'info', icon: 'ℹ️',
            titulo: 'Sensor O₂ — Não disponível',
            detalhe: 'Este veículo não possui sensor O₂ acessível via OBD2',
            recomendacao: 'Este teste não se aplica ao seu veículo.'
        });
    }

    // ============================================================
    // CRUZAMENTO 5: Carga Motor + MAP Coherence
    // ============================================================
    if (rpm > 0 && carga > 0) {
        let mapCohNivel = 'ok';
        let mapCohIcon = '✅';
        let mapCohStatus = '';

        if (carga < 20 && rpm < 1200) {
            // Idle: MAP should be 25-50 kPa
            if (map > 55) {
                mapCohNivel = 'alerta';
                mapCohIcon = '⚠️';
                mapCohStatus = `Idle: MAP ${map.toFixed(0)} kPa com ${carga.toFixed(0)}% carga — MAP alta demais para idle`;
            } else if (map < 20) {
                mapCohNivel = 'alerta';
                mapCohIcon = '⚠️';
                mapCohStatus = `Idle: MAP ${map.toFixed(0)} kPa com ${carga.toFixed(0)}% carga — MAP muito baixa`;
            } else {
                mapCohStatus = `Idle: MAP ${map.toFixed(0)} kPa, carga ${carga.toFixed(0)}% — coerente`;
            }
        } else if (carga > 50) {
            // High load: MAP should be 75-105 kPa
            if (map < 50) {
                mapCohNivel = 'alerta';
                mapCohIcon = '⚠️';
                mapCohStatus = `Carga alta: MAP ${map.toFixed(0)} kPa com ${carga.toFixed(0)}% carga — MAP baixa demais para carga`;
            } else if (map > 105) {
                mapCohNivel = 'alerta';
                mapCohIcon = '⚠️';
                mapCohStatus = `Carga alta: MAP ${map.toFixed(0)} kPa com ${carga.toFixed(0)}% carga — MAP alta demais`;
            } else {
                mapCohStatus = `Carga: MAP ${map.toFixed(0)} kPa, carga ${carga.toFixed(0)}% — coerente`;
            }
        } else {
            mapCohStatus = `MAP ${map.toFixed(0)} kPa, carga ${carga.toFixed(0)}% — intermediário`;
        }

        if (mapCohNivel !== 'ok') {
            tests.push({
                nivel: mapCohNivel, icon: mapCohIcon,
                titulo: 'Coerência MAP × Carga',
                detalhe: mapCohStatus,
                recomendacao: 'Sensor MAP pode estar descalibrado. Verifique com multímetro ou substitua.'
            });
        }
    }

    // ============================================================
    // CRUZAMENTO 6: IAT vs Temperatura Ambiente
    // ============================================================
    if (iat > 0 && tempAmb > -20) {
        const diffIatAmb = iat - tempAmb;
        let iatNivel = 'ok';
        let iatIcon = '✅';
        let iatStatus = '';
        let iatRecomendacao = '';

        if (diffIatAmb > 25) {
            iatNivel = 'alerta';
            iatIcon = '⚠️';
            iatStatus = `Ar muito quente (${iat.toFixed(1)}°C vs ${tempAmb.toFixed(1)}°C) — Δ${diffIatAmb.toFixed(0)}°C`;
            iatRecomendacao = 'Verifique intercooler e dutos de admissão.';
        } else if (diffIatAmb < -10) {
            iatNivel = 'alerta';
            iatIcon = '⚠️';
            iatStatus = `Ar mais frio que ambiente (${iat.toFixed(1)}°C vs ${tempAmb.toFixed(1)}°C)`;
            iatRecomendacao = 'Sensor IAT pode estar descalibrado.';
        } else {
            iatStatus = `Normal (${iat.toFixed(1)}°C vs ${tempAmb.toFixed(1)}°C, Δ${diffIatAmb.toFixed(0)}°C)`;
            iatRecomendacao = 'Sensor IAT operando corretamente.';
        }

        if (iatNivel !== 'ok') {
            tests.push({
                nivel: iatNivel, icon: iatIcon,
                titulo: 'IAT × Ambiente',
                detalhe: iatStatus,
                recomendacao: iatRecomendacao
            });
        }
    }

    // ============================================================
    // CRUZAMENTO 7: Pressão de Combustível
    // ============================================================
    if (fuelPress > 0) {
        let fpNivel = 'ok';
        let fpIcon = '✅';
        let fpStatus = '';
        let fpRecomendacao = '';

        if (fuelPress < 200) {
            fpNivel = 'critico';
            fpIcon = '🚨';
            fpStatus = `Pressão MUITO BAIXA: ${fuelPress.toFixed(0)} kPa (mínimo: 300)`;
            fpRecomendacao = 'Bomba de combustível com defeito ou filtro completamente entupido. Substitua urgentemente.';
        } else if (fuelPress < 250) {
            fpNivel = 'critico';
            fpIcon = '❌';
            fpStatus = `Pressão BAIXA: ${fuelPress.toFixed(0)} kPa (mínimo: 300)`;
            fpRecomendacao = 'Filtro de combustível entupido ou bomba fraca. Verifique filtro primeiro.';
        } else if (fuelPress < 300) {
            fpNivel = 'alerta';
            fpIcon = '⚠️';
            fpStatus = `Pressão abaixo do ideal: ${fuelPress.toFixed(0)} kPa`;
            fpRecomendacao = 'Possível filtro sujo ou bomba desgastada. Monitore.';
        } else if (fuelPress > 500) {
            fpNivel = 'critico';
            fpIcon = '🚨';
            fpStatus = `Pressão ALTA: ${fuelPress.toFixed(0)} kPa (máximo: 450)`;
            fpRecomendacao = 'Regulador de pressão travado ou retorno bloqueado.';
        } else if (fuelPress > 450) {
            fpNivel = 'alerta';
            fpIcon = '⚠️';
            fpStatus = `Pressão elevada: ${fuelPress.toFixed(0)} kPa`;
            fpRecomendacao = 'Verificar regulador de pressão.';
        } else {
            fpStatus = `Pressão OK: ${fuelPress.toFixed(0)} kPa (faixa: 300-450)`;
            fpRecomendacao = 'Sistema de combustível operando corretamente.';
        }

        tests.push({
            nivel: fpNivel, icon: fpIcon,
            titulo: `Pressão Combustível: ${fpStatus.split(':')[0]}`,
            detalhe: fpStatus,
            recomendacao: fpRecomendacao
        });
    }

    // ============================================================
    // MAF Status (for vehicles that have it)
    // ============================================================
    if (!pidSupport.maf) {
        tests.push({
            nivel: 'info', icon: 'ℹ️',
            titulo: 'Sensor MAF — Não disponível',
            detalhe: 'Veículo usa speed-density (MAP + RPM + IAT). O cálculo de ar é feito pelo MAP.',
            recomendacao: 'Este teste não se aplica. O MAP é o sensor principal de ar.'
        });
    }

    // ============================================================
    // Render results
    // ============================================================
    if (tests.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:10px; color:#94a3b8; font-size:11px;">Coletando dados dos sensores...</div>';
        return;
    }

    const nivelOrder = { critico: 0, alerta: 1, ok: 2, info: 3 };
    tests.sort((a, b) => nivelOrder[a.nivel] - nivelOrder[b.nivel]);

    // Build summary bar
    const critCount = tests.filter(t => t.nivel === 'critico').length;
    const alertCount = tests.filter(t => t.nivel === 'alerta').length;
    const okCount = tests.filter(t => t.nivel === 'ok').length;

    let summaryBg = 'rgba(34,197,94,0.1)';
    let summaryBorder = 'rgba(34,197,94,0.3)';
    let summaryText = `${okCount} OK`;
    if (critCount > 0) {
        summaryBg = 'rgba(239,68,68,0.15)';
        summaryBorder = 'rgba(239,68,68,0.4)';
        summaryText = `${critCount} CRÍTICO${critCount > 1 ? 'S' : ''}`;
    } else if (alertCount > 0) {
        summaryBg = 'rgba(251,191,36,0.1)';
        summaryBorder = 'rgba(251,191,36,0.3)';
        summaryText = `${alertCount} ALERTA${alertCount > 1 ? 'S' : ''}`;
    }

    container.innerHTML = `
        <div style="font-size:10px; color:var(--accent); text-transform:uppercase; font-weight:800; letter-spacing:1px; margin-bottom:12px;">🔬 Análise Cruzada dos Sensores</div>
        <div style="background:${summaryBg}; border:1px solid ${summaryBorder}; border-radius:8px; padding:10px; margin-bottom:12px; text-align:center; font-size:11px; font-weight:700; color:#e2e8f0;">
            ${summaryText} | ${tests.length} testes executados
            ${diagnosticoFinal ? `<div style="font-size:10px; color:var(--accent); margin-top:4px;">Diagnóstico: ${diagnosticoFinal}</div>` : ''}
        </div>
        ${tests.map(t => {
            const cor = t.nivel === 'critico' ? 'var(--danger)' : t.nivel === 'alerta' ? 'var(--warning)' : t.nivel === 'ok' ? 'var(--success)' : '#64748b';
            const bg = t.nivel === 'critico' ? 'rgba(239,68,68,0.1)' : t.nivel === 'alerta' ? 'rgba(251,191,36,0.1)' : t.nivel === 'ok' ? 'rgba(34,197,94,0.05)' : 'rgba(100,116,139,0.05)';
            return `
                <div style="background:${bg}; border:1px solid ${cor}30; border-radius:10px; padding:12px; margin-bottom:8px;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                        <span style="font-size:1.2rem;">${t.icon}</span>
                        <span style="font-size:11px; font-weight:800; color:${cor}; text-transform:uppercase;">${t.titulo}</span>
                    </div>
                    <div style="font-size:11px; color:#e2e8f0; margin-bottom:6px;">${t.detalhe}</div>
                    <div style="font-size:10px; color:#94a3b8; font-style:italic;">💡 ${t.recomendacao}</div>
                </div>
            `;
        }).join('')}
    `;
}

let nivelCombustivelAnterior = null;
let detectandoAbastecimento = false;
let _sensorLogCount = 0;

// ==========================================
// RENDER TICK — desacopla aquisição de renderização.
// Antes, cada resposta OBD reconstruía o DOM inteiro (31 sensores + diag +
// qualidade + histórico de anomalias) na main thread, saturando a UI e
// atrasando o parser. Agora a aquisição só atualiza o modelo e marca "sujo";
// o repaint roda no máximo a cada RENDER_INTERVAL_MS via requestAnimationFrame.
// ==========================================
const RenderTick = {
    INTERVAL_MS: 250, // ~4 Hz
    _dirty: false,
    _last: 0,
    _raf: null,
    marcar() {
        this._dirty = true;
        if (this._raf === null && typeof requestAnimationFrame === 'function') {
            this._raf = requestAnimationFrame(() => this._tick());
        }
    },
    _tick() {
        this._raf = null;
        const agora = performance.now();
        if (this._dirty && agora - this._last >= this.INTERVAL_MS) {
            this._dirty = false;
            this._last = agora;
            renderizarTudo();
        }
        if (this._dirty) {
            this._raf = requestAnimationFrame(() => this._tick());
        }
    }
};

let _lastRenderDiag = -1e12;
let _lastRenderQual = -1e12;
let _lastRenderAnlz = -1e12;
let _lastRenderMs = 0;

function renderizarTudo() {
    const t0 = performance.now();
    // Blocos independentes: um erro em um não trava os demais nem o tick.
    try { atualizarPainelConsumo(); } catch (e) { AGXLogger.error('render.painel', e.message); }
    try { renderizarSensores(); } catch (e) { AGXLogger.error('render.sensores', e.message); }

    // Diagnóstico/qualidade/análise são pesados (reconstroem HTML) → cadência menor.
    if (t0 - _lastRenderDiag >= 1000) {
        _lastRenderDiag = t0;
        try { renderizarDiagnostico(); } catch (e) { AGXLogger.error('render.diag', e.message); }
    }
    if (t0 - _lastRenderQual >= 3000) {
        _lastRenderQual = t0;
        try { renderizarQualidadeCombustivel(); } catch (e) { AGXLogger.error('render.qual', e.message); }
    }
    if (t0 - _lastRenderAnlz >= 1500) {
        _lastRenderAnlz = t0;
        try { analyzeSensorDiagnostics(); } catch (e) { AGXLogger.error('render.analise', e.message); }
    }

    _lastRenderMs = performance.now() - t0;
    if (_lastRenderMs > 120) AGXLogger.log('RENDER_SLOW', `render ${_lastRenderMs.toFixed(0)}ms`);
}

function simularDadosOBD() {
    if (!modoSimulacao) return;

    const kmAtual = (typeof getKmAtual === 'function' ? getKmAtual() : parseInt(localStorage.getItem("car_km"))) || 80000;
    const fatorDesgaste = Math.min(1, kmAtual / 300000);

    leiturasOBD.rpm = 750 + Math.random() * 500 + (Math.random() > 0.92 ? Math.random() * 3000 : 0);
    leiturasOBD.velocidade = Math.max(0, (leiturasOBD.rpm - 800) * 0.04 + (Math.random() - 0.5) * 20);
    leiturasOBD.tempMotor = 82 + Math.random() * 18 + fatorDesgaste * 8 + (Math.random() > 0.95 ? 15 : 0);
    leiturasOBD.tensaoBateria = 13.2 + Math.random() * 1.2 - fatorDesgaste * 0.8 + (Math.random() > 0.93 ? -2 : 0);
    leiturasOBD.cargaMotor = Math.min(100, Math.max(10, (leiturasOBD.rpm / 8000) * 100 + Math.random() * 15));
    leiturasOBD.posAcelerador = Math.min(100, Math.max(0, (leiturasOBD.rpm - 750) / 60 + Math.random() * 5));
    leiturasOBD.tempArAdmissao = 25 + Math.random() * 15 + (leiturasOBD.cargaMotor > 60 ? 10 : 0);
    leiturasOBD.pressaoMAP = 25 + Math.random() * 75 * (leiturasOBD.cargaMotor / 100);
    leiturasOBD.nivelO2 = 0.1 + Math.random() * 0.9;
    leiturasOBD.pontoIgnicao = 8 + Math.random() * 12 + (leiturasOBD.tempMotor > 95 ? 3 : 0);
    leiturasOBD.statusCombustivel = leiturasOBD.tensaoBateria < 11.5 ? 'Fraco' : leiturasOBD.tensaoBateria > 14.8 ? 'Sobrecarga' : 'Normal';

    leiturasOBD.fuelTrimSTFT = (Math.random() - 0.4) * 20 + (fatorDesgaste * 5);
    leiturasOBD.fuelTrimLTFT = (Math.random() - 0.4) * 15 + (fatorDesgaste * 8);
    leiturasOBD.pressaoCombustivel = 300 + Math.random() * 100 - (fatorDesgaste * 50) + (leiturasOBD.cargaMotor > 60 ? 50 : 0);
    leiturasOBD.tempPosCatalisador = leiturasOBD.tempMotor + 100 + Math.random() * 200 + (leiturasOBD.cargaMotor > 50 ? 100 : 0);
    leiturasOBD.tempAmbiente = 20 + Math.random() * 15;

    leiturasOBD.maf = 2 + (leiturasOBD.cargaMotor / 100) * 40 + (leiturasOBD.rpm / 8000) * 20 + Math.random() * 5;
    leiturasOBD.etanolPercent = Math.random() > 0.5 ? 27 : 85;
    leiturasOBD.tempOleo = 75 + Math.random() * 25 + fatorDesgaste * 10 + (leiturasOBD.cargaMotor > 70 ? 15 : 0);
    leiturasOBD.consumoRealLh = 1 + (leiturasOBD.cargaMotor / 100) * 8 + (leiturasOBD.rpm / 8000) * 5 + Math.random() * 2;
    leiturasOBD.pressaoBarometrica = 98 + Math.random() * 6;
    leiturasOBD.tempCatalisador = 300 + Math.random() * 400 + (leiturasOBD.cargaMotor > 50 ? 150 : 0);
    leiturasOBD.torqueSolicitado = Math.min(100, Math.max(0, (leiturasOBD.cargaMotor * 0.9) + (Math.random() - 0.5) * 10));
    leiturasOBD.torqueReal = Math.min(100, Math.max(0, leiturasOBD.torqueSolicitado - 5 + (Math.random() - 0.5) * 8));

    const baseConsumo = 2 + (leiturasOBD.cargaMotor / 100) * 6 + (leiturasOBD.rpm / 8000) * 3;
    leiturasOBD.consumoEsperado = Math.max(1.5, baseConsumo);
    leiturasOBD.consumoInstantaneo = leiturasOBD.consumoEsperado + (Math.random() - 0.3) * 3 + (fatorDesgaste * 2) + (Math.abs(leiturasOBD.fuelTrimLTFT) > 10 ? 1.5 : 0);

    const rpmEsperado = leiturasOBD.velocidade > 5 ? (leiturasOBD.velocidade * 30 + 800) : 800;
    const baseClutch = leiturasOBD.velocidade > 10 ? Math.max(0, ((leiturasOBD.rpm - rpmEsperado) / rpmEsperado) * 100) : 0;
    leiturasOBD.deslizamentoEmbreagem = Math.min(30, baseClutch + (Math.random() > 0.95 ? 15 + Math.random() * 10 : Math.random() * 2));

    const consumoLh = leiturasOBD.consumoInstantaneo;
    const tanqueCap = parseInt(localStorage.getItem("car_tanque_capacidade")) || 50;
    const consumoPercentual = (consumoLh / 3600) * (1 / tanqueCap) * 100;
    leiturasOBD.nivelCombustivel = Math.max(0, leiturasOBD.nivelCombustivel - consumoPercentual);

    if (leiturasOBD.nivelCombustivel < 10 && Math.random() > 0.7) {
        leiturasOBD.nivelCombustivel = 60 + Math.random() * 30;
        detectarAbastecimento(nivelCombustivelAnterior, leiturasOBD.nivelCombustivel);
    }
    nivelCombustivelAnterior = leiturasOBD.nivelCombustivel;

    const elTempHeader = document.getElementById('temp-value');
    const elVoltHeader = document.getElementById('volt-value');
    if (elTempHeader) elTempHeader.innerText = leiturasOBD.tempMotor.toFixed(1) + '°C';
    if (elVoltHeader) elVoltHeader.innerText = leiturasOBD.tensaoBateria.toFixed(1) + 'V';

    const elLiters = document.getElementById('val-liters');
    const litrosRestante = ((leiturasOBD.nivelCombustivel / 100) * tanqueCap).toFixed(1);
    if (elLiters) elLiters.innerText = litrosRestante;

    const rpmEl = document.getElementById('rpm-num');
    if (rpmEl) rpmEl.innerText = Math.round(leiturasOBD.rpm);
    const rpmFill = document.getElementById('rpm-fill');
    if (rpmFill) {
        const pct = (leiturasOBD.rpm / 8000) * 314;
        rpmFill.style.strokeDasharray = `${pct} 314`;
    }

    atualizarAcumuladores();
    addSensorHistory();
    RenderTick.marcar();

    if (++_sensorLogCount % 10 === 0) {
        AGXLogger.sensorReadings({
            rpm: Math.round(leiturasOBD.rpm),
            temp: Math.round(leiturasOBD.tempMotor),
            fuel: Math.round(leiturasOBD.nivelCombustivel),
            volt: leiturasOBD.tensaoBateria.toFixed(1),
            speed: Math.round(leiturasOBD.velocidade),
            load: Math.round(leiturasOBD.cargaMotor)
        });
    }
}

function editarOdometro() {
    const atual = parseInt(localStorage.getItem("car_km")) || 0;
    const novo = prompt("Digite a quilometragem atual do veículo:", atual);
    if (novo !== null && !isNaN(novo) && parseInt(novo) > 0) {
        const kmNovo = parseInt(novo);
        localStorage.setItem("car_km", kmNovo);
        localStorage.setItem("car_ultima_data", new Date().toISOString().split('T')[0]);

        if (typeof getVeiculos === 'function') {
            const vehicles = getVeiculos();
            const idx = getIdxAtivo();
            if (vehicles[idx]) {
                vehicles[idx].km = kmNovo;
                salvarVeiculos(vehicles);
            }
        }

        const odoEl = document.getElementById('txt-odometro');
        if (odoEl) odoEl.innerHTML = kmNovo.toLocaleString() + ' <span style="font-size:0.9rem;color:#aaa;">KM</span><button onclick="editarOdometro()" style="background:rgba(0,242,255,0.1);border:1px solid var(--accent);color:var(--accent);border-radius:50%;width:28px;height:28px;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;margin-left:6px;vertical-align:middle;" title="Atualizar odometro"><i class="fas fa-pen"></i></button>';
        showToast("Odômetro atualizado para " + kmNovo.toLocaleString() + " KM", "success");
        if (typeof renderizarDadosGlobais === 'function') renderizarDadosGlobais();
    }
}

function atualizarPainelConsumo() {
    const elInst = document.getElementById('val-instant');
    const elMedio = document.getElementById('val-consumo-medio');
    const elKmRest = document.getElementById('val-km-restantes');
    const vel = leiturasOBD.velocidade || 0;
    const consLh = leiturasOBD.consumoInstantaneo || 0;
    if (elInst) {
        if (consLh > 0 && vel > 5) {
            const kmL = vel / consLh;
            elInst.innerHTML = `${kmL.toFixed(1)} <small style="font-size:10px">km/L</small>`;
        } else if (consLh > 0) {
            elInst.innerHTML = `${consLh.toFixed(1)} <small style="font-size:10px">L/h</small>`;
        } else {
            elInst.innerHTML = `-- <small style="font-size:10px">km/L</small>`;
        }
    }
    if (elMedio) {
        let kmLitro = calcularKmPorLitro();
        elMedio.innerHTML = kmLitro ? `${kmLitro} <small style="font-size:10px">km/L</small>` : `-- <small style="font-size:10px">km/L</small>`;
    }
    if (elKmRest) {
        const tanqueCap = (typeof getTanqueCapacidade === 'function') ? getTanqueCapacidade() : (parseInt(localStorage.getItem("car_tanque_capacidade")) || 50);
        const nivel = leiturasOBD.nivelCombustivel || 0;
        const litrosRestante = (nivel / 100) * tanqueCap;
        let kmLitro = calcularKmPorLitro();
        if (tanqueCap > 0 && litrosRestante > 0 && kmLitro > 0) {
            const kmRest = Math.round(litrosRestante * parseFloat(kmLitro));
            elKmRest.innerHTML = `${kmRest.toLocaleString()} <small style="font-size:10px">km</small>`;
        } else {
            elKmRest.innerHTML = `-- <small style="font-size:10px">km</small>`;
        }
    }
}

async function conectarVeiculoReal() {
    if ('serial' in navigator) {
        try {
            port = await navigator.serial.requestPort();
            await port.open({ baudRate: 115200 });

            modoSimulacao = false;
            tipoConexao = 'serial';
            atualizarBadgeconexao();

            const btnConnect = document.getElementById('btn-conectar-carro');
            if (btnConnect) {
                btnConnect.innerText = "CONECTADO";
                btnConnect.style.background = "var(--success)";
                btnConnect.style.color = "#000";
            }

            const badge = document.querySelector('.header-stats .stat-mini:nth-child(2)');
            if (badge) {
                badge.innerHTML = '<i class="fas fa-satellite-dish"></i> Conectado';
                badge.style.borderColor = "var(--success)";
                badge.style.color = "var(--success)";
            }

            clearInterval(simulationIntervalId);

            const textEncoder = new TextEncoderStream();
            textEncoder.readable.pipeTo(port.writable);
            writer = textEncoder.writable.getWriter();

            const textDecoder = new TextDecoderStream();
            port.readable.pipeTo(textDecoder.writable);
            reader = textDecoder.readable.getReader();

            console.log("Conectado à porta serial.");
            AGXLogger.serialConnect("Conectado à porta serial", { baudRate: 115200 });
            noDataCount = 0;
            Object.keys(pidFailures).forEach(k => delete pidFailures[k]);
            Object.keys(pidSupport).forEach(k => pidSupport[k] = true);
            Object.keys(pidUnsupported).forEach(k => delete pidUnsupported[k]);
            _scanNoDataShown = false;
            _ultimoReinitElm = 0;

            await inicializarPainelReal();

            document.getElementById('btn-obd-sim').classList.remove('active');
            document.getElementById('btn-obd-real').classList.add('active');
            const obdModeStat = document.querySelector('.header-stats .stat-mini:nth-child(2)');
            if (obdModeStat) obdModeStat.innerHTML = '<i class="fas fa-satellite-dish"></i> Conectado';
            const connectButton = document.getElementById('btn-conectar-carro');
            if (connectButton) connectButton.classList.add('hidden');

        } catch (error) {
            console.error("Erro ao conectar ou configurar a porta serial:", error);
            alert("Erro ao conectar ao ELM327: " + error.message);
            modoSimulacao = true;
            tipoConexao = null;
            atualizarBadgeconexao();
            iniciarSimulacao();
            const btnConnect = document.getElementById('btn-conectar-carro');
            if (btnConnect) {
                btnConnect.innerText = "CONECTAR AO CARRO (ELM327)";
                btnConnect.style.background = "";
                btnConnect.style.color = "";
                btnConnect.classList.remove('hidden');
            }
            const obdModeStat = document.querySelector('.header-stats .stat-mini:nth-child(2)');
            if (obdModeStat) {
                obdModeStat.innerHTML = '<i class="fas fa-satellite-dish"></i> Simulado';
                obdModeStat.style.borderColor = "";
                obdModeStat.style.color = "";
            }
            document.getElementById('btn-obd-sim').classList.add('active');
            document.getElementById('btn-obd-real').classList.remove('active');
        }
    } else {
        alert("Seu navegador não suporta a Web Serial API. Por favor, use Chrome ou Edge.");
    }
}

// --- CONEXÃO BLUETOOTH (Web Bluetooth API) ---
const ELM327_BLE_PROFILES = [
    { name: 'Clones baratos (FFF0)', service: '0000fff0-0000-1000-8000-00805f9b34fb', rx: '0000fff1-0000-1000-8000-00805f9b34fb', tx: '0000fff2-0000-1000-8000-00805f9b34fb' },
    { name: 'vLinker / genéricos (18F0)', service: '000018f0-0000-1000-8000-00805f9b34fb', rx: '00002af0-0000-1000-8000-00805f9b34fb', tx: '00002af1-0000-1000-8000-00805f9b34fb' },
    { name: 'HC-05/HC-06 SPP (FFE0)', service: '0000ffe0-0000-1000-8000-00805f9b34fb', rx: '0000ffe1-0000-1000-8000-00805f9b34fb', tx: '0000ffe1-0000-1000-8000-00805f9b34fb' }
];

const ELM327_ALL_OPTIONAL_SERVICES = ELM327_BLE_PROFILES.map(p => p.service);

async function conectarVeiculoAuto() {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    if (isMobile && navigator.bluetooth) {
        await conectarVeiculoBluetooth();
    } else if ('serial' in navigator) {
        await conectarVeiculoReal();
    } else if (navigator.bluetooth) {
        await conectarVeiculoBluetooth();
    } else {
        showToast("Navegador não suporta conexão OBD2. Use Chrome.", "error");
    }
}

async function conectarVeiculoBluetooth() {
    if (!navigator.bluetooth) {
        showToast("Seu navegador não suporta Web Bluetooth. Use Chrome Android.", "error");
        return;
    }

    try {
        showToast("Procurando dispositivos BLE (OBD2/ELM327)...", "info");

        const device = await navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: 'ELM' },
                { namePrefix: 'OBD' },
                { namePrefix: 'Vlink' },
                { namePrefix: 'Vgate' },
                { namePrefix: 'BLED' },
                { namePrefix: 'BLU' }
            ],
            optionalServices: ELM327_ALL_OPTIONAL_SERVICES
        });

        bleDevice = device;
        showToast("Conectando ao dispositivo...", "info");

        device.addEventListener('gattserverdisconnected', onBleDisconnect);

        const server = await device.gatt.connect();

        let connected = false;
        for (const profile of ELM327_BLE_PROFILES) {
            try {
                const service = await server.getPrimaryService(profile.service);
                bleCharacteristic = await service.getCharacteristic(profile.rx);
                try {
                    bleTxCharacteristic = await service.getCharacteristic(profile.tx);
                } catch (e) {
                    bleTxCharacteristic = bleCharacteristic;
                }
                connected = true;
                bleWriteType = bleTxCharacteristic.properties.writeWithoutResponse ? 'writeWithoutResponse' : 'write';
                console.log(`Conectado via UUID: ${profile.name} | Write type: ${bleWriteType}`);
                AGXLogger.bleConnect(`Conectado via ${profile.name}`, { uuid: profile.uuid, writeType: bleWriteType });
                noDataCount = 0;
                Object.keys(pidFailures).forEach(k => delete pidFailures[k]);
                Object.keys(pidSupport).forEach(k => pidSupport[k] = true);
                Object.keys(pidUnsupported).forEach(k => delete pidUnsupported[k]);
                _scanNoDataShown = false;
                _ultimoReinitElm = 0;
                bleDataCount = 0;
                break;
            } catch (e) {
                console.log(`UUID ${profile.name} não encontrado, tentando próximo...`);
            }
        }

        if (!connected) {
            throw new Error("Nenhum serviço BLE compatível encontrado no dispositivo.");
        }

        modoSimulacao = false;
        tipoConexao = 'ble';
        atualizarBadgeconexao();

        clearInterval(simulationIntervalId);

        await bleCharacteristic.startNotifications();
        bleCharacteristic.addEventListener('characteristicvaluechanged', onBleNotification);

        showToast("Bluetooth conectado! Inicializando ELM327...", "success");

        atualizarUIConectado();

        await inicializarPainelReal();

    } catch (error) {
        console.error("Erro na conexão Bluetooth:", error);
        AGXLogger.bleError(`Erro na conexão Bluetooth: ${error.message}`, { name: error.name });
        if (error.name === 'NotFoundError') {
            showToast("Nenhum dispositivo selecionado.", "warning");
        } else {
            showToast("Erro ao conectar Bluetooth: " + error.message, "error");
        }
        modoSimulacao = true;
        tipoConexao = null;
        bleCharacteristic = null;
        bleTxCharacteristic = null;
        atualizarBadgeconexao();
        iniciarSimulacao();
        atualizarUIDesconectado();
    }
}

function onBleNotification(event) {
    const decoder = new TextDecoder();
    const value = decoder.decode(event.target.value);
    bleBuffer += value;

    if (bleBuffer.includes(">")) {
        const resposta = bleBuffer;
        bleBuffer = '';
        bleDataCount++;
        console.log(`[BLE #${bleDataCount}] Recebido:`, resposta.trim());
        AGXLogger.log('BLE_DATA', `#${bleDataCount}: ${resposta.trim()}`);

        if (bleDataCount === 1) {
            showToast("Primeira resposta do ELM327 recebida!", "success");
        }

        if (elmPromptResolve) elmPromptResolve();
        const pidCtx = lastPidSent;
        // try/catch: um erro de parse não pode escapar do handler de notificação
        // (evita erros "uncaught" e mantém o laço de leitura sempre vivo).
        try {
            parseObdResponse(resposta, pidCtx);
        } catch (e) {
            console.error("Erro ao processar resposta BLE:", e);
            if (typeof AGXLogger !== 'undefined') AGXLogger.log('PARSE_ERROR', `BLE parse falhou: ${e && e.message}`);
        }
    }
}

function onBleDisconnect() {
    // Evita execução dupla: desconectarVeiculo() chama onBleDisconnect() direto E
    // gatt.disconnect() dispara 'gattserverdisconnected' → onBleDisconnect de novo.
    if (tipoConexao === null && modoSimulacao) {
        _desconexaoManual = false;
        return;
    }
    console.log("Dispositivo Bluetooth desconectado.");
    const manual = _desconexaoManual;
    _desconexaoManual = false;
    const estavaConectado = (tipoConexao !== null) || !modoSimulacao;
    AGXLogger.bleDisconnect("Dispositivo Bluetooth desconectado", { manual });

    modoSimulacao = true;
    tipoConexao = null;
    bleCharacteristic = null;
    bleTxCharacteristic = null;
    bleDevice = null;
    atualizarBadgeconexao();
    if (pollingTelemetriaId) { clearInterval(pollingTelemetriaId); pollingTelemetriaId = null; }
    iniciarSimulacao();
    atualizarUIDesconectado();

    if (estavaConectado && !manual) {
        AGXLogger.log('CONEXAO_PERDIDA', 'Conexão OBD perdida inesperadamente — modo SIMULADO ativado (dados NÃO são reais)');
        showToast("⚠️ CONEXÃO PERDIDA — agora exibindo DADOS SIMULADOS (não reais). Reconecte para voltar ao real.", "danger", 9000);
    } else if (manual) {
        showToast("Desconectado. Modo simulado ativado.", "info");
    }
}

function desconectarVeiculo() {
    _desconexaoManual = true;
    if (tipoConexao === 'ble' && bleDevice) {
        bleDevice.gatt.disconnect();
    } else if (tipoConexao === 'serial' && port) {
        port.close();
    }
    onBleDisconnect();
}

function atualizarUIConectado() {
    const btnConnect = document.getElementById('btn-conectar-carro');
    if (btnConnect) {
        btnConnect.innerText = "CONECTADO";
        btnConnect.style.background = "var(--success)";
        btnConnect.style.color = "#000";
    }
    const btnDisconnect = document.getElementById('btn-desconectar-carro');
    if (btnDisconnect) btnDisconnect.classList.remove('hidden');
    const badge = document.querySelector('.header-stats .stat-mini:nth-child(2)');
    if (badge) {
        badge.innerHTML = '<i class="fas fa-satellite-dish"></i> Conectado';
        badge.style.borderColor = "var(--success)";
        badge.style.color = "var(--success)";
    }
    document.getElementById('btn-obd-sim').classList.remove('active');
    document.getElementById('btn-obd-real').classList.add('active');
    const connectButton = document.getElementById('btn-conectar-carro');
    if (connectButton) connectButton.classList.add('hidden');
}

function atualizarUIDesconectado() {
    const btnConnect = document.getElementById('btn-conectar-carro');
    if (btnConnect) {
        btnConnect.innerText = "CONECTAR AO CARRO (ELM327)";
        btnConnect.style.background = "";
        btnConnect.style.color = "";
        btnConnect.classList.remove('hidden');
    }
    const btnDisconnect = document.getElementById('btn-desconectar-carro');
    if (btnDisconnect) btnDisconnect.classList.add('hidden');
    const obdModeStat = document.querySelector('.header-stats .stat-mini:nth-child(2)');
    if (obdModeStat) {
        obdModeStat.innerHTML = '<i class="fas fa-satellite-dish"></i> Simulado';
        obdModeStat.style.borderColor = "";
        obdModeStat.style.color = "";
    }
    document.getElementById('btn-obd-sim').classList.add('active');
    document.getElementById('btn-obd-real').classList.remove('active');
}

async function inicializarPainelReal() {
    const delay = ms => new Promise(res => setTimeout(res, ms));
    const isBle = tipoConexao === 'ble';
    const baseDelay = isBle ? 500 : 200;
    try {
        modoSimulacao = false;
        atualizarBadgeconexao();
        clearInterval(simulationIntervalId);
        if (pollingTelemetriaId) { clearInterval(pollingTelemetriaId); pollingTelemetriaId = null; }

        await sendElmCommand("ATD"); await delay(baseDelay);
        await sendElmCommand("ATZ"); await delay(isBle ? 2000 : 1000);
        await sendElmCommand("ATE0"); await delay(baseDelay);
        await sendElmCommand("ATL0"); await delay(baseDelay);
        await sendElmCommand("ATS0"); await delay(baseDelay);
        await sendElmCommand("ATH0"); await delay(baseDelay);
        await sendElmCommand("ATAT1"); await delay(baseDelay);
        await sendElmCommand("ATSP0"); await delay(isBle ? 1000 : 500);
        try { await sendElmCommand("ATST64"); await delay(baseDelay); } catch(e) {}

        if (tipoConexao === 'serial') {
            readLoop();
        }

        try { await sendElmCommand("0902"); await delay(800); } catch(e) { console.error("Falha VIN:", e); }
        try { await sendElmCommand("01A6"); await delay(500); } catch(e) { console.error("Falha Odo:", e); }

        iniciarPollingLoop();
    } catch(e) { console.error("Erro na inicialização:", e); }
}

let elmPromptResolve = null;
let elmCommandQueue = [];
let elmProcessing = false;

function waitForElmPrompt(timeoutMs = tipoConexao === 'ble' ? 3000 : 2000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            elmPromptResolve = null;
            resolve(false);
        }, timeoutMs);
        elmPromptResolve = () => {
            clearTimeout(timer);
            elmPromptResolve = null;
            resolve(true);
        };
    });
}

async function sendElmCommand(command) {
    // Track last PID sent for NO DATA detection
    if (command.startsWith('01') || command.startsWith('09')) {
        lastPidSent = command.substring(0, 4);
    } else {
        lastPidSent = null;
    }

    if (tipoConexao === 'ble') {
        const txChar = bleTxCharacteristic || bleCharacteristic;
        if (!txChar) {
            console.error("Characteristic BLE não disponível.");
            return;
        }
        if (elmProcessing) {
            if (elmCommandQueue.length >= 32) elmCommandQueue.shift();
            elmCommandQueue.push(command);
            return;
        }
        elmProcessing = true;
        try {
            console.log("Enviando BLE:", command);
            AGXLogger.log('ELM_SEND', `BLE: ${command}`);
            const encoder = new TextEncoder();
            const data = encoder.encode(command + "\r");
            if (bleWriteType === 'writeWithoutResponse') {
                await txChar.writeValueWithoutResponse(data);
            } else {
                await txChar.writeValueWithResponse(data);
            }
            await waitForElmPrompt();
        } catch (e) {
            console.error("Erro ao enviar comando BLE:", e);
            AGXLogger.elmError(command, e.message);
        } finally {
            elmProcessing = false;
            if (elmCommandQueue.length > 0 && !modoSimulacao) {
                const next = elmCommandQueue.shift();
                await sendElmCommand(next);
            }
        }
        return;
    }

    if (tipoConexao === 'serial') {
        if (!writer) {
            console.error("Writer da porta serial não disponível.");
            return;
        }
        if (elmProcessing) {
            if (elmCommandQueue.length >= 32) elmCommandQueue.shift();
            elmCommandQueue.push(command);
            return;
        }
        elmProcessing = true;
        try {
            console.log("Enviando Serial:", command);
            AGXLogger.log('ELM_SEND', `Serial: ${command}`);
            await writer.write(command + "\r");
            await waitForElmPrompt();
        } catch (e) {
            console.error("Erro ao enviar comando serial:", e);
            AGXLogger.elmError(command, e.message);
        } finally {
            elmProcessing = false;
            if (elmCommandQueue.length > 0 && !modoSimulacao) {
                const next = elmCommandQueue.shift();
                await sendElmCommand(next);
            }
        }
    }
}

// ==========================================
// SCHEDULER DE POLLING — um único laço serializado (1 comando em voo).
// Substitui o setInterval anterior, que disparava um novo ciclo a cada
// 12s/6s mesmo com o ciclo anterior em andamento (ciclos sobrepostos →
// fila estourava → comandos eram descartados → leituras "travavam").
// PIDs rápidos a cada ciclo; médios a cada 2; odômetro a cada 10.
// ==========================================
let _pollingAtivo = false;
const PIDS_RAPIDOS = ["010C","010D","0104","0105","0142","010F","0111","012F"];
const PIDS_MEDIOS  = ["0106","0107","010B","010A","010E","0101","0103","0121","014D","014E","0114","0115","0116","0117","0146","0110","0152","015C","015E","0133","013C","0161","0162"];
const PID_ODOMETRO = "01A6";

async function iniciarPollingLoop() {
    if (_pollingAtivo) return;
    _pollingAtivo = true;
    let ciclo = 0;
    try {
        while (!modoSimulacao && (tipoConexao === 'ble' || tipoConexao === 'serial')) {
            const tCiclo = performance.now();
            for (const cmd of PIDS_RAPIDOS) {
                if (modoSimulacao) return;
                if (pidUnsupported[cmd]) continue;
                await sendElmCommand(cmd);
                await new Promise(r => setTimeout(r, 40));
            }
            if (ciclo % 2 === 1) {
                for (const cmd of PIDS_MEDIOS) {
                    if (modoSimulacao) return;
                    if (pidUnsupported[cmd]) continue;
                    await sendElmCommand(cmd);
                    await new Promise(r => setTimeout(r, 40));
                }
            }
            if (ciclo % 10 === 0 && !pidUnsupported[PID_ODOMETRO]) {
                await sendElmCommand(PID_ODOMETRO);
            }
            _logPollHeartbeat(ciclo, performance.now() - tCiclo);
            ciclo++;
        }
    } finally {
        _pollingAtivo = false;
    }
}

// Heartbeat compacto: série temporal leve para diagnosticar travas/desconexões em campo.
function _logPollHeartbeat(ciclo, durMs) {
    if (ciclo % 2 !== 0) return; // ~1 amostra a cada 2 ciclos
    AGXLogger.log('POLL', `ciclo ${ciclo} em ${durMs.toFixed(0)}ms`, {
        ciclo,
        durMs: Math.round(durMs),
        rpm: Math.round(leiturasOBD.rpm),
        vel: Math.round(leiturasOBD.velocidade),
        noData: noDataCount,
        naoSuportados: Object.keys(pidUnsupported).length,
        queue: elmCommandQueue.length,
        renderMs: _lastRenderMs
    });
}

let _ultimoReinitElm = 0;
function _reinicializarElmLeve() {
    const agora = Date.now();
    if (agora - _ultimoReinitElm < 30000) return; // no máximo 1x a cada 30s
    _ultimoReinitElm = agora;
    try { sendElmCommand("ATSP0"); } catch (e) {}
    AGXLogger.log('ELM_REINIT', 'Reenviado ATSP0 (re-detecção de protocolo) — conexão mantida');
    if (typeof showToast === 'function') {
        showToast("Muitas respostas vazias do ELM327 — reajustando protocolo (conexão mantida).", "warning");
    }
}

async function readLoop() {
    if (tipoConexao !== 'serial' || !reader) {
        return;
    }
    while (port && port.readable && !modoSimulacao) {
        try {
            const { value, done } = await reader.read();
            if (done) {
                console.log("Leitor serial fechado.");
                break;
            }
            console.log("Recebido Serial:", value);
            if (value.includes(">")) {
                if (elmPromptResolve) elmPromptResolve();
            }
            const pidCtxSerial = lastPidSent;
            parseObdResponse(value, pidCtxSerial);
        } catch (error) {
            console.error("Erro na leitura serial:", error);
            break;
        }
    }
    if (!modoSimulacao && tipoConexao === 'serial') {
        console.log("Conexão serial perdida. Retornando ao modo de simulação.");
        AGXLogger.serialDisconnect("Conexão serial perdida");
        modoSimulacao = true;
        tipoConexao = null;
        atualizarBadgeconexao();
        if (pollingTelemetriaId) clearInterval(pollingTelemetriaId);
        iniciarSimulacao();
        atualizarUIDesconectado();
    }
}

// --- BANCO DE DADOS E AUXILIARES DTC (ESTILO TORQUE) ---
const OBDex_URL = 'https://foerbsnavi.github.io/obdex/generic.min.json';

const DICIONARIO_DTC_FALLBACK = {
    "P0300": { description: "Random/Multiple Cylinder Misfire Detected", cause: "Spark plugs, ignition coils, fuel injectors", severity: "high" },
    "P0301": { description: "Cylinder 1 Misfire Detected", cause: "Spark plug, ignition coil, injector cylinder 1", severity: "high" },
    "P0302": { description: "Cylinder 2 Misfire Detected", cause: "Spark plug, ignition coil, injector cylinder 2", severity: "high" },
    "P0303": { description: "Cylinder 3 Misfire Detected", cause: "Spark plug, ignition coil, injector cylinder 3", severity: "high" },
    "P0304": { description: "Cylinder 4 Misfire Detected", cause: "Spark plug, ignition coil, injector cylinder 4", severity: "high" },
    "P0171": { description: "System Too Lean (Bank 1)", cause: "Vacuum leak, weak fuel pump, dirty MAF", severity: "medium" },
    "P0172": { description: "System Too Rich (Bank 1)", cause: "Clogged injector, high fuel pressure, faulty MAF", severity: "medium" },
    "P0420": { description: "Catalyst System Efficiency Below Threshold (Bank 1)", cause: "Worn catalytic converter, O2 sensor", severity: "medium" },
    "P0401": { description: "Exhaust Gas Recirculation Flow Insufficient", cause: "EGR valve stuck, carbon buildup", severity: "medium" },
    "P0440": { description: "Evaporative Emission Control System Malfunction", cause: "Loose gas cap, EVAP leak", severity: "low" },
    "P0442": { description: "Evaporative Emission Control System Leak Detected (small)", cause: "Gas cap, EVAP hose leak", severity: "low" },
    "P0455": { description: "Evaporative Emission Control System Leak Detected (gross)", cause: "Missing gas cap, major EVAP leak", severity: "low" },
    "P0500": { description: "Vehicle Speed Sensor Malfunction", cause: "Speed sensor, wiring, ABS module", severity: "medium" },
    "P0505": { description: "Idle Air Control System Malfunction", cause: "IAC valve, throttle body carbon", severity: "medium" },
    "P0562": { description: "System Voltage Low", cause: "Alternator, battery, wiring", severity: "high" },
    "P0600": { description: "Serial Communication Link Malfunction", cause: "Wiring harness, ECU communication error", severity: "high" },
    "P0700": { description: "Transmission Control System Malfunction", cause: "Transmission control module, solenoids", severity: "high" },
    "P0100": { description: "Mass Air Flow Circuit Malfunction", cause: "MAF sensor, wiring, air leak", severity: "medium" },
    "P0105": { description: "Manifold Absolute Pressure/Barometric Pressure Circuit Malfunction", cause: "MAP sensor, vacuum hose, wiring", severity: "medium" },
    "P0110": { description: "Intake Air Temperature Circuit Malfunction", cause: "IAT sensor, wiring", severity: "low" },
    "P0115": { description: "Engine Coolant Temperature Circuit Malfunction", cause: "ECT sensor, wiring, thermostat", severity: "medium" },
    "P0120": { description: "Throttle/Pedal Position Sensor A Circuit Malfunction", cause: "TPS sensor, wiring, throttle body", severity: "medium" },
    "P0130": { description: "O2 Sensor Circuit Malfunction (Bank 1 Sensor 1)", cause: "O2 sensor, wiring, exhaust leak", severity: "medium" },
    "P0135": { description: "O2 Sensor Heater Circuit Malfunction (Bank 1 Sensor 1)", cause: "O2 sensor heater, wiring", severity: "medium" },
    "P0201": { description: "Injector Circuit Malfunction - Cylinder 1", cause: "Fuel injector, wiring, ECM", severity: "high" },
    "P0335": { description: "Crankshaft Position Sensor A Circuit Malfunction", cause: "CKP sensor, wiring, timing belt", severity: "high" },
    "P0340": { description: "Camshaft Position Sensor A Circuit Malfunction", cause: "CMP sensor, wiring, timing chain", severity: "high" },
    "P0400": { description: "Exhaust Gas Recirculation Flow Malfunction", cause: "EGR valve, passages blocked", severity: "medium" },
    "P0446": { description: "Evaporative Emission Control System Vent Control Malfunction", cause: "EVAP vent valve, charcoal canister", severity: "low" }
};

async function loadOBDex() {
    if (_obdexCache) return _obdexCache;
    if (_obdexLoading) return null;
    _obdexLoading = true;
    try {
        const resp = await fetch(OBDex_URL);
        if (!resp.ok) throw new Error(resp.status);
        const data = await resp.json();
        _obdexCache = {};
        for (const entry of data) {
            if (entry.code) _obdexCache[entry.code] = entry;
        }
        console.log(`[OBDex] Loaded ${Object.keys(_obdexCache).length} DTCs`);
    } catch (e) {
        console.warn('[OBDex] Failed to load, using fallback:', e.message);
        _obdexCache = DICIONARIO_DTC_FALLBACK;
    }
    _obdexLoading = false;
    return _obdexCache;
}

function obterDTCInfo(codigo) {
    const db = _obdexCache || DICIONARIO_DTC_FALLBACK;
    const entry = db[codigo];
    if (!entry) return null;
    if (entry.code) {
        return {
            code: entry.code,
            description: entry.title || entry.description || 'Código desconhecido',
            cause: entry.common_causes || entry.cause || '',
            severity: entry.severity || 'medium',
            symptoms: entry.symptoms || '',
            repair: entry.repair || '',
            affectedComponents: entry.affected_components || ''
        };
    }
    return { code: codigo, description: entry.description || 'Código não encontrado', cause: entry.cause || '', severity: entry.severity || 'medium' };
}

const obterSistemaDTC = (codigo) => {
    const prefixo = codigo[0];
    const sistemas = {
        'P': 'Trem de Força / Transmissão',
        'C': 'Chassi (ABS/Direção/Freios)',
        'B': 'Carroceria (Airbag/Ar-Condicionado)',
        'U': 'Rede de Comunicação (Módulos/CAN)'
    };
    return sistemas[prefixo] || 'Sistema Desconhecido';
};

const obterSubsistemaDTC = (codigo) => {
    if (codigo[0] !== 'P') return '';
    const char = codigo[2];
    if (['1', '2'].includes(char)) return 'Controle de Medição de Combustível e Ar (Injeção)';
    if (char === '3') return 'Sistema de Ignição ou Falha de Ignição (Misfire)';
    if (char === '4') return 'Controles Auxiliares de Emissões (Catalisador/EGR)';
    if (char === '5') return 'Controle de Velocidade e Marcha Lenta';
    if (char === '6') return 'Módulo de Controle do Computador (ECU/PCM)';
    if (['7', '8', '9'].includes(char)) return 'Transmissão / Caixa de Câmbio';
    return 'Subsistema não identificado';
};

function decodeDTC(hexPair) {
    const firstDigit = hexPair[0];
    const prefixes = ["P0", "P1", "P2", "P3", "C0", "C1", "C2", "C3", "B0", "B1", "B2", "B3", "U0", "U1", "U2", "U3"];
    return prefixes[parseInt(firstDigit, 16)] + hexPair.substring(1);
}

// ---------------------------------------------------------------------------
// DTC em português do Brasil (diferencial sobre Torque/Car Scanner: o leitor
// leigo entende o problema sem saber inglês).
//   podeDirigir: sim | curta | nao | pare
//   urgencia:    baixa | media | alta | critica
// ---------------------------------------------------------------------------
const URGENCIA_CORES = { baixa: '#00ff88', media: '#ffc542', alta: '#ff5577', critica: '#ff0055' };
const DIRIGIR_CORES = { sim: '#00ff88', curta: '#ffc542', nao: '#ff5577', pare: '#ff0055' };
const DIRIGIR_TEXTO = {
    sim: 'Pode dirigir — acompanhe o painel',
    curta: 'Só trajetos curtos — marque a oficina',
    nao: 'Não recomendado dirigir',
    pare: 'Pare o veículo e chame socorro'
};

const DTC_PT_BR = {
    "P0300": { titulo: "Falha de ignição aleatória (mais de um cilindro)", explicacao: "O motor está perdendo a combustão em vários cilindros de forma irregular. Isso faz o carro trepidar, perder potência e gastar mais combustível.", podeDirigir: "curta", urgencia: "alta", causa: "Velas gastas, bobinas vencidas, injetores sujos ou vazamento de vácuo.", sintomas: "Trepidação ao acelerar, luz da injeção acesa, cheiro forte de gasolina, consumo aumentado.", pecas: ["Velas de ignição", "Bobinas de ignição", "Injetores"], custo: "R$ 150 a R$ 800" },
    "P0301": { titulo: "Falha de ignição no cilindro 1", explicacao: "O cilindro 1 não está queimando o combustível direito. Costuma ser uma vela ou bobina com defeito.", podeDirigir: "curta", urgencia: "alta", causa: "Vela, bobina ou injetor do cilindro 1; cabos de alta queimados.", sintomas: "Motor falhando em marcha lenta e ao acelerar, perda de potência.", pecas: ["Vela de ignição", "Bobina de ignição", "Injetor"], custo: "R$ 120 a R$ 600" },
    "P0302": { titulo: "Falha de ignição no cilindro 2", explicacao: "O cilindro 2 não está queimando o combustível direito. Costuma ser uma vela ou bobina com defeito.", podeDirigir: "curta", urgencia: "alta", causa: "Vela, bobina ou injetor do cilindro 2; cabos de alta queimados.", sintomas: "Motor falhando em marcha lenta e ao acelerar, perda de potência.", pecas: ["Vela de ignição", "Bobina de ignição", "Injetor"], custo: "R$ 120 a R$ 600" },
    "P0303": { titulo: "Falha de ignição no cilindro 3", explicacao: "O cilindro 3 não está queimando o combustível direito. Costuma ser uma vela ou bobina com defeito.", podeDirigir: "curta", urgencia: "alta", causa: "Vela, bobina ou injetor do cilindro 3; cabos de alta queimados.", sintomas: "Motor falhando em marcha lenta e ao acelerar, perda de potência.", pecas: ["Vela de ignição", "Bobina de ignição", "Injetor"], custo: "R$ 120 a R$ 600" },
    "P0304": { titulo: "Falha de ignição no cilindro 4", explicacao: "O cilindro 4 não está queimando o combustível direito. Costuma ser uma vela ou bobina com defeito.", podeDirigir: "curta", urgencia: "alta", causa: "Vela, bobina ou injetor do cilindro 4; cabos de alta queimados.", sintomas: "Motor falhando em marcha lenta e ao acelerar, perda de potência.", pecas: ["Vela de ignição", "Bobina de ignição", "Injetor"], custo: "R$ 120 a R$ 600" },
    "P0171": { titulo: "Mistura muito pobre (Banco 1)", explicacao: "O motor está recebendo mais ar do que combustível. A injeção tenta compensar e pode deixar o carro falhando.", podeDirigir: "curta", urgencia: "alta", causa: "Vazamento de vácuo, bomba de combustível fraca, filtro/sensor de ar sujo.", sintomas: "Motor falhando na partida, marcha lenta irregular, perda de potência.", pecas: ["Filtro de ar", "Sensor MAF", "Bomba de combustível"], custo: "R$ 100 a R$ 700" },
    "P0172": { titulo: "Mistura muito rica (Banco 1)", explicacao: "Está entrando combustível demais no motor. além do desperdício, pode danificar o catalisador.", podeDirigir: "curta", urgencia: "alta", causa: "Injetor vazando, regulador de pressão com defeito, sensor de O₂ ruim.", sintomas: "Consumo alto, motor engasgando, cheiro de combustível no escapamento.", pecas: ["Injetores", "Sensor O₂", "Regulador de pressão"], custo: "R$ 150 a R$ 900" },
    "P0174": { titulo: "Mistura muito pobre (Banco 2)", explicacao: "Lado oposto do motor recebendo mais ar do que combustível. Em motores V6/V8 é o segundo banco.", podeDirigir: "curta", urgencia: "alta", causa: "Vazamento de vácuo, MAF sujo, bomba de combustível fraca.", sintomas: "Marcha lenta irregular, falhas ao acelerar, luz acesa.", pecas: ["Sensor MAF", "Filtro de ar", "Bomba de combustível"], custo: "R$ 100 a R$ 700" },
    "P0175": { titulo: "Mistura muito rica (Banco 2)", explicacao: "Segundo banco do motor com combustível em excesso. Pode fundir o catalisador se não corrigir.", podeDirigir: "curta", urgencia: "alta", causa: "Injetor vazando, sensor O₂ ruim, filtro de ar entupido.", sintomas: "Consumo alto, cheiro forte de gasolina, motor falhando.", pecas: ["Injetores", "Sensor O₂", "Filtro de ar"], custo: "R$ 150 a R$ 900" },
    "P0420": { titulo: "Catalisador com desempenho abaixo do esperado (Banco 1)", explicacao: "O catalisador não está mais filtrando os gases direito. Costuma acender a luz da injeção e deixar o carro sem força.", podeDirigir: "curta", urgencia: "media", causa: "Catalisador desgastado, sensor O₂ traseiro com defeito, queima de combustível ruim (produtores de misfire).", sintomas: "Luz da injeção, cheiro de enxofre, perda leve de potência, consumo maior.", pecas: ["Catalisador", "Sensor O₂"], custo: "R$ 400 a R$ 3.500 (peça é cara)" },
    "P0430": { titulo: "Catalisador com desempenho abaixo do esperado (Banco 2)", explicacao: "Mesmo problema do P0420, no segundo lado do motor. Em carros 4 cilindros normalmente não aparece.", podeDirigir: "curta", urgencia: "media", causa: "Catalisador desgastado ou sensor O₂ do banco 2 com defeito.", sintomas: "Luz da injeção acesa, cheiro de enxofre, consumo maior.", pecas: ["Catalisador", "Sensor O₂"], custo: "R$ 400 a R$ 3.500" },
    "P0401": { titulo: "Recirculação de gases (EGR) sem fluxo suficiente", explicacao: "A válvula de EGR não está deixando os gases de escapamento voltarem ao motor. Costuma entupir de carbonização.", podeDirigir: "curta", urgencia: "media", causa: "Válvula EGR travada, passagens entupidas de carbon (muito comum em diesel e flex).", sintomas: "Motor falhando, perda de potência, consumo aumentado, luz acesa.", pecas: ["Válvula EGR", "Jogo de borrachas"], custo: "R$ 200 a R$ 1.200" },
    "P0402": { titulo: "Recirculação de gases (EGR) com fluxo excessivo", explicacao: "A válvula EGR está abrindo além da conta, deixando o motor trepidar em marcha lenta.", podeDirigir: "curta", urgencia: "media", causa: "Válvula EGR presa aberta ou solenoide com defeito.", sintomas: "Marcha lenta falhando, motor apagando ao parar no semáforo.", pecas: ["Válvula EGR", "Solenoide EGR"], custo: "R$ 200 a R$ 1.200" },
    "P0403": { titulo: "Falha no circuito elétrico da válvula EGR", explicacao: "A central não consegue mandar o comando elétrico para a válvula de recirculação de gases.", podeDirigir: "curta", urgencia: "media", causa: "Fiação cortada, conector oxidado ou válvula queimada.", sintomas: "Luz da injeção acesa, possível motor falhando.", pecas: ["Válvula EGR", "Conectores e fiação"], custo: "R$ 250 a R$ 1.300" },
    "P0440": { titulo: "Falha no sistema de vapores do tanque (EVAP)", explicacao: "O sistema que recolhe os vapores de combustível do tanque está com problema. Frequentemente é só a tampa do tanque.", podeDirigir: "sim", urgencia: "baixa", causa: "Tampa do tanque frouxa ou furada, mangueira estourada, válvula do carvão ativado.", sintomas: "Geralmente só a luz acesa; às vezes cheiro de gasolina.", pecas: ["Tampa do tanque", "Mangueiras EVAP"], custo: "R$ 30 a R$ 400" },
    "P0442": { titulo: "Vazamento pequeno no sistema de vapores (EVAP)", explicacao: "Detectaram um vazamento pequeno na linha de vapores. Costuma ser a tampa do tanque.", podeDirigir: "sim", urgencia: "baixa", causa: "Tampa do tanque, borracha de vedação ou mangueira rachada.", sintomas: "Luz da injeção acesa, cheiro ocasional de gasolina.", pecas: ["Tampa do tanque", "Mangueiras EVAP"], custo: "R$ 30 a R$ 300" },
    "P0446": { titulo: "Válvula de ventilação do EVAP com defeito", explicacao: "A válvula que ventila o tanque não está respondendo ao comando da central.", podeDirigir: "sim", urgencia: "baixa", causa: "Solenoide do carvão ativado travado ou conector.", sintomas: "Luz acesa; raramente dificuldade na abertura do tanque.", pecas: ["Válvula do carvão ativado"], custo: "R$ 250 a R$ 900" },
    "P0455": { titulo: "Vazamento grande no sistema de vapores (EVAP)", explicacao: "Vazamento considerável detectado — na maioria das vezes a tampa do tanque está ausente ou furada.", podeDirigir: "sim", urgencia: "baixa", causa: "Tampa do tanque frouxa/furada, mangueira rompida, tanque trincado.", sintomas: "Cheiro de gasolina, luz da injeção acesa.", pecas: ["Tampa do tanque", "Mangueiras EVAP"], custo: "R$ 30 a R$ 500" },
    "P0456": { titulo: "Vazamento muito pequeno no EVAP", explicacao: "Um vazamento minúsculo no sistema de vapores. Difícil de achar sem equipamento de fumaça.", podeDirigir: "sim", urgencia: "baixa", causa: "O-ring da tampa, válvula do tanque ou conexão de mangueira.", sintomas: "Geralmente só a luz acesa.", pecas: ["Tampa do tanque", "Vedação do tanque"], custo: "R$ 80 a R$ 500" },
    "P0128": { titulo: "Termostato do motor não atinge a temperatura", explicacao: "O motor está demorando para esquentar ou ficando frio demais — o termostato provavelmente está abrindo cedo.", podeDirigir: "sim", urgencia: "media", causa: "Termostato travado aberto, sensor de temperatura ruim, nível de líquido baixo.", sintomas: "Aquecimento fraco no inverno, luz acesa, consumo maior.", pecas: ["Termostato", "Líquido de arrefecimento", "Sensor de temperatura"], custo: "R$ 120 a R$ 600" },
    "P0115": { titulo: "Sensor de temperatura do líquido de arrefecimento", explicacao: "O sensor que mede a temperatura do motor está com circuito com defeito.", podeDirigir: "curta", urgencia: "media", causa: "Sensor com defeito, fiação cortada ou conector oxidado.", sintomas: "Mostrador de temperatura errado, motor não entra em temperatura correta, consumo pior.", pecas: ["Sensor de temperatura", "Fiação"], custo: "R$ 80 a R$ 400" },
    "P0116": { titulo: "Sensor de temperatura com leitura fora da faixa", explicacao: "O sensor está respondendo, mas o valor muda de forma estranha — sinal de sensor fraco ou ar no sistema.", podeDirigir: "curta", urgencia: "media", causa: "Sensor desgastado, ar no sistema de arrefecimento.", sintomas: "Ponteiro de temperatura oscilando, luz acesa.", pecas: ["Sensor de temperatura", "Purga do sistema de arrefecimento"], custo: "R$ 80 a R$ 400" },
    "P0117": { titulo: "Temperatura do motor muito baixa (leitura)", explicacao: "O motor está avisando que está frio demais — pode ser sensor ou termostato travado aberto.", podeDirigir: "curta", urgencia: "media", causa: "Sensor de temperatura ou termostato travado aberto.", sintomas: "Aquecimento fraco, luz acesa.", pecas: ["Sensor de temperatura", "Termostato"], custo: "R$ 100 a R$ 500" },
    "P0118": { titulo: "Temperatura do motor muito alta (leitura)", explicacao: "Leitura de temperatura anormalmente alta. Se o mostrador também estiver no vermelho, pare o carro.", podeDirigir: "nao", urgencia: "alta", causa: "Sensor com defeito, fiação em curto, líquido de arrefecimento baixo.", sintomas: "Mostrador alto, luz vermelha, risco de superaquecimento.", pecas: ["Sensor de temperatura", "Líquido de arrefecimento"], custo: "R$ 100 a R$ 500" },
    "P0113": { titulo: "Sensor de temperatura do ar de admissão (leitura alta)", explicacao: "O sensor de temperatura do ar entrando no motor está mandando sinal alto demais.", podeDirigir: "sim", urgencia: "baixa", causa: "Conector oxidado, fiação, sensor IAT com defeito.", sintomas: "Leve perda de potência, luz acesa.", pecas: ["Sensor IAT"], custo: "R$ 80 a R$ 350" },
    "P0112": { titulo: "Sensor de temperatura do ar de admissão (leitura baixa)", explicacao: "O sensor de temperatura do ar de admissão está mandando sinal baixo demais.", podeDirigir: "sim", urgencia: "baixa", causa: "Sensor IAT com defeito ou fiação em curto.", sintomas: "Pouco perceptível; luz acesa.", pecas: ["Sensor IAT"], custo: "R$ 80 a R$ 350" },
    "P0100": { titulo: "Circuito do sensor de vazão de ar (MAF)", explicacao: "O sensor que mede quanto ar entra no motor está fora do padrão. Ele afeta toda a injeção.", podeDirigir: "curta", urgencia: "media", causa: "Sensor MAF sujo, filtro de ar vencido, mangueira rachada admitindo ar.", sintomas: "Marcha lenta irregular, motor engasgando, consumo maior.", pecas: ["Sensor MAF", "Filtro de ar"], custo: "R$ 150 a R$ 900" },
    "P0101": { titulo: "Sensor MAF com leitura fora da faixa esperada", explicacao: "O valor do sensor de ar não bate com o esperado pelo motor — normalmente filtro de ar sujo ou vazamento de ar.", podeDirigir: "curta", urgencia: "media", causa: "Filtro de ar sujo, MAF sujo, ar entrando pela mangueira.", sintomas: "Perda de potência, marcha lenta oscilando.", pecas: ["Filtro de ar", "Sensor MAF"], custo: "R$ 60 a R$ 900" },
    "P0102": { titulo: "Sinal do sensor de ar (MAF) baixo demais", explicacao: "O sensor está lendo menos ar do que deveria — o motor injeta pouco combustível.", podeDirigir: "curta", urgencia: "media", causa: "Sensor MAF com defeito ou fiação.", sintomas: "Motor falhando, não pega bem.", pecas: ["Sensor MAF"], custo: "R$ 200 a R$ 900" },
    "P0103": { titulo: "Sinal do sensor de ar (MAF) alto demais", explicacao: "O sensor está lendo mais ar do que entra de verdade — o motor injeta combustível demais.", podeDirigir: "curta", urgencia: "media", causa: "Sensor MAF com defeito, filtro de ar incorreto.", sintomas: "Consumo alto, motor ralando.", pecas: ["Sensor MAF", "Filtro de ar"], custo: "R$ 200 a R$ 900" },
    "P0105": { titulo: "Circuito do sensor de pressão do coletor (MAP)", explicacao: "O sensor que mede a pressão dentro do coletor de admissão está com problema.", podeDirigir: "curta", urgencia: "media", causa: "Sensor MAP, mangueira de vácuo ressecada, fiação.", sintomas: "Marcha lenta irregular, luz acesa.", pecas: ["Sensor MAP", "Mangueiras de vácuo"], custo: "R$ 100 a R$ 600" },
    "P0107": { titulo: "Pressão do coletor (MAP) muito baixa", explicacao: "Leitura de pressão baixa demais — pode indicar vazamento de vácuo grande.", podeDirigir: "curta", urgencia: "media", causa: "Vazamento de vácuo, sensor MAP ruim.", sintomas: "Motor falhando, marcha lenta alta.", pecas: ["Sensor MAP", "Mangueiras de vácuo"], custo: "R$ 100 a R$ 600" },
    "P0108": { titulo: "Pressão do coletor (MAP) muito alta", explicacao: "Leitura de pressão alta demais — comum em válvula EGR travada aberta ou sensor com defeito.", podeDirigir: "curta", urgencia: "media", causa: "Válvula EGR presa, sensor MAP com defeito, coletor entupido.", sintomas: "Perda de potência, motor pesado.", pecas: ["Sensor MAP", "Válvula EGR"], custo: "R$ 150 a R$ 1.000" },
    "P0130": { titulo: "Sensor de oxigênio — circuito (Banco 1, Sensor 1)", explicacao: "O sensor de oxigênio dianteiro está com problema no circuito. Ele é o principal para calcular a mistura.", podeDirigir: "curta", urgencia: "media", causa: "Sensor O₂ com defeito, fiação, vazamento de ar no escapamento.", sintomas: "Consumo maior, luz acesa, marcha lenta irregular.", pecas: ["Sensor O₂"], custo: "R$ 150 a R$ 800" },
    "P0131": { titulo: "Sensor de oxigênio — sinal baixo (Banco 1, Sensor 1)", explicacao: "O sensor está indicando mistura muito pobre o tempo todo.", podeDirigir: "curta", urgencia: "media", causa: "Sensor O₂ velho, vazamento de vácuo, bomba de combustível fraca.", sintomas: "Motor falhando, consumo aumentado.", pecas: ["Sensor O₂", "Mangueiras de vácuo"], custo: "R$ 150 a R$ 800" },
    "P0132": { titulo: "Sensor de oxigênio — sinal alto (Banco 1, Sensor 1)", explicacao: "O sensor está indicando mistura muito rica o tempo todo.", podeDirigir: "curta", urgencia: "media", causa: "Sensor O₂ com defeito, injetor vazando, catalisador entupido.", sintomas: "Consumo alto, cheiro de gasolina.", pecas: ["Sensor O₂", "Injetores"], custo: "R$ 150 a R$ 800" },
    "P0133": { titulo: "Sensor de oxigênio lento demais (Banco 1, Sensor 1)", explicacao: "O sensor está respondendo devagar para as mudanças de mistura — age com idade e fuligem.", podeDirigir: "sim", urgencia: "baixa", causa: "Sensor O₂ envelhecido, catalisador gasto.", sintomas: "Consumo um pouco maior, luz acesa.", pecas: ["Sensor O₂"], custo: "R$ 150 a R$ 800" },
    "P0134": { titulo: "Sensor de oxigênio sem atividade (Banco 1, Sensor 1)", explicacao: "O sensor não está gerando sinal nenhum — ele ou o aquecedor dele podem estar mortos.", podeDirigir: "curta", urgencia: "media", causa: "Sensor O₂ queimado, fiação, fusível do aquecedor.", sintomas: "Luz acesa, consumo pior.", pecas: ["Sensor O₂"], custo: "R$ 150 a R$ 800" },
    "P0135": { titulo: "Aquecedor do sensor de oxigênio (Banco 1, Sensor 1)", explicacao: "O aquecedor que faz o sensor O₂ funcionar rápido está com defeito. O sensor só passa a trabalhar depois que esquenta.", podeDirigir: "sim", urgencia: "baixa", causa: "Resistência interna do sensor queimada, fusível, fiação.", sintomas: "Luz acesa; consumo levemente pior no começo do uso.", pecas: ["Sensor O₂"], custo: "R$ 150 a R$ 800" },
    "P0136": { titulo: "Sensor de oxigênio traseiro (Banco 1, Sensor 2)", explicacao: "Este sensor fica depois do catalisador e serve para monitorá-lo. E ele não está respondendo.", podeDirigir: "sim", urgencia: "baixa", causa: "Sensor O₂ traseiro com defeito ou escapamento vazando.", sintomas: "Luz acesa; é ele que dispara os erros P0420.", pecas: ["Sensor O₂ traseiro"], custo: "R$ 150 a R$ 800" },
    "P0137": { titulo: "Sensor de oxigênio traseiro com sinal baixo (Banco 1, Sensor 2)", explicacao: "O sensor depois do catalisador está lendo abaixo do esperado.", podeDirigir: "sim", urgencia: "baixa", causa: "Sensor ruim, vazamento de escapamento, catalisador desgastado.", sintomas: "Luz da injeção acesa.", pecas: ["Sensor O₂ traseiro"], custo: "R$ 150 a R$ 800" },
    "P0138": { titulo: "Sensor de oxigênio traseiro com sinal alto (Banco 1, Sensor 2)", explicacao: "O sensor depois do catalisador está lendo acima do esperado — sinal de catalisador fraco ou sensor ruim.", podeDirigir: "sim", urgencia: "baixa", causa: "Catalisador desgastado ou sensor O₂ com defeito.", sintomas: "Luz acesa, possível cheiro de enxofre.", pecas: ["Sensor O₂ traseiro", "Catalisador"], custo: "R$ 150 a R$ 1.500" },
    "P0141": { titulo: "Aquecedor do sensor de oxigênio traseiro (Banco 1, Sensor 2)", explicacao: "A resistência de aquecimento do sensor traseiro parou de funcionar.", podeDirigir: "sim", urgencia: "baixa", causa: "Sensor O₂ traseiro com defeito ou fusível queimado.", sintomas: "Luz da injeção acesa.", pecas: ["Sensor O₂ traseiro"], custo: "R$ 150 a R$ 800" },
    "P0140": { titulo: "Sensor de oxigênio traseiro sem atividade (Banco 1, Sensor 2)", explicacao: "O sensor depois do catalisador não está gerando sinal.", podeDirigir: "sim", urgencia: "baixa", causa: "Sensor morto ou fiação cortada.", sintomas: "Luz acesa; pode liberar erro P0420 junto.", pecas: ["Sensor O₂ traseiro"], custo: "R$ 150 a R$ 800" },
    "P0170": { titulo: "Controle de mistura fora de ajuste (Banco 1)", explicacao: "A injeção chegou ao limite das correções e ainda assim não deixou a mistura no ponto.", podeDirigir: "curta", urgencia: "media", causa: "Vazamento de vácuo, sensor O₂, MAF sujo, bomba de combustível.", sintomas: "Motor falhando, consumo aumentado.", pecas: ["Sensor O₂", "Sensor MAF", "Mangueiras de vácuo"], custo: "R$ 150 a R$ 900" },
    "P0325": { titulo: "Sensor de detonação (knock sensor)", explicacao: "O sensor que escuta a batida do motor (detonação) parou de responder. O motor passa a perder potência para se proteger.", podeDirigir: "curta", urgencia: "media", causa: "Sensor de detonação, fiação, aperto incorreto ou cabo de massa.", sintomas: "Motor sem força, consumo maior, luz acesa.", pecas: ["Sensor de detonação"], custo: "R$ 200 a R$ 900" },
    "P0335": { titulo: "Sensor de rotação do virabrequim (CKP)", explicacao: "É o sensor que diz ao motor quando injetar e dar faísca. Se ele cair, o carro costuma morrer e não religar.", podeDirigir: "nao", urgencia: "critica", causa: "Sensor CKP com defeito, engrenagem quebrada, fiação, correia esticada.", sintomas: "Carro morre andando, não pega, trepidação forte, luz acesa.", pecas: ["Sensor de rotação (CKP)"], custo: "R$ 250 a R$ 1.200" },
    "P0340": { titulo: "Sensor de rotação do comando de válvulas (CMP)", explicacao: "Este sensor sincroniza o comando de válvulas com o virabrequim. Com defeito, o carro pode não pegar.", podeDirigir: "nao", urgencia: "critica", causa: "Sensor CMP, correia/tesoura de comando esticada ou quebrada, fiação.", sintomas: "Não pega, morre andando, marcha lenta ruim.", pecas: ["Sensor de rotação do comando (CMP)"], custo: "R$ 250 a R$ 1.300" },
    "P0016": { titulo: "Sincronismo entre virabrequim e comando de válvulas", explicacao: "O motor percebeu que o eixo das válvulas não está na posição certa em relação ao pistão. Costuma ser correia ou corrente de comando.", podeDirigir: "nao", urgencia: "critica", causa: "Correia/tesoura de comando saltada, tensionador com folga, sensor fora de posição.", sintomas: "Não pega, motor falhando, barulho na parte de cima do motor, cheiro de queimado na oficina.", pecas: ["Correia do motor", "Tensionador", "Kit de comando"], custo: "R$ 600 a R$ 3.500" },
    "P0500": { titulo: "Sensor de velocidade do veículo", explicacao: "O sensor que informa a velocidade do carro ao motor e ao painel está com defeito.", podeDirigir: "curta", urgencia: "media", causa: "Sensor de velocidade (no câmbio ou roda traseira), fiação, ABS.", sintomas: "Velocímetro travado ou errado, marcha automática engasgando.", pecas: ["Sensor de velocidade"], custo: "R$ 150 a R$ 800" },
    "P0505": { titulo: "Controle de marcha lenta (IAC)", explicacao: "O motor não está controlando direito a rotação parado — por isso apaga ou acelera sozinho no semáforo.", podeDirigir: "curta", urgencia: "media", causa: "Válvula de marcha lenta travada de carbonização, borboleta suja, vazamento de vácuo.", sintomas: "Motor apagando no semáforo, marcha lenta oscilando, frio não pega.", pecas: ["Válvula IAC", "Limpeza da borboleta"], custo: "R$ 150 a R$ 700" },
    "P0507": { titulo: "Marcha lenta acima do esperado", explicacao: "O motor está com rotação alta na hora de parar — comum depois de limpar a borboleta sem reaprender.", podeDirigir: "sim", urgencia: "baixa", causa: "Válvula IAC com folga, ar escapando pela borboleta, adaptação não feita.", sintomas: "Rotação alta parado, motor demora para baixar.", pecas: ["Válvula IAC", "Limpeza da borboleta"], custo: "R$ 100 a R$ 600" },
    "P0560": { titulo: "Tensão do sistema elétrico", explicacao: "A central detectou tensão fora da faixa normal (o ideal é entre 13,8V e 14,7V com o motor ligado).", podeDirigir: "curta", urgencia: "alta", causa: "Alternador com defeito, bateria velha, chicote com mau contato.", sintomas: "Luz da bateria acesa, farol fraco, painel reiniciando.", pecas: ["Bateria", "Alternador", "Correia do alternador"], custo: "R$ 400 a R$ 1.800" },
    "P0562": { titulo: "Tensão da bateria baixa", explicacao: "Tensão abaixo do normal — o alternador não está carregando direito ou a bateria está no fim.", podeDirigir: "nao", urgencia: "alta", causa: "Bateria descarregada, alternador ruim, terminais sulfatados, correia frouxa.", sintomas: "Motor difícil de pegar, luz da bateria, farol apagando em marcha lenta.", pecas: ["Bateria", "Alternador", "Cabo de massa"], custo: "R$ 350 a R$ 1.800" },
    "P0600": { titulo: "Falha na comunicação entre os módulos (CAN)", explicacao: "Os computadores do carro (motor, câmbio, ABS, painel) pararam de conversar entre si.", podeDirigir: "nao", urgencia: "critica", causa: "Chicote danificado, massa ruim, módulo com defeito, oxidação nos conectores.", sintomas: "Vários alertas ao mesmo tempo, luz da injeção e ABS acesas, carro não pega.", pecas: ["Diagnóstico de chicote", "Conectores"], custo: "R$ 300 a R$ 2.500" },
    "P0601": { titulo: "Memória da central do motor (CRC) com erro", explicacao: "O computador do motor detectou erro na própria memória. Normalmente a peça precisa ser trocada ou reprogramada.", podeDirigir: "nao", urgencia: "critica", causa: "Falha interna da ECU, quedas de tensão, módulo reprogramado incorretamente.", sintomas: "Motor não pega ou entra em modo de emergência.", pecas: ["Reparo/reprogramação da ECU"], custo: "R$ 500 a R$ 3.000" },
    "P0606": { titulo: "Processador da central do motor com defeito", explicacao: "Falha interna do processador da central de injeção.", podeDirigir: "nao", urgencia: "critica", causa: "Dano interno da ECU, água no módulo, sobretensão.", sintomas: "Motor não pega, falhas aleatórias, painel travado.", pecas: ["Reparo ou troca da ECU"], custo: "R$ 800 a R$ 4.000" },
    "P0700": { titulo: "Falha no sistema de controle da transmissão", explicacao: "Este é um aviso genérico: o módulo do câmbio encontrou problema. O código específico do câmbio está no módulo dele.", podeDirigir: "nao", urgencia: "alta", causa: "Solenoides, sensor de velocidade, nível de óleo baixo ou velho, chicote do câmbio.", sintomas: "Câmbio travando em terceira, engate brusco, luz acesa.", pecas: ["Óleo do câmbio", "Solenoides", "Sensor de velocidade"], custo: "R$ 300 a R$ 3.000" },
    "P0705": { titulo: "Sensor de faixa da transmissão (prumo)", explicacao: "O sensor que diz em que marcha você está (P, R, N, D) está com defeito.", podeDirigir: "nao", urgencia: "alta", causa: "Sensor do seletor de marchas, chicote, conector oxidado.", sintomas: "Marcha-atras não anda, carro não liga em P/N, luz acesa.", pecas: ["Sensor de faixa do câmbio"], custo: "R$ 250 a R$ 1.500" },
    "P0710": { titulo: "Sensor de temperatura do óleo da transmissão", explicacao: "O sensor de temperatura da transmissão está com circuito com defeito.", podeDirigir: "curta", urgencia: "media", causa: "Sensor com defeito, fiação.", sintomas: "Câmbio entrando em modo de contingência (marcha reduzida).", pecas: ["Sensor de temperatura do câmbio"], custo: "R$ 250 a R$ 1.500" },
    "P0715": { titulo: "Sensor de velocidade de entrada da transmissão", explicacao: "O sensor que mede a rotação que chega na transmissão parou de responder.", podeDirigir: "nao", urgencia: "alta", causa: "Sensor da turbina, chicote, rotor magnético sujo.", sintomas: "Câmbio engasgando, carro sem força, marcha-atras acesa.", pecas: ["Sensor de entrada da transmissão"], custo: "R$ 300 a R$ 1.800" },
    "P0720": { titulo: "Sensor de velocidade de saída da transmissão", explicacao: "O sensor que mede a velocidade depois da transmissão está falhando.", podeDirigir: "nao", urgencia: "alta", causa: "Sensor de velocidade de saída, fiação, ABS (em alguns carros).", sintomas: "Velocímetro falhando, câmbio em modo de contingência.", pecas: ["Sensor de velocidade da transmissão"], custo: "R$ 300 a R$ 1.800" },
    "P0730": { titulo: "Relação de marcha incorreta", explicacao: "A transmissão não está entregando a relação de redução esperada — pode estar patinando por dentro.", podeDirigir: "nao", urgencia: "critica", causa: "Óleo do câmbio vencido, solenoide, embreagem da transmissão gasta, baixo nível de óleo.", sintomas: "Motor alto e carro não anda, engates bruscos, cheiro de óleo queimado.", pecas: ["Óleo do câmbio", "Kit de solenoides", "Revisão interna"], custo: "R$ 500 a R$ 6.000" },
    "P0740": { titulo: "Embreagem do convertidor de casal (TCC)", explicacao: "O convertidor de casal não está travando direito. Isso aumenta o consumo e esquenta o óleo.", podeDirigir: "curta", urgencia: "media", causa: "Solenoide do TCC, válvula travada, óleo do câmbio velho.", sintomas: "Consumo alto, motor acelera sem acelerar junto, marcha lenta oscilando.", pecas: ["Óleo do câmbio", "Solenoide do TCC"], custo: "R$ 400 a R$ 2.500" },
    "P0750": { titulo: "Solenoide de troca de marcha A", explicacao: "O solenoide que empurra o fluido para engatar a primeira marcha está com defeito.", podeDirigir: "nao", urgencia: "alta", causa: "Solenoide com defeito, óleo sujo, chicote do câmbio.", sintomas: "Não pega primeira, engate brusco, carro fica em modo de contingência.", pecas: ["Kit de solenoides", "Óleo do câmbio"], custo: "R$ 400 a R$ 2.500" },
    "P0753": { titulo: "Solenoide de troca de marcha A (falha elétrica)", explicacao: "Falha elétrica no solenoide de troca de marcha — o circuito não responde ao comando.", podeDirigir: "nao", urgencia: "alta", causa: "Bobina do solenoide queimada, fiação, conector do câmbio.", sintomas: "Câmbio não engata, luz acesa.", pecas: ["Solenoide da transmissão"], custo: "R$ 400 a R$ 2.500" },
    "P0755": { titulo: "Solenoide de troca de marcha B", explicacao: "O solenoide responsável por outra marcha está com defeito.", podeDirigir: "nao", urgencia: "alta", causa: "Solenoide com defeito, óleo sujo, chicote.", sintomas: "Marcha específica não engata, engate brusco.", pecas: ["Kit de solenoides", "Óleo do câmbio"], custo: "R$ 400 a R$ 2.500" },
    "P0200": { titulo: "Circuito dos injetores de combustível", explicacao: "O circuito elétrico que aciona os injetores está com problema em geral.", podeDirigir: "curta", urgencia: "alta", causa: "Fiação, módulo de injeção, injetores com resistência errada.", sintomas: "Motor falhando em todos os cilindros, não pega.", pecas: ["Injetores", "Chicote da injeção"], custo: "R$ 300 a R$ 1.800" },
    "P0201": { titulo: "Circuito do injetor do cilindro 1", explicacao: "O injetor do cilindro 1 não está respondendo ao comando elétrico.", podeDirigir: "curta", urgencia: "alta", causa: "Injetor queimado, fiação, conector.", sintomas: "Motor falhando, perda de potência.", pecas: ["Injetor", "Chicote"], custo: "R$ 200 a R$ 900" },
    "P0202": { titulo: "Circuito do injetor do cilindro 2", explicacao: "O injetor do cilindro 2 não está respondendo ao comando elétrico.", podeDirigir: "curta", urgencia: "alta", causa: "Injetor queimado, fiação, conector.", sintomas: "Motor falhando, perda de potência.", pecas: ["Injetor", "Chicote"], custo: "R$ 200 a R$ 900" },
    "P0203": { titulo: "Circuito do injetor do cilindro 3", explicacao: "O injetor do cilindro 3 não está respondendo ao comando elétrico.", podeDirigir: "curta", urgencia: "alta", causa: "Injetor queimado, fiação, conector.", sintomas: "Motor falhando, perda de potência.", pecas: ["Injetor", "Chicote"], custo: "R$ 200 a R$ 900" },
    "P0204": { titulo: "Circuito do injetor do cilindro 4", explicacao: "O injetor do cilindro 4 não está respondendo ao comando elétrico.", podeDirigir: "curta", urgencia: "alta", causa: "Injetor queimado, fiação, conector.", sintomas: "Motor falhando, perda de potência.", pecas: ["Injetor", "Chicote"], custo: "R$ 200 a R$ 900" },
    "P0230": { titulo: "Circuito da bomba de combustível (primário)", explicacao: "O relé/circuito que liga a bomba de combustível está com falha.", podeDirigir: "nao", urgencia: "critica", causa: "Relé da bomba, fusível, chicote, massa do tanque.", sintomas: "Carro morre e não religa, não se ouve a bomba ligar ao dar a partida.", pecas: ["Relé da bomba", "Bomba de combustível"], custo: "R$ 200 a R$ 1.500" },
    "P0087": { titulo: "Pressão baixa no trilho de combustível (common rail)", explicacao: "O sistema de injeção direta/diesel não está atingindo a pressão necessária. Muito comum em motores diesel.", podeDirigir: "nao", urgencia: "critica", causa: "Bomba de alta pressão gasta, injetores vazando, sensor de pressão, combustível sujo.", sintomas: "Motor não pega, modo de emergência, barulho metálico na bomba.", pecas: ["Bomba de alta pressão", "Injetores", "Filtro de combustível"], custo: "R$ 800 a R$ 6.000" },
    "P0191": { titulo: "Sensor de pressão do trilho de combustível com leitura fora da faixa", explicacao: "O sensor que mede a pressão de combustível está lendo valor estranho.", podeDirigir: "nao", urgencia: "alta", causa: "Sensor de pressão, bomba de alta, vazamento no trilho.", sintomas: "Modo de emergência, motor sem força.", pecas: ["Sensor de pressão do trilho"], custo: "R$ 300 a R$ 2.000" },
    "P0192": { titulo: "Sensor de pressão do trilho — sinal baixo", explicacao: "O sensor de pressão de combustível está mandando sinal baixo demais — a central acha que falta pressão.", podeDirigir: "nao", urgencia: "alta", causa: "Sensor com defeito, bomba de pressão gasta.", sintomas: "Motor engasgando, não pega, modo de emergência.", pecas: ["Sensor de pressão do trilho", "Bomba de alta pressão"], custo: "R$ 300 a R$ 2.500" },
    "P0193": { titulo: "Sensor de pressão do trilho — sinal alto", explicacao: "O sensor de pressão está mandando sinal alto demais.", podeDirigir: "nao", urgencia: "alta", causa: "Sensor com defeito, fiação em curto.", sintomas: "Motor sem força, luz acesa.", pecas: ["Sensor de pressão do trilho"], custo: "R$ 300 a R$ 2.500" },
    "P0011": { titulo: "Posição do comando de válvulas (VVT) adiantada demais", explicacao: "A fase do comando de válvulas está fora do ponto ideal — o motor perde potência e a luz acende.", podeDirigir: "curta", urgencia: "alta", causa: "Óleo do motor velho e sujo, atuador VVT com defeito, correia esticada.", sintomas: "Sem potência, marcha lenta ruim, consumo alto.", pecas: ["Óleo do motor", "Atuador VVT", "Correia do motor"], custo: "R$ 300 a R$ 2.000" },
    "P0012": { titulo: "Posição do comando de válvulas (VVT) atrasada demais", explicacao: "A fase do comando de válvulas está atrasada em relação ao que a central pediu.", podeDirigir: "curta", urgencia: "alta", causa: "Atuador VVT travado, óleo velho, correia com folga.", sintomas: "Motor pesado, sem potência, luz acesa.", pecas: ["Atuador VVT", "Óleo do motor"], custo: "R$ 300 a R$ 2.000" },
    "P0351": { titulo: "Circuito da bobina de ignição — cilindro 1", explicacao: "O circuito elétrico da bobina do cilindro 1 está com falha (código de estagiamento do cilindro 1).", podeDirigir: "curta", urgencia: "alta", causa: "Bobina queimada, chicote, módulo de ignição.", sintomas: "Motor falhando, treme no ralento.", pecas: ["Bobina de ignição"], custo: "R$ 150 a R$ 700" },
    "P0352": { titulo: "Circuito da bobina de ignição — cilindro 2", explicacao: "O circuito elétrico da bobina do cilindro 2 está com falha.", podeDirigir: "curta", urgencia: "alta", causa: "Bobina queimada, chicote, módulo de ignição.", sintomas: "Motor falhando, treme no ralento.", pecas: ["Bobina de ignição"], custo: "R$ 150 a R$ 700" },
    "P0520": { titulo: "Sensor de pressão do óleo do motor", explicacao: "O sensor que avisa a pressão do óleo está com circuito com defeito. A luz do óleo deve ser levada a sério.", podeDirigir: "nao", urgencia: "critica", causa: "Sensor de pressão, chicote, nível de óleo baixo.", sintomas: "Luz do óleo acesa (ou piscando), ruido no motor.", pecas: ["Sensor de pressão do óleo", "Óleo do motor"], custo: "R$ 150 a R$ 900" },
    "P2002": { titulo: "Filtro de partículas (DPF) com eficiência baixa", explicacao: "O filtro de fuligem do diesel não está limpando direito — ele precisa de regeneração.", podeDirigir: "curta", urgencia: "media", causa: "Uso curto e em baixa rotação, turbo com folga, óleo inadequado, DPF saturado.", sintomas: "Luz do DPF, motor sem força, aumento do consumo.", pecas: ["Regeneração do DPF", "Turbo"], custo: "R$ 400 a R$ 4.000" },
    "P1171": { titulo: "Mistura pobre em aceleração plena (código de fabricante — muito comum em Volkswagen)", explicacao: "Em aceleração máxima o motor não está recebendo combustível suficiente. É um dos códigos mais vistos em VW e Audi.", podeDirigir: "curta", urgencia: "media", causa: "Sensor O₂ velho, MAF sujo, bomba de combustível fraca, filtro entupido.", sintomas: "Motor engasgando fundo, falhando ao pisar todo o acelerador.", pecas: ["Sensor O₂", "Sensor MAF", "Bomba de combustível"], custo: "R$ 150 a R$ 900" },
    "P0120": { titulo: "Sensor da borboleta de aceleração (TPS)", explicacao: "O sensor que informa quanto você pisou no acelerador está com circuito com defeito.", podeDirigir: "curta", urgencia: "alta", causa: "TPS desgastado, fiação, mola da borboleta.", sintomas: "Motor em modo de contingência, sem potência, marcha lenta ruim.", pecas: ["Sensor TPS", "Corpo da borboleta"], custo: "R$ 150 a R$ 800" },
    "P0220": { titulo: "Potenciômetro da borboleta (TPS) — circuito B", explicacao: "O segundo circuito do sensor da borboleta está com falha (redundância de segurança).", podeDirigir: "curta", urgencia: "alta", causa: "TPS com defeito, fiação.", sintomas: "Motor sem força, luz acesa, aceleração travada.", pecas: ["Sensor TPS"], custo: "R$ 150 a R$ 800" },
    "P0121": { titulo: "Sensor da borboleta fora da faixa esperada", explicacao: "Os valores do acelerador não batem com o que o motor espera.", podeDirigir: "curta", urgencia: "media", causa: "TPS desgasto, borboleta suja, adaptação perdida.", sintomas: "Trepidação, aceleração irregular.", pecas: ["Sensor TPS", "Limpeza da borboleta"], custo: "R$ 150 a R$ 800" },
    "C0035": { titulo: "Sensor de velocidade da roda dianteira esquerda (ABS)", explicacao: "O sensor que mede o giro da roda dianteira esquerda está falhando. O ABS desliga para evitar frenagem errada.", podeDirigir: "sim", urgencia: "media", causa: "Sensor da roda, anel magnético sujo/quebrado, chicote na articulação.", sintomas: "Luz do ABS acesa, sensor de velocidade pode piscar.", pecas: ["Sensor de roda", "Anel magnético"], custo: "R$ 120 a R$ 600" },
    "C0040": { titulo: "Sensor de velocidade da roda dianteira direita (ABS)", explicacao: "O sensor que mede o giro da roda dianteira direita está falhando.", podeDirigir: "sim", urgencia: "media", causa: "Sensor da roda, anel magnético sujo, chicote.", sintomas: "Luz do ABS acesa.", pecas: ["Sensor de roda", "Anel magnético"], custo: "R$ 120 a R$ 600" },
    "C0045": { titulo: "Sensor de velocidade da roda traseira esquerda (ABS)", explicacao: "O sensor que mede o giro da roda traseira esquerda está falhando.", podeDirigir: "sim", urgencia: "media", causa: "Sensor da roda, anel magnético, chicote.", sintomas: "Luz do ABS acesa.", pecas: ["Sensor de roda"], custo: "R$ 120 a R$ 600" },
    "C0050": { titulo: "Sensor de velocidade da roda traseira direita (ABS)", explicacao: "O sensor que mede o giro da roda traseira direita está falhando.", podeDirigir: "sim", urgencia: "media", causa: "Sensor da roda, anel magnético, chicote.", sintomas: "Luz do ABS acesa.", pecas: ["Sensor de roda"], custo: "R$ 120 a R$ 600" },
    "C0060": { titulo: "Controle hidráulico do ABS com falha", explicacao: "A central do ABS não está conseguindo acionar a válvula de pressão corretamente.", podeDirigir: "nao", urgencia: "alta", causa: "Bomba/módulo do ABS, fluido de freio velho ou com bolhas.", sintomas: "Luz do ABS acesa e o pedal de freio fica estranho.", pecas: ["Módulo do ABS", "Troca do fluido de freio"], custo: "R$ 500 a R$ 4.000" },
    "C0065": { titulo: "Válvula de pressão do ABS com falha", explicacao: "Uma das válvulas do módulo ABS não está respondendo.", podeDirigir: "nao", urgencia: "alta", causa: "Módulo do ABS, fluido de freio contaminado.", sintomas: "Luz do ABS acesa, pedal pulsando fora de hora.", pecas: ["Módulo do ABS"], custo: "R$ 500 a R$ 4.000" },
    "U0073": { titulo: "Falha no barramento de comunicação (CAN)", explicacao: "Os módulos do carro perderam a comunicação entre si pela rede CAN.", podeDirigir: "nao", urgencia: "alta", causa: "Chicote danificado, massa do carro ruim, módulo queimado puxando a rede.", sintomas: "Vários erros ao mesmo tempo, painel com luzes acesas.", pecas: ["Diagnóstico de rede CAN"], custo: "R$ 300 a R$ 2.500" },
    "U0100": { titulo: "Sem comunicação com a central do motor (ECM)", explicacao: "Outros módulos não estão recebendo resposta da central do motor.", podeDirigir: "nao", urgencia: "critica", causa: "ECU sem energia, chicote, massa, módulo com defeito.", sintomas: "Motor não pega, várias luzes acesas no painel.", pecas: ["Diagnóstico da ECU"], custo: "R$ 400 a R$ 3.000" },
    "U0121": { titulo: "Sem comunicação com o módulo do ABS", explicacao: "A rede do carro não está recebendo resposta do módulo de freio ABS.", podeDirigir: "nao", urgencia: "alta", causa: "Módulo ABS sem energia, fusível, chicote, massa.", sintomas: "Luz do ABS e outras acesas, freio com pedal estranho.", pecas: ["Diagnóstico do módulo ABS"], custo: "R$ 300 a R$ 2.500" },
    "U0140": { titulo: "Sem comunicação com o módulo da carroceria (BCM)", explicacao: "A central que cuida de luzes, travas e painel parou de responder na rede.", podeDirigir: "curta", urgencia: "media", causa: "BCM sem energia, fusível queimado, chicote.", sintomas: "Luzes e travas com comportamento estranho, alarme disparando.", pecas: ["Diagnóstico do BCM"], custo: "R$ 300 a R$ 2.000" },
    "B0021": { titulo: "Circuito do airbag frontal (colisão frontal)", explicacao: "O sistema de airbag encontrou falha no circuito frontal. O airbag pode não disparar em um acidente.", podeDirigir: "sim", urgencia: "alta", causa: "Conector sob o banco (cor amarela) desconectado, sensor de impacto, chicote da coluna.", sintomas: "Luz do airbag acesa no painel.", pecas: ["Revisão do sistema SRS (airbag)"], custo: "R$ 300 a R$ 2.500" },
    "B0020": { titulo: "Circuito do airbag do passageiro", explicacao: "Falha no circuito do airbag do banco do passageiro.", podeDirigir: "sim", urgencia: "alta", causa: "Conector do banco, sensor de presença, chicote.", sintomas: "Luz do airbag acesa; airbag do passageiro pode ficar desarmado.", pecas: ["Revisão do sistema SRS (airbag)"], custo: "R$ 300 a R$ 2.500" },
    "B0026": { titulo: "Cinto de segurança do passageiro com falha", explicacao: "O módulo de airbag detectou problema no cinto de segurança do passageiro (pretensor/loop).", podeDirigir: "sim", urgencia: "media", causa: "Pretensor do cinto, conector, chicote sob o banco.", sintomas: "Luz do airbag/cinto acesa.", pecas: ["Pretensor do cinto"], custo: "R$ 400 a R$ 2.000" },
    "B0053": { titulo: "Sensor de impacto lateral com falha", explicacao: "Sensor de impacto lateral do airbag não está respondendo.", podeDirigir: "sim", urgencia: "media", causa: "Sensor na porta ou coluna, chicote que passa pela dobradiça.", sintomas: "Luz do airbag acesa.", pecas: ["Revisão do sistema SRS"], custo: "R$ 300 a R$ 2.500" }
};

// Falhas genéricas por família de código (usado quando o código não está no
// DTC_PT_BR — assim TODO código leva explicação em português).
const FAMILIAS_DTC_PT = {
    "P001": { titulo: "Sincronismo do comando de válvulas (VVT)", explicacao: "A fase do eixo de válvulas está fora do ponto ideal em relação ao motor.", podeDirigir: "curta", urgencia: "alta", causa: "Óleo velho, atuador VVT, correia esticada.", sintomas: "Sem potência, marcha lenta ruim, luz acesa.", pecas: ["Óleo do motor", "Atuador VVT", "Correia do motor"], custo: "R$ 300 a R$ 2.000" },
    "P010": { titulo: "Sensor de admissão de ar (MAF/MAP)", explicacao: "O motor está medindo o ar de entrada de forma errada, o que bagunça toda a injeção.", podeDirigir: "curta", urgencia: "media", causa: "Sensor sujo ou queimado, filtro de ar vencido, mangueira rachada.", sintomas: "Marcha lenta irregular, perda de potência, consumo maior.", pecas: ["Filtro de ar", "Sensor MAF/MAP"], custo: "R$ 100 a R$ 900" },
    "P011": { titulo: "Medição de temperatura do motor ou do ar", explicacao: "O sensor de temperatura (motor ou ar) está fora da faixa esperada.", podeDirigir: "curta", urgencia: "media", causa: "Sensor com defeito, fiação, nível de líquido baixo.", sintomas: "Mostrador errado, motor fora da temperatura ideal, consumo maior.", pecas: ["Sensor de temperatura", "Líquido de arrefecimento"], custo: "R$ 100 a R$ 500" },
    "P012": { titulo: "Sensor da borboleta de aceleração (TPS)", explicacao: "O sensor que informa quanto você pisou no acelerador está fora do padrão.", podeDirigir: "curta", urgencia: "media", causa: "TPS desgastado, borboleta suja, fiação.", sintomas: "Aceleração irregular, motor em modo de contingência.", pecas: ["Sensor TPS", "Limpeza da borboleta"], custo: "R$ 150 a R$ 800" },
    "P013": { titulo: "Sensor de oxigênio dianteiro (Banco 1, Sensor 1)", explicacao: "O sensor principal de mistura está fora do padrão — ele afeta consumo e potência.", podeDirigir: "curta", urgencia: "media", causa: "Sensor O₂ envelhecido, vazamento de escapamento, vazamento de vácuo.", sintomas: "Consumo aumentado, luz da injeção acesa.", pecas: ["Sensor O₂"], custo: "R$ 150 a R$ 800" },
    "P014": { titulo: "Sensor de oxigênio / controle de emissões", explicacao: "Componente de emissões (O₂ ou EGR) fora da faixa esperada.", podeDirigir: "sim", urgencia: "baixa", causa: "Sensor de oxigênio envelhecido, catalisador gasto.", sintomas: "Luz da injeção acesa, consumo um pouco maior.", pecas: ["Sensor O₂"], custo: "R$ 150 a R$ 800" },
    "P015": { titulo: "Sensor de oxigênio do segundo banco", explicacao: "O sensor O₂ do lado oposto do motor (banco 2) está fora do padrão.", podeDirigir: "curta", urgencia: "media", causa: "Sensor O₂ com defeito, vazamento de escapamento.", sintomas: "Luz acesa, consumo maior.", pecas: ["Sensor O₂"], custo: "R$ 150 a R$ 800" },
    "P017": { titulo: "Controle de mistura (ar × combustível)", explicacao: "O motor está compensando mistura muito rica ou muito pobre e chegou ao limite.", podeDirigir: "curta", urgencia: "alta", causa: "Vazamento de vácuo, MAF/Bomba de combustível, injetores.", sintomas: "Motor falhando, consumo alto, marcha lenta irregular.", pecas: ["Sensor MAF", "Sensor O₂", "Bomba de combustível"], custo: "R$ 150 a R$ 900" },
    "P019": { titulo: "Pressão de combustível (trilho/common rail)", explicacao: "A pressão de combustível está fora do esperado para o motor trabalhar.", podeDirigir: "nao", urgencia: "alta", causa: "Bomba de alta pressão, injetores vazando, sensor, combustível sujo.", sintomas: "Motor sem força, modo de emergência, não pega.", pecas: ["Bomba de alta pressão", "Filtro de combustível"], custo: "R$ 500 a R$ 4.000" },
    "P020": { titulo: "Injetores de combustível (circuito elétrico)", explicacao: "A central não está conseguindo acionar um ou mais injetores.", podeDirigir: "curta", urgencia: "alta", causa: "Injetor queimado, fiação, módulo de injeção.", sintomas: "Motor falhando, perda de potência, cheiro de combustível.", pecas: ["Injetores", "Chicote da injeção"], custo: "R$ 200 a R$ 1.800" },
    "P023": { titulo: "Bombas e pressão de combustível", explicacao: "O sistema de alimentação de combustível está com problema elétrico ou de pressão.", podeDirigir: "nao", urgencia: "critica", causa: "Bomba de combustível, relé, fusível, sensor de pressão.", sintomas: "Carro morre e não religa, não pega.", pecas: ["Bomba de combustível", "Relé"], custo: "R$ 200 a R$ 1.500" },
    "P030": { titulo: "Falha de ignição (misfire)", explicacao: "O motor está perdendo combustão em um ou mais cilindros — é o que causa trepidação.", podeDirigir: "curta", urgencia: "alta", causa: "Velas gastas, bobinas vencidas, injetores, vácuo.", sintomas: "Trepidação, perda de potência, luz da injeção acesa.", pecas: ["Velas de ignição", "Bobinas de ignição", "Injetores"], custo: "R$ 150 a R$ 800" },
    "P032": { titulo: "Sensor de detonação (anti-batida)", explicacao: "O sensor que escuta a batida do motor está com circuito com defeito.", podeDirigir: "curta", urgencia: "media", causa: "Sensor, fiação, aperto da massa incorreto.", sintomas: "Motor sem força, consumo maior.", pecas: ["Sensor de detonação"], custo: "R$ 200 a R$ 900" },
    "P033": { titulo: "Sensor de rotação do virabrequim (CKP)", explicacao: "O sensor que dá o tempo de ignição e injeção está com falha.", podeDirigir: "nao", urgencia: "critica", causa: "Sensor CKP, engrenagem, fiação, correia.", sintomas: "Carro morre e não religa, não pega, trepidação.", pecas: ["Sensor de rotação (CKP)"], custo: "R$ 250 a R$ 1.200" },
    "P034": { titulo: "Sensor de rotação do comando de válvulas (CMP)", explicacao: "O sensor que sincroniza as válvulas está com falha.", podeDirigir: "nao", urgencia: "critica", causa: "Sensor CMP, correia de comando esticada, fiação.", sintomas: "Não pega, morre andando, marcha lenta ruim.", pecas: ["Sensor de rotação do comando (CMP)"], custo: "R$ 250 a R$ 1.300" },
    "P035": { titulo: "Bobinas de ignição (circuito)", explicacao: "O circuito elétrico de uma bobina de ignição está com falha.", podeDirigir: "curta", urgencia: "alta", causa: "Bobina queimada, chicote, módulo de ignição.", sintomas: "Motor falhando, treme no ralento, sem potência.", pecas: ["Bobinas de ignição"], custo: "R$ 150 a R$ 700" },
    "P040": { titulo: "Recirculação de gases do escapamento (EGR)", explicacao: "A válvula de EGR não está trabalhando direito — costuma entupir de carbonização.", podeDirigir: "curta", urgencia: "media", causa: "Válvula EGR travada, passagens entupidas, fiação.", sintomas: "Perda de potência, motor falhando, consumo maior.", pecas: ["Válvula EGR"], custo: "R$ 200 a R$ 1.200" },
    "P042": { titulo: "Catalisador (Banco 1)", explicacao: "O catalisador não está mais convertendo os gases direito (ou o sensor dele está ruim).", podeDirigir: "curta", urgencia: "media", causa: "Catalisador desgastado, sensor O₂ traseiro, motor queimando mal.", sintomas: "Luz acesa, cheiro de enxofre, menos potência.", pecas: ["Catalisador", "Sensor O₂"], custo: "R$ 400 a R$ 3.500" },
    "P043": { titulo: "Catalisador (Banco 2)", explicacao: "Catalisador do segundo banco com desempenho baixo.", podeDirigir: "curta", urgencia: "media", causa: "Catalisador desgastado ou sensor O₂ ruim.", sintomas: "Luz acesa, cheiro de enxofre.", pecas: ["Catalisador", "Sensor O₂"], custo: "R$ 400 a R$ 3.500" },
    "P044": { titulo: "Sistema de vapores do tanque (EVAP)", explicacao: "Vapores de combustível não estão sendo recolhidos como deveriam. Frequentemente é só a tampa do tanque.", podeDirigir: "sim", urgencia: "baixa", causa: "Tampa do tanque, mangueiras, válvula do carvão ativado.", sintomas: "Luz acesa, cheiro ocasional de gasolina.", pecas: ["Tampa do tanque", "Mangueiras EVAP"], custo: "R$ 30 a R$ 500" },
    "P045": { titulo: "Sistema de vapores do tanque (EVAP) — válvulas", explicacao: "Válvulas do sistema de vapores do tanque com falha ou vazamento.", podeDirigir: "sim", urgencia: "baixa", causa: "Tampa do tanque, solenoide do carvão, mangueira.", sintomas: "Luz da injeção acesa.", pecas: ["Tampa do tanque", "Válvula do carvão ativado"], custo: "R$ 30 a R$ 500" },
    "P050": { titulo: "Velocidade e marcha lenta", explicacao: "Sensor de velocidade ou controle de marcha lenta fora do padrão.", podeDirigir: "curta", urgencia: "media", causa: "Sensor de velocidade, válvula IAC, borboleta suja.", sintomas: "Velocímetro errado, motor apagando no semáforo.", pecas: ["Sensor de velocidade", "Válvula IAC"], custo: "R$ 150 a R$ 800" },
    "P056": { titulo: "Tensão elétrica do veículo", explicacao: "Tensão da bateria/alternador fora da faixa correta.", podeDirigir: "curta", urgencia: "alta", causa: "Alternador, bateria velha, correia frouxa, massa ruim.", sintomas: "Luz da bateria acesa, farol fraco, painel reiniciando.", pecas: ["Bateria", "Alternador"], custo: "R$ 350 a R$ 1.800" },
    "P060": { titulo: "Central do motor (ECU) — falha interna", explicacao: "Problema dentro do computador do motor ou na rede de comunicação.", podeDirigir: "nao", urgencia: "critica", causa: "ECU com defeito, chicote danificado, queda de tensão, oxidação.", sintomas: "Motor não pega, várias luzes acesas, comportamento aleatório.", pecas: ["Diagnóstico da ECU"], custo: "R$ 500 a R$ 4.000" },
    "P070": { titulo: "Transmissão — falha genérica", explicacao: "O módulo do câmbio encontrou problema (código específico fica no módulo do câmbio).", podeDirigir: "nao", urgencia: "alta", causa: "Óleo do câmbio vencido, solenoides, sensores, chicote.", sintomas: "Câmbio travando, engate brusco, marcha reduzida.", pecas: ["Óleo do câmbio", "Solenoides"], custo: "R$ 300 a R$ 3.000" },
    "P071": { titulo: "Transmissão — sensores de temperatura e velocidade", explicacao: "Sensores da transmissão (temperatura ou velocidade) fora do padrão.", podeDirigir: "nao", urgencia: "alta", causa: "Sensores da transmissão, chicote, rotor magnético.", sintomas: "Câmbio em modo de contingência, velocímetro falhando.", pecas: ["Sensores da transmissão"], custo: "R$ 300 a R$ 1.800" },
    "P073": { titulo: "Transmissão — relação de marcha incorreta", explicacao: "A transmissão não está entregando a redução correta — pode estar patinando.", podeDirigir: "nao", urgencia: "critica", causa: "Óleo vencido, solenoides, embreagem interna gasta.", sintomas: "Motor alto e carro não anda, cheiro de óleo queimado.", pecas: ["Óleo do câmbio", "Revisão interna"], custo: "R$ 500 a R$ 6.000" },
    "P074": { titulo: "Transmissão — convertidor de casal (TCC)", explicacao: "O convertidor de casal não está travando direito, aumentando o consumo.", podeDirigir: "curta", urgencia: "media", causa: "Solenoide do TCC, óleo do câmbio velho.", sintomas: "Consumo alto, marcha lenta oscilando.", pecas: ["Óleo do câmbio", "Solenoide do TCC"], custo: "R$ 400 a R$ 2.500" },
    "P075": { titulo: "Transmissão — solenoides de troca de marcha", explicacao: "Um dos solenoides que engata as marchas está com defeito.", podeDirigir: "nao", urgencia: "alta", causa: "Solenoide queimado, óleo sujo, chicote.", sintomas: "Marcha específica não engata, engate brusco.", pecas: ["Kit de solenoides", "Óleo do câmbio"], custo: "R$ 400 a R$ 2.500" },
    "C00": { titulo: "Sistema de freio assistido (ABS/EBD)", explicacao: "O sistema ABS/EBD detectou falha e pode ter desativado o freio eletrônico.", podeDirigir: "nao", urgencia: "alta", causa: "Sensores de roda, módulo ABS, fluido de freio velho, chicote.", sintomas: "Luz do ABS acesa, pedal pulsando ou afundando.", pecas: ["Sensores de roda", "Fluido de freio"], custo: "R$ 150 a R$ 4.000" },
    "U00": { titulo: "Rede de comunicação do veículo (CAN)", explicacao: "Os módulos eletrônicos do carro estão sem comunicação entre si.", podeDirigir: "nao", urgencia: "alta", causa: "Chicote danificado, massa ruim, módulo queimado.", sintomas: "Vários erros ao mesmo tempo, painel com luzes acesas.", pecas: ["Diagnóstico de rede CAN"], custo: "R$ 300 a R$ 2.500" },
    "U01": { titulo: "Módulo sem comunicação", explicacao: "Um dos computadores do carro não está respondendo na rede.", podeDirigir: "nao", urgencia: "alta", causa: "Fusível, massa, chicote ou módulo queimado.", sintomas: "Função do módulo parada, luz acesa.", pecas: ["Diagnóstico do módulo"], custo: "R$ 300 a R$ 3.000" },
    "B00": { titulo: "Segurança passiva (airbag e cintos)", explicacao: "O sistema de airbag/cinto detectou falha. O reforço pode não funcionar em um acidente.", podeDirigir: "sim", urgencia: "alta", causa: "Conectores sob os bancos, sensores de impacto, chicote da coluna.", sintomas: "Luz do airbag acesa no painel.", pecas: ["Revisão do sistema SRS (airbag)"], custo: "R$ 300 a R$ 2.500" }
};

function obterDtcInfoPT(codigo) {
    const cod = String(codigo || '').toUpperCase().trim();
    if (DTC_PT_BR[cod]) return DTC_PT_BR[cod];
    const familia = FAMILIAS_DTC_PT[cod.slice(0, 3)] || FAMILIAS_DTC_PT[cod.slice(0, 4)];
    if (familia) return familia;
    const sistema = obterSistemaDTC(cod);
    const subsistema = obterSubsistemaDTC(cod);
    return {
        titulo: `Falha no sistema ${sistema}`,
        explicacao: `O módulo do veículo registrou o código ${cod} (${sistema}${subsistema && subsistema !== 'Subsistema não identificado' ? ' — ' + subsistema : ''}). Ainda não temos explicação específica para este código em português.`,
        podeDirigir: 'curta',
        urgencia: 'media',
        causa: 'Peça o diagnóstico completo à oficina para confirmar a causa.',
        sintomas: 'Pode não haver sintoma perceptível; a luz do painel costuma acender.',
        pecas: [],
        custo: 'Diagnóstico a partir de R$ 80'
    };
}

function gerarHtmlDtcPt(codigo, pt) {
    const urgCor = URGENCIA_CORES[pt.urgencia] || URGENCIA_CORES.media;
    const dirigirCor = DIRIGIR_CORES[pt.podeDirigir] || '#94a3b8';
    const dirigirTxt = DIRIGIR_TEXTO[pt.podeDirigir] || '';
    const urgLabel = { baixa: 'baixa', media: 'média', alta: 'alta', critica: 'crítica' }[pt.urgencia] || 'média';
    const pecas = Array.isArray(pt.pecas) ? pt.pecas.filter(Boolean) : [];
    return `
        <div style="margin-top:10px; padding:11px; background:rgba(255,255,255,0.04); border-radius:8px; border:1px solid rgba(255,255,255,0.07);">
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">
                <span style="background:${urgCor}; color:#000; font-size:8px; font-weight:900; padding:3px 7px; border-radius:4px; text-transform:uppercase;">Urgência: ${urgLabel}</span>
                <span style="background:${dirigirCor}; color:#000; font-size:8px; font-weight:900; padding:3px 7px; border-radius:4px;">${escapeHtml(dirigirTxt)}</span>
            </div>
            <div style="font-size:13px; font-weight:800; color:#fff; margin-bottom:5px;">${escapeHtml(pt.titulo)}</div>
            <p style="font-size:12px; line-height:1.5; color:#cbd5e1; margin:0;">${escapeHtml(pt.explicacao)}</p>
            ${pt.causa ? `<div style="margin-top:7px; font-size:10px; color:#94a3b8;"><strong style="color:var(--warning);">Por que acontece:</strong> ${escapeHtml(pt.causa)}</div>` : ''}
            ${pt.sintomas ? `<div style="margin-top:4px; font-size:10px; color:#94a3b8;"><strong style="color:var(--accent);">O que você sente:</strong> ${escapeHtml(pt.sintomas)}</div>` : ''}
            ${pecas.length ? `<div style="margin-top:4px; font-size:10px; color:#94a3b8;"><strong style="color:var(--success);">Peças prováveis:</strong> ${escapeHtml(pecas.join(', '))}</div>` : ''}
            ${pt.custo ? `<div style="margin-top:4px; font-size:10px; color:#94a3b8;"><strong>Custo estimado:</strong> ${escapeHtml(pt.custo)}</div>` : ''}
        </div>
        <div style="margin-top:9px; font-size:9px; color:#64748b; text-transform:uppercase; font-weight:700; letter-spacing:0.5px;">Detalhamento técnico</div>`;
}

function gerarHtmlErroTorque(codigo) {
    const sistema = obterSistemaDTC(codigo);
    const subsistema = obterSubsistemaDTC(codigo);
    const info = obterDTCInfo(codigo);
    const pt = obterDtcInfoPT(codigo);
    const desc = escapeHtml(info ? info.description : "Descrição detalhada não cadastrada.");
    const causa = info ? info.cause : '';
    const sintomas = info ? info.symptoms : '';
    const reparo = info ? info.repair : '';
    const nivelCor = (info && info.severity === 'high') ? 'var(--danger)' : (info && info.severity === 'low') ? 'var(--success)' : 'var(--warning)';
    
    let html = `
        <div style="margin-bottom: 15px; padding: 15px; background: rgba(255,0,85,0.05); border-radius: 12px; border-left: 4px solid ${nivelCor};">
            <div style="font-size: 1.8rem; font-weight: 900; color: ${nivelCor}; line-height: 1;">${codigo}</div>
            <div style="font-size: 9px; color: var(--accent); text-transform: uppercase; font-weight: 800; margin: 6px 0;">
                ${escapeHtml(sistema)}${subsistema ? ' — ' + escapeHtml(subsistema) : ''}
            </div>${gerarHtmlDtcPt(codigo, pt)}
            <p style="font-size: 11px; line-height: 1.4; color: #94a3b8; margin: 0;">${desc}</p>`;
    if (causa) {
        html += `<div style="margin-top:8px; font-size:10px; color:#94a3b8;"><strong style="color:var(--warning);">Possíveis causas:</strong> ${escapeHtml(typeof causa === 'string' ? causa : Array.isArray(causa) ? causa.join(', ') : '')}</div>`;
    }
    if (sintomas) {
        html += `<div style="margin-top:4px; font-size:10px; color:#94a3b8;"><strong style="color:var(--accent);">Sintomas:</strong> ${escapeHtml(typeof sintomas === 'string' ? sintomas : Array.isArray(sintomas) ? sintomas.join(', ') : '')}</div>`;
    }
    if (reparo) {
        const rep = typeof reparo === 'object' ? `${reparo.difficulty || ''} ${reparo.estimated_hours ? '(' + reparo.estimated_hours + 'h)' : ''}` : reparo;
        if (String(rep).trim()) html += `<div style="margin-top:4px; font-size:10px; color:#94a3b8;"><strong style="color:var(--success);">Reparo:</strong> ${escapeHtml(rep)}</div>`;
    }
    html += `</div>`;
    return html;
}

function parseObdResponse(response, pidCtx) {
    // Normalize: handle both BLE (\r\r>) and Serial (\r\n>) terminators
    let normalized = response.replace(/\r\r?>/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n').map(line => {
        let l = line.trim();
        // Add spaces between hex bytes for OBD responses (BLE format: "410C11CC" → "41 0C 11 CC")
        if (/^4[0-9A-F]{2,}/i.test(l) && !l.includes(' ')) {
            l = l.replace(/([0-9A-F]{2})/gi, '$1 ').trim();
        }
        return l;
    }).filter(line => line.length > 0);

    for (const line of lines) {
        // Qualquer resposta OBD válida (41.., 49.., 7F..) = adaptador vivo → zera o contador de "link mudo".
        if (/^(4[0-9A-F]|49|7F)/i.test(line)) noDataCount = 0;

        if (line.includes("NO DATA") || line.includes("UNABLE TO CONNECT")) {
            noDataCount++;
            // Marca o PID específico como não suportado (funciona para QUALQUER PID, não só os mapeados).
            if (pidCtx) {
                pidFailures[pidCtx] = (pidFailures[pidCtx] || 0) + 1;
                if (!PIDS_ESSENCIAIS.has(pidCtx) && pidFailures[pidCtx] >= PID_FAIL_THRESHOLD && !pidUnsupported[pidCtx]) {
                    pidUnsupported[pidCtx] = true;
                    if (pidToKey[pidCtx]) {
                        pidSupport[pidToKey[pidCtx]] = false;
                        leiturasOBD[pidToKey[pidCtx]] = 0;
                    }
                    AGXLogger.log('PID_UNSUPPORTED', `${pidCtx} não suportado após ${PID_FAIL_THRESHOLD} falhas`);
                }
            }
            // NUNCA desconectar por NO DATA. Apenas loga e reajusta o ELM de forma leve.
            if (noDataCount >= NO_DATA_THRESHOLD && !modoSimulacao) {
                noDataCount = 0;
                AGXLogger.log('NO_DATA_RECOVER', `${NO_DATA_THRESHOLD}+ respostas vazias seguidas — reajustando ELM (sem desconectar)`);
                _reinicializarElmLeve();
            }
            // Painel de scan: atualiza no máximo 1x (não reescreve DOM no caminho quente).
            if (!_scanNoDataShown) {
                _scanNoDataShown = true;
                const scanActive = document.getElementById('scan-active');
                const res = document.getElementById('scan-result');
                const resContent = document.getElementById('scan-result-content');
                if (scanActive && res && resContent) {
                    scanActive.classList.add('hidden');
                    res.classList.remove('hidden');
                    resContent.innerHTML = `<div style="color:var(--success); font-weight:800; font-size:10px"><i class="fas fa-check-circle"></i> STATUS:</div>
                             <p style="font-size:12px; margin:5px 0 15px;">Nenhum código de falha encontrado. Sistema operacional normal.</p>`;
                }
            }
            continue;
        }

        if (line.includes("49 02")) {
            let cleanHex = line.replace(/49\s?02\s?01\s?/, "").replace(/\s/g, "");
            if (cleanHex.length >= 34) {
                let vin = hexToAscii(cleanHex.substring(0, 34));
                const vinEl = document.getElementById('lbl-vin');
                if (vinEl) {
                    vinEl.innerText = vin;
                    document.getElementById('lbl-vin-container').classList.remove('hidden');
                }
                let wmi = vin.substring(0, 3);
                const WMI_DB = {
                    "9BW": "Volkswagen", "9BG": "Chevrolet", "93H": "Fiat",
                    "9BF": "Ford", "93C": "Chery", "93R": "Renault",
                    "93A": "GM", "93M": "Mitsubishi", "93P": "Peugeot",
                    "93T": "Citroën", "93V": "Honda", "93W": "Hyundai",
                    "93X": "Toyota", "93Y": "Kia", "93Z": "Suzuki",
                    "93L": "Nissan", "93N": "Dodge", "93S": "Subaru",
                    "93U": "BMW", "93J": "Mercedes-Benz", "93G": "Audi",
                    "93F": "Jeep", "93B": "Volvo", "93D": "Land Rover",
                    "93K": "Mazda", "93Q": "Mitsubishi", "93I": "Porsche",
                    "9A0": "Agrale", "9A1": "GM Trucks", "9A2": "Iveco",
                    "9A4": "MAN", "9A5": "Scania", "9A6": "Mercedes-Benz Trucks",
                    "9A8": "Volkswagen Trucks", "9AA": "Honda",
                    "9AH": "Hyundai Trucks", "9AJ": "Toyota Trucks",
                    "9AK": "Nissan Trucks", "9AL": "Kia Trucks",
                    "9AM": "Randon", "9AN": "Marcopolo", "9AO": "Busscar",
                    "9AP": "Caetano", "9AQ": "Ashok Leyland", "9AR": "Avelino",
                    "9AS": "Metalpont", "9AT": "Ciferal", "9AU": "Vera Cruz",
                    "9AV": "Thomson", "9AW": "Daimler", "9AX": "Neobus",
                    "9AY": "Terraza", "9AZ": "Viação Ouro",
                    "1C4": "Chrysler", "1D1": "Dodge", "1FA": "Ford",
                    "1FT": "Ford Trucks", "1GC": "GM", "1GM": "GM",
                    "1HG": "Honda", "1J4": "Jeep", "1L1": "Lincoln",
                    "1LN": "Lincoln", "1ME": "Mercury", "1N4": "Nissan",
                    "1NX": "Toyota", "1VW": "Volkswagen", "2C3": "Chrysler",
                    "2D4": "Dodge", "2FA": "Ford", "2G1": "GM",
                    "2HG": "Honda", "2HM": "Hyundai", "2T1": "Toyota",
                    "3C3": "Chrysler", "3D1": "Dodge", "3FA": "Ford",
                    "3G1": "GM", "3HG": "Honda", "3HM": "Hyundai",
                    "3N6": "Nissan", "3VW": "Volkswagen",
                    "4T1": "Toyota", "4T3": "Toyota",
                    "5J6": "Honda", "5TD": "Hyundai", "5YJ": "Tesla",
                    "J10": "Isuzu", "J20": "Daihatsu", "J30": "Suzuki",
                    "J40": "Toyota", "J50": "Subaru", "J60": "Nissan",
                    "J70": "Honda", "J80": "Mazda", "J90": "Kia"
                };
                let montadora = WMI_DB[wmi] || "Desconhecida";
                console.log("Veículo Detectado: " + montadora);
            }
        }

        if (line.includes("43")) {
            document.getElementById('scan-active').classList.add('hidden');
            const res = document.getElementById('scan-result');
            res.classList.remove('hidden');
            const resContent = document.getElementById('scan-result-content');

            const parts = line.split(" ").filter(p => p.length === 2);
            let html = `<div style="color:var(--danger); font-weight:800; font-size:10px; margin-bottom:8px; text-transform:uppercase;"><i class="fas fa-exclamation-triangle"></i> Erros Identificados na ECU:</div>`;
            let startIdx = line.includes("43 01") ? 2 : 1;

            for (let i = startIdx; i < parts.length; i += 2) {
                const hexPair = parts[i] + (parts[i + 1] || "00");
                if (hexPair === "0000") continue;

                const codigoDTC = decodeDTC(hexPair);
                html += gerarHtmlErroTorque(codigoDTC);

                if (codigoDTC.startsWith("P030")) {
                    adicionarAosNecessarios('Bobina de Ignição', `Falha ${codigoDTC} Detectada`, 0, 'Crítica', 15);
                    if (codigoDTC === "P0300") adicionarAosNecessarios('Jogo de Velas de Ignição', 'Falha P0300 Detectada', 0, 'Crítica', 15);
                }
            }

            html += `<button class="btn-main" style="background:var(--warning); color:#000; font-size:10px; padding:8px 12px; margin-top:8px;" onclick="nav('shop', document.querySelectorAll('.dock-item')[3]); alternarSubAbaPecas('sacola');">Buscar Peças</button>`;
            html += `<button class="btn-main" style="background:var(--danger); color:#fff; font-size:10px; padding:8px 12px; margin-top:8px; margin-left:5px;" onclick="limparDTCs()">🗑 Limpar DTCs</button>`;
            resContent.innerHTML = html;
            renderizarPlanoNecessidades();
        }

        if (line.includes("41 A6")) {
            const match = line.match(/41 A6 ([0-9A-F]{2}) ([0-9A-F]{2}) ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                let odoReal = ((parseInt(match[1], 16) * 16777216) + (parseInt(match[2], 16) * 65536) + (parseInt(match[3], 16) * 256) + parseInt(match[4], 16)) / 10;
                const odoEl = document.getElementById('txt-odometro');
                if (odoEl) odoEl.innerHTML = odoReal.toLocaleString() + ' <span style="font-size: 0.9rem; color: #aaa;">KM</span>';
                localStorage.setItem("car_km", Math.round(odoReal));
                if (typeof getVeiculos === 'function') {
                    const vehicles = getVeiculos();
                    const idx = getIdxAtivo();
                    if (vehicles[idx]) {
                        vehicles[idx].km = Math.round(odoReal);
                        salvarVeiculos(vehicles);
                    }
                }
            }
        }

        if (line.includes("41 0C")) {
            const match = line.match(/41 0C ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                noDataCount = 0;
                const rpm = ((parseInt(match[1], 16) * 256) + parseInt(match[2], 16)) / 4;
                leiturasOBD.rpm = rpm;
                const rpmEl = document.getElementById('rpm-num');
                if (rpmEl) rpmEl.innerText = Math.round(rpm);
                const rpmFill = document.getElementById('rpm-fill');
                if (rpmFill) {
                    const pct = (rpm / 8000) * 314;
                    rpmFill.style.strokeDasharray = `${pct} 314`;
                }
                const rpmEsperado = leiturasOBD.velocidade > 5 ? (leiturasOBD.velocidade * 30 + 800) : 800;
                const baseClutch = leiturasOBD.velocidade > 10 ? Math.max(0, ((rpm - rpmEsperado) / rpmEsperado) * 100) : 0;
                leiturasOBD.deslizamentoEmbreagem = Math.min(30, baseClutch);
                if (++_sensorLogCount % 10 === 0 && !modoSimulacao) {
                    AGXLogger.sensorReadings({
                        rpm: Math.round(leiturasOBD.rpm),
                        temp: Math.round(leiturasOBD.tempMotor),
                        fuel: Math.round(leiturasOBD.nivelCombustivel),
                        volt: leiturasOBD.tensaoBateria.toFixed(1),
                        speed: Math.round(leiturasOBD.velocidade),
                        load: Math.round(leiturasOBD.cargaMotor)
                    });
                }
            }
        }

        if (line.includes("41 05")) {
            const match = line.match(/41 05 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.tempMotor = parseInt(match[1], 16) - 40;
                const elTempHeader = document.getElementById('temp-value');
                if (elTempHeader) elTempHeader.innerText = leiturasOBD.tempMotor.toFixed(1) + '°C';
            }
        }

        if (line.includes("41 42")) {
            const match = line.match(/41 42 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.tensaoBateria = ((parseInt(match[1], 16) * 256) + parseInt(match[2], 16)) / 1000;
                const elVoltHeader = document.getElementById('volt-value');
                if (elVoltHeader) elVoltHeader.innerText = leiturasOBD.tensaoBateria.toFixed(1) + 'V';
            }
        }

        if (line.includes("41 0D")) {
            const match = line.match(/41 0D ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.velocidade = parseInt(match[1], 16);
                const rpmEsperado = leiturasOBD.velocidade > 5 ? (leiturasOBD.velocidade * 30 + 800) : 800;
                const baseClutch = leiturasOBD.velocidade > 10 ? Math.max(0, ((leiturasOBD.rpm - rpmEsperado) / rpmEsperado) * 100) : 0;
                leiturasOBD.deslizamentoEmbreagem = Math.min(30, baseClutch);
            }
        }

        if (line.includes("41 04")) {
            const match = line.match(/41 04 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.cargaMotor = parseInt(match[1], 16) / 2.55;
            }
        }

        if (line.includes("41 0F")) {
            const match = line.match(/41 0F ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.tempArAdmissao = parseInt(match[1], 16) - 40;
            }
        }

        if (line.includes("41 11")) {
            const match = line.match(/41 11 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.posAcelerador = parseInt(match[1], 16) / 2.55;
            }
        }

        if (line.includes("41 06")) {
            const match = line.match(/41 06 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.fuelTrimSTFT = (parseInt(match[1], 16) / 1.28) - 100;
            }
        }

        if (line.includes("41 07")) {
            const match = line.match(/41 07 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.fuelTrimLTFT = (parseInt(match[1], 16) / 1.28) - 100;
            }
        }

        if (line.includes("41 0B")) {
            const match = line.match(/41 0B ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.pressaoMAP = parseInt(match[1], 16);
            }
        }

        if (line.includes("41 0A")) {
            const match = line.match(/41 0A ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.pressaoCombustivel = parseInt(match[1], 16) * 3;
            }
        }

        if (line.includes("41 0E")) {
            const match = line.match(/41 0E ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.pontoIgnicao = (parseInt(match[1], 16) / 2) - 64;
            }
        }

        if (line.includes("41 46")) {
            const match = line.match(/41 46 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.tempAmbiente = parseInt(match[1], 16) - 40;
            }
        }

        if (line.includes("41 2F")) {
            const match = line.match(/41 2F ([0-9A-F]{2})/);
            if (match) {
                const nivelAnterior = leiturasOBD.nivelCombustivel;
                const novoNivel = parseInt(match[1], 16) / 2.55;
                leiturasOBD.nivelCombustivel = novoNivel;
                const tanqueCap = parseInt(localStorage.getItem("car_tanque_capacidade")) || 50;
                const litrosRestante = ((novoNivel / 100) * tanqueCap).toFixed(1);
                const elLiters = document.getElementById('val-liters');
                if (elLiters) elLiters.innerText = litrosRestante;
                if (!modoSimulacao && nivelAnterior > 0 && novoNivel > nivelAnterior + 10) {
                    detectarAbastecimento(nivelAnterior, novoNivel);
                }
                nivelCombustivelAnterior = novoNivel;
            }
        }

        if (line.includes("41 01")) {
            const match = line.match(/41 01 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                const byteA = parseInt(match[1], 16);
                leiturasOBD.statusMIL = (byteA & 0x80) !== 0;
                leiturasOBD.qtdDTCs = byteA & 0x7F;
            }
        }

        if (line.includes("41 03")) {
            const match = line.match(/41 03 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                const byteA = parseInt(match[1], 16);
                const byteB = parseInt(match[2], 16);
                const fuelStatus1 = (byteA >> 4) & 0x0F;
                const statuses = { 1: 'Open Loop (cold start)', 2: 'Closed Loop', 3: 'Open Loop (lean)', 4: 'Open Loop (rich)', 5: 'Closed Loop (fault)', 6: '--' };
                leiturasOBD.statusSistemaComb = statuses[fuelStatus1] || '--';
            }
        }

        if (line.includes("41 21")) {
            const match = line.match(/41 21 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.distDesdeDTC = (parseInt(match[1], 16) * 256) + parseInt(match[2], 16);
            }
        }

        if (line.includes("41 4D")) {
            const match = line.match(/41 4D ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.tempoDesdeUltimaPartida = (parseInt(match[1], 16) * 256) + parseInt(match[2], 16);
            }
        }

        if (line.includes("41 4E")) {
            const match = line.match(/41 4E ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.tempoDesdeDTC = (parseInt(match[1], 16) * 256) + parseInt(match[2], 16);
            }
        }

        if (line.includes("41 14")) {
            const match = line.match(/41 14 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.o2Sensor1 = parseInt(match[2], 16) / 200;
                leiturasOBD.nivelO2 = parseFloat(leiturasOBD.o2Sensor1);
            }
        }

        if (line.includes("41 15")) {
            const match = line.match(/41 15 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.o2Sensor2 = parseInt(match[2], 16) / 200;
            }
        }

        if (line.includes("41 16")) {
            const match = line.match(/41 16 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.o2Sensor3 = parseInt(match[2], 16) / 200;
            }
        }

        if (line.includes("41 17")) {
            const match = line.match(/41 17 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.o2Sensor4 = parseInt(match[2], 16) / 200;
            }
        }

        // --- NOVOS PIDs (expansão) ---
        if (line.includes("41 10")) {
            const match = line.match(/41 10 ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.maf = ((parseInt(match[1], 16) * 256) + parseInt(match[2], 16)) / 100;
            }
        }

        if (line.includes("41 52")) {
            const match = line.match(/41 52 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.etanolPercent = (parseInt(match[1], 16) * 100) / 255;
            }
        }

        if (line.includes("41 5C")) {
            const match = line.match(/41 5C ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.tempOleo = parseInt(match[1], 16) - 40;
            }
        }

        if (line.includes("41 5E")) {
            const match = line.match(/41 5E ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.consumoRealLh = ((parseInt(match[1], 16) * 256) + parseInt(match[2], 16)) / 20;
            }
        }

        if (line.includes("41 33")) {
            const match = line.match(/41 33 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.pressaoBarometrica = parseInt(match[1], 16);
            }
        }

        if (line.includes("41 3C")) {
            const match = line.match(/41 3C ([0-9A-F]{2}) ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.tempCatalisador = ((parseInt(match[1], 16) * 256) + parseInt(match[2], 16)) / 10 - 40;
            }
        }

        if (line.includes("41 61")) {
            const match = line.match(/41 61 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.torqueSolicitado = parseInt(match[1], 16) - 125;
            }
        }

        if (line.includes("41 62")) {
            const match = line.match(/41 62 ([0-9A-F]{2})/);
            if (match) {
                leiturasOBD.torqueReal = parseInt(match[1], 16) - 125;
            }
        }

        // --- FIX: Removed random overrides, added real consumption calculation ---
        if (!leiturasOBD.statusSistemaComb || leiturasOBD.statusSistemaComb === '--') {
            leiturasOBD.statusSistemaComb = leiturasOBD.tensaoBateria < 11.5 ? 'Open Loop' : 'Closed Loop';
        }
        const cargaReal = parseFloat(leiturasOBD.cargaMotor) || 0;
        const rpmReal = leiturasOBD.rpm || 0;
        const baseConsumo = 2 + (cargaReal / 100) * 6 + (rpmReal / 8000) * 3;
        leiturasOBD.consumoEsperado = Math.max(1.5, baseConsumo);
        leiturasOBD.consumoInstantaneo = leiturasOBD.consumoRealLh > 0 ? leiturasOBD.consumoRealLh : leiturasOBD.consumoEsperado;
    }

    atualizarAcumuladores();
    addSensorHistory();
    detectarAnomalias();
    RenderTick.marcar();
}

// Alterna entre modo simulado e modo real (hardware conectado)
function toggleObdMode(isSimulated) {
    document.getElementById('btn-obd-sim').classList.toggle('active', isSimulated);
    document.getElementById('btn-obd-real').classList.toggle('active', !isSimulated);

    if (isSimulated && !modoSimulacao) {
        if (pollingTelemetriaId) { clearInterval(pollingTelemetriaId); pollingTelemetriaId = null; }
        modoSimulacao = true;
        tipoConexao = null;
        atualizarBadgeconexao();
        iniciarSimulacao();
        showToast("Modo simulado ativado.", "info");
    } else if (!isSimulated && modoSimulacao) {
        if (!bleCharacteristic && !tipoConexao) {
            showToast("Nenhum adaptador conectado. Use Conectar para vincular.", "error");
            document.getElementById('btn-obd-sim').classList.add('active');
            document.getElementById('btn-obd-real').classList.remove('active');
            return;
        }
        clearInterval(simulationIntervalId);
        modoSimulacao = false;
        atualizarBadgeconexao();
        inicializarPainelReal();
        showToast("Modo real ativado.", "success");
    }
}

function limparDTCs() {
    const kmAtual = localStorage.getItem("car_km");
    if (!confirm("Isso irá limpar todos os códigos de falha (DTCs) da ECU.\n\nDeseja continuar?")) return;

    if (modoSimulacao) {
        showToast("DTCs limpos com sucesso (simulado).", "success");
        document.getElementById('scan-result').classList.add('hidden');
        document.getElementById('scan-idle').classList.remove('hidden');
        return;
    }

    showToast("Limpando DTCs da ECU...", "info");
    sendElmCommand("04").then(() => {
        setTimeout(() => {
            if (kmAtual) {
                localStorage.setItem("car_km", kmAtual);
                if (typeof getVeiculos === 'function') {
                    const v = getVeiculos(); const i = getIdxAtivo();
                    if (v[i]) { v[i].km = parseInt(kmAtual); salvarVeiculos(v); }
                }
            }
            showToast("DTCs limpos com sucesso!", "success");
            document.getElementById('scan-result').classList.add('hidden');
            document.getElementById('scan-idle').classList.remove('hidden');
            sendElmCommand("0101");
        }, 1000);
    }).catch(() => {
        if (kmAtual) {
            localStorage.setItem("car_km", kmAtual);
            if (typeof getVeiculos === 'function') {
                const v = getVeiculos(); const i = getIdxAtivo();
                if (v[i]) { v[i].km = parseInt(kmAtual); salvarVeiculos(v); }
            }
        }
        showToast("Erro ao limpar DTCs.", "error");
    });
}

// Nova versão do scanner acoplada ao novo layout preditivo
function runScanner() {
    document.getElementById('scan-idle').classList.add('hidden');
    document.getElementById('scan-result').classList.add('hidden');
    document.getElementById('scan-active').classList.remove('hidden');
    
    if (!modoSimulacao) {
        sendElmCommand("03");
        return;
    }

    setTimeout(() => {
        document.getElementById('scan-active').classList.add('hidden');
        document.getElementById('scan-result').classList.remove('hidden');
        
        const res = document.getElementById('scan-result-content');
        res.innerHTML = `<div style="color:var(--danger); font-weight:800; font-size:10px; margin-bottom:8px; text-transform:uppercase;"><i class="fas fa-exclamation-triangle"></i> Falhas Detectadas:</div>`;
        res.innerHTML += gerarHtmlErroTorque("P0300");
        res.innerHTML += `<button class="btn-main" style="background:var(--warning); color:#000; font-size:10px; padding:8px 12px; margin-top:8px;" onclick="nav('shop', document.querySelectorAll('.dock-item')[3]); alternarSubAbaPecas('sacola');">Buscar Peças</button>`;
        res.innerHTML += `<button class="btn-main" style="background:var(--danger); color:#fff; font-size:10px; padding:8px 12px; margin-top:8px; margin-left:5px;" onclick="limparDTCs()">🗑 Limpar DTCs</button>`;

        adicionarAosNecessarios('Jogo de Velas de Ignição', 'Falha P0300 Detectada', 0, 'Crítica', 15);
        adicionarAosNecessarios('Bobina de Ignição', 'Falha P0300 Detectada', 0, 'Crítica', 15);

        renderizarPlanoNecessidades();

        const btnShop = document.querySelector("#scan-result button");
        if (btnShop) {
            btnShop.onclick = () => {
                nav('shop', document.querySelectorAll('.dock-item')[3]);
                alternarSubAbaPecas('sacola');
            };
        }
    }, 2000);
}

const SENSORES_OBD = [
    { id: 'rpm', label: 'RPM Motor', icon: '⚙️', unit: '', decimals: 0, min: 0, max: 8000, critico: [6500, 8000], alerta: [5500, 6500] },
    { id: 'velocidade', label: 'Velocidade', icon: '🚗', unit: 'km/h', decimals: 0, min: 0, max: 220, critico: [180, 220], alerta: [140, 180] },
    { id: 'tempMotor', label: 'Temp. Motor', icon: '🌡️', unit: '°C', decimals: 1, min: -40, max: 120, critico: [105, 120], alerta: [95, 105] },
    { id: 'tensaoBateria', label: 'Tensão Bateria', icon: '🔋', unit: 'V', decimals: 1, min: 10, max: 16, critico: [10, 11.5], alerta: [11.5, 12.0] },
    { id: 'cargaMotor', label: 'Carga Motor', icon: '📊', unit: '%', decimals: 0, min: 0, max: 100, critico: [90, 100], alerta: [75, 90] },
    { id: 'posAcelerador', label: 'Pos. Acelerador', icon: '⬆️', unit: '%', decimals: 0, min: 0, max: 100, critico: [90, 100], alerta: [75, 90] },
    { id: 'tempArAdmissao', label: 'Temp. Admissão', icon: '💨', unit: '°C', decimals: 1, min: 0, max: 80, critico: [60, 80], alerta: [50, 60] },
    { id: 'pressaoMAP', label: 'Pressão MAP', icon: '🔴', unit: 'kPa', decimals: 0, min: 0, max: 110, critico: [95, 110], alerta: [80, 95] },
    { id: 'consumoInstantaneo', label: 'Consumo', icon: '⛽', unit: 'L/h', decimals: 1, min: 0, max: 20, critico: [15, 20], alerta: [10, 15] },
    { id: 'nivelO2', label: 'Sensor O₂', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0.01, 0.05], alerta: [0.05, 0.15] },
    { id: 'pontoIgnicao', label: 'Ponto Ignição', icon: '⚡', unit: '°', decimals: 1, min: -64, max: 64, critico: [30, 40], alerta: [25, 30] },
    { id: 'fuelTrimSTFT', label: 'Fuel Trim STFT', icon: '🔧', unit: '%', decimals: 1, min: -30, max: 30, critico: [-30, -20], alerta: [-20, -10], criticoAlto: [20, 30], alertaAlto: [10, 20] },
    { id: 'fuelTrimLTFT', label: 'Fuel Trim LTFT', icon: '🔧', unit: '%', decimals: 1, min: -30, max: 30, critico: [-30, -20], alerta: [-20, -10], criticoAlto: [20, 30], alertaAlto: [10, 20] },
    { id: 'pressaoCombustivel', label: 'Pressão Comb.', icon: '⛽', unit: 'kPa', decimals: 0, min: 0, max: 600, critico: [150, 250], alerta: [250, 300], criticoAlto: [500, 600], alertaAlto: [450, 500] },
    { id: 'tempAmbiente', label: 'Temp. Ambiente', icon: '🌍', unit: '°C', decimals: 1, min: -20, max: 55, critico: [-20, -10], alerta: [-10, 0], criticoAlto: [45, 55], alertaAlto: [40, 45] },
    { id: 'deslizamentoEmbreagem', label: 'Embreagem', icon: '🔗', unit: '%', decimals: 1, min: 0, max: 30, critico: [15, 30], alerta: [8, 15] },
    { id: 'distDesdeDTC', label: 'Dist. desde DTCs', icon: '📏', unit: 'km', decimals: 0, min: 0, max: 65535, critico: [], alerta: [] },
    { id: 'tempoDesdeUltimaPartida', label: 'Tempo Motor', icon: '⏱️', unit: 'min', decimals: 0, min: 0, max: 1440, critico: [480, 1440], alerta: [360, 480] },
    { id: 'tempoDesdeDTC', label: 'Tempo desde DTCs', icon: '📅', unit: 'min', decimals: 0, min: 0, max: 65535, critico: [], alerta: [] },
    { id: 'o2Sensor1', label: 'Sensor O₂ (B1S1)', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0.01, 0.05], alerta: [0.05, 0.15] },
    { id: 'o2Sensor2', label: 'Sensor O₂ (B1S2)', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0.01, 0.05], alerta: [0.05, 0.15] },
    { id: 'o2Sensor3', label: 'Sensor O₂ (B2S1)', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0.01, 0.05], alerta: [0.05, 0.15] },
    { id: 'o2Sensor4', label: 'Sensor O₂ (B2S2)', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0.01, 0.05], alerta: [0.05, 0.15] },
    { id: 'maf', label: 'Vazão MAF', icon: '💨', unit: 'g/s', decimals: 1, min: 0, max: 200, critico: [150, 200], alerta: [120, 150] },
    { id: 'etanolPercent', label: '% Etanol', icon: '⛽', unit: '%', decimals: 0, min: 0, max: 100, critico: [], alerta: [] },
    { id: 'tempOleo', label: 'Temp. Óleo', icon: '🛢️', unit: '°C', decimals: 0, min: 40, max: 150, critico: [130, 150], alerta: [115, 130] },
    { id: 'consumoRealLh', label: 'Consumo Real', icon: '⛽', unit: 'L/h', decimals: 1, min: 0, max: 30, critico: [20, 30], alerta: [15, 20] },
    { id: 'pressaoBarometrica', label: 'Pressão Barom.', icon: '🌍', unit: 'kPa', decimals: 0, min: 80, max: 110, critico: [80, 85], alerta: [85, 90] },
    { id: 'tempCatalisador', label: 'Temp. Catalisador', icon: '🔥', unit: '°C', decimals: 0, min: 0, max: 1000, critico: [850, 1000], alerta: [750, 850] },
    { id: 'torqueSolicitado', label: 'Torque Solicitado', icon: '⚡', unit: '%', decimals: 0, min: -125, max: 130, critico: [100, 130], alerta: [80, 100] },
    { id: 'torqueReal', label: 'Torque Real', icon: '⚡', unit: '%', decimals: 0, min: -125, max: 130, critico: [100, 130], alerta: [80, 100] }
];

let _sensoresCache = null;

function renderizarSensores() {
    const container = document.getElementById('obd-sensores');
    if (!container) return;

    // Map sensor IDs to pidSupport keys
    const sensorPidMap = {
        'maf': 'maf', 'fuelTrimSTFT': 'fuelTrimSTFT', 'fuelTrimLTFT': 'fuelTrimLTFT',
        'pressaoCombustivel': 'pressaoCombustivel', 'pressaoMAP': 'pressaoMAP',
        'tempOleo': 'tempOleo', 'tempAmbiente': 'tempAmbiente',
        'o2Sensor1': 'o2Sensor1', 'o2Sensor2': 'o2Sensor2'
    };

    // Constrói a estrutura uma única vez; depois atualiza só valores/cores.
    if (!_sensoresCache || _sensoresCache.container !== container || _sensoresCache.count !== SENSORES_OBD.length) {
        container.innerHTML = '';
        const nodes = SENSORES_OBD.map(s => {
            const card = document.createElement('div');
            card.style.cssText = 'background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border-left:3px solid var(--success);';
            const label = document.createElement('div');
            label.style.cssText = 'font-size:8px; color:#94a3b8; text-transform:uppercase;';
            label.textContent = `${s.icon} ${s.label}`;
            const value = document.createElement('div');
            value.style.cssText = 'font-size:1.1rem; font-weight:800; color:var(--success);';
            value.textContent = '--';
            card.appendChild(label);
            card.appendChild(value);
            container.appendChild(card);
            return { s, card, label, value, pidKey: sensorPidMap[s.id] };
        });
        _sensoresCache = { container, count: SENSORES_OBD.length, nodes };
    }

    for (const node of _sensoresCache.nodes) {
        const { s, card, label, value, pidKey } = node;

        if (pidKey && !pidSupport[pidKey]) {
            card.style.borderLeft = '3px solid #333';
            card.style.opacity = '0.4';
            label.style.color = '#666';
            value.style.color = '#666';
            value.textContent = 'Não disponível';
            continue;
        }

        card.style.opacity = '1';
        label.style.color = '#94a3b8';

        const val = leiturasOBD[s.id] || 0;
        let cor = 'var(--success)';

        if (s.criticoAlto) {
            if ((val >= s.critico[0] && val <= s.critico[1]) || (val >= s.criticoAlto[0] && val <= s.criticoAlto[1])) {
                cor = 'var(--danger)';
            } else if ((val >= s.alerta[0] && val <= s.alerta[1]) || (val >= s.alertaAlto[0] && val <= s.alertaAlto[1])) {
                cor = 'var(--warning)';
            }
        } else {
            if ((val >= s.critico[0] && val <= s.critico[1]) || (s.id === 'tensaoBateria' && val <= s.critico[1])) {
                cor = 'var(--danger)';
            } else if ((val >= s.alerta[0] && val <= s.alerta[1]) || (s.id === 'tensaoBateria' && val <= s.alerta[1])) {
                cor = 'var(--warning)';
            } else if (s.id === 'nivelO2' && val < 0.1) {
                cor = 'var(--danger)';
            } else if (s.id === 'nivelO2' && val > 0.8) {
                cor = 'var(--warning)';
            }
        }

        card.style.borderLeft = `3px solid ${cor}`;
        value.style.color = cor;
        value.textContent = `${val > 0 ? '+' : ''}${val.toFixed(s.decimals)}${s.unit ? ' ' + s.unit : ''}`;
    }
}

function renderizarDiagnostico() {
    renderizarHistoricoAnomalias();
    const statusIcon = document.getElementById('diag-status-icon');
    const statusText = document.getElementById('diag-status-text');
    const statusSub = document.getElementById('diag-status-sub');
    const alertasContainer = document.getElementById('diag-alertas');
    const sugestoesContainer = document.getElementById('diag-sugestoes');
    if (!statusIcon || !statusText || !alertasContainer || !sugestoesContainer) return;

    const alertas = [];
    const sugestoes = [];
    let nivelGeral = 'ok'; // ok, alerta, critico

    const L = leiturasOBD;

    // --- Temperatura do Motor ---
    if (L.tempMotor > 105) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Motor superaquecendo!', detalhe: `Temperatura em ${L.tempMotor.toFixed(1)}°C (limite: 105°C)` });
        sugestoes.push({ texto: 'Verifique o nível de líquido de arrefecimento e a mangueira do radiador.', prioridade: 'alta' });
    } else if (L.tempMotor > 95) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Temperatura do motor elevada.', detalhe: `${L.tempMotor.toFixed(1)}°C — próximo do limite` });
        sugestoes.push({ texto: 'Possível termostato travado aberto ou ventilador com defeito.', prioridade: 'media' });
    }

    // --- Tensão da Bateria ---
    if (L.tensaoBateria < 11.5) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Bateria descarregando!', detalhe: `Tensão em ${L.tensaoBateria.toFixed(1)}V (mínimo: 12.0V)` });
        sugestoes.push({ texto: 'Alternador pode estar com defeito. Verifique correia e regulador de tensão.', prioridade: 'alta' });
    } else if (L.tensaoBateria < 12.0) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Tensão da bateria baixa.', detalhe: `${L.tensaoBateria.toFixed(1)}V — bateria pode estar fraca` });
        sugestoes.push({ texto: 'Bateria pode precisar de carga ou troca. Verifique os terminais.', prioridade: 'media' });
    } else if (L.tensaoBateria > 15.0) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Sobretensão no sistema elétrico!', detalhe: `${L.tensaoBateria.toFixed(1)}V (máximo: 14.8V)` });
        sugestoes.push({ texto: 'Regulador de tensão com defeito. Pode danificar bateria e eletrônica.', prioridade: 'alta' });
    }

    // --- RPM ---
    if (L.rpm > 6500) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'RPM em zona de perigo!', detalhe: `${Math.round(L.rpm)} RPM — risco de dano ao motor` });
        sugestoes.push({ texto: 'Evite girar o motor acima de 6000 RPM por tempo prolongado.', prioridade: 'alta' });
    } else if (L.rpm > 5500 && L.velocidade < 20) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'RPM alto com veículo parado.', detalhe: `${Math.round(L.rpm)} RPM em ponto morto` });
        sugestoes.push({ texto: 'Marcha lenta pode estar irregular. Verifique vela de ignição e sensor IAT.', prioridade: 'media' });
    }

    // --- Sensor O₂ ---
    if (L.nivelO2 < 0.1) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Sensor O₂ com leitura baixa.', detalhe: `${L.nivelO2.toFixed(2)}V — mistura muito pobre` });
        sugestoes.push({ texto: 'Mistura pobre pode indicar vazamento de ar ou injetor entupido.', prioridade: 'media' });
    } else if (L.nivelO2 > 0.8) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Sensor O₂ com leitura alta.', detalhe: `${L.nivelO2.toFixed(2)}V — mistura muito rica` });
        sugestoes.push({ texto: 'Mistura rica pode indicar injetor vazando, sensor MAP com defeito ou regulador de pressão de combustível travado.', prioridade: 'media' });
        if (L.pressaoMAP > 95) {
            sugestoes.push({ texto: `Pressão MAP elevada (${L.pressaoMAP.toFixed(0)} kPa) combinada com leitura rica — forte indício de falha no sensor MAP.`, prioridade: 'alta' });
        }
    }

    // --- Pressão MAP ---
    if (L.pressaoMAP > 95) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Pressão MAP elevada.', detalhe: `${L.pressaoMAP.toFixed(0)} kPa — acima do esperado` });
        sugestoes.push({ texto: 'Possível obstrução na admissão ou válvula EGR travada.', prioridade: 'media' });
    }

    // --- Consumo ---
    if (L.consumoInstantaneo > 15 && L.cargaMotor < 30) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Consumo elevado para a carga atual.', detalhe: `${L.consumoInstantaneo.toFixed(1)} L/h com ${L.cargaMotor.toFixed(0)}% de carga` });
        sugestoes.push({ texto: 'Consumo alto pode indicar vaza de combustível ou sensor de fluxo com defeito.', prioridade: 'media' });
    }

    // --- Temp Ar Admissão ---
    if (L.tempArAdmissao > 55) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Ar de admissão muito quente.', detalhe: `${L.tempArAdmissao.toFixed(1)}°C — afeta performance` });
        sugestoes.push({ texto: 'Ar quente reduz potência. Verifique o intercooler e ductos de admissão.', prioridade: 'baixa' });
    }

    // --- FUEL TRIM (STFT / LTFT) ---
    const ftStft = L.fuelTrimSTFT;
    const ftLtft = L.fuelTrimLTFT;

    if (ftStft > 20 || ftLtft > 20) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Fuel Trim muito alto (mistura pobre)!', detalhe: `STFT: ${ftStft > 0 ? '+' : ''}${ftStft.toFixed(1)}% | LTFT: ${ftLtft > 0 ? '+' : ''}${ftLtft.toFixed(1)}%` });
        sugestoes.push({ texto: 'ECU adicionando muita correção. Possíveis causas: vazamento de ar na admissão, injetor entupido, sensor MAP/MAF sujo ou descalibrado, ou baixa pressão de combustível.', prioridade: 'alta' });
        if (L.pressaoMAP > 95) {
            sugestoes.push({ texto: `Pressão MAP elevada (${L.pressaoMAP.toFixed(0)} kPa) — pode indicar obstrução na admissão ou sensor MAP com defeito. Verifique dutos, filtro de ar e conexões.`, prioridade: 'alta' });
        }
        if (L.nivelO2 > 0.6) {
            sugestoes.push({ texto: `Sensor O₂ lendo rico (${L.nivelO2.toFixed(2)}V) mas fuel trim está pobre — possível sensor MAP reportando pressão incorreta à ECU.`, prioridade: 'alta' });
        }
    } else if (ftStft < -20 || ftLtft < -20) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Fuel Trim muito baixo (mistura rica)!', detalhe: `STFT: ${ftStft > 0 ? '+' : ''}${ftStft.toFixed(1)}% | LTFT: ${ftLtft > 0 ? '+' : ''}${ftLtft.toFixed(1)}%` });
        sugestoes.push({ texto: 'ECU reduzindo muita correção. Possíveis causas: injetor vazando, regulador de pressão com defeito, sensor MAP descalibrado ou sensor O₂ descalibrado.', prioridade: 'alta' });
    } else if (ftStft > 10 || ftLtft > 10) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Fuel Trim elevado (tendência pobre).', detalhe: `STFT: ${ftStft > 0 ? '+' : ''}${ftStft.toFixed(1)}% | LTFT: ${ftLtft > 0 ? '+' : ''}${ftLtft.toFixed(1)}%` });
        sugestoes.push({ texto: 'Mistura lean. Verificar filtro de ar, conexões da admissão e limpeza dos bicos injetores.', prioridade: 'media' });
    } else if (ftStft < -10 || ftLtft < -10) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Fuel Trim baixo (tendência rica).', detalhe: `STFT: ${ftStft > 0 ? '+' : ''}${ftStft.toFixed(1)}% | LTFT: ${ftLtft > 0 ? '+' : ''}${ftLtft.toFixed(1)}%` });
        sugestoes.push({ texto: 'Mistura rica. Verificar se injetores estão vazando ou sensor O₂ está com leitura correta.', prioridade: 'media' });
    }

    // --- TEMP. AMBIENTE × FUEL TRIM (cross-correlation) ---
    if (L.tempAmbiente > 45 && (ftStft > 15 || ftLtft > 15)) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Temperatura ambiente incompatível + Fuel Trim anormal!', detalhe: `Sensor ambiente: ${L.tempAmbiente.toFixed(1)}°C | STFT: ${ftStft > 0 ? '+' : ''}${ftStft.toFixed(1)}% — a ECU pode estar calculando mistura errada com base em temperatura falsa.` });
        sugestoes.push({ texto: 'Se a temperatura ambiente está errada (sensor defeituoso), a ECU usa esse valor para calcular injeção. Uma leitura de 47°C quando na realidade são 25°C faz a ECU ajustar a mistura incorretamente — isso pode ser a CAUSA RAIZ dos problemas de fuel trim.', prioridade: 'alta' });
        sugestoes.push({ texto: 'Verifique o sensor de temperatura ambiente (PID 0146) com multímetro. Se estiver fora de faixa (tipicamente -40°C a +125°C), substitua-o. Após a correção, refaça o diagnóstico.', prioridade: 'alta' });
    }

    // --- PRESSÃO DE COMBUSTÍVEL ---
    if (L.pressaoCombustivel < 250) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Pressão de combustível baixa!', detalhe: `${L.pressaoCombustivel.toFixed(0)} kPa (mínimo: 300 kPa)` });
        sugestoes.push({ texto: 'Bomba de combustível fraca, filtro entupido ou regulador de pressão com defeito.', prioridade: 'alta' });
    } else if (L.pressaoCombustivel < 300) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Pressão de combustível abaixo do ideal.', detalhe: `${L.pressaoCombustivel.toFixed(0)} kPa` });
        sugestoes.push({ texto: 'Verificar filtro de combustível e bomba. Pode causar falhas em alta rotação.', prioridade: 'media' });
    } else if (L.pressaoCombustivel > 500) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Pressão de combustível alta demais.', detalhe: `${L.pressaoCombustivel.toFixed(0)} kPa (máximo: 450 kPa)` });
        sugestoes.push({ texto: 'Retorno de combustível bloqueado ou regulador de pressão travado. Pode danificar injetores.', prioridade: 'alta' });
    }

    // --- TEMP. PÓS-CATALISADOR ---
    if (L.tempCatalisador > 850) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Catalisador superaquecendo!', detalhe: `${L.tempCatalisador.toFixed(0)}°C (limite: 850°C)` });
        sugestoes.push({ texto: 'Catalisador pode estar entupido ou queimando. Risco de danos ao motor. Verificar ignição e mistura.', prioridade: 'alta' });
    } else if (L.tempCatalisador > 750) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Temperatura do catalisador elevada.', detalhe: `${L.tempCatalisador.toFixed(0)}°C` });
        sugestoes.push({ texto: 'Catalisador pode estar degradando. Verificar se há misfire ou fuel trim anormal.', prioridade: 'media' });
    }

    // --- DESLIZAMENTO DA EMBREAGEM ---
    if (L.deslizamentoEmbreagem > 15) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Embreagem deslizando significativamente!', detalhe: `${L.deslizamentoEmbreagem.toFixed(1)}% de deslizamento` });
        sugestoes.push({ texto: 'Embreagem gasta. Disco, mola e/ou rolamento precisam de troca. Substituir kit completo.', prioridade: 'alta' });
    } else if (L.deslizamentoEmbreagem > 8) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Possível deslizamento inicial da embreagem.', detalhe: `${L.deslizamentoEmbreagem.toFixed(1)}% de deslizamento` });
        sugestoes.push({ texto: 'Monitorar. Se aumentar, considerar troca do kit de embreagem.', prioridade: 'media' });
    }

    // --- TEMP. AMBIENTE ---
    if (L.tempAmbiente > 45) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Temperatura ambiente absurdamente alta!', detalhe: `${L.tempAmbiente.toFixed(1)}°C — valor incompatível com clima brasileiro. Possível erro de sensor.` });
        sugestoes.push({ texto: 'Leitura acima de 45°C é extremamente rara no Brasil. Verifique se o sensor de temperatura ambiente está funcionando corretamente. Se o carro estava parado ao sol, aguarde 10min e refaça o teste.', prioridade: 'alta' });
        if (L.tempArAdmissao > 0 && L.tempArAdmissao < 40) {
            sugestoes.push({ texto: `Temperatura do ar de admissão (${L.tempArAdmissao.toFixed(1)}°C) está normal — isso confirma possível erro no sensor de ambiente.`, prioridade: 'alta' });
        }
        const ftAbs = Math.max(Math.abs(ftStft), Math.abs(ftLtft));
        if (ftAbs > 10) {
            sugestoes.push({ texto: `⚠️ IMPORTANTE: Fuel trim está anormal (${ftAbs > 0 ? '+' : ''}${ftStft.toFixed(1)}% / ${ftLtft > 0 ? '+' : ''}${ftLtft.toFixed(1)}%). Um sensor de temperatura ambiente defeituoso pode ser a CAUSA RAIZ — a ECU usa essa temperatura para calcular a mistura. Uma leitura errada gera injeção incorreta.`, prioridade: 'alta' });
        }
    } else if (L.tempAmbiente > 40) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Temperatura ambiente muito alta.', detalhe: `${L.tempAmbiente.toFixed(1)}°C — pode afetar performance do motor` });
        sugestoes.push({ texto: 'Ar quente reduz potência. Evite acelerações pesadas em dias muito quentes.', prioridade: 'baixa' });
    } else if (L.tempAmbiente < -5) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Temperatura ambiente abaixo de zero.', detalhe: `${L.tempAmbiente.toFixed(1)}°C — motor pode demorar a atingir temperatura operacional` });
        sugestoes.push({ texto: 'Em frio extremo, aguarde o motor aquecer antes de acelerar. Use combustível de inverno se disponível.', prioridade: 'baixa' });
    }

    // --- MIL (Luz de Averia) ---
    if (L.statusMIL) {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Luz de Averia (MIL) Acesa!', detalhe: `${L.qtdDTCs} código(s) de falha registrado(s)` });
        sugestoes.push({ texto: 'Execute um diagnóstico completo para identificar os códigos de falha. Não ignore a luz de advertência.', prioridade: 'alta' });
    }

    // --- Sistema de Combustível ---
    if (L.statusSistemaComb === 'Open Loop (cold start)' || L.statusSistemaComb === 'Open Loop (lean)' || L.statusSistemaComb === 'Open Loop (rich)') {
        if (L.tempMotor > 80) {
            if (nivelGeral !== 'critico') nivelGeral = 'alerta';
            alertas.push({ nivel: 'alerta', msg: 'Sistema em Open Loop com motor quente.', detalhe: `Status: ${L.statusSistemaComb}` });
            sugestoes.push({ texto: 'Motor aquecido deveria estar em Closed Loop. Verificar sensores O₂ e sensor de temperatura.', prioridade: 'media' });
        }
    } else if (L.statusSistemaComb === 'Closed Loop (fault)') {
        nivelGeral = 'critico';
        alertas.push({ nivel: 'critico', msg: 'Sistema de combustível com falha!', detalhe: 'Closed Loop com erro detectado' });
        sugestoes.push({ texto: 'Falha no controle de mistura. Verificar sensores O₂, injetores e sensor MAF.', prioridade: 'alta' });
    }

    // --- Sensor O₂ (B1S1 vs B1S2) ---
    if (L.o2Sensor1 > 0.01 && L.o2Sensor2 > 0.01) {
        const diffO2 = Math.abs(L.o2Sensor1 - L.o2Sensor2);
        if (diffO2 < 0.1 && L.o2Sensor1 > 0.6) {
            if (nivelGeral !== 'critico') nivelGeral = 'alerta';
            alertas.push({ nivel: 'alerta', msg: 'Sensor O₂ traseiro alto.', detalhe: `B1S1: ${L.o2Sensor1.toFixed(2)}V | B1S2: ${L.o2Sensor2.toFixed(2)}V` });
            sugestoes.push({ texto: 'Sensor O₂ traseiro alto pode indicar catalisador degradado. Verifique a eficiência do catalisador.', prioridade: 'media' });
        }
    }

    // ====================================================================
    // CROSS-CORRELATION: Análise cruzada de sensores
    // ====================================================================

    // --- 1. TEMP. MOTOR × TEMP. AMBIENTE ---
    if (L.tempMotor > 100 && L.tempAmbiente < 25 && L.tempAmbiente > 0) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Motor quente com ambiente fresco!', detalhe: `Motor: ${L.tempMotor.toFixed(1)}°C | Ambiente: ${L.tempAmbiente.toFixed(1)}°C` });
        sugestoes.push({ texto: 'O motor está quente mas o ambiente está normal — isso descarta calor externo como causa. Verifique líquido de arrefecimento, termostato, bomba d\'água e ventilador.', prioridade: 'alta' });
    }

    // --- 2. TEMP. AR ADMISSÃO × TEMP. AMBIENTE (intercooler check) ---
    if (L.tempArAdmissao > 0 && L.tempAmbiente > 0) {
        const deltaAdmissao = L.tempArAdmissao - L.tempAmbiente;
        if (deltaAdmissao > 25) {
            if (nivelGeral !== 'critico') nivelGeral = 'alerta';
            alertas.push({ nivel: 'alerta', msg: 'Ar de admissão muito mais quente que o ambiente!', detalhe: `Admissão: ${L.tempArAdmissao.toFixed(1)}°C | Ambiente: ${L.tempAmbiente.toFixed(1)}°C (+${deltaAdmissao.toFixed(0)}°C)` });
            sugestoes.push({ texto: 'Ar de admissão deveria estar próximo da temperatura ambiente (com intercooler). Diferença >25°C indica intercooler com defeito, dutos vazando ou motor de arrefecimento do intercooler parado.', prioridade: 'alta' });
        } else if (deltaAdmissao > 15) {
            sugestoes.push({ texto: `Ar de admissão ${deltaAdmissao.toFixed(0)}°C mais quente que o ambiente — intercooler pode estar parcialmente obstruído ou com eficiência reduzida.`, prioridade: 'media' });
        }
    }

    // --- 3. MAP × CARGA DO MOTOR ---
    if (L.pressaoMAP > 95 && L.cargaMotor < 30) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'MAP alto com carga baixa!', detalhe: `MAP: ${L.pressaoMAP.toFixed(0)} kPa | Carga: ${L.cargaMotor.toFixed(0)}%` });
        sugestoes.push({ texto: 'Com carga baixa (marcha lenta/pouca aceleração), a pressão MAP deveria ser baixa (~30-50 kPa). Valor alto indica obstrução na admissão, válvula EGR travada aberta ou sensor MAP descalibrado.', prioridade: 'alta' });
    } else if (L.pressaoMAP < 25 && L.cargaMotor > 70) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'MAP muito baixo com carga alta!', detalhe: `MAP: ${L.pressaoMAP.toFixed(0)} kPa | Carga: ${L.cargaMotor.toFixed(0)}%` });
        sugestoes.push({ texto: 'Com carga alta, a pressão MAP deveria ser mais alta (~80-100 kPa). Valor muito baixo pode indicar vazamento grande na admissão ou sensor MAP com defeito.', prioridade: 'alta' });
    }

    // --- 4. PRESSÃO COMBUSTÍVEL × FUEL TRIM ---
    if (L.pressaoCombustivel > 0 && L.pressaoCombustivel < 300 && (ftStft > 15 || ftLtft > 15)) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Pressão de combustível baixa + Fuel Trim pobre!', detalhe: `Combustível: ${L.pressaoCombustivel.toFixed(0)} kPa | STFT: ${ftStft > 0 ? '+' : ''}${ftStft.toFixed(1)}%` });
        sugestoes.push({ texto: 'Pressão de combustível abaixo do ideal (mínimo 300 kPa) combinada com fuel trim pobre indica que a ECU está compensando falta de combustível. Causa provável: bomba de combustível fraca ou filtro entupido.', prioridade: 'alta' });
    }

    // --- 5. CATALISADOR × FUEL TRIM × O2 ---
    if (L.tempCatalisador > 750 && (ftStft < -15 || ftLtft < -15) && L.nivelO2 > 0.7) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Catalisador quente + mistura rica + O₂ alto!', detalhe: `Catalisador: ${L.tempCatalisador.toFixed(0)}°C | Fuel Trim: ${ftStft.toFixed(1)}% | O₂: ${L.nivelO2.toFixed(2)}V` });
        sugestoes.push({ texto: 'Combustível não queimado está chegando ao catalisador e superaquecendo-o. Causa provável: injetor(es) vazando(s), velas com defeito ou bobina de ignição com problema. Verifique cada injetor individualmente.', prioridade: 'alta' });
    }

    // --- 6. OPEN LOOP × TEMP. MOTOR ---
    if (L.statusSistemaComb && L.statusSistemaComb.includes('Open Loop') && L.tempMotor > 85) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Open Loop persistente com motor quente!', detalhe: `Status: ${L.statusSistemaComb} | Motor: ${L.tempMotor.toFixed(1)}°C` });
        sugestoes.push({ texto: 'O motor já atingiu temperatura operacional (>85°C) mas o sistema continua em Open Loop. A ECU não está recebendo dados corretos dos sensores. Verifique sensor de temperatura do motor (ECT) e sensor O2.', prioridade: 'alta' });
    }

    // --- 7. TENSÃO BAIXA × QUALIDADE DAS LEITURAS ---
    if (L.tensaoBateria > 0 && L.tensaoBateria < 12.0) {
        const leiturasQuestionaveis = [];
        if (L.tempAmbiente > 45) leiturasQuestionaveis.push('tempAmbiente');
        if (L.nivelO2 > 0.9 || L.nivelO2 < 0.05) leiturasQuestionaveis.push('sensorO2');
        if (L.pressaoMAP > 100) leiturasQuestionaveis.push('pressaoMAP');
        if (L.fuelTrimSTFT > 25 || L.fuelTrimSTFT < -25) leiturasQuestionaveis.push('fuelTrim');
        if (leiturasQuestionaveis.length > 0) {
            if (nivelGeral !== 'critico') nivelGeral = 'alerta';
            alertas.push({ nivel: 'alerta', msg: 'Bateria fraca pode estar causando leituras erráticas!', detalhe: `Tensão: ${L.tensaoBateria.toFixed(1)}V | Sensores afetados: ${leiturasQuestionaveis.join(', ')}` });
            sugestoes.push({ texto: `Tensão abaixo de 12V pode causar leituras incorretas nos sensores (${leiturasQuestionaveis.join(', ')}). Corrija a bateria/alternador PRIMEIRO e refaça o diagnóstico.`, prioridade: 'alta' });
        }
    }

    // --- 8. RPM × VELOCIDADE × EMBREAGEM ---
    if (L.rpm > 3000 && L.velocidade > 60 && L.deslizamentoEmbreagem > 5) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Embreagem deslizando em velocidade!', detalhe: `RPM: ${Math.round(L.rpm)} | Vel: ${L.velocidade.toFixed(0)} km/h | Deslizamento: ${L.deslizamentoEmbreagem.toFixed(1)}%` });
        sugestoes.push({ texto: 'Embreagem deslizando em alta velocidade consome mais combustível e sobrecarrega o motor. Substitua o kit de embreagem o quanto antes.', prioridade: 'alta' });
    }

    // --- 9. O2 Pobre + FUEL TRIM Rico (contradição) ---
    if (L.nivelO2 < 0.2 && (ftStft < -15 || ftLtft < -15)) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Sensor O₂ pobre mas Fuel Trim rico!', detalhe: `O₂: ${L.nivelO2.toFixed(2)}V (pobre) | STFT: ${ftStft.toFixed(1)}% (rico)` });
        sugestoes.push({ texto: 'Leitura contraditória: O₂ indica mistura pobre mas ECU está reduzendo injeção (rico). Possível sensor O₂ descalibrado ou com atraso de resposta. Verifique o sensor O₂ com scanner avançado.', prioridade: 'alta' });
    }

    // --- 10. TEMP. MOTOR × FUEL TRIM (motor quente + lean = perigo) ---
    if (L.tempMotor > 100 && (ftStft > 20 || ftLtft > 20)) {
        if (nivelGeral !== 'critico') nivelGeral = 'alerta';
        alertas.push({ nivel: 'alerta', msg: 'Motor quente + mistura pobre!', detalhe: `Motor: ${L.tempMotor.toFixed(1)}°C | STFT: ${ftStft > 0 ? '+' : ''}${ftStft.toFixed(1)}%` });
        sugestoes.push({ texto: 'Mistura pobre em motor quente é perigosa — reduz a lubrificação e pode causar superaquecimento adicional. Verifique vazamentos de ar na admissão e bomba de combustível IMEDIATAMENTE.', prioridade: 'alta' });
    }

    // ====================================================================
    // FIM CROSS-CORRELATION
    // ====================================================================

    // --- Status Geral ---
    if (nivelGeral === 'critico') {
        statusIcon.textContent = '🚨';
        statusIcon.style.color = 'var(--danger)';
        statusText.textContent = 'ALERTA CRÍTICO';
        statusText.style.color = 'var(--danger)';
        statusSub.textContent = 'Problemas sérios detectados. Verifique imediatamente.';
    } else if (nivelGeral === 'alerta') {
        statusIcon.textContent = '⚠️';
        statusIcon.style.color = 'var(--warning)';
        statusText.textContent = 'Atenção Necessária';
        statusText.style.color = 'var(--warning)';
        statusSub.textContent = 'Alguns parâmetros fora da faixa ideal.';
    } else {
        statusIcon.textContent = '✅';
        statusIcon.style.color = 'var(--success)';
        statusText.textContent = 'Sistema Normal';
        statusText.style.color = 'var(--success)';
        statusSub.textContent = 'Todos os sensores dentro dos parâmetros esperados.';
    }

    const bgStatus = nivelGeral === 'critico' ? 'rgba(239,68,68,0.1)' : nivelGeral === 'alerta' ? 'rgba(234,179,8,0.1)' : 'rgba(34,197,94,0.1)';
    const bordaStatus = nivelGeral === 'critico' ? 'var(--danger)' : nivelGeral === 'alerta' ? 'var(--warning)' : 'var(--success)';
    const statusContainer = document.getElementById('diag-status');
    statusContainer.style.background = bgStatus;
    statusContainer.style.border = `2px solid ${bordaStatus}`;
    statusContainer.style.borderRadius = '12px';

    alertasContainer.innerHTML = alertas.length > 0
        ? '<div style="font-size:9px; color:var(--danger); text-transform:uppercase; font-weight:800; margin-bottom:8px;">Alertas Detectados</div>' +
          alertas.map(a => `
            <div style="padding:10px 12px; margin-bottom:8px; border-radius:8px; background:rgba(255,255,255,0.03); border-left:3px solid ${a.nivel === 'critico' ? 'var(--danger)' : 'var(--warning)'};">
                <div style="font-size:12px; font-weight:700; color:${a.nivel === 'critico' ? 'var(--danger)' : 'var(--warning)'};">${a.msg}</div>
                <div style="font-size:10px; color:#94a3b8; margin-top:2px;">${a.detalhe}</div>
            </div>
        `).join('')
        : '';

    sugestoesContainer.innerHTML = sugestoes.length > 0
        ? '<div style="font-size:9px; color:var(--accent); text-transform:uppercase; font-weight:800; margin-bottom:8px; margin-top:10px;">Sugestões de Diagnóstico</div>' +
          sugestoes.map(s => `
            <div style="padding:10px 12px; margin-bottom:8px; border-radius:8px; background:rgba(0,242,255,0.03); border-left:3px solid var(--accent);">
                <div style="font-size:11px; color:#e2e8f0;">${s.texto}</div>
                <div style="font-size:9px; color:${s.prioridade === 'alta' ? 'var(--danger)' : s.prioridade === 'media' ? 'var(--warning)' : '#94a3b8'}; margin-top:3px; text-transform:uppercase; font-weight:700;">Prioridade: ${s.prioridade}</div>
            </div>
        `).join('')
        : '';

    // --- ANÁLISE DE CONSUMO ---
    const consumoContainer = document.getElementById('diag-consumo');
    if (consumoContainer && L.consumoEsperado > 0) {
        const real = L.consumoInstantaneo;
        const esperado = L.consumoEsperado;
        const delta = real - esperado;
        const pctDelta = ((delta / esperado) * 100).toFixed(0);
        const statusConsumo = delta > 2 ? 'alto' : delta > 0.5 ? 'levemente_alto' : delta < -1 ? 'baixo' : 'normal';

        let corBarra = 'var(--success)';
        let statusLabel = 'Consumo Normal';
        let statusCor = 'var(--success)';
        let iconStatus = '✅';

        if (statusConsumo === 'alto') {
            corBarra = 'var(--danger)';
            statusLabel = 'Consumo Elevado';
            statusCor = 'var(--danger)';
            iconStatus = '🚨';
        } else if (statusConsumo === 'levemente_alto') {
            corBarra = 'var(--warning)';
            statusLabel = 'Consumo Ligeiramente Alto';
            statusCor = 'var(--warning)';
            iconStatus = '⚠️';
        } else if (statusConsumo === 'baixo') {
            corBarra = 'var(--accent)';
            statusLabel = 'Consumo Abaixo do Esperado';
            statusCor = 'var(--accent)';
            iconStatus = 'ℹ️';
        }

        const maxConsumo = Math.max(real, esperado, 1);
        const pctReal = (real / maxConsumo) * 100;
        const pctEsperado = (esperado / maxConsumo) * 100;

        const causas = [];
        if (statusConsumo === 'alto' || statusConsumo === 'levemente_alto') {
            if (Math.abs(L.fuelTrimLTFT) > 10) causas.push({ texto: 'Fuel Trim descalibrado — ECU compensando falha na mistura', icon: '🔧' });
            if (L.nivelO2 < 0.15 || L.nivelO2 > 0.85) causas.push({ texto: 'Sensor O₂ com leitura fora do ideal — possível descalibração', icon: '🫁' });
            if (L.pressaoMAP > 95 || L.pressaoMAP < 30) causas.push({ texto: 'Sensor MAP fora do esperado — pode estar descalibrado ou com obstrução', icon: '🔴' });
            if (L.tempMotor < 82) causas.push({ texto: 'Motor não está atingindo temperatura operacional — termostato travado aberto', icon: '🌡️' });
            if (L.pressaoCombustivel < 300) causas.push({ texto: 'Pressão de combustível baixa — bomba ou filtro', icon: '⛽' });
            if (L.tempArAdmissao > 50) causas.push({ texto: 'Ar de admissão quente — intercooler ou dutos com problema', icon: '💨' });
            if (L.deslizamentoEmbreagem > 8) causas.push({ texto: 'Embreagem deslizando — RPM não converte em movimento', icon: '🔗' });
                if (L.tempCatalisador > 750) causas.push({ texto: 'Catalisador quente demais — possível entupimento', icon: '🔥' });
            if (causas.length === 0) {
                causas.push({ texto: 'Filtro de ar sujo ou obstruído', icon: '🌬️' });
                causas.push({ texto: 'Velas de ignição com desgaste', icon: '⚡' });
                causas.push({ texto: 'Bicos injetores sujos ou entupidos', icon: '🔧' });
                causas.push({ texto: 'Pneus com pressão abaixo do recomendado', icon: '🛞' });
                causas.push({ texto: 'Freios arrastando (pastilhas travadas)', icon: '🛑' });
            }
        }

        let htmlConsumo = `
            <div style="margin-top:15px; padding:15px; background:rgba(255,255,255,0.03); border-radius:12px; border:1px solid rgba(255,255,255,0.05);">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                    <span style="font-size:1.2rem;">${iconStatus}</span>
                    <div>
                        <div style="font-size:10px; color:var(--accent); text-transform:uppercase; font-weight:800; letter-spacing:1px;">Análise de Consumo</div>
                        <div style="font-size:13px; font-weight:700; color:${statusCor};">${statusLabel}</div>
                    </div>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-bottom:12px;">
                    <div style="text-align:center; padding:10px; background:rgba(255,255,255,0.03); border-radius:8px;">
                        <div style="font-size:8px; color:#94a3b8; text-transform:uppercase;">Atual</div>
                        <div style="font-size:1.1rem; font-weight:800; color:${statusCor};">${real.toFixed(1)}</div>
                        <div style="font-size:8px; color:#94a3b8;">L/h</div>
                    </div>
                    <div style="text-align:center; padding:10px; background:rgba(255,255,255,0.03); border-radius:8px;">
                        <div style="font-size:8px; color:#94a3b8; text-transform:uppercase;">Esperado</div>
                        <div style="font-size:1.1rem; font-weight:800; color:var(--success);">${esperado.toFixed(1)}</div>
                        <div style="font-size:8px; color:#94a3b8;">L/h</div>
                    </div>
                    <div style="text-align:center; padding:10px; background:rgba(255,255,255,0.03); border-radius:8px;">
                        <div style="font-size:8px; color:#94a3b8; text-transform:uppercase;">Diferença</div>
                        <div style="font-size:1.1rem; font-weight:800; color:${delta > 0.5 ? 'var(--danger)' : 'var(--success)'};">${delta > 0 ? '+' : ''}${delta.toFixed(1)}</div>
                        <div style="font-size:8px; color:#94a3b8;">L/h (${pctDelta > 0 ? '+' : ''}${pctDelta}%)</div>
                    </div>
                </div>

                <div style="margin-bottom:12px;">
                    <div style="display:flex; justify-content:space-between; font-size:8px; color:#94a3b8; margin-bottom:4px;">
                        <span>Real</span><span>Esperado</span>
                    </div>
                    <div style="background:rgba(255,255,255,0.05); height:8px; border-radius:4px; overflow:hidden; position:relative;">
                        <div style="position:absolute; height:100%; width:${pctReal}%; background:${corBarra}; border-radius:4px; transition:0.5s;"></div>
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:8px; color:#94a3b8; margin-top:2px;">
                        <span>Real: ${real.toFixed(1)} L/h</span><span>Base: ${esperado.toFixed(1)} L/h</span>
                    </div>
                </div>
        `;

        if (causas.length > 0) {
            htmlConsumo += `
                <div style="font-size:9px; color:var(--warning); text-transform:uppercase; font-weight:800; margin-bottom:8px;">Possíveis Causas</div>
                ${causas.map(c => `
                    <div style="display:flex; align-items:flex-start; gap:8px; padding:8px 10px; margin-bottom:6px; background:rgba(234,179,8,0.05); border-radius:6px; border-left:3px solid var(--warning);">
                        <span style="font-size:12px;">${c.icon}</span>
                        <span style="font-size:11px; color:#e2e8f0;">${c.texto}</span>
                    </div>
                `).join('')}
            `;
        }

        htmlConsumo += '</div>';
        consumoContainer.innerHTML = htmlConsumo;
    }
}

// ==========================================
// SISTEMA DE ABASTECIMENTO E QUALIDADE
// ==========================================

let abastecimentos = [];

function carregarAbastecimentos() {
    try {
        const chave = (typeof chaveV === 'function') ? chaveV("abastecimentos") : "car_abastecimentos";
        abastecimentos = JSON.parse(localStorage.getItem(chave) || "[]");
    } catch (e) {
        abastecimentos = [];
    }
}

function salvarAbastecimentos() {
    const chave = (typeof chaveV === 'function') ? chaveV("abastecimentos") : "car_abastecimentos";
    localStorage.setItem(chave, JSON.stringify(abastecimentos));
}

function obterPosicaoAtual() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({
                lat: parseFloat(pos.coords.latitude.toFixed(6)),
                lng: parseFloat(pos.coords.longitude.toFixed(6)),
                precisao: pos.coords.accuracy
            }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
        );
    });
}

async function reverseGeocode(lat, lng) {
    try {
        const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1&accept-language=pt-BR`, {
            headers: { 'User-Agent': 'AutoGestaoX/1.0' }
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data;
    } catch(e) { return null; }
}

async function buscarPostosProximos(lat, lng) {
    try {
        const raio = 500;
        const query = `[out:json][timeout:10];node["amenity"="fuel"](around:${raio},${lat},${lng});out body;`;
        const resp = await fetch(`https://overpass-api.de/api/interpreter`, {
            method: 'POST',
            body: `data=${encodeURIComponent(query)}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        return data.elements.map(e => ({
            nome: e.tags?.name || e.tags?.brand || 'Posto sem nome',
            marca: e.tags?.brand || '',
            lat: e.lat,
            lng: e.lon,
            distancia: Math.round(haversineDist(lat, lng, e.lat, e.lng))
        })).sort((a, b) => a.distancia - b.distancia);
    } catch(e) { return []; }
}

function haversineDist(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function sugerirPostoHistorico() {
    const nomes = [...new Set(abastecimentos.filter(a => a.posto).map(a => a.posto))];
    return nomes.sort();
}

async function detectarAbastecimento(nivelAntes, nivelDepois) {
    if (nivelAntes === null || nivelAntes === undefined) return;
    if (nivelDepois > nivelAntes + 10) {
        const tanqueCap = getTanqueCapacidade ? getTanqueCapacidade() : (parseInt(localStorage.getItem("car_tanque_capacidade")) || 50);
        const litros = ((nivelDepois - nivelAntes) / 100) * tanqueCap;
        const kmAtual = getKmAtual ? getKmAtual() : (parseInt(localStorage.getItem("car_km")) || 0);
        const posicao = await obterPosicaoAtual();

        let postoDetectado = "";
        if (posicao) {
            const postos = await buscarPostosProximos(posicao.lat, posicao.lng);
            if (postos.length > 0 && postos[0].distancia < 100) {
                postoDetectado = postos[0].nome;
            }
        }

        const abast = {
            data: new Date().toISOString(),
            litros: parseFloat(litros.toFixed(1)),
            nivelAntes: parseFloat(nivelAntes.toFixed(1)),
            nivelDepois: parseFloat(nivelDepois.toFixed(1)),
            km: kmAtual,
            posto: postoDetectado,
            geo: posicao,
            snapshot: {
                fuelTrimSTFT: parseFloat(leiturasOBD.fuelTrimSTFT.toFixed(1)),
                fuelTrimLTFT: parseFloat(leiturasOBD.fuelTrimLTFT.toFixed(1)),
                consumo: parseFloat(leiturasOBD.consumoInstantaneo.toFixed(1)),
                nivelO2: parseFloat(leiturasOBD.nivelO2.toFixed(2)),
                tempCatalisador: parseFloat(leiturasOBD.tempCatalisador.toFixed(0)),
                tempMotor: parseFloat(leiturasOBD.tempMotor.toFixed(1)),
                pressaoMAP: parseFloat(leiturasOBD.pressaoMAP.toFixed(0)),
                etanolPercent: parseFloat(leiturasOBD.etanolPercent.toFixed(0)),
                o2Sensor1: parseFloat(leiturasOBD.o2Sensor1.toFixed(2)),
                o2Oscilacao: calcularOscilacaoO2()
            }
        };

        abastecimentos.push(abast);
        salvarAbastecimentos();

        const msgPosto = postoDetectado ? ` — ${postoDetectado}` : '';
        showToast(`Abastecimento detectado! ~${litros.toFixed(1)}L${msgPosto}`, "info");
        if (typeof renderizarAbastecimentos === 'function') renderizarAbastecimentos();
        capturarBaselineCombustivel();
        resetarAcumuladores();
    }
}

async function registrarAbastecimentoManual() {
    if (typeof AGXLogger !== 'undefined') AGXLogger.userAction('Abriu registro de abastecimento');
    const kmAtual = getKmAtual ? getKmAtual() : (parseInt(localStorage.getItem("car_km")) || 0);
    const nivelAtual = leiturasOBD.nivelCombustivel || 50;
    const tanqueCap = getTanqueCapacidade ? getTanqueCapacidade() : (parseInt(localStorage.getItem("car_tanque_capacidade")) || 50);
    const posicao = await obterPosicaoAtual();
    const historico = sugerirPostoHistorico();

    let postosProximos = [];
    let nomeDetectado = '';
    if (posicao) {
        showToast("🔍 Buscando postos próximos...", "info");
        postosProximos = await buscarPostosProximos(posicao.lat, posicao.lng);
        const geo = await reverseGeocode(posicao.lat, posicao.lng);
        if (geo?.address) {
            const a = geo.address;
            nomeDetectado = a.fuel || a.shop || a.amenity || a.road || '';
        }
    }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'modal-abast';
    modal.innerHTML = `
        <div class="modal-content glass-card" style="max-width:420px; max-height:85vh; overflow-y:auto; padding:20px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h4 style="margin:0; color:var(--accent);">REGISTRAR ABASTECIMENTO</h4>
                <button onclick="fecharModalAbast()" style="background:none; border:none; color:#94a3b8; font-size:1.2rem; cursor:pointer;">✕</button>
            </div>

            <div style="margin-bottom:12px;">
                <label style="font-size:9px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Litros abastecidos *</label>
                <input type="number" id="abast-litros" step="0.1" min="0" placeholder="Ex: 35.5"
                    style="width:100%; padding:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:8px; color:#fff; font-size:14px; margin-top:4px; box-sizing:border-box;">
            </div>

            <div style="margin-bottom:12px;">
                <label style="font-size:9px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Posto</label>
                <input type="text" id="abast-posto" placeholder="Nome do posto" value="${escapeHtml(nomeDetectado)}"
                    list="abast-postos-list" autocomplete="off"
                    style="width:100%; padding:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:8px; color:#fff; font-size:12px; margin-top:4px; box-sizing:border-box;">
                <datalist id="abast-postos-list">
                    ${historico.map(n => `<option value="${escapeHtml(n)}">`).join('')}
                </datalist>
            </div>

            ${postosProximos.length > 0 ? `
            <div style="margin-bottom:12px;">
                <label style="font-size:9px; color:#94a3b8; text-transform:uppercase; font-weight:700;">📍 Postos próximos</label>
                <div style="max-height:120px; overflow-y:auto; margin-top:4px;">
                    ${postosProximos.slice(0, 5).map(p => `
                        <div onclick="document.getElementById('abast-posto').value = this.getAttribute('data-nome')"
                            data-nome="${escapeHtml(p.nome)}"
                            style="padding:8px; margin-bottom:4px; background:rgba(255,255,255,0.03); border-radius:6px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; border:1px solid rgba(255,255,255,0.05);">
                            <div>
                                <div style="font-size:11px; font-weight:600; color:#fff;">${escapeHtml(p.nome)}</div>
                                ${p.marca ? `<div style="font-size:8px; color:#666;">${escapeHtml(p.marca)}</div>` : ''}
                            </div>
                            <div style="font-size:9px; color:var(--accent);">${Number(p.distancia) || 0}m</div>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px;">
                <div>
                    <label style="font-size:9px; color:#94a3b8; text-transform:uppercase; font-weight:700;">Preço/L (R$)</label>
                    <input type="number" id="abast-preco" step="0.01" min="0" placeholder="Ex: 5.89"
                        style="width:100%; padding:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:8px; color:#fff; font-size:12px; margin-top:4px; box-sizing:border-box;">
                </div>
                <div>
                    <label style="font-size:9px; color:#94a3b8; text-transform:uppercase; font-weight:700;">KM atual</label>
                    <input type="number" id="abast-km" value="${kmAtual}"
                        style="width:100%; padding:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:8px; color:#fff; font-size:12px; margin-top:4px; box-sizing:border-box;">
                </div>
            </div>

            <div id="abast-resultado" style="font-size:11px; color:#94a3b8; margin-bottom:12px; min-height:16px;"></div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                <button class="btn-main" onclick="fecharModalAbast()" style="background:rgba(255,255,255,0.05); color:#94a3b8; border:1px solid rgba(255,255,255,0.1); padding:10px;">Cancelar</button>
                <button class="btn-main" onclick="confirmarAbastecimento()" style="padding:10px;">Salvar</button>
            </div>

            ${posicao ? `<div style="font-size:8px; color:#666; margin-top:8px; text-align:center;">📍 GPS: ${posicao.lat}, ${posicao.lng} (±${Math.round(posicao.precisao)}m)</div>` : '<div style="font-size:8px; color:#666; margin-top:8px; text-align:center;">⚠️ GPS não disponível</div>'}
        </div>
    `;
    document.body.appendChild(modal);

    const litrosInput = document.getElementById('abast-litros');
    const precoInput = document.getElementById('abast-preco');
    const resultadoDiv = document.getElementById('abast-resultado');

    function atualizarResultado() {
        const l = parseFloat(litrosInput.value) || 0;
        const p = parseFloat(precoInput.value) || 0;
        if (l > 0 && p > 0) {
            resultadoDiv.innerHTML = `<span style="color:var(--accent); font-weight:700;">Total: R$ ${(l * p).toFixed(2)}</span>`;
        } else {
            resultadoDiv.innerHTML = '';
        }
    }
    litrosInput.addEventListener('input', atualizarResultado);
    precoInput.addEventListener('input', atualizarResultado);
    litrosInput.focus();
}

function fecharModalAbast() {
    const m = document.getElementById('modal-abast');
    if (m) m.remove();
}

async function confirmarAbastecimento() {
    const litros = parseFloat(document.getElementById('abast-litros').value) || 0;
    if (litros <= 0) { showToast("Quantidade inválida.", "error"); return; }

    const kmAtual = getKmAtual ? getKmAtual() : (parseInt(localStorage.getItem("car_km")) || 0);
    const nivelAtual = leiturasOBD.nivelCombustivel || 50;
    const tanqueCap = getTanqueCapacidade ? getTanqueCapacidade() : (parseInt(localStorage.getItem("car_tanque_capacidade")) || 50);
    const posicao = await obterPosicaoAtual();

    const posto = document.getElementById('abast-posto').value || "";
    const precoLitro = parseFloat(document.getElementById('abast-preco').value) || 0;
    const kmInput = parseInt(document.getElementById('abast-km').value) || kmAtual;
    const custoTotal = precoLitro > 0 ? parseFloat((litros * precoLitro).toFixed(2)) : 0;

    const abast = {
        data: new Date().toISOString(),
        litros: litros,
        nivelAntes: parseFloat(nivelAtual.toFixed(1)),
        nivelDepois: parseFloat(Math.min(100, nivelAtual + (litros / tanqueCap * 100)).toFixed(1)),
        km: kmInput,
        posto: posto,
        precoLitro: precoLitro || undefined,
        custoTotal: custoTotal || undefined,
        geo: posicao,
        snapshot: {
            fuelTrimSTFT: parseFloat(leiturasOBD.fuelTrimSTFT.toFixed(1)),
            fuelTrimLTFT: parseFloat(leiturasOBD.fuelTrimLTFT.toFixed(1)),
            consumo: parseFloat(leiturasOBD.consumoInstantaneo.toFixed(1)),
            nivelO2: parseFloat(leiturasOBD.nivelO2.toFixed(2)),
            tempCatalisador: parseFloat((leiturasOBD.tempCatalisador || leiturasOBD.tempPosCatalisador || 0).toFixed(0)),
            tempMotor: parseFloat(leiturasOBD.tempMotor.toFixed(1)),
            pressaoMAP: parseFloat(leiturasOBD.pressaoMAP.toFixed(0)),
            etanolPercent: parseFloat(leiturasOBD.etanolPercent.toFixed(0)),
            o2Sensor1: parseFloat(leiturasOBD.o2Sensor1.toFixed(2)),
            o2Oscilacao: calcularOscilacaoO2()
        }
    };

    abastecimentos.push(abast);
    salvarAbastecimentos();
    fecharModalAbast();
    showToast(custoTotal > 0 ? `Abastecimento registrado: ${litros}L — R$ ${custoTotal.toFixed(2)}` : `Abastecimento registrado: ${litros}L`, "success");
    if (typeof renderizarAbastecimentos === 'function') renderizarAbastecimentos();
    capturarBaselineCombustivel();
    resetarAcumuladores();
    if (typeof AGXLogger !== 'undefined') AGXLogger.userAction('Abastecimento registrado', { litros, posto, custo: custoTotal });
}

function editarAbastecimento(index, litros, posto) {
    if (abastecimentos[index]) {
        abastecimentos[index].litros = parseFloat(litros) || 0;
        abastecimentos[index].posto = posto || "";
        salvarAbastecimentos();
        showToast("Abastecimento atualizado.", "success");
    }
}

function removerAbastecimento(index) {
    abastecimentos.splice(index, 1);
    salvarAbastecimentos();
    showToast("Abastecimento removido.", "info");
}

function calcularKmPorLitro() {
    const real = getConsumoMedioReal();
    if (real) return real;

    if (abastecimentos.length < 2) return null;
    const ordenado = [...abastecimentos].sort((a, b) => a.km - b.km);
    let totalKm = ordenado[ordenado.length - 1].km - ordenado[0].km;
    let totalLitros = ordenado.slice(1).reduce((sum, a) => sum + (a.litros || 0), 0);
    if (totalLitros < 1 || totalKm < 1) return null;
    const kmL = totalKm / totalLitros;
    if (kmL < 2 || kmL > 30) return null;
    return parseFloat(kmL.toFixed(1));
}

function calcularOscilacaoO2() {
    const hist = sensorHistory.nivelO2;
    if (hist.length < 5) return 0;
    let oscilacoes = 0;
    for (let i = 1; i < hist.length; i++) {
        if ((hist[i] > 0.6 && hist[i-1] < 0.4) || (hist[i] < 0.4 && hist[i-1] > 0.6)) {
            oscilacoes++;
        }
    }
    return oscilacoes;
}

function calcularPerfilPostos() {
    const perfil = {};
    abastecimentos.forEach(a => {
        if (!a.posto) return;
        if (!perfil[a.posto]) {
            perfil[a.posto] = {
                nome: a.posto, abastecimentos: 0,
                mediaFuelTrim: 0, mediaConsumo: 0, mediaO2: 0,
                mediaMAP: 0, mediaEtanol: 0, mediaOscilacaoO2: 0,
                qualidade: 100, historico: [], melhorPosto: false
            };
        }
        const p = perfil[a.posto];
        const snap = a.snapshot || {};
        p.abastecimentos++;
        p.historico.push(snap);
        p.mediaFuelTrim += Math.abs(snap.fuelTrimLTFT || 0);
        p.mediaConsumo += snap.consumo || 0;
        p.mediaO2 += snap.nivelO2 || 0;
        p.mediaMAP += snap.pressaoMAP || 0;
        p.mediaEtanol += snap.etanolPercent || 0;
        p.mediaOscilacaoO2 += snap.o2Oscilacao || 0;
    });

    let melhorQualidade = -1;

    Object.values(perfil).forEach(p => {
        if (p.abastecimentos > 0) {
            p.mediaFuelTrim = parseFloat((p.mediaFuelTrim / p.abastecimentos).toFixed(1));
            p.mediaConsumo = parseFloat((p.mediaConsumo / p.abastecimentos).toFixed(1));
            p.mediaO2 = parseFloat((p.mediaO2 / p.abastecimentos).toFixed(2));
            p.mediaMAP = parseFloat((p.mediaMAP / p.abastecimentos).toFixed(0));
            p.mediaEtanol = parseFloat((p.mediaEtanol / p.abastecimentos).toFixed(0));
            p.mediaOscilacaoO2 = parseFloat((p.mediaOscilacaoO2 / p.abastecimentos).toFixed(0));

            let penalidades = 0;
            if (p.mediaFuelTrim > 15) penalidades += 30;
            else if (p.mediaFuelTrim > 10) penalidades += 20;
            else if (p.mediaFuelTrim > 5) penalidades += 10;
            if (p.mediaConsumo > 12) penalidades += 25;
            else if (p.mediaConsumo > 10) penalidades += 15;
            else if (p.mediaConsumo > 8) penalidades += 8;
            if (p.mediaOscilacaoO2 < 3) penalidades += 15;
            if (p.mediaMAP > 80) penalidades += 10;

            p.qualidade = Math.max(0, 100 - penalidades);
            if (p.qualidade > melhorQualidade) melhorQualidade = p.qualidade;
        }
    });

    Object.values(perfil).forEach(p => {
        p.melhorPosto = (p.qualidade === melhorQualidade && p.qualidade > 60);
    });

    return perfil;
}

let _baselineCombustivel = null;

function capturarBaselineCombustivel() {
    _baselineCombustivel = {
        fuelTrimSTFT: leiturasOBD.fuelTrimSTFT,
        fuelTrimLTFT: leiturasOBD.fuelTrimLTFT,
        consumo: leiturasOBD.consumoInstantaneo,
        nivelO2: leiturasOBD.nivelO2,
        pressaoMAP: leiturasOBD.pressaoMAP,
        timestamp: Date.now()
    };
}

function analisarQualidadeCombustivel() {
    if (!_baselineCombustivel) return null;
    const B = _baselineCombustivel;
    const L = leiturasOBD;

    const deltaSTFT = Math.abs(L.fuelTrimSTFT - B.fuelTrimSTFT);
    const deltaLTFT = Math.abs(L.fuelTrimLTFT - B.fuelTrimLTFT);
    const deltaConsumo = Math.abs(L.consumoInstantaneo - B.consumo);
    const deltaO2 = Math.abs(L.nivelO2 - B.nivelO2);
    const deltaMAP = Math.abs(L.pressaoMAP - B.pressaoMAP);

    let scoreSTFT = Math.max(0, 100 - (deltaSTFT * 10));
    let scoreLTFT = Math.max(0, 100 - (deltaLTFT * 8));
    let scoreO2 = Math.max(0, 100 - (deltaO2 * 150));
    let scoreConsumo = Math.max(0, 100 - (deltaConsumo * 15));

    const indiceQualidade = (scoreSTFT * 0.35 + scoreLTFT * 0.30 + scoreO2 * 0.20 + scoreConsumo * 0.15);

    const oscilacaoO2 = calcularOscilacaoO2();
    const combustivelOK = indiceQualidade > 70;
    const problemaDetectado = indiceQualidade < 50;

    let diagnostico = '';
    let nivel = 'ok';
    if (indiceQualidade >= 80) {
        diagnostico = 'Combustível de boa qualidade detectado.';
        nivel = 'ok';
    } else if (indiceQualidade >= 60) {
        diagnostico = 'Combustível com qualidade intermediária. Considere trocar de posto.';
        nivel = 'alerta';
    } else if (indiceQualidade >= 40) {
        diagnostico = 'Combustível de baixa qualidade! Pode causar desgaste e maior consumo.';
        nivel = 'critico';
    } else {
        diagnostico = 'Combustível muito ruim! Risco de danos ao motor. Troque imediatamente de posto.';
        nivel = 'critico';
    }

    if (oscilacaoO2 < 3) {
        diagnostico += ' Sensor O₂ com oscilação baixa — combustível não está queimando corretamente.';
    }

    return {
        indiceQualidade: parseFloat(indiceQualidade.toFixed(1)),
        scoreSTFT: parseFloat(scoreSTFT.toFixed(1)),
        scoreLTFT: parseFloat(scoreLTFT.toFixed(1)),
        scoreO2: parseFloat(scoreO2.toFixed(1)),
        scoreConsumo: parseFloat(scoreConsumo.toFixed(1)),
        oscilacaoO2,
        diagnostico,
        nivel,
        combustivelOK,
        problemaDetectado,
        deltaSTFT: parseFloat(deltaSTFT.toFixed(1)),
        deltaLTFT: parseFloat(deltaLTFT.toFixed(1))
    };
}

function renderizarQualidadeCombustivel() {
    const container = document.getElementById('diag-qualidade-combustivel');
    if (!container) return;

    const resultado = analisarQualidadeCombustivel();
    const perfil = calcularPerfilPostos();
    const postos = Object.values(perfil).sort((a, b) => b.qualidade - a.qualidade);

    if (!resultado && postos.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = `<div style="font-size:9px; color:#94a3b8; text-transform:uppercase; font-weight:700; margin-bottom:12px;">⛽ Análise de Qualidade do Combustível</div>`;

    if (resultado) {
        const cor = resultado.nivel === 'ok' ? 'var(--success)' : resultado.nivel === 'alerta' ? 'var(--warning)' : 'var(--danger)';
        const bgCor = resultado.nivel === 'ok' ? 'rgba(0,200,83,0.08)' : resultado.nivel === 'alerta' ? 'rgba(255,152,0,0.08)' : 'rgba(244,67,54,0.08)';

        html += `
            <div style="background:${bgCor}; border-radius:10px; padding:14px; margin-bottom:12px; border-left:4px solid ${cor};">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <div>
                        <div style="font-size:11px; font-weight:800; color:${cor};">Índice de Qualidade</div>
                        <div style="font-size:9px; color:#94a3b8;">Análise em tempo real vs. baseline do abastecimento</div>
                    </div>
                    <div style="text-align:center;">
                        <div style="font-size:2rem; font-weight:900; color:${cor};">${resultado.indiceQualidade}</div>
                        <div style="font-size:8px; color:#94a3b8;">/100</div>
                    </div>
                </div>
                <div style="height:6px; background:rgba(255,255,255,0.1); border-radius:3px; overflow:hidden; margin-bottom:8px;">
                    <div style="height:100%; width:${resultado.indiceQualidade}%; background:${cor}; border-radius:3px; transition:width 0.5s;"></div>
                </div>
                <div style="font-size:10px; color:${cor}; font-weight:600;">${resultado.diagnostico}</div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:6px; margin-bottom:12px;">
                ${[
                    { label: 'Fuel Trim', score: resultado.scoreSTFT, delta: resultado.deltaSTFT + '%' },
                    { label: 'LTFT', score: resultado.scoreLTFT, delta: resultado.deltaLTFT + '%' },
                    { label: 'Sensor O₂', score: resultado.scoreO2, delta: resultado.oscilacaoO2 + ' osc.' },
                    { label: 'Consumo', score: resultado.scoreConsumo, delta: '' }
                ].map(item => {
                    const c = item.score >= 80 ? 'var(--success)' : item.score >= 60 ? 'var(--warning)' : 'var(--danger)';
                    return `
                        <div style="background:rgba(255,255,255,0.03); padding:8px; border-radius:6px; text-align:center; border-top:2px solid ${c};">
                            <div style="font-size:8px; color:#94a3b8; text-transform:uppercase;">${item.label}</div>
                            <div style="font-size:1rem; font-weight:800; color:${c};">${item.score.toFixed(0)}</div>
                            ${item.delta ? `<div style="font-size:7px; color:#666;">Δ ${item.delta}</div>` : ''}
                        </div>
                    `;
                }).join('')}
            </div>`;
    }

    if (postos.length > 0) {
        html += `
            <div style="font-size:9px; color:#94a3b8; text-transform:uppercase; font-weight:700; margin-bottom:8px;">Ranking por Posto</div>`;
        postos.forEach(p => {
            const cor = p.qualidade >= 80 ? 'var(--success)' : p.qualidade >= 60 ? 'var(--warning)' : 'var(--danger)';
            const badge = p.melhorPosto ? '<span style="background:var(--success); color:#000; padding:2px 6px; border-radius:4px; font-size:7px; font-weight:800; margin-left:6px;">MELHOR</span>' : '';
            html += `
                <div style="padding:10px; margin-bottom:6px; background:rgba(255,255,255,0.03); border-radius:8px; border-left:4px solid ${cor};">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:11px; font-weight:700; color:#fff;">${escapeHtml(p.nome)}${badge}</div>
                            <div style="font-size:8px; color:#94a3b8;">${p.abastecimentos} abast. — LTFT: ±${p.mediaFuelTrim}% — O₂ osc: ${p.mediaOscilacaoO2} — MAP: ${p.mediaMAP} kPa</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:1.1rem; font-weight:900; color:${cor};">${p.qualidade}</div>
                            <div style="font-size:7px; color:#94a3b8;">QUALIDADE</div>
                        </div>
                    </div>
                </div>`;
        });
    }

    container.innerHTML = html;
}
