// =============================================
// obd2.js — Conexão ELM327, simulação e leitura de dados OBD2
// =============================================

// --- MODO SIMULADOR DE DADOS E CONEXÃO REAL ---
let modoSimulacao = true; 
let simulationIntervalId;
let pollingIntervalId;
let pollingTelemetriaId;
let port;
let reader;
let writer;
let bleCharacteristic = null;
let bleTxCharacteristic = null;
let bleWriteType = 'writeWithoutResponse';
let bleBuffer = '';
let bleDevice = null;
let tipoConexao = null; // 'serial' ou 'ble'

// Pre-load OBDex DTC database (lazy, non-blocking)
loadOBDex();

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

let nivelCombustivelAnterior = null;
let detectandoAbastecimento = false;

function simularDadosOBD() {
    if (!modoSimulacao) return;

    const kmAtual = parseInt(localStorage.getItem("car_km")) || 80000;
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
    const consumoPercentual = (consumoLh / 3600) * (1 / 3) * 100;
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
    const tanqueCap = parseInt(localStorage.getItem("car_tanque_capacidade")) || 50;
    const litrosRestante = ((leiturasOBD.nivelCombustivel / 100) * tanqueCap).toFixed(1);
    if (elLiters) elLiters.innerText = litrosRestante;

    const rpmEl = document.getElementById('rpm-num');
    if (rpmEl) rpmEl.innerText = Math.round(leiturasOBD.rpm);
    const rpmFill = document.getElementById('rpm-fill');
    if (rpmFill) {
        const pct = (leiturasOBD.rpm / 8000) * 314;
        rpmFill.style.strokeDasharray = `${pct} 314`;
    }

    atualizarPainelConsumo();
    renderizarSensores();
    renderizarDiagnostico();
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
        if (!kmLitro && consLh > 0 && vel > 5) {
            const calc = vel / consLh;
            if (calc >= 2 && calc <= 30) kmLitro = calc.toFixed(1);
        }
        elMedio.innerHTML = kmLitro ? `${kmLitro} <small style="font-size:10px">km/L</small>` : `-- <small style="font-size:10px">km/L</small>`;
    }
    if (elKmRest) {
        const tanqueCap = parseInt(localStorage.getItem("car_tanque_capacidade")) || 0;
        const nivel = leiturasOBD.nivelCombustivel || 0;
        const litrosRestante = (nivel / 100) * tanqueCap;
        let kmLitro = calcularKmPorLitro();
        if (!kmLitro && consLh > 0 && vel > 5) {
            const calc = vel / consLh;
            if (calc >= 2 && calc <= 30) kmLitro = calc;
        }
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

            const btnConnect = document.getElementById('btn-conectar-carro');
            if (btnConnect) {
                btnConnect.innerText = "CONECTADO";
                btnConnect.style.background = "var(--success)";
                btnConnect.style.color = "#000";
            }

            const badge = document.querySelector('.header-stats .stat-mini:nth-child(2)');
            if (badge) {
                badge.innerHTML = '<i class="fas fa-satellite-dish"></i> Conectado';
                badge.borderColor = "var(--success)";
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
            simulationIntervalId = setInterval(simularDadosOBD, 3000);
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

        clearInterval(simulationIntervalId);

        await bleCharacteristic.startNotifications();
        bleCharacteristic.addEventListener('characteristicvaluechanged', onBleNotification);

        showToast("Bluetooth conectado! Inicializando ELM327...", "success");

        atualizarUIConectado();

        await inicializarPainelReal();

    } catch (error) {
        console.error("Erro na conexão Bluetooth:", error);
        if (error.name === 'NotFoundError') {
            showToast("Nenhum dispositivo selecionado.", "warning");
        } else {
            showToast("Erro ao conectar Bluetooth: " + error.message, "error");
        }
        modoSimulacao = true;
        tipoConexao = null;
        bleCharacteristic = null;
        bleTxCharacteristic = null;
        simulationIntervalId = setInterval(simularDadosOBD, 3000);
        atualizarUIDesconectado();
    }
}

let bleDataCount = 0;
function onBleNotification(event) {
    const decoder = new TextDecoder();
    const value = decoder.decode(event.target.value);
    bleBuffer += value;

    if (bleBuffer.includes(">")) {
        const resposta = bleBuffer;
        bleBuffer = '';
        bleDataCount++;
        console.log(`[BLE #${bleDataCount}] Recebido:`, resposta.trim());

        if (bleDataCount === 1) {
            showToast("Primeira resposta do ELM327 recebida!", "success");
        }

        if (elmPromptResolve) elmPromptResolve();
        parseObdResponse(resposta);
    }
}

