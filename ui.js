// =============================================
// ui.js — Navegação, dados do veículo (FIPE), manutenção, loja de peças e onboarding
// =============================================

const API_FIPE = "https://parallelum.com.br/fipe/api/v1/carros";
let marcasCache = [];
let modelosCache = {};
let anosPorModeloCache = {};
let listaNecessidades = [];
let categoriaAtualCatalogo = "filtros"; // Categoria padrão ao abrir

// ==========================================
// CATÁLOGO MESTRE DE MANUTENÇÃO
// Referência genérica (não é dado de nenhum veículo específico).
// Cada item pode vencer por KM, por tempo (meses), ou pelos dois —
// nesse caso vale o que vencer primeiro.
// ==========================================
const CATALOGO_MANUTENCAO = [
    { id: 'oleo_motor', nome: 'Óleo do Motor com Filtro', categoria: 'Motor & Transmissão', intervaloKm: 10000, intervaloMeses: 12, criticidade: 'Alta' },
    { id: 'correia_dentada', nome: 'Correia Dentada', categoria: 'Motor & Transmissão', intervaloKm: 60000, intervaloMeses: 60, criticidade: 'Crítica' },
    { id: 'bomba_dagua', nome: 'Bomba d\'Água', categoria: 'Motor & Transmissão', intervaloKm: 60000, intervaloMeses: 60, criticidade: 'Crítica' },
    { id: 'tensor_correia', nome: 'Tensor da Correia', categoria: 'Motor & Transmissão', intervaloKm: 60000, intervaloMeses: 60, criticidade: 'Crítica' },
    { id: 'filtro_ar_motor', nome: 'Filtro de Ar do Motor', categoria: 'Filtros & Alimentação', intervaloKm: 15000, intervaloMeses: 12, criticidade: 'Média' },
    { id: 'filtro_combustivel', nome: 'Filtro de Combustível', categoria: 'Filtros & Alimentação', intervaloKm: 10000, intervaloMeses: 12, criticidade: 'Alta' },
    { id: 'velas', nome: 'Jogo de Velas de Ignição', categoria: 'Ignição', intervaloKm: 40000, intervaloMeses: null, criticidade: 'Alta' },
    { id: 'bobina', nome: 'Bobina de Ignição', categoria: 'Ignição', intervaloKm: 80000, intervaloMeses: null, criticidade: 'Média' },
    { id: 'pastilha_dianteira', nome: 'Pastilha de Freio Dianteira', categoria: 'Freios', intervaloKm: 30000, intervaloMeses: null, criticidade: 'Crítica' },
    { id: 'disco_freio', nome: 'Disco de Freio (Par)', categoria: 'Freios', intervaloKm: 60000, intervaloMeses: null, criticidade: 'Crítica' },
    { id: 'fluido_freio', nome: 'Fluido de Freio', categoria: 'Freios', intervaloKm: null, intervaloMeses: 24, criticidade: 'Crítica' },
    { id: 'amortecedores', nome: 'Amortecedores', categoria: 'Suspensão & Direção', intervaloKm: 80000, intervaloMeses: null, criticidade: 'Alta' },
    { id: 'filtro_cabine', nome: 'Filtro de Cabine (Ar-Condicionado)', categoria: 'Ar Condicionado', intervaloKm: 15000, intervaloMeses: 12, criticidade: 'Média' },
    { id: 'bateria', nome: 'Bateria', categoria: 'Elétrica', intervaloKm: null, intervaloMeses: 48, criticidade: 'Alta' }
];

// Registros reais de manutenção do usuário — vazio até ele cadastrar algo.
// Persistido no localStorage, como o resto dos dados do veículo.
let registrosManutencao = [];

function carregarRegistrosManutencao() {
    try {
        registrosManutencao = JSON.parse(localStorage.getItem("car_maint_records")) || [];
    } catch (e) {
        console.error("Erro ao carregar registros de manutenção:", e);
        registrosManutencao = [];
    }
}

function salvarRegistrosManutencao() {
    localStorage.setItem("car_maint_records", JSON.stringify(registrosManutencao));
}

function formatarDataBR(isoDate) {
    if (!isoDate) return '--';
    const [ano, mes, dia] = isoDate.split('-');
    return `${dia}/${mes}/${ano}`;
}

function validarPlaca(placa) {
    if (!placa) return true;
    return /^[A-Z0-9]{7}$/.test(placa.toUpperCase());
}

function validarVIN(vin) {
    if (!vin) return true;
    return /^[A-Z0-9]{17}$/.test(vin.toUpperCase());
}

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function popularDatalistManutencao() {
    const dl = document.getElementById('list-maint-itens');
    if (!dl) return;
    dl.innerHTML = '';
    CATALOGO_MANUTENCAO.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.nome;
        dl.appendChild(opt);
    });
}

// Inicialização do App e Verificação de Dados Dinâmicos
document.addEventListener("DOMContentLoaded", async () => {
    simulationIntervalId = setInterval(simularDadosOBD, 3000); // Inicia a simulação
    carregarRegistrosManutencao();
    popularDatalistManutencao();
    await initStaticSelects();
    verificarOnboardingESincronizacao();
});

async function initStaticSelects() {
    try {
        const response = await fetch(`${API_FIPE}/marcas`);
        marcasCache = await response.json();
        ['list-onb-marcas', 'list-inp-prof-marcas'].forEach(id => {
            const dl = document.getElementById(id);
            dl.innerHTML = '';
            marcasCache.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.nome;
                dl.appendChild(opt);
            });
        });
    } catch (error) {
        console.error("Erro ao carregar marcas:", error);
    }
}

async function onMarcaChange(prefix) {
    const brandName = document.getElementById(prefix + '-marca').value;
    const anoSelect = document.getElementById(prefix + '-ano');
    const modSelect = document.getElementById(prefix + '-modelo');
    const verSelect = document.getElementById(prefix + '-versao');

    anoSelect.innerHTML = '<option value="">Ano...</option>';
    modSelect.innerHTML = '<option value="">Modelo...</option>';
    verSelect.innerHTML = '<option value="">Versão...</option>';

    const brand = marcasCache.find(m => m.nome === brandName);
    if (!brand) return;

    try {
        const resp = await fetch(`${API_FIPE}/marcas/${brand.codigo}/modelos`);
        const data = await resp.json();
        modelosCache[prefix] = data.modelos;

        const anosComModelos = {};

        const fetches = data.modelos.map(async (mod) => {
            try {
                const respAnos = await fetch(`${API_FIPE}/marcas/${brand.codigo}/modelos/${mod.codigo}/anos`);
                const anos = await respAnos.json();
                anosPorModeloCache[`${prefix}_${mod.codigo}`] = anos;
                anos.forEach(a => {
                    const anoNum = a.codigo.split('-')[0];
                    if (!anosComModelos[anoNum]) anosComModelos[anoNum] = 0;
                    anosComModelos[anoNum]++;
                });
            } catch (e) {}
        });

        await Promise.all(fetches);

        const anosOrdenados = Object.keys(anosComModelos).sort((a, b) => b - a);
        anosOrdenados.forEach(ano => {
            anoSelect.innerHTML += `<option value="${ano}">${ano} (${anosComModelos[ano]} modelos)</option>`;
        });
    } catch (error) {
        console.error("Erro ao carregar anos:", error);
    }
}

function onAnoChange(prefix) {
    const brandName = document.getElementById(prefix + '-marca').value;
    const anoSel = document.getElementById(prefix + '-ano').value;
    const modSelect = document.getElementById(prefix + '-modelo');
    const verSelect = document.getElementById(prefix + '-versao');

    modSelect.innerHTML = '<option value="">Modelo...</option>';
    verSelect.innerHTML = '<option value="">Versão...</option>';

    if (!anoSel) return;

    const brand = marcasCache.find(m => m.nome === brandName);
    const modelos = modelosCache[prefix] || [];

    modelos.forEach(mod => {
        const chaveCache = `${prefix}_${mod.codigo}`;
        const anosDoModelo = anosPorModeloCache[chaveCache] || [];
        const temAno = anosDoModelo.some(a => a.codigo.startsWith(anoSel + '-'));
        if (temAno) {
            modSelect.innerHTML += `<option value="${mod.codigo}">${mod.nome}</option>`;
        }
    });
}

function onModeloChange(prefix) {
    const brandName = document.getElementById(prefix + '-marca').value;
    const anoSel = document.getElementById(prefix + '-ano').value;
    const modelCode = document.getElementById(prefix + '-modelo').value;
    const verSelect = document.getElementById(prefix + '-versao');

    verSelect.innerHTML = '<option value="">Versão...</option>';

    if (!anoSel || !modelCode) return;

    const brand = marcasCache.find(m => m.nome === brandName);
    if (!brand) return;

    const chaveCache = `${prefix}_${modelCode}`;
    const versoes = anosPorModeloCache[chaveCache] || [];
    const filtradas = versoes.filter(v => v.codigo.startsWith(anoSel + '-'));

    filtradas.forEach(ver => {
        verSelect.innerHTML += `<option value="${ver.codigo}">${ver.nome}</option>`;
    });
}