function onBleDisconnect() {
    console.log("Dispositivo Bluetooth desconectado.");
    if (!modoSimulacao) {
        modoSimulacao = true;
        tipoConexao = null;
        bleCharacteristic = null;
        bleTxCharacteristic = null;
        if (pollingIntervalId) clearInterval(pollingIntervalId);
        if (pollingTelemetriaId) clearInterval(pollingTelemetriaId);
        simulationIntervalId = setInterval(simularDadosOBD, 3000);
        atualizarUIDesconectado();
        showToast("Bluetooth desconectado. Voltando ao modo simulado.", "warning");
    }
}

function desconectarVeiculo() {
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
        clearInterval(simulationIntervalId);
        if (pollingIntervalId) { clearInterval(pollingIntervalId); pollingIntervalId = null; }
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

        pollingIntervalId = setInterval(() => { if(!modoSimulacao) sendElmCommand("010C"); }, isBle ? 1000 : 500);
        pollingTelemetriaId = setInterval(() => {
            if(!modoSimulacao) {
                if (isBle) {
                    (async () => {
                        const cmds = ["010C","0104","010D","0105","0142","010F","0111","0106","0107","010B","010A","010E","0101","0103","0121","012F","014D","014E","0114","0115","0116","0117","0146","01A6","0110","0152","015C","015E","0133","013C","0161","0162"];
                        for (const cmd of cmds) {
                            if (modoSimulacao) break;
                            await sendElmCommand(cmd);
                            await delay(150);
                        }
                    })();
                } else {
                    sendElmCommand("0104");
                    setTimeout(() => sendElmCommand("010D"), 300);
                    setTimeout(() => sendElmCommand("0105"), 600);
                    setTimeout(() => sendElmCommand("0142"), 900);
                    setTimeout(() => sendElmCommand("010F"), 1200);
                    setTimeout(() => sendElmCommand("0111"), 1500);
                    setTimeout(() => sendElmCommand("0106"), 1800);
                    setTimeout(() => sendElmCommand("0107"), 2100);
                    setTimeout(() => sendElmCommand("010B"), 2400);
                    setTimeout(() => sendElmCommand("010A"), 2700);
                    setTimeout(() => sendElmCommand("010E"), 3000);
                    setTimeout(() => sendElmCommand("0101"), 3300);
                    setTimeout(() => sendElmCommand("0103"), 3600);
                    setTimeout(() => sendElmCommand("0121"), 3900);
                    setTimeout(() => sendElmCommand("012F"), 4200);
                    setTimeout(() => sendElmCommand("014D"), 4500);
                    setTimeout(() => sendElmCommand("014E"), 4800);
                    setTimeout(() => sendElmCommand("0114"), 5100);
                    setTimeout(() => sendElmCommand("0115"), 5400);
                    setTimeout(() => sendElmCommand("0116"), 5700);
                    setTimeout(() => sendElmCommand("0117"), 6000);
                    setTimeout(() => sendElmCommand("0146"), 6300);
                    setTimeout(() => sendElmCommand("01A6"), 6600);
                    setTimeout(() => sendElmCommand("0110"), 6900);
                    setTimeout(() => sendElmCommand("0152"), 7200);
                    setTimeout(() => sendElmCommand("015C"), 7500);
                    setTimeout(() => sendElmCommand("015E"), 7800);
                    setTimeout(() => sendElmCommand("0133"), 8100);
                    setTimeout(() => sendElmCommand("013C"), 8400);
                    setTimeout(() => sendElmCommand("0161"), 8700);
                    setTimeout(() => sendElmCommand("0162"), 9000);
                }
            }
        }, isBle ? 12000 : 6000);
    } catch(e) { console.error("Erro na inicialização:", e); }
}

let elmPromptResolve = null;
let elmCommandQueue = [];
let elmProcessing = false;

function waitForElmPrompt(timeoutMs = tipoConexao === 'ble' ? 4000 : 2000) {
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
    if (tipoConexao === 'ble') {
        const txChar = bleTxCharacteristic || bleCharacteristic;
        if (!txChar) {
            console.error("Characteristic BLE não disponível.");
            return;
        }
        if (elmProcessing) {
            elmCommandQueue.push(command);
            return;
        }
        elmProcessing = true;
        try {
            console.log("Enviando BLE:", command);
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
            elmCommandQueue.push(command);
            return;
        }
        elmProcessing = true;
        try {
            console.log("Enviando Serial:", command);
            await writer.write(command + "\r");
            await waitForElmPrompt();
        } catch (e) {
            console.error("Erro ao enviar comando serial:", e);
        } finally {
            elmProcessing = false;
            if (elmCommandQueue.length > 0 && !modoSimulacao) {
                const next = elmCommandQueue.shift();
                await sendElmCommand(next);
            }
        }
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
            parseObdResponse(value);
        } catch (error) {
            console.error("Erro na leitura serial:", error);
            break;
        }
    }
    if (!modoSimulacao && tipoConexao === 'serial') {
        console.log("Conexão serial perdida. Retornando ao modo de simulação.");
        modoSimulacao = true;
        tipoConexao = null;
        if (pollingIntervalId) clearInterval(pollingIntervalId);
        if (pollingTelemetriaId) clearInterval(pollingTelemetriaId);
        simulationIntervalId = setInterval(simularDadosOBD, 3000);
        atualizarUIDesconectado();
    }
}

// --- BANCO DE DADOS E AUXILIARES DTC (ESTILO TORQUE) ---
const OBDex_URL = 'https://foerbsnavi.github.io/obdex/generic.min.json';
let _obdexCache = null;
let _obdexLoading = false;

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

function gerarHtmlErroTorque(codigo) {
    const sistema = obterSistemaDTC(codigo);
    const subsistema = obterSubsistemaDTC(codigo);
    const info = obterDTCInfo(codigo);
    const desc = info ? info.description : "Descrição detalhada não cadastrada.";
    const causa = info ? info.cause : '';
    const sintomas = info ? info.symptoms : '';
    const reparo = info ? info.repair : '';
    const nivelCor = (info && info.severity === 'high') ? 'var(--danger)' : (info && info.severity === 'low') ? 'var(--success)' : 'var(--warning)';
    
    let html = `
        <div style="margin-bottom: 15px; padding: 15px; background: rgba(255,0,85,0.05); border-radius: 12px; border-left: 4px solid ${nivelCor};">
            <div style="font-size: 1.8rem; font-weight: 900; color: ${nivelCor}; line-height: 1;">${codigo}</div>
            <div style="font-size: 9px; color: var(--accent); text-transform: uppercase; font-weight: 800; margin: 6px 0;">
                ${sistema}${subsistema ? ' — ' + subsistema : ''}
            </div>
            <p style="font-size: 12px; line-height: 1.4; color: #fff; margin: 8px 0 0 0; opacity: 0.9;">${desc}</p>`;
    if (causa) {
        html += `<div style="margin-top:8px; font-size:10px; color:#94a3b8;"><strong style="color:var(--warning);">Possíveis causas:</strong> ${typeof causa === 'string' ? causa : Array.isArray(causa) ? causa.join(', ') : ''}</div>`;
    }
    if (sintomas) {
        html += `<div style="margin-top:4px; font-size:10px; color:#94a3b8;"><strong style="color:var(--accent);">Sintomas:</strong> ${typeof sintomas === 'string' ? sintomas : Array.isArray(sintomas) ? sintomas.join(', ') : ''}</div>`;
    }
    if (reparo) {
        const rep = typeof reparo === 'object' ? `${reparo.difficulty || ''} ${reparo.estimated_hours ? '(' + reparo.estimated_hours + 'h)' : ''}` : reparo;
        if (rep.trim()) html += `<div style="margin-top:4px; font-size:10px; color:#94a3b8;"><strong style="color:var(--success);">Reparo:</strong> ${rep}</div>`;
    }
    html += `</div>`;
    return html;
}