function verificarOnboardingESincronizacao() {
    let kmAtual = localStorage.getItem("car_km");
    
    if (!kmAtual) {
        document.getElementById("modal-onboarding").classList.remove("hidden");
    } else {
        processarEstimativaDeQuilometragem();
        renderizarDadosGlobais();
    }
}

function concluirOnboarding() {
    const kmInput = document.getElementById("onb-km").value;
    const mSel = document.getElementById("onb-marca").value;
    const modSelect = document.getElementById("onb-modelo");
    const verSel = document.getElementById("onb-versao");
    const anoSel = document.getElementById("onb-ano").value;
    const placaInput = document.getElementById("onb-placa").value.trim();
    const vinInput = document.getElementById("onb-vin").value.trim();

    if (!kmInput || kmInput <= 0) {
        showToast("Por favor, digite uma quilometragem inicial válida (apenas números positivos).", "error");
        return;
    }

    if (placaInput && !validarPlaca(placaInput)) {
        showToast("Placa inválida. Formato correto: ABC1D23 (7 caracteres, letras e números).", "error");
        return;
    }

    if (vinInput && !validarVIN(vinInput)) {
        showToast("Chassi/VIN inválido. Deve conter exatamente 17 caracteres (letras e números).", "error");
        return;
    }

    localStorage.setItem("car_km", kmInput);
    localStorage.setItem("car_marca_nome", mSel);
    localStorage.setItem("car_modelo_nome", modSelect.options[modSelect.selectedIndex]?.text || "");
    localStorage.setItem("car_versao_nome", verSel.options[verSel.selectedIndex]?.text || "");
    localStorage.setItem("car_ano", anoSel);
    localStorage.setItem("car_ultima_data", new Date().toISOString());
    localStorage.setItem("car_media_diaria", "40");
    if (placaInput) localStorage.setItem("car_placa", placaInput.toUpperCase());
    if (vinInput) localStorage.setItem("car_vin", vinInput.toUpperCase());

    const tanqueInput = document.getElementById("onb-tanque").value;
    if (tanqueInput && parseInt(tanqueInput) > 0) {
        localStorage.setItem("car_tanque_capacidade", tanqueInput);
    }

    document.getElementById("modal-onboarding").classList.add("hidden");
    renderizarDadosGlobais();
}

function processarEstimativaDeQuilometragem() {
    let ultimaDataStr = localStorage.getItem("car_ultima_data");
    if (!ultimaDataStr) return;

    let ultimaData = new Date(ultimaDataStr);
    let hoje = new Date();
    
    let diferencaTempo = hoje.getTime() - ultimaData.getTime();
    let diferencaDias = Math.floor(diferencaTempo / (1000 * 3600 * 24));

    if (diferencaDias >= 1) {
        let kmAtual = parseInt(localStorage.getItem("car_km"));
        let mediaDiaria = parseInt(localStorage.getItem("car_media_diaria")) || 40;
        let kmSugerida = kmAtual + (diferencaDias * mediaDiaria);

        document.getElementById("lbl-estimativa-dias").innerText = `Faz ${diferencaDias} dia(s) desde sua última sincronização.`;
        document.getElementById("txt-km-sugerida").innerText = kmSugerida.toLocaleString() + " KM";
        document.getElementById("inp-km-estimada-editavel").value = kmSugerida;

        document.getElementById("modal-estimativa").classList.remove("hidden");
    }
}

function confirmarEstimativa(usarSugerido) {
    let kmFinal = parseInt(document.getElementById("inp-km-estimada-editavel").value);

    if (kmFinal && kmFinal > 0) {
        localStorage.setItem("car_km", kmFinal);
        localStorage.setItem("car_ultima_data", new Date().toISOString());
        renderizarDadosGlobais();
    }
    document.getElementById("modal-estimativa").classList.add("hidden");
}

function renderizarDadosGlobais() {
    let km = parseInt(localStorage.getItem("car_km")) || 0;
    let marcaNome = localStorage.getItem("car_marca_nome") || "Não Configurado";
    let modeloNome = localStorage.getItem("car_modelo_nome") || "";
    let ano = localStorage.getItem("car_ano") || "--";
    let placa = localStorage.getItem("car_placa") || "";
    let vin = localStorage.getItem("car_vin") || "";

    document.getElementById("txt-odometro").innerText = km.toLocaleString() + " KM";
    document.getElementById("lbl-veiculo-nome").innerText = `${marcaNome} ${modeloNome}`.trim();
    document.getElementById("lbl-veiculo-ano").innerText = `Ano: ${ano}`;
    
    // Exibe placa no perfil (se o elemento existir)
    const lblPlaca = document.getElementById("lbl-placa");
    if (lblPlaca) {
        if (placa) {
            lblPlaca.innerText = placa;
            document.getElementById("lbl-placa-container").classList.remove("hidden");
        } else {
            document.getElementById("lbl-placa-container").classList.add("hidden");
        }
    }

    // Exibe chassi no perfil (se o elemento existir)
    const lblVin = document.getElementById("lbl-vin");
    if (lblVin) {
        if (vin) {
            lblVin.innerText = vin;
            document.getElementById("lbl-vin-container").classList.remove("hidden");
        } else {
            document.getElementById("lbl-vin-container").classList.add("hidden");
        }
    }
    
    // Configura os valores nos inputs do perfil para o usuário ver o atual
    document.getElementById("inp-prof-km").value = km;
    const inpPlaca = document.getElementById("inp-prof-placa");
    if (inpPlaca) inpPlaca.value = placa;
    const inpVin = document.getElementById("inp-prof-vin");
    if (inpVin) inpVin.value = vin;
    const inpTanque = document.getElementById("inp-prof-tanque");
    if (inpTanque) inpTanque.value = localStorage.getItem("car_tanque_capacidade") || "";

    preencherPerfil(marcaNome, modeloNome, ano);

    const kmLitro = calcularKmPorLitro();
    const elConsumoMedio = document.getElementById("val-consumo-medio");
    if (elConsumoMedio) {
        elConsumoMedio.innerHTML = kmLitro ? `${kmLitro} <small style="font-size:10px">km/L</small>` : `-- <small style="font-size:10px">km/L</small>`;
    }

    renderizarAlertasManutencao();
}

async function preencherPerfil(marca, modelo, ano) {
    const marcaInput = document.getElementById("inp-prof-marca");
    const anoSelect = document.getElementById("inp-prof-ano");
    const modSelect = document.getElementById("inp-prof-modelo");
    const verSelect = document.getElementById("inp-prof-versao");

    if (!marca) return;
    marcaInput.value = marca;

    if (!marcasCache.length) {
        try {
            const resp = await fetch(`${API_FIPE}/marcas`);
            marcasCache = await resp.json();
        } catch (e) { return; }
    }

    const brand = marcasCache.find(m => m.nome === marca);
    if (!brand) return;

    try {
        const resp = await fetch(`${API_FIPE}/marcas/${brand.codigo}/modelos`);
        const data = await resp.json();
        modelosCache['inp-prof'] = data.modelos;

        const anosComModelos = {};
        const fetches = data.modelos.map(async (mod) => {
            try {
                const respAnos = await fetch(`${API_FIPE}/marcas/${brand.codigo}/modelos/${mod.codigo}/anos`);
                const anos = await respAnos.json();
                anosPorModeloCache[`inp-prof_${mod.codigo}`] = anos;
                anos.forEach(a => {
                    const anoNum = a.codigo.split('-')[0];
                    if (!anosComModelos[anoNum]) anosComModelos[anoNum] = 0;
                    anosComModelos[anoNum]++;
                });
            } catch (e) {}
        });
        await Promise.all(fetches);

        const anosOrdenados = Object.keys(anosComModelos).sort((a, b) => b - a);
        anoSelect.innerHTML = '<option value="">Ano...</option>';
        anosOrdenados.forEach(a => {
            anoSelect.innerHTML += `<option value="${a}" ${a == ano ? 'selected' : ''}>${a}</option>`;
        });

        if (ano) {
            modSelect.innerHTML = '<option value="">Modelo...</option>';
            data.modelos.forEach(mod => {
                const chaveCache = `inp-prof_${mod.codigo}`;
                const anosDoModelo = anosPorModeloCache[chaveCache] || [];
                const temAno = anosDoModelo.some(a => a.codigo.startsWith(ano + '-'));
                if (temAno) {
                    modSelect.innerHTML += `<option value="${mod.codigo}" ${mod.nome === modelo ? 'selected' : ''}>${mod.nome}</option>`;
                }
            });

            const model = data.modelos.find(m => m.nome === modelo);
            if (model) {
                const chaveCache = `inp-prof_${model.codigo}`;
                const versoes = anosPorModeloCache[chaveCache] || [];
                const verSalva = localStorage.getItem("car_versao_nome") || "";
                const filtradas = versoes.filter(v => v.codigo.startsWith(ano + '-'));
                verSelect.innerHTML = '<option value="">Versão...</option>';
                let verEncontrada = false;
                filtradas.forEach(ver => {
                    const selected = ver.nome === verSalva ? 'selected' : '';
                    if (ver.nome === verSalva) verEncontrada = true;
                    verSelect.innerHTML += `<option value="${ver.codigo}" ${selected}>${ver.nome}</option>`;
                });
                if (!verEncontrada && verSalva) {
                    verSelect.innerHTML += `<option value="${verSalva}" selected>${verSalva}</option>`;
                }
            }
        }
    } catch (e) {
        console.error("Erro ao preencher perfil:", e);
    }
}

function renderizarSaudeVeiculo() {
    const container = document.getElementById('maint-saude');
    if (!container) return;

    const kmAtual = parseInt(localStorage.getItem("car_km")) || 0;
    const hoje = new Date();
    container.innerHTML = '<div style="font-size:10px; color:var(--accent); text-transform:uppercase; margin-bottom:10px; font-weight:800; letter-spacing:1px;">Painel de Saúde do Veículo</div>';

    CATALOGO_MANUTENCAO.forEach(catalogo => {
        // Acha o registro mais recente do usuário para esse item
        const registrosDoItem = registrosManutencao.filter(r => r.item === catalogo.nome);
        const ultimoRegistro = registrosDoItem.sort((a, b) => new Date(b.data) - new Date(a.data))[0];

        const card = document.createElement('div');
        card.className = 'glass-card';
        card.style = 'margin-bottom: 12px; padding: 14px;';

        if (!ultimoRegistro) {
            // Nunca foi registrado: não inventa dado, avisa o usuário
            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <strong style="font-size:13px; color:#fff;">${catalogo.nome}</strong>
                    <span style="color:#64748b; font-weight:700; font-size:10px; text-transform:uppercase;">Sem registro</span>
                </div>
                <div style="font-size:9px; color:#64748b;">Adicione um registro de manutenção para acompanhar este item.</div>
            `;
            container.appendChild(card);
            return;
        }

        // % restante por KM (se o item tiver intervalo em KM)
        let pctKm = null;
        if (catalogo.intervaloKm) {
            const kmDesdeTroca = kmAtual - ultimoRegistro.km;
            pctKm = Math.min(100, Math.max(0, 100 - (kmDesdeTroca / catalogo.intervaloKm) * 100));
        }

        // % restante por tempo (se o item tiver intervalo em meses)
        let pctTempo = null;
        if (catalogo.intervaloMeses) {
            const dataTroca = new Date(ultimoRegistro.data);
            const mesesDesdeTroca = (hoje - dataTroca) / (1000 * 60 * 60 * 24 * 30.44);
            pctTempo = Math.min(100, Math.max(0, 100 - (mesesDesdeTroca / catalogo.intervaloMeses) * 100));
        }

        // Usa o critério mais restritivo: o que vencer primeiro (KM ou tempo)
        const candidatos = [pctKm, pctTempo].filter(p => p !== null);
        const pct = candidatos.length ? Math.min(...candidatos) : 100;

        let cor = "var(--success)";
        if (pct <= 20) cor = "var(--danger)";
        else if (pct <= 50) cor = "var(--warning)";

        const limiteKm = catalogo.intervaloKm ? (ultimoRegistro.km + catalogo.intervaloKm) : null;
        const infoDireita = limiteKm
            ? `Próxima Troca: <strong style="color:#fff;">${limiteKm.toLocaleString()} KM</strong>`
            : `Último Registro: <strong style="color:#fff;">${formatarDataBR(ultimoRegistro.data)}</strong>`;

        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <strong style="font-size:13px; color:#fff;">${catalogo.nome}</strong>
                <span style="color:${cor}; font-weight:900; font-size:12px;">${pct.toFixed(0)}%</span>
            </div>
            <div style="width:100%; background:rgba(255,255,255,0.05); height:6px; border-radius:3px; overflow:hidden;">
                <div style="width:${pct}%; background:${cor}; height:100%; transition:0.4s; box-shadow: 0 0 10px ${cor}44;"></div>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:9px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.5px;">
                <span>${infoDireita}</span>
                <span>Criticidade: <strong style="color:#fff;">${catalogo.criticidade}</strong></span>
            </div>
        `;
        container.appendChild(card);
    });
}

// Navegação entre Telas
function nav(screenId, element) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.dock-item').forEach(d => d.classList.remove('active'));
    
    document.getElementById('scr-' + screenId).classList.add('active');
    element.classList.add('active');

    // Gatilho inteligente para renderizar os dados ao entrar na aba Peças
    if (screenId === 'shop') {
        const btnSacola = document.getElementById('btn-sub-sacola');
        const abaAlvo = (btnSacola && btnSacola.classList.contains('active')) ? 'sacola' : 'catalogo';
        
        if (typeof alternarSubAbaPecas === 'function') {
            alternarSubAbaPecas(abaAlvo);
        } else if (abaAlvo === 'catalogo' && typeof renderizarCatalogoInteligente === 'function') {
            renderizarCatalogoInteligente();
        }
    }

    // Gatilho para o Painel de Saúde e Histórico
    if (screenId === 'maintenance') {
        renderizarSaudeVeiculo();
        renderizarHistoricoManutencao();
        const btnSaude = document.getElementById('btn-sub-saude');
        const abaAlvo = (btnSaude && btnSaude.classList.contains('active')) ? 'saude' : 'historico';
        alternarSubAbaManutencao(abaAlvo);
    }
}

function alternarSubAbaManutencao(aba) {
    const btnHistorico = document.getElementById('btn-sub-historico');
    const btnSaude = document.getElementById('btn-sub-saude');
    const btnGastos = document.getElementById('btn-sub-gastos');
    const btnCombustivel = document.getElementById('btn-sub-combustivel');
    const contHistorico = document.getElementById('maint-historico');
    const contSaude = document.getElementById('maint-saude');
    const contGastos = document.getElementById('maint-gastos');
    const contCombustivel = document.getElementById('maint-combustivel');

    if (btnHistorico) btnHistorico.classList.toggle('active', aba === 'historico');
    if (btnSaude) btnSaude.classList.toggle('active', aba === 'saude');
    if (btnGastos) btnGastos.classList.toggle('active', aba === 'gastos');
    if (btnCombustivel) btnCombustivel.classList.toggle('active', aba === 'combustivel');
    if (contHistorico) contHistorico.classList.toggle('hidden', aba !== 'historico');
    if (contSaude) contSaude.classList.toggle('hidden', aba !== 'saude');
    if (contGastos) contGastos.classList.toggle('hidden', aba !== 'gastos');
    if (contCombustivel) contCombustivel.classList.toggle('hidden', aba !== 'combustivel');

    if (aba === 'saude') renderizarSaudeVeiculo();
    if (aba === 'gastos') renderizarDashboardGastos();
    if (aba === 'combustivel') renderizarAbastecimentos();
}

function renderizarDashboardGastos() {
    const container = document.getElementById('maint-gastos');
    if (!container) return;

    const totalGasto = registrosManutencao.reduce((sum, r) => sum + (r.custoPeca || 0) + (r.custoMao || 0), 0);
    const totalRegistros = registrosManutencao.length;
    const mediaGasto = totalRegistros > 0 ? totalGasto / totalRegistros : 0;

    // Gastos por sistema
    const gastosPorSistema = {};
    registrosManutencao.forEach(r => {
        const sistema = r.sistema || 'Sem categoria';
        if (!gastosPorSistema[sistema]) gastosPorSistema[sistema] = 0;
        gastosPorSistema[sistema] += (r.custoPeca || 0) + (r.custoMao || 0);
    });

    // Gastos por mês (últimos 6 meses)
    const gastosPorMes = {};
    const hoje = new Date();
    for (let i = 5; i >= 0; i--) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
        const chave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        gastosPorMes[chave] = 0;
    }
    registrosManutencao.forEach(r => {
        if (r.data) {
            const chave = r.data.substring(0, 7);
            if (chave in gastosPorMes) gastosPorMes[chave] += (r.custoPeca || 0) + (r.custoMao || 0);
        }
    });

    const maxGastoMes = Math.max(...Object.values(gastosPorMes), 1);

    let html = `
        <div style="font-size:10px; color:var(--accent); text-transform:uppercase; margin-bottom:10px; font-weight:800; letter-spacing:1px;">Dashboard de Gastos</div>

        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-bottom:15px;">
            <div class="glass-card" style="padding:12px; text-align:center; border-bottom:3px solid var(--success);">
                <span style="font-size:8px; color:#94a3b8; text-transform:uppercase;">Total Gasto</span>
                <div style="font-size:1rem; font-weight:800; color:var(--success);">R$ ${totalGasto.toFixed(2)}</div>
            </div>
            <div class="glass-card" style="padding:12px; text-align:center; border-bottom:3px solid var(--accent);">
                <span style="font-size:8px; color:#94a3b8; text-transform:uppercase;">Média/Registro</span>
                <div style="font-size:1rem; font-weight:800; color:var(--accent);">R$ ${mediaGasto.toFixed(2)}</div>
            </div>
            <div class="glass-card" style="padding:12px; text-align:center; border-bottom:3px solid var(--warning);">
                <span style="font-size:8px; color:#94a3b8; text-transform:uppercase;">Registros</span>
                <div style="font-size:1rem; font-weight:800; color:var(--warning);">${totalRegistros}</div>
            </div>
        </div>
    `;

    // Gastos por mês (gráfico de barras)
    html += `<div class="glass-card" style="padding:15px;">
        <div style="font-size:9px; color:#94a3b8; text-transform:uppercase; margin-bottom:10px; font-weight:700;">Gastos por Mês (últimos 6 meses)</div>`;
    
    Object.entries(gastosPorMes).forEach(([mes, valor]) => {
        const [ano, numMes] = mes.split('-');
        const nomesMes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
        const nomeMes = nomesMes[parseInt(numMes) - 1];
        const pct = (valor / maxGastoMes) * 100;
        html += `
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                <span style="font-size:9px; color:#94a3b8; width:30px;">${nomeMes}</span>
                <div style="flex:1; background:rgba(255,255,255,0.05); height:12px; border-radius:6px; overflow:hidden;">
                    <div style="width:${pct}%; background:var(--accent); height:100%; transition:0.5s;"></div>
                </div>
                <span style="font-size:9px; color:var(--accent); width:60px; text-align:right;">R$ ${valor.toFixed(2)}</span>
            </div>
        `;
    });
    html += `</div>`;

    // Gastos por sistema
    const sistemas = Object.entries(gastosPorSistema).sort((a, b) => b[1] - a[1]);
    if (sistemas.length > 0 && sistemas[0][1] > 0) {
        html += `<div class="glass-card" style="padding:15px;">
            <div style="font-size:9px; color:#94a3b8; text-transform:uppercase; margin-bottom:10px; font-weight:700;">Gastos por Sistema</div>`;
        sistemas.forEach(([sistema, valor]) => {
            const pct = (valor / totalGasto) * 100;
            html += `
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
                    <span style="font-size:9px; color:#94a3b8; width:120px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${sistema}</span>
                    <div style="flex:1; background:rgba(255,255,255,0.05); height:12px; border-radius:6px; overflow:hidden;">
                        <div style="width:${pct}%; background:var(--warning); height:100%; transition:0.5s;"></div>
                    </div>
                    <span style="font-size:9px; color:var(--warning); width:60px; text-align:right;">R$ ${valor.toFixed(2)}</span>
                </div>
            `;
        });
        html += `</div>`;
    }

    container.innerHTML = html;
}