function parseObdResponse(response) {
    const lines = response.split('\r\n').map(line => line.trim()).filter(line => line.length > 0);

    for (const line of lines) {
        if (line.includes("NO DATA")) {
            document.getElementById('scan-active').classList.add('hidden');
            const res = document.getElementById('scan-result');
            res.classList.remove('hidden');
            const resContent = document.getElementById('scan-result-content');
            resContent.innerHTML = `<div style="color:var(--success); font-weight:800; font-size:10px"><i class="fas fa-check-circle"></i> STATUS:</div>
                             <p style="font-size:12px; margin:5px 0 15px;">Nenhum código de falha encontrado. Sistema operacional normal.</p>`;
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
                const fuelStatus2 = byteA & 0x0F;
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
        atualizarPainelConsumo();
        renderizarSensores();
        renderizarDiagnostico();
    }
}

// Alterna entre modo simulado e modo real (hardware conectado)
function toggleObdMode(isSimulated) {
    document.getElementById('btn-obd-sim').classList.toggle('active', isSimulated);
    document.getElementById('btn-obd-real').classList.toggle('active', !isSimulated);

    if (isSimulated && !modoSimulacao) {
        if (pollingIntervalId) { clearInterval(pollingIntervalId); pollingIntervalId = null; }
        if (pollingTelemetriaId) { clearInterval(pollingTelemetriaId); pollingTelemetriaId = null; }
        modoSimulacao = true;
        tipoConexao = null;
        simulationIntervalId = setInterval(simularDadosOBD, 3000);
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
    { id: 'tempMotor', label: 'Temp. Motor', icon: '🌡️', unit: '°C', decimals: 1, min: 60, max: 120, critico: [105, 120], alerta: [95, 105] },
    { id: 'tensaoBateria', label: 'Tensão Bateria', icon: '🔋', unit: 'V', decimals: 1, min: 10, max: 16, critico: [10, 11.5], alerta: [11.5, 12.0] },
    { id: 'cargaMotor', label: 'Carga Motor', icon: '📊', unit: '%', decimals: 0, min: 0, max: 100, critico: [90, 100], alerta: [75, 90] },
    { id: 'posAcelerador', label: 'Pos. Acelerador', icon: '⬆️', unit: '%', decimals: 0, min: 0, max: 100, critico: [90, 100], alerta: [75, 90] },
    { id: 'tempArAdmissao', label: 'Temp. Admissão', icon: '💨', unit: '°C', decimals: 1, min: 0, max: 80, critico: [60, 80], alerta: [50, 60] },
    { id: 'pressaoMAP', label: 'Pressão MAP', icon: '🔴', unit: 'kPa', decimals: 0, min: 0, max: 110, critico: [95, 110], alerta: [80, 95] },
    { id: 'consumoInstantaneo', label: 'Consumo', icon: '⛽', unit: 'L/h', decimals: 1, min: 0, max: 20, critico: [15, 20], alerta: [10, 15] },
    { id: 'nivelO2', label: 'Sensor O₂', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0, 0.05], alerta: [0.05, 0.15] },
    { id: 'pontoIgnicao', label: 'Ponto Ignição', icon: '⚡', unit: '°', decimals: 1, min: 0, max: 40, critico: [30, 40], alerta: [25, 30] },
    { id: 'fuelTrimSTFT', label: 'Fuel Trim STFT', icon: '🔧', unit: '%', decimals: 1, min: -30, max: 30, critico: [-30, -20], alerta: [-20, -10], criticoAlto: [20, 30], alertaAlto: [10, 20] },
    { id: 'fuelTrimLTFT', label: 'Fuel Trim LTFT', icon: '🔧', unit: '%', decimals: 1, min: -30, max: 30, critico: [-30, -20], alerta: [-20, -10], criticoAlto: [20, 30], alertaAlto: [10, 20] },
    { id: 'pressaoCombustivel', label: 'Pressão Comb.', icon: '⛽', unit: 'kPa', decimals: 0, min: 0, max: 600, critico: [150, 250], alerta: [250, 300], criticoAlto: [500, 600], alertaAlto: [450, 500] },
    { id: 'tempAmbiente', label: 'Temp. Ambiente', icon: '🌍', unit: '°C', decimals: 1, min: -20, max: 55, critico: [-20, -10], alerta: [-10, 0], criticoAlto: [45, 55], alertaAlto: [40, 45] },
    { id: 'deslizamentoEmbreagem', label: 'Embreagem', icon: '🔗', unit: '%', decimals: 1, min: 0, max: 30, critico: [15, 30], alerta: [8, 15] },
    { id: 'distDesdeDTC', label: 'Dist. desde DTCs', icon: '📏', unit: 'km', decimals: 0, min: 0, max: 65535, critico: [0, 100], alerta: [100, 500] },
    { id: 'tempoDesdeUltimaPartida', label: 'Tempo Motor', icon: '⏱️', unit: 'min', decimals: 0, min: 0, max: 1440, critico: [480, 1440], alerta: [360, 480] },
    { id: 'tempoDesdeDTC', label: 'Tempo desde DTCs', icon: '📅', unit: 'min', decimals: 0, min: 0, max: 65535, critico: [0, 100], alerta: [100, 1000] },
    { id: 'o2Sensor1', label: 'Sensor O₂ (B1S1)', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0, 0.05], alerta: [0.05, 0.15] },
    { id: 'o2Sensor2', label: 'Sensor O₂ (B1S2)', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0, 0.05], alerta: [0.05, 0.15] },
    { id: 'o2Sensor3', label: 'Sensor O₂ (B2S1)', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0, 0.05], alerta: [0.05, 0.15] },
    { id: 'o2Sensor4', label: 'Sensor O₂ (B2S2)', icon: '🫁', unit: 'V', decimals: 2, min: 0, max: 1, critico: [0, 0.05], alerta: [0.05, 0.15] },
    { id: 'maf', label: 'Vazão MAF', icon: '💨', unit: 'g/s', decimals: 1, min: 0, max: 200, critico: [150, 200], alerta: [120, 150] },
    { id: 'etanolPercent', label: '% Etanol', icon: '⛽', unit: '%', decimals: 0, min: 0, max: 100, critico: [], alerta: [] },
    { id: 'tempOleo', label: 'Temp. Óleo', icon: '🛢️', unit: '°C', decimals: 0, min: 40, max: 150, critico: [130, 150], alerta: [115, 130] },
    { id: 'consumoRealLh', label: 'Consumo Real', icon: '⛽', unit: 'L/h', decimals: 1, min: 0, max: 30, critico: [20, 30], alerta: [15, 20] },
    { id: 'pressaoBarometrica', label: 'Pressão Barom.', icon: '🌍', unit: 'kPa', decimals: 0, min: 80, max: 110, critico: [80, 85], alerta: [85, 90] },
    { id: 'tempCatalisador', label: 'Temp. Catalisador', icon: '🔥', unit: '°C', decimals: 0, min: 0, max: 1000, critico: [850, 1000], alerta: [750, 850] },
    { id: 'torqueSolicitado', label: 'Torque Solicitado', icon: '⚡', unit: '%', decimals: 0, min: -125, max: 130, critico: [100, 130], alerta: [80, 100] },
    { id: 'torqueReal', label: 'Torque Real', icon: '⚡', unit: '%', decimals: 0, min: -125, max: 130, critico: [100, 130], alerta: [80, 100] }
];

function renderizarSensores() {
    const container = document.getElementById('obd-sensores');
    if (!container) return;

    container.innerHTML = SENSORES_OBD.map(s => {
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

        return `
            <div style="background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; border-left:3px solid ${cor};">
                <div style="font-size:8px; color:#94a3b8; text-transform:uppercase;">${s.icon} ${s.label}</div>
                <div style="font-size:1.1rem; font-weight:800; color:${cor};">${val > 0 ? '+' : ''}${val.toFixed(s.decimals)}${s.unit ? ' ' + s.unit : ''}</div>
            </div>
        `;
    }).join('');
}

function renderizarDiagnostico() {
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

let abastecimentos = JSON.parse(localStorage.getItem("car_abastecimentos") || "[]");

function salvarAbastecimentos() {
    localStorage.setItem("car_abastecimentos", JSON.stringify(abastecimentos));
}

function detectarAbastecimento(nivelAntes, nivelDepois) {
    if (nivelAntes === null || nivelAntes === undefined) return;
    if (nivelDepois > nivelAntes + 10) {
        const tanqueCap = parseInt(localStorage.getItem("car_tanque_capacidade")) || 50;
        const litros = ((nivelDepois - nivelAntes) / 100) * tanqueCap;
        const kmAtual = parseInt(localStorage.getItem("car_km")) || 0;

        const abast = {
            data: new Date().toISOString(),
            litros: parseFloat(litros.toFixed(1)),
            nivelAntes: parseFloat(nivelAntes.toFixed(1)),
            nivelDepois: parseFloat(nivelDepois.toFixed(1)),
            km: kmAtual,
            posto: "",
            snapshot: {
                fuelTrimSTFT: parseFloat(leiturasOBD.fuelTrimSTFT.toFixed(1)),
                fuelTrimLTFT: parseFloat(leiturasOBD.fuelTrimLTFT.toFixed(1)),
                consumo: parseFloat(leiturasOBD.consumoInstantaneo.toFixed(1)),
                nivelO2: parseFloat(leiturasOBD.nivelO2.toFixed(2)),
                tempCatalisador: parseFloat(leiturasOBD.tempCatalisador.toFixed(0)),
                tempMotor: parseFloat(leiturasOBD.tempMotor.toFixed(1))
            }
        };

        abastecimentos.push(abast);
        salvarAbastecimentos();

        showToast(`Abastecimento detectado! ~${litros.toFixed(1)}L adicionados. Registre o posto no histórico.`, "info");
        if (typeof renderizarAbastecimentos === 'function') renderizarAbastecimentos();
    }
}

function registrarAbastecimentoManual() {
    const kmAtual = parseInt(localStorage.getItem("car_km")) || 0;
    const nivelAtual = leiturasOBD.nivelCombustivel || 50;
    const tanqueCap = parseInt(localStorage.getItem("car_tanque_capacidade")) || 50;

    const abast = {
        data: new Date().toISOString(),
        litros: 0,
        nivelAntes: parseFloat(nivelAtual.toFixed(1)),
        nivelDepois: parseFloat(nivelAtual.toFixed(1)),
        km: kmAtual,
        posto: "",
        snapshot: {
            fuelTrimSTFT: parseFloat(leiturasOBD.fuelTrimSTFT.toFixed(1)),
            fuelTrimLTFT: parseFloat(leiturasOBD.fuelTrimLTFT.toFixed(1)),
            consumo: parseFloat(leiturasOBD.consumoInstantaneo.toFixed(1)),
            nivelO2: parseFloat(leiturasOBD.nivelO2.toFixed(2)),
            tempCatalisador: parseFloat((leiturasOBD.tempCatalisador || leiturasOBD.tempPosCatalisador || 0).toFixed(0)),
            tempMotor: parseFloat(leiturasOBD.tempMotor.toFixed(1))
        }
    };

    abastecimentos.push(abast);
    salvarAbastecimentos();
    showToast("Registro de abastecimento salvo. Edite para adicionar posto e litros.", "success");
    if (typeof renderizarAbastecimentos === 'function') renderizarAbastecimentos();
}

function editarAbastecimento(index, litros, posto) {
    if (abastecimentos[index]) {
        abastecimentos[index].litros = parseFloat(litros) || 0;
        abastecimentos[index].posto = posto || "";
        salvarAbastecimentos();
        showToast("Abastecimento atualizado!", "success");
    }
}

function removerAbastecimento(index) {
    abastecimentos.splice(index, 1);
    salvarAbastecimentos();
    showToast("Abastecimento removido.", "info");
}

function calcularKmPorLitro() {
    if (abastecimentos.length < 2) return null;
    const ordenado = [...abastecimentos].sort((a, b) => a.km - b.km);
    let totalKm = ordenado[ordenado.length - 1].km - ordenado[0].km;
    let totalLitros = ordenado.slice(1).reduce((sum, a) => sum + (a.litros || 0), 0);
    if (totalLitros < 1 || totalKm < 1) return null;
    const kmL = totalKm / totalLitros;
    if (kmL < 2 || kmL > 30) return null;
    return parseFloat(kmL.toFixed(1));
}

function calcularPerfilPostos() {
    const perfil = {};
    abastecimentos.forEach(a => {
        if (!a.posto) return;
        if (!perfil[a.posto]) {
            perfil[a.posto] = { nome: a.posto, abastecimentos: 0, mediaFuelTrim: 0, mediaConsumo: 0, mediaMisfires: 0, qualidade: 100, historico: [] };
        }
        const p = perfil[a.posto];
        p.abastecimentos++;
        p.historico.push(a.snapshot);
        p.mediaFuelTrim += Math.abs(a.snapshot.fuelTrimLTFT || 0);
        p.mediaConsumo += a.snapshot.consumo || 0;
    });

    Object.values(perfil).forEach(p => {
        if (p.abastecimentos > 0) {
            p.mediaFuelTrim = parseFloat((p.mediaFuelTrim / p.abastecimentos).toFixed(1));
            p.mediaConsumo = parseFloat((p.mediaConsumo / p.abastecimentos).toFixed(1));

            let penalidades = 0;
            if (p.mediaFuelTrim > 10) penalidades += 25;
            else if (p.mediaFuelTrim > 5) penalidades += 10;
            if (p.mediaConsumo > 10) penalidades += 20;
            else if (p.mediaConsumo > 8) penalidades += 10;

            p.qualidade = Math.max(0, 100 - penalidades);
        }
    });

    return perfil;
}