function renderizarAbastecimentos() {
    const container = document.getElementById('maint-combustivel');
    if (!container) return;

    const tanqueCap = parseInt(localStorage.getItem("car_tanque_capacidade")) || 50;
    const kmAtual = parseInt(localStorage.getItem("car_km")) || 0;
    const nivelAtual = (typeof leiturasOBD !== 'undefined' && leiturasOBD.nivelCombustivel) || 50;
    const litrosRestante = ((nivelAtual / 100) * tanqueCap).toFixed(1);
    const kmLitro = calcularKmPorLitro();
    const perfil = calcularPerfilPostos();
    const ordenado = [...abastecimentos].sort((a, b) => new Date(b.data) - new Date(a.data));

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <div style="font-size:10px; color:var(--accent); text-transform:uppercase; font-weight:800; letter-spacing:1px;">Monitor de Combustível</div>
            <button class="btn-main" style="font-size:10px; padding:6px 12px;" onclick="registrarAbastecimentoManual()"><i class="fas fa-plus"></i> Registrar Abastecimento</button>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-bottom:15px;">
            <div class="glass-card" style="padding:12px; text-align:center; border-bottom:3px solid var(--warning);">
                <span style="font-size:8px; color:#94a3b8; text-transform:uppercase;">No Tanque</span>
                <div style="font-size:1.1rem; font-weight:800; color:var(--warning);">${litrosRestante}L</div>
                <div style="font-size:8px; color:#94a3b8;">${tanqueCap}L total</div>
            </div>
            <div class="glass-card" style="padding:12px; text-align:center; border-bottom:3px solid var(--success);">
                <span style="font-size:8px; color:#94a3b8; text-transform:uppercase;">Nível</span>
                <div style="font-size:1.1rem; font-weight:800; color:var(--success);">${nivelAtual.toFixed(0)}%</div>
                <div style="width:100%; background:rgba(255,255,255,0.05); height:6px; border-radius:3px; margin-top:4px;">
                    <div style="width:${nivelAtual}%; background:${nivelAtual < 20 ? 'var(--danger)' : nivelAtual < 40 ? 'var(--warning)' : 'var(--success)'}; height:100%; border-radius:3px;"></div>
                </div>
            </div>
            <div class="glass-card" style="padding:12px; text-align:center; border-bottom:3px solid var(--accent);">
                <span style="font-size:8px; color:#94a3b8; text-transform:uppercase;">Média Geral</span>
                <div style="font-size:1.1rem; font-weight:800; color:var(--accent);">${kmLitro || '--'} km/L</div>
                <div style="font-size:8px; color:#94a3b8;">${abastecimentos.length} abast.</div>
            </div>
        </div>
    `;

    if (ordenado.length > 0) {
        html += `<div class="glass-card" style="padding:15px; margin-bottom:12px;">
            <div style="font-size:9px; color:#94a3b8; text-transform:uppercase; margin-bottom:10px; font-weight:700;">Histórico de Abastecimentos</div>
            <div style="max-height:250px; overflow-y:auto;">
                ${ordenado.map((a, i) => {
                    const idx = abastecimentos.indexOf(a);
                    const data = new Date(a.data);
                    const dataFmt = data.toLocaleDateString('pt-BR');
                    const kmLitroAbast = a.litros > 0 && idx < ordenado.length - 1 ? ((a.km - ordenado[idx + 1]?.km) / a.litros).toFixed(1) : null;
                    return `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; margin-bottom:6px; background:rgba(255,255,255,0.03); border-radius:8px; border-left:3px solid var(--accent);">
                            <div>
                                <div style="font-size:11px; font-weight:700; color:#fff;">${dataFmt} — ${a.litros || '?'}L</div>
                                <div style="font-size:9px; color:#94a3b8;">${a.km?.toLocaleString()} KM${a.posto ? ' — ' + a.posto : ''}</div>
                                ${kmLitroAbast ? `<div style="font-size:9px; color:var(--success);">${kmLitroAbast} km/L</div>` : ''}
                            </div>
                            <div style="display:flex; gap:6px;">
                                <button style="background:none; border:none; color:#475569; cursor:pointer;" onclick="promptEditarAbastecimento(${idx})"><i class="fas fa-pen"></i></button>
                                <button style="background:none; border:none; color:#475569; cursor:pointer;" onclick="removerAbastecimento(${idx})"><i class="fas fa-trash-alt"></i></button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>`;
    }

    const postos = Object.values(perfil).sort((a, b) => b.qualidade - a.qualidade);
    if (postos.length > 0) {
        html += `<div class="glass-card" style="padding:15px;">
            <div style="font-size:9px; color:#94a3b8; text-transform:uppercase; margin-bottom:10px; font-weight:700;">Qualidade por Posto</div>
            ${postos.map(p => {
                const cor = p.qualidade >= 80 ? 'var(--success)' : p.qualidade >= 60 ? 'var(--warning)' : 'var(--danger)';
                return `
                    <div style="padding:12px; margin-bottom:8px; background:rgba(255,255,255,0.03); border-radius:8px; border-left:4px solid ${cor};">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:12px; font-weight:700; color:#fff;">${p.nome}</div>
                                <div style="font-size:9px; color:#94a3b8;">${p.abastecimentos} abastecimento(s) — Média: ${p.mediaConsumo} L/h — LTFT: ±${p.mediaFuelTrim}%</div>
                            </div>
                            <div style="text-align:center;">
                                <div style="font-size:1.2rem; font-weight:900; color:${cor};">${p.qualidade}</div>
                                <div style="font-size:8px; color:#94a3b8;">QUALIDADE</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>`;
    } else if (abastecimentos.length === 0) {
        html += `<div class="glass-card" style="padding:30px; text-align:center;">
            <i class="fas fa-gas-pump" style="font-size:2rem; color:var(--accent); opacity:0.3; margin-bottom:10px;"></i>
            <p style="color:#94a3b8; font-size:12px;">Nenhum abastecimento registrado ainda.</p>
            <p style="color:#94a3b8; font-size:10px;">Registre um abastecimento ou aguarde a detecção automática.</p>
        </div>`;
    }

    container.innerHTML = html;
}

function promptEditarAbastecimento(index) {
    const a = abastecimentos[index];
    if (!a) return;
    const novoPosto = prompt("Nome do Posto:", a.posto || "");
    if (novoPosto !== null) {
        const novosLitros = prompt("Litros abastecidos:", a.litros || "");
        if (novosLitros !== null) {
            editarAbastecimento(index, novosLitros, novoPosto);
            renderizarAbastecimentos();
        }
    }
}

function renderizarAlertasManutencao() {
    const container = document.getElementById('dash-alertas');
    if (!container) return;

    const kmAtual = parseInt(localStorage.getItem("car_km")) || 0;
    const hoje = new Date();
    const alertas = [];

    CATALOGO_MANUTENCAO.forEach(catalogo => {
        const registrosDoItem = registrosManutencao.filter(r => r.item === catalogo.nome);
        const ultimoRegistro = registrosDoItem.sort((a, b) => new Date(b.data) - new Date(a.data))[0];

        if (!ultimoRegistro) {
            alertas.push({ nome: catalogo.nome, tipo: 'info', msg: 'Sem registro', cor: 'var(--accent)' });
            return;
        }

        let pct = 100;
        if (catalogo.intervaloKm) {
            const kmDesdeTroca = kmAtual - ultimoRegistro.km;
            const pctKm = 100 - (kmDesdeTroca / catalogo.intervaloKm) * 100;
            pct = Math.min(pct, pctKm);
        }
        if (catalogo.intervaloMeses) {
            const dataTroca = new Date(ultimoRegistro.data);
            const mesesDesdeTroca = (hoje - dataTroca) / (1000 * 60 * 60 * 24 * 30.44);
            const pctTempo = 100 - (mesesDesdeTroca / catalogo.intervaloMeses) * 100;
            pct = Math.min(pct, pctTempo);
        }

        if (pct <= 0) {
            alertas.push({ nome: catalogo.nome, tipo: 'critico', msg: 'VENCIDO', cor: 'var(--danger)' });
        } else if (pct <= 20) {
            alertas.push({ nome: catalogo.nome, tipo: 'urgente', msg: `${pct.toFixed(0)}% restante`, cor: 'var(--danger)' });
        } else if (pct <= 50) {
            alertas.push({ nome: catalogo.nome, tipo: 'atencao', msg: `${pct.toFixed(0)}% restante`, cor: 'var(--warning)' });
        }
    });

    if (alertas.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = '<div style="font-size:10px; color:var(--danger); text-transform:uppercase; margin-bottom:8px; font-weight:800; letter-spacing:1px;"><i class="fas fa-exclamation-triangle"></i> Alertas de Manutenção</div>';
    alertas.forEach(a => {
        html += `
            <div class="glass-card" style="padding:10px 14px; margin-bottom:8px; border-left:4px solid ${a.cor};">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:12px; font-weight:700; color:#fff;">${a.nome}</span>
                    <span style="font-size:10px; font-weight:800; color:${a.cor};">${a.msg}</span>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// Funções do Modal de Manutenção
function openMaintModal() { document.getElementById('modal-maint-wrapper').classList.remove('hidden'); }
function closeMaintModal() {
    document.getElementById('modal-maint-wrapper').classList.add('hidden');
    editandoManutencaoIndex = null;
    const btn = document.getElementById('maint-save-btn');
    if (btn) btn.textContent = 'Registrar';
    const ttl = document.getElementById('maint-modal-titulo');
    if (ttl) ttl.textContent = 'NOVO REGISTRO';
}

let editandoManutencaoIndex = null;

function saveMaintRecord() {
    const sistema = document.getElementById('maint-sistema').value;
    const item = document.getElementById('maint-item').value.trim();
    const marca = document.getElementById('maint-marca').value.trim();
    const oficina = document.getElementById('maint-oficina').value.trim();
    const data = document.getElementById('maint-data').value;
    const km = parseInt(document.getElementById('maint-km').value);
    const custoPeca = parseFloat(document.getElementById('maint-custo-peca').value) || 0;
    const custoMao = parseFloat(document.getElementById('maint-custo-mao').value) || 0;
    const notas = document.getElementById('maint-notas').value.trim();

    if (!item || !data || !km || km <= 0) {
        showToast("Preencha ao menos Item, Data e KM Atual para salvar o registro.", "warning");
        return;
    }

    const registro = { sistema, item, marca, oficina, data, km, custoPeca, custoMao, notas, criadoEm: new Date().toISOString() };

    if (editandoManutencaoIndex !== null) {
        registro.criadoEm = registrosManutencao[editandoManutencaoIndex].criadoEm || registro.criadoEm;
        registrosManutencao[editandoManutencaoIndex] = registro;
        showToast("Registro atualizado com sucesso!", "success");
    } else {
        registrosManutencao.push(registro);
        showToast("Manutenção registrada com sucesso!", "success");
    }
    salvarRegistrosManutencao();

    // Limpa o formulário para o próximo registro
    ['maint-sistema', 'maint-item', 'maint-marca', 'maint-oficina', 'maint-data', 'maint-km', 'maint-custo-peca', 'maint-custo-mao', 'maint-notas'].forEach(id => {
        document.getElementById(id).value = '';
    });

    closeMaintModal();
    renderizarHistoricoManutencao();
    renderizarSaudeVeiculo();
}

function renderizarHistoricoManutencao() {
    const tbody = document.getElementById('maint-tbody');
    if (!tbody) return;

    const filterSelect = document.getElementById('filter-maint');
    if (filterSelect && !filterSelect.dataset.listenerAdded) {
        filterSelect.addEventListener('change', () => renderizarHistoricoManutencao());
        filterSelect.dataset.listenerAdded = 'true';
    }

    if (registrosManutencao.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#94a3b8; padding:20px;">Nenhum registro ainda. Adicione sua primeira manutenção.</td></tr>';
        return;
    }

    const filtro = document.getElementById('filter-maint')?.value || 'todos';
    let lista = registrosManutencao.map((r, indexOriginal) => ({ ...r, indexOriginal }));

    if (filtro === 'categoria') {
        lista.sort((a, b) => (a.sistema || '').localeCompare(b.sistema || ''));
    } else if (filtro === 'vencimento') {
        const kmAtual = parseInt(localStorage.getItem("car_km")) || 0;
        const hoje = new Date();
        lista.sort((a, b) => {
            const catA = CATALOGO_MANUTENCAO.find(c => c.nome === a.item);
            const catB = CATALOGO_MANUTENCAO.find(c => c.nome === b.item);
            const prioA = catA ? Math.min(
                catA.intervaloKm ? (1 - (kmAtual - a.km) / catA.intervaloKm) : 1,
                catA.intervaloMeses ? (1 - ((hoje - new Date(a.data)) / (1000*60*60*24*30.44)) / catA.intervaloMeses) : 1
            ) : 0.5;
            const prioB = catB ? Math.min(
                catB.intervaloKm ? (1 - (kmAtual - b.km) / catB.intervaloKm) : 1,
                catB.intervaloMeses ? (1 - ((hoje - new Date(b.data)) / (1000*60*60*24*30.44)) / catB.intervaloMeses) : 1
            ) : 0.5;
            return prioA - prioB;
        });
    } else {
        lista.sort((a, b) => new Date(b.data) - new Date(a.data));
    }

    tbody.innerHTML = lista.map(r => {
        const custoPeca = r.custoPeca || 0;
        const custoMao = r.custoMao || 0;
        const total = custoPeca + custoMao;
        return `
        <tr>
            <td>${r.item}</td>
            <td>${r.km.toLocaleString()} KM</td>
            <td>${formatarDataBR(r.data)}</td>
            <td>${custoPeca > 0 ? 'R$ ' + custoPeca.toFixed(2) : '--'}</td>
            <td>${custoMao > 0 ? 'R$ ' + custoMao.toFixed(2) : '--'}</td>
            <td>${total > 0 ? 'R$ ' + total.toFixed(2) : '--'}</td>
            <td>
                <button style="background:none; border:none; color:#475569; cursor:pointer; margin-right:6px;" onclick="editarRegistroManutencao(${r.indexOriginal})"><i class="fas fa-pen"></i></button>
                <button style="background:none; border:none; color:#475569; cursor:pointer;" onclick="removerRegistroManutencao(${r.indexOriginal})"><i class="fas fa-trash-alt"></i></button>
            </td>
        </tr>
    `}).join('');
}

function removerRegistroManutencao(index) {
    registrosManutencao.splice(index, 1);
    salvarRegistrosManutencao();
    renderizarHistoricoManutencao();
    renderizarSaudeVeiculo();
}

function editarRegistroManutencao(index) {
    const r = registrosManutencao[index];
    if (!r) return;

    editandoManutencaoIndex = index;

    document.getElementById('maint-sistema').value = r.sistema || '';
    document.getElementById('maint-item').value = r.item || '';
    document.getElementById('maint-marca').value = r.marca || '';
    document.getElementById('maint-oficina').value = r.oficina || '';
    document.getElementById('maint-data').value = r.data || '';
    document.getElementById('maint-km').value = r.km || '';
    document.getElementById('maint-custo-peca').value = r.custoPeca || '';
    document.getElementById('maint-custo-mao').value = r.custoMao || '';
    document.getElementById('maint-notas').value = r.notas || '';

    const btn = document.getElementById('maint-save-btn');
    if (btn) btn.textContent = 'Salvar Alterações';
    const ttl = document.getElementById('maint-modal-titulo');
    if (ttl) ttl.textContent = 'Editar Manutenção';

    openMaintModal();
}

function salvarPerfil() {
    const kmInput = document.getElementById("inp-prof-km").value;
    const mInput = document.getElementById("inp-prof-marca").value;
    const modSelect = document.getElementById("inp-prof-modelo");
    const verSelect = document.getElementById("inp-prof-versao");
    const anoSelect = document.getElementById("inp-prof-ano").value;
    const placaInput = document.getElementById("inp-prof-placa")?.value.trim() || "";
    const vinInput = document.getElementById("inp-prof-vin")?.value.trim() || "";
    const tanqueInput = document.getElementById("inp-prof-tanque")?.value || "";

    if (kmInput && kmInput > 0) {
        if (placaInput && !validarPlaca(placaInput)) {
            showToast("Placa inválida. Formato correto: ABC1D23 (7 caracteres, letras e números).", "error");
            return;
        }

        if (vinInput && !validarVIN(vinInput)) {
            showToast("Chassi/VIN inválido. Deve conter exatamente 17 caracteres (letras e números).", "error");
            return;
        }

        localStorage.setItem("car_km", kmInput);
        if(mInput) localStorage.setItem("car_marca_nome", mInput);
        if(modSelect.selectedIndex > 0) localStorage.setItem("car_modelo_nome", modSelect.options[modSelect.selectedIndex].text);
        if(verSelect.selectedIndex > 0) localStorage.setItem("car_versao_nome", verSelect.options[verSelect.selectedIndex].text);
        if(anoSelect) localStorage.setItem("car_ano", anoSelect);
        localStorage.setItem("car_placa", placaInput.toUpperCase());
        localStorage.setItem("car_vin", vinInput.toUpperCase());
        if(tanqueInput) localStorage.setItem("car_tanque_capacidade", tanqueInput);
        localStorage.setItem("car_ultima_data", new Date().toISOString());
        
        renderizarDadosGlobais();
        showToast("Configurações atualizadas com sucesso!", "success");
    } else {
        showToast("Insira uma quilometragem válida.", "error");
    }
}

// ==========================================
// BACKUP, TRANSFERÊNCIA E RELATÓRIO (PDF)
// ==========================================

// Reúne tudo que identifica o veículo e seu histórico num único objeto
function coletarDadosCompletos() {
    return {
        appNome: "AutoGestão X",
        versaoFormato: 4,
        exportadoEm: new Date().toISOString(),
        veiculo: {
            km: localStorage.getItem("car_km"),
            marca: localStorage.getItem("car_marca_nome"),
            modelo: localStorage.getItem("car_modelo_nome"),
            versao: localStorage.getItem("car_versao_nome"),
            ano: localStorage.getItem("car_ano"),
            placa: localStorage.getItem("car_placa"),
            vin: localStorage.getItem("car_vin"),
            tanqueCapacidade: localStorage.getItem("car_tanque_capacidade"),
            ultimaData: localStorage.getItem("car_ultima_data"),
            mediaDiaria: localStorage.getItem("car_media_diaria")
        },
        registrosManutencao: registrosManutencao,
        planoAquisicao: listaNecessidades,
        abastecimentos: abastecimentos
    };
}

// Baixa um arquivo .json com todos os dados do veículo — serve como backup
// e também como forma de levar os dados para outro dispositivo/instalação.
function exportarDadosJSON() {
    const dados = coletarDadosCompletos();
    const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const marcaArquivo = (dados.veiculo.marca || 'veiculo').replace(/\s+/g, '_');
    const dataArquivo = new Date().toISOString().slice(0, 10);

    const a = document.createElement('a');
    a.href = url;
    a.download = `autogestaox_backup_${marcaArquivo}_${dataArquivo}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Lê um arquivo .json exportado anteriormente e substitui os dados locais
function importarDadosJSON(inputEl) {
    const file = inputEl.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const dados = JSON.parse(e.target.result);
            if (!dados.veiculo || !Array.isArray(dados.registrosManutencao)) {
                throw new Error("Formato de arquivo inválido.");
            }

            const resumo = `${dados.veiculo.marca || '?'} ${dados.veiculo.modelo || ''} — ${dados.registrosManutencao.length} registro(s) de manutenção`;
            if (!confirm(`Isso vai substituir os dados atuais deste dispositivo por:\n\n${resumo}\n\nDeseja continuar?`)) {
                inputEl.value = '';
                return;
            }

            const v = dados.veiculo;
            if (v.km) localStorage.setItem("car_km", v.km);
            if (v.marca) localStorage.setItem("car_marca_nome", v.marca);
            if (v.modelo) localStorage.setItem("car_modelo_nome", v.modelo);
            if (v.versao) localStorage.setItem("car_versao_nome", v.versao);
            if (v.ano) localStorage.setItem("car_ano", v.ano);
            if (v.placa) localStorage.setItem("car_placa", v.placa);
            if (v.vin) localStorage.setItem("car_vin", v.vin);
            if (v.tanqueCapacidade) localStorage.setItem("car_tanque_capacidade", v.tanqueCapacidade);
            if (v.ultimaData) localStorage.setItem("car_ultima_data", v.ultimaData);
            if (v.mediaDiaria) localStorage.setItem("car_media_diaria", v.mediaDiaria);

            registrosManutencao = dados.registrosManutencao || [];
            registrosManutencao.forEach(r => {
                if (r.custo !== undefined && r.custoPeca === undefined) {
                    r.custoPeca = r.custo;
                    r.custoMao = 0;
                    delete r.custo;
                }
            });
            salvarRegistrosManutencao();

            listaNecessidades = dados.planoAquisicao || [];

            if (dados.abastecimentos) {
                abastecimentos = dados.abastecimentos;
                salvarAbastecimentos();
            }

            renderizarDadosGlobais();
            renderizarSaudeVeiculo();
            renderizarHistoricoManutencao();
            renderizarPlanoNecessidades();

            showToast("Dados importados com sucesso!", "success");
        } catch (err) {
            console.error("Erro ao importar dados:", err);
            showToast("Não foi possível importar o arquivo. Verifique se é um backup válido do AutoGestão X.", "error");
        } finally {
            inputEl.value = '';
        }
    };
    reader.readAsText(file);
}

// Gera um PDF com os dados do veículo, histórico de manutenção e status atual —
// útil para mostrar a um mecânico ou a um comprador na venda do carro.
function exportarRelatorioPDF() {
    if (typeof jspdf === 'undefined') {
        alert("A biblioteca de geração de PDF ainda está carregando. Tente novamente em alguns segundos.");
        return;
    }

    const { jsPDF } = jspdf;
    const doc = new jsPDF();

    const marca = localStorage.getItem("car_marca_nome") || "Não configurado";
    const modelo = localStorage.getItem("car_modelo_nome") || "";
    const versao = localStorage.getItem("car_versao_nome") || "";
    const ano = localStorage.getItem("car_ano") || "--";
    const km = parseInt(localStorage.getItem("car_km")) || 0;
    const placa = localStorage.getItem("car_placa") || "Não informada";
    const vin = localStorage.getItem("car_vin") || "Não informado";

    let y = 20;
    const margemEsquerda = 14;
    const larguraUtil = 182;
    const alturaMaxima = 275;

    const quebrarPaginaSeNecessario = (espacoNecessario = 20) => {
        if (y + espacoNecessario > alturaMaxima) {
            doc.addPage();
            y = 20;
        }
    };

    // =============================================
    // CABEÇALHO E IDENTIFICAÇÃO DO VEÍCULO
    // =============================================
    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text("Relatório de Manutenção — AutoGestão X", margemEsquerda, y);
    y += 7;
    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(120);
    doc.text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`, margemEsquerda, y);
    doc.setTextColor(0);
    y += 10;

    // Box de identificação do veículo
    doc.setFillColor(240, 240, 240);
    doc.roundedRect(margemEsquerda, y - 2, larguraUtil, 38, 2, 2, 'F');
    doc.setDrawColor(180);
    doc.roundedRect(margemEsquerda, y - 2, larguraUtil, 38, 2, 2, 'S');

    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text("IDENTIFICAÇÃO DO VEÍCULO", margemEsquerda + 4, y + 6);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);

    let infoY = y + 13;
    const col1X = margemEsquerda + 4;
    const col2X = margemEsquerda + 95;

    doc.setFont(undefined, 'bold');
    doc.text("Veículo:", col1X, infoY);
    doc.setFont(undefined, 'normal');
    doc.text(`${marca} ${modelo} ${versao}`.trim(), col1X + 20, infoY);

    doc.setFont(undefined, 'bold');
    doc.text("Ano:", col2X, infoY);
    doc.setFont(undefined, 'normal');
    doc.text(String(ano), col2X + 12, infoY);
    infoY += 6;

    doc.setFont(undefined, 'bold');
    doc.text("Placa:", col1X, infoY);
    doc.setFont(undefined, 'normal');
    doc.text(placa, col1X + 15, infoY);

    doc.setFont(undefined, 'bold');
    doc.text("KM Atual:", col2X, infoY);
    doc.setFont(undefined, 'normal');
    doc.text(`${km.toLocaleString()} KM`, col2X + 22, infoY);
    infoY += 6;

    doc.setFont(undefined, 'bold');
    doc.text("Chassi/VIN:", col1X, infoY);
    doc.setFont(undefined, 'normal');
    doc.text(vin, col1X + 26, infoY);
    infoY += 8;

    y = infoY + 6;

    // =============================================
    // SEÇÃO: HISTÓRICO DE MANUTENÇÕES
    // =============================================
    quebrarPaginaSeNecessario(20);
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text("Histórico de Manutenções", margemEsquerda, y);
    y += 8;

    if (registrosManutencao.length === 0) {
        doc.setFontSize(9);
        doc.setFont(undefined, 'italic');
        doc.setTextColor(120);
        doc.text("Nenhum registro cadastrado ainda.", margemEsquerda, y);
        doc.setTextColor(0);
        y += 6;
    } else {
        doc.setFontSize(8);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(100);
        doc.text("DATA", margemEsquerda, y);
        doc.text("ITEM", margemEsquerda + 20, y);
        doc.text("KM", margemEsquerda + 78, y);
        doc.text("PEÇA", margemEsquerda + 100, y);
        doc.text("MÃO OBRA", margemEsquerda + 122, y);
        doc.text("TOTAL", margemEsquerda + 148, y);
        doc.text("OFICINA", margemEsquerda + 165, y);
        doc.setTextColor(0);
        y += 1;

        doc.setDrawColor(180);
        doc.line(margemEsquerda, y, margemEsquerda + larguraUtil, y);
        y += 4;

        doc.setFont(undefined, 'normal');
        const ordenado = [...registrosManutencao].sort((a, b) => new Date(b.data) - new Date(a.data));
        ordenado.forEach(r => {
            quebrarPaginaSeNecessario(6);
            const cp = r.custoPeca || 0;
            const cm = r.custoMao || 0;
            const ct = cp + cm;
            doc.setFontSize(7);
            doc.text(formatarDataBR(r.data), margemEsquerda, y);
            doc.text(r.item.substring(0, 25), margemEsquerda + 20, y);
            doc.text(`${r.km.toLocaleString()} KM`, margemEsquerda + 78, y);
            doc.text(cp > 0 ? `R$${cp.toFixed(2)}` : "--", margemEsquerda + 100, y);
            doc.text(cm > 0 ? `R$${cm.toFixed(2)}` : "--", margemEsquerda + 122, y);
            doc.text(ct > 0 ? `R$${ct.toFixed(2)}` : "--", margemEsquerda + 148, y);
            doc.text((r.oficina || "-").substring(0, 14), margemEsquerda + 165, y);
            y += 5;
        });
    }

    y += 8;

    // =============================================
    // SEÇÃO: STATUS ATUAL DOS ITENS DE MANUTENÇÃO
    // =============================================
    quebrarPaginaSeNecessario(25);
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text("Status Atual dos Itens de Manutenção", margemEsquerda, y);
    y += 3;
    doc.setFontSize(8);
    doc.setFont(undefined, 'italic');
    doc.setTextColor(120);
    doc.text("Percentual de vida útil restante (menor valor entre KM e tempo)", margemEsquerda, y);
    doc.setTextColor(0);
    y += 8;

    const hoje = new Date();

    CATALOGO_MANUTENCAO.forEach(catalogo => {
        quebrarPaginaSeNecessario(22);

        const registrosDoItem = registrosManutencao.filter(r => r.item === catalogo.nome);
        const ultimoRegistro = registrosDoItem.sort((a, b) => new Date(b.data) - new Date(a.data))[0];

        doc.setFontSize(9);
        doc.setFont(undefined, 'bold');
        doc.text(catalogo.nome, margemEsquerda, y);
        y += 5;

        if (!ultimoRegistro) {
            doc.setFont(undefined, 'italic');
            doc.setFontSize(8);
            doc.setTextColor(140);
            doc.text("Sem registro — adicione um registro de manutenção para acompanhar este item.", margemEsquerda + 4, y);
            doc.setTextColor(0);
            y += 6;
            return;
        }

        // Calcula % restante por KM
        let pctKm = null;
        let proximaTrocaKm = null;
        if (catalogo.intervaloKm) {
            const kmDesdeTroca = km - ultimoRegistro.km;
            pctKm = Math.min(100, Math.max(0, 100 - (kmDesdeTroca / catalogo.intervaloKm) * 100));
            proximaTrocaKm = ultimoRegistro.km + catalogo.intervaloKm;
        }

        // Calcula % restante por tempo
        let pctTempo = null;
        let proximaTrocaData = null;
        if (catalogo.intervaloMeses) {
            const dataTroca = new Date(ultimoRegistro.data);
            const mesesDesdeTroca = (hoje - dataTroca) / (1000 * 60 * 60 * 24 * 30.44);
            pctTempo = Math.min(100, Math.max(0, 100 - (mesesDesdeTroca / catalogo.intervaloMeses) * 100));
            const proxData = new Date(dataTroca);
            proxData.setMonth(proxData.getMonth() + catalogo.intervaloMeses);
            proximaTrocaData = proxData;
        }

        const candidatos = [pctKm, pctTempo].filter(p => p !== null);
        const pct = candidatos.length ? Math.min(...candidatos) : 100;

        // Linha 1: último registro
        doc.setFont(undefined, 'normal');
        doc.setFontSize(8);
        doc.setTextColor(80);
        doc.text(`Último registro: ${formatarDataBR(ultimoRegistro.data)} — ${ultimoRegistro.km.toLocaleString()} KM`, margemEsquerda + 4, y);
        y += 4;

        // Linha 2: percentual
        let statusLabel = "";
        if (pctKm !== null && pctTempo !== null) {
            statusLabel = `Status: ${pctKm.toFixed(0)}% (KM) / ${pctTempo.toFixed(0)}% (tempo) → ${pct.toFixed(0)}%`;
        } else if (pctKm !== null) {
            statusLabel = `Status: ${pct.toFixed(0)}% (baseado em KM)`;
        } else {
            statusLabel = `Status: ${pct.toFixed(0)}% (baseado em tempo)`;
        }
        doc.setFont(undefined, 'bold');
        doc.setFontSize(8);
        doc.setTextColor(0);
        doc.text(statusLabel, margemEsquerda + 4, y);
        y += 4;

        // Linha 3: próxima troca
        let proximaTrocaLabel = "Próxima troca: ";
        if (proximaTrocaKm && proximaTrocaData) {
            proximaTrocaLabel += `~${proximaTrocaKm.toLocaleString()} KM ou até ${formatarDataBR(proximaTrocaData.toISOString().slice(0, 10))}`;
        } else if (proximaTrocaKm) {
            proximaTrocaLabel += `~${proximaTrocaKm.toLocaleString()} KM`;
        } else if (proximaTrocaData) {
            proximaTrocaLabel += `até ${formatarDataBR(proximaTrocaData.toISOString().slice(0, 10))}`;
        } else {
            proximaTrocaLabel += "Não definida";
        }
        doc.setFont(undefined, 'italic');
        doc.setFontSize(8);
        doc.setTextColor(100);
        doc.text(proximaTrocaLabel, margemEsquerda + 4, y);
        doc.setTextColor(0);
        y += 7;
    });

    // =============================================
    // RODAPÉ
    // =============================================
    const totalPaginas = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPaginas; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(150);
        doc.text(
            `AutoGestão X — Documento gerado automaticamente — Página ${i} de ${totalPaginas}`,
            margemEsquerda, 290
        );
        doc.text(
            `Placa: ${placa} | VIN: ${vin}`,
            margemEsquerda + 120, 290
        );
    }

    const nomeArquivo = `relatorio_${(marca || 'veiculo').replace(/\s+/g, '_')}_${placa !== 'Não informada' ? placa : 'sem-placa'}_${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(nomeArquivo);
}

function exportarCSV() {
    if (registrosManutencao.length === 0) {
        showToast("Nenhum registro para exportar.", "warning");
        return;
    }

    const headers = ["Data", "Sistema", "Item", "Marca", "Oficina", "KM", "Custo Peça (R$)", "Mão de Obra (R$)", "Total (R$)", "Notas"];
    const rows = registrosManutencao.map(r => [
        r.data || '',
        r.sistema || '',
        r.item || '',
        r.marca || '',
        r.oficina || '',
        r.km || '',
        (r.custoPeca || 0).toFixed(2),
        (r.custoMao || 0).toFixed(2),
        ((r.custoPeca || 0) + (r.custoMao || 0)).toFixed(2),
        (r.notas || '').replace(/"/g, '""')
    ]);

    const csvContent = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const marca = (localStorage.getItem("car_marca_nome") || 'veiculo').replace(/\s+/g, '_');
    const placa = localStorage.getItem("car_placa") || 'sem-placa';
    const dataArquivo = new Date().toISOString().slice(0, 10);

    const a = document.createElement('a');
    a.href = url;
    a.download = `autogestaox_manutencoes_${marca}_${placa}_${dataArquivo}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("CSV exportado com sucesso!", "success");
}
// BANCO DE DADOS DE COMPONENTES E PREDITIVA
// ==========================================
const BANCO_PECAS = {
    "filtros": [
        { id: "p1", nome: "Filtro de Óleo", categoria: "Filtros & Alimentação", vidaUtilKm: 10000, prioridade: "Alta" },
        { id: "p2", nome: "Filtro de Ar do Motor", categoria: "Filtros & Alimentação", vidaUtilKm: 15000, prioridade: "Média" },
        { id: "p3", nome: "Filtro de Combustível", categoria: "Filtros & Alimentação", vidaUtilKm: 10000, prioridade: "Alta" }
    ],
    "ignicao": [
        { id: "p4", nome: "Jogo de Velas de Ignição", categoria: "Ignição", vidaUtilKm: 40000, prioridade: "Alta" },
        { id: "p5", nome: "Bobina de Ignição", categoria: "Ignição", vidaUtilKm: 80000, prioridade: "Média" }
    ],
    "freios": [
        { id: "p6", nome: "Pastilha de Freio Dianteira", categoria: "Freios", vidaUtilKm: 30000, prioridade: "Crítica" },
        { id: "p7", nome: "Disco de Freio (Par)", categoria: "Freios", vidaUtilKm: 60000, prioridade: "Média" }
    ],
    "motor": [
        { id: "p8", nome: "Óleo de Motor 5W40 Sintético", categoria: "Motor & Transmissão", vidaUtilKm: 10000, prioridade: "Alta" },
        { id: "p9", nome: "Kit Correia Dentada e Tensor", categoria: "Motor & Transmissão", vidaUtilKm: 60000, prioridade: "Crítica" }
    ]
};

const DIAGNOSTICO_PECAS = {
    "P0300": [
        { nome: "Jogo de Velas de Ignição", motivo: "Código OBD2 P0300 (Falha de Ignição)", prioridade: "Crítica" },
        { nome: "Bobina de Ignição", motivo: "Código OBD2 P0300 (Falha de Ignição)", prioridade: "Crítica" }
    ]
};

function alternarSubAbaPecas(aba) {
    const btnCatalogo = document.getElementById('btn-sub-catalogo');
    const btnSacola = document.getElementById('btn-sub-sacola');
    const containerCatalogo = document.getElementById('catalogo-container');
    const containerSacola = document.getElementById('sacola-container');
    
    if (btnCatalogo) btnCatalogo.classList.toggle('active', aba === 'catalogo');
    if (btnSacola) btnSacola.classList.toggle('active', aba === 'sacola');
    if (containerCatalogo) containerCatalogo.classList.toggle('hidden', aba !== 'catalogo');
    if (containerSacola) containerSacola.classList.toggle('hidden', aba !== 'sacola');

    if (aba === 'catalogo') renderizarCatalogoInteligente();
    else if (aba === 'sacola') renderizarPlanoNecessidades();
}

// Muda a subcategoria dentro do catálogo inteligente
function mudarCategoriaCatalogo(categoria) {
    categoriaAtualCatalogo = categoria;
    renderizarCatalogoInteligente();
}

// Renderiza o Catálogo com os Seletores de Categoria
function renderizarCatalogoInteligente() {
    const container = document.getElementById('catalogo-container');
    if (!container) return;
    
    const marca = localStorage.getItem("car_marca_nome") || "VW";
    const modelo = localStorage.getItem("car_modelo_nome") || "GOL 8V";
    const categoria = (typeof categoriaAtualCatalogo !== 'undefined') ? categoriaAtualCatalogo : 'filtros';
    
    container.innerHTML = `
        <div style="font-size: 11px; color: #94a3b8; margin-bottom: 5px; text-transform: uppercase;">
            PEÇAS COMPATÍVEIS COM: <strong style="color: var(--accent);">${marca} ${modelo}</strong>
        </div>
        <div style="display: flex; gap: 6px; margin-bottom: 15px; overflow-x: auto; padding-bottom: 8px;">
            <button class="tab-btn ${categoria === 'filtros' ? 'active' : ''}" onclick="mudarCategoriaCatalogo('filtros')" style="font-size:10px; padding:8px 12px; min-width:80px;">Filtros</button>
            <button class="tab-btn ${categoria === 'ignicao' ? 'active' : ''}" onclick="mudarCategoriaCatalogo('ignicao')" style="font-size:10px; padding:8px 12px; min-width:80px;">Ignição</button>
            <button class="tab-btn ${categoria === 'freios' ? 'active' : ''}" onclick="mudarCategoriaCatalogo('freios')" style="font-size:10px; padding:8px 12px; min-width:80px;">Freios</button>
            <button class="tab-btn ${categoria === 'motor' ? 'active' : ''}" onclick="mudarCategoriaCatalogo('motor')" style="font-size:10px; padding:8px 12px; min-width:80px;">Motor</button>
        </div>
    `;

    // Renderiza as peças da categoria selecionada
    if (typeof BANCO_PECAS !== 'undefined' && BANCO_PECAS[categoria]) {
        BANCO_PECAS[categoria].forEach(peca => {
            const card = document.createElement('div');
            card.className = 'glass-card';
            card.style = 'display: flex; justify-content: space-between; align-items: center; padding: 14px; margin-bottom: 10px;';
            
            const queryML = encodeURIComponent(`${peca.nome} ${marca} ${modelo}`);
            const urlML = `https://lista.mercadolivre.com.br/${queryML}`;

            card.innerHTML = `
                <div style="flex: 1; padding-right: 10px;">
                    <span style="font-size: 9px; color: var(--accent); display: block; text-transform: uppercase;">Vida útil estim.: ${peca.vidaUtilKm.toLocaleString()} km</span>
                    <strong style="font-size: 13px; color: #fff;">${peca.nome}</strong>
                    <span style="display: block; font-size: 11px; color: #94a3b8; margin-top: 2px;">Verificar valor real</span>
                </div>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <a href="${urlML}" target="_blank" class="btn-main" style="width: auto; padding: 8px 12px; font-size: 10px; text-decoration: none; display: inline-block;">
                        VER PREÇO
                    </a>
                    <button class="btn-main" 
                            style="width: 32px; height: 32px; padding: 0; font-size: 14px; background: rgba(0, 242, 255, 0.1); color: var(--accent); border: 1px solid var(--accent);" 
                            onclick="adicionarAosNecessarios('${peca.nome}', 'Seleção Manual', 0, '${peca.prioridade}', 85)">
                        +
                    </button>
                </div>
            `;
            container.appendChild(card);
        });
    }
}

function adicionarAosNecessarios(nome, motivo, preco = 0, prioridade = "Média", vidaUtilPct = 90) {
    if (listaNecessidades.some(item => item.nome === nome)) return;
    listaNecessidades.push({ nome, motivo, preco, prioridade, vidaUtilPct });
    showToast(`${nome} adicionado ao seu Plano de Aquisição!`, "success");
    if (!document.getElementById('sacola-container').classList.contains('hidden')) renderizarPlanoNecessidades();
}

// Retorna cores baseadas na criticidade e proximidade da troca
function obterCorPrioridade(prioridade) {
    if (prioridade === "Crítica") return "var(--danger)";
    if (prioridade === "Alta") return "var(--warning)";
    return "var(--success)";
}

// Renderiza o Plano de Aquisição com barras de progresso e criticidade
function renderizarPlanoNecessidades() {
    const container = document.getElementById('sacola-container');
    if (!container) return;
    
    container.innerHTML = '<div style="font-size:12px; font-weight: 800; color: var(--accent); margin-bottom: 15px; text-transform:uppercase;">Plano de Aquisição Ativo</div>';

    if (listaNecessidades.length === 0) {
        container.innerHTML += '<div style="text-align:center; padding:30px; color:#94a3b8; font-size:13px;">Nenhum item pendente no plano.</div>';
        return;
    }

    let totalEstimado = 0;
    listaNecessidades.sort((a, b) => (a.prioridade === "Crítica" ? -1 : 1));

    listaNecessidades.forEach((item, index) => {
        totalEstimado += (item.preco || 0);
        const corAlerta = obterCorPrioridade(item.prioridade);
        
        const card = document.createElement('div');
        card.className = 'glass-card';
        card.style = `border-left: 4px solid ${corAlerta}; padding: 14px; margin-bottom: 10px; position: relative;`;
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                <div>
                    <span style="background: ${corAlerta}; color: #000; font-size: 8px; font-weight: 900; padding: 2px 6px; border-radius: 3px; text-transform: uppercase;">Prioridade: ${item.prioridade}</span>
                    <strong style="font-size: 14px; color: #fff; display: block; margin-top: 4px;">${item.nome}</strong>
                    <span style="font-size: 10px; color: #94a3b8; display: block; margin-top: 2px;">Motivo: <strong>${item.motivo}</strong></span>
                </div>
                <button style="background: none; border: none; color: #475569; cursor: pointer;" onclick="removerDosNecessarios(${index})">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>
            
            <div style="margin-top: 10px;">
                <div style="display: flex; justify-content: space-between; font-size: 9px; color: #64748b; margin-bottom: 3px;">
                    <span>Vida Útil Restante:</span>
                    <span style="color: ${item.vidaUtilPct <= 20 ? 'var(--danger)' : corAlerta}; font-weight: bold;">${item.vidaUtilPct}%</span>
                </div>
                <div style="width: 100%; background: #1e293b; height: 6px; border-radius: 3px; overflow: hidden;">
                    <div style="width: ${item.vidaUtilPct}%; background: ${item.vidaUtilPct <= 20 ? 'var(--danger)' : corAlerta}; height: 100%;"></div>
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    if (totalEstimado > 0) {
        container.innerHTML += `
            <div class="glass-card" style="background: rgba(0, 255, 170, 0.02); border-color: rgba(0, 255, 170, 0.1); margin-top: 15px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 11px; text-transform: uppercase; color: #94a3b8;">Orçamento Estimado:</span>
                    <strong style="font-size: 1.3rem; color: var(--success);">R$ ${totalEstimado.toFixed(2)}</strong>
                </div>
            </div>
        `;
    }
}

function removerDosNecessarios(index) {
    listaNecessidades.splice(index, 1);
    renderizarPlanoNecessidades();
}


// Força o carregamento inicial das peças e filtros assim que o app abre
document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
        if (typeof alternarSubAbaPecas === "function") {
            alternarSubAbaPecas('catalogo');
        }
    }, 150);
});
