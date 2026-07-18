// =============================================
// ui.js — Navegação, dados do veículo (FIPE), manutenção, loja de peças e onboarding
// =============================================

const API_FIPE_V2 = "https://fipe.parallelum.com.br/api/v2/cars/brands";
let marcasCache = [];
let modelosCache = {};
let anosPorModeloCache = {};
let listaNecessidades = JSON.parse(localStorage.getItem("car_lista_necessidades") || "[]");
let categoriaAtualCatalogo = "filtros";
let editandoVeiculoId = null;

function cacheGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function cacheSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// ==========================================
// MULTI-VEÍCULO — Camada de dados
// ==========================================
// Formato antigo (legado): chaves individuais car_km, car_marca_nome, etc.
// Formato novo: array em "car_vehicles" + índice ativo em "car_active_idx"

function migrarDadosLegadoSeNecessario() {
    console.log("[PERFIL-DEBUG] migrarDadosLegadoSeNecessario INICIADO");
    try {
        const raw = localStorage.getItem("car_vehicles");
        console.log("[PERFIL-DEBUG] car_vehicles raw:", raw);
        const vehicles = JSON.parse(raw || "null");
        console.log("[PERFIL-DEBUG] parsed vehicles:", vehicles, "isArray:", Array.isArray(vehicles), "length:", vehicles?.length);
        if (vehicles && Array.isArray(vehicles) && vehicles.length > 0) {
            console.log("[PERFIL-DEBUG] migração: já existem veículos, retornando");
            return;
        }
    } catch (e) {
        console.warn("[PERFIL-DEBUG] migração: JSON parse erro, removendo car_vehicles", e);
        localStorage.removeItem("car_vehicles");
    }

    const km = localStorage.getItem("car_km");
    console.log("[PERFIL-DEBUG] car_km:", km);
    if (!km || parseInt(km) <= 0) {
        console.log("[PERFIL-DEBUG] migração: sem km, criando array vazio");
        localStorage.setItem("car_vehicles", JSON.stringify([]));
        localStorage.setItem("car_active_idx", "0");
        return;
    }

    console.log("[PERFIL-DEBUG] migração: criando veículo a partir de dados legados");
    const novoVeiculo = {
        id: Date.now().toString(36),
        km: parseInt(km) || 0,
        marca: localStorage.getItem("car_marca_nome") || "",
        modelo: localStorage.getItem("car_modelo_nome") || "",
        ano: localStorage.getItem("car_ano") || "",
        anoCodigo: localStorage.getItem("car_ano_codigo") || "",
        placa: localStorage.getItem("car_placa") || "",
        vin: localStorage.getItem("car_vin") || "",
        tanqueCapacidade: localStorage.getItem("car_tanque_capacidade") || "",
        motor: localStorage.getItem("car_motor") || "",
        mediaDiaria: localStorage.getItem("car_media_diaria") || "40"
    };

    localStorage.setItem("car_vehicles", JSON.stringify([novoVeiculo]));
    localStorage.setItem("car_active_idx", "0");
    console.log("[PERFIL-DEBUG] migração concluída, veículo:", novoVeiculo);
}

function getVeiculos() {
    migrarDadosLegadoSeNecessario();
    return JSON.parse(localStorage.getItem("car_vehicles") || "[]");
}

function getIdxAtivo() {
    return parseInt(localStorage.getItem("car_active_idx") || "0") || 0;
}

function getVeiculoAtivo() {
    const v = getVeiculos();
    const idx = getIdxAtivo();
    return v[idx] || null;
}

function salvarVeiculos(arr) {
    localStorage.setItem("car_vehicles", JSON.stringify(arr));
}

function setIdxAtivo(idx) {
    localStorage.setItem("car_active_idx", String(idx));
    localStorage.setItem("car_ultima_data", new Date().toISOString());
}

function trocarVeiculo(id) {
    console.log("[PERFIL-DEBUG] trocarVeiculo:", id);
    editandoVeiculoId = null;
    const v = getVeiculos();
    const idx = v.findIndex(x => x.id === id);
    console.log("[PERFIL-DEBUG] trocarVeiculo idx:", idx);
    if (idx < 0) return;
    setIdxAtivo(idx);
    sincronizarLegado();
    renderizarDadosGlobais();
    renderizarSaudeVeiculo();
    renderizarHistoricoManutencao();
    renderizarPlanoNecessidades();
    showToast("Veículo trocado com sucesso.", "info");
}

function toggleFormVeiculo() {
    console.log("[PERFIL-DEBUG] toggleFormVeiculo CHAMADO");
    const form = document.getElementById("card-form-veiculo");
    const txt = document.getElementById("btn-toggle-text");
    const btn = document.getElementById("btn-toggle-form");
    console.log("[PERFIL-DEBUG] form:", !!form, "btn:", !!btn, "txt:", !!txt);
    if (!form || !txt || !btn) {
        console.warn("[PERFIL-DEBUG] toggleFormVeiculo: ELEMENTOS NÃO ENCONTRADOS");
        return;
    }

    const isHidden = form.classList.contains("hidden");
    console.log("[PERFIL-DEBUG] isHidden:", isHidden);

    if (isHidden) {
        editandoVeiculoId = null;
        limparFormularioVeiculo();
        const tit = document.getElementById("prof-form-titulo");
        if (tit) tit.textContent = "Dados do Veículo";
        const btnSave = document.getElementById("prof-btn-salvar");
        if (btnSave) btnSave.textContent = "Salvar Veículo";
        form.classList.remove("hidden");
        txt.innerText = "Cancelar";
        btn.querySelector("i").className = "fas fa-times";
    } else {
        form.classList.add("hidden");
        txt.innerText = "Adicionar novo Veículo";
        btn.querySelector("i").className = "fas fa-plus";
    }
    console.log("[PERFIL-DEBUG] toggleFormVeiculo FINALIZADO");
}

function editarVeiculoAtivo() {
    console.log("[PERFIL-DEBUG] editarVeiculoAtivo CHAMADO");
    const v = getVeiculoAtivo();
    if (!v) {
        console.warn("[PERFIL-DEBUG] editarVeiculoAtivo: nenhum veículo ativo");
        return;
    }
    console.log("[PERFIL-DEBUG] editarVeiculoAtivo veículo:", v);
    editandoVeiculoId = v.id;

    document.getElementById("inp-prof-km").value = v.km || "";
    document.getElementById("inp-prof-marca").value = v.marca || "";
    const placaInp = document.getElementById("inp-prof-placa");
    if (placaInp) placaInp.value = v.placa || "";
    const vinInp = document.getElementById("inp-prof-vin");
    if (vinInp) vinInp.value = v.vin || "";
    const tanqueInp = document.getElementById("inp-prof-tanque");
    if (tanqueInp) tanqueInp.value = v.tanqueCapacidade || "";
    const kmDiaInp = document.getElementById("inp-prof-km-dia");
    if (kmDiaInp) kmDiaInp.value = v.mediaDiaria || "40";

    const form = document.getElementById("card-form-veiculo");
    const txt = document.getElementById("btn-toggle-text");
    const btn = document.getElementById("btn-toggle-form");
    if (form) form.classList.remove("hidden");
    if (txt) txt.innerText = "Cancelar";
    if (btn) btn.querySelector("i").className = "fas fa-times";

    const tit = document.getElementById("prof-form-titulo");
    if (tit) tit.textContent = "Editar Veículo";
    const btnSave = document.getElementById("prof-btn-salvar");
    if (btnSave) btnSave.textContent = "Atualizar Veículo";

    preencherPerfil(v.marca || "", v.modelo || "", v.ano || "");
    console.log("[PERFIL-DEBUG] editarVeiculoAtivo FINALIZADO");
}

function limparFormularioVeiculo() {
    document.getElementById("inp-prof-km").value = "";
    document.getElementById("inp-prof-marca").value = "";
    const placaInp = document.getElementById("inp-prof-placa");
    if (placaInp) placaInp.value = "";
    const vinInp = document.getElementById("inp-prof-vin");
    if (vinInp) vinInp.value = "";
    const tanqueInp = document.getElementById("inp-prof-tanque");
    if (tanqueInp) tanqueInp.value = "";
    const kmDiaInp = document.getElementById("inp-prof-km-dia");
    if (kmDiaInp) kmDiaInp.value = "40";
    const modSelect = document.getElementById("inp-prof-modelo");
    if (modSelect) modSelect.innerHTML = '<option value="">Modelo...</option>';
    const anoSelect = document.getElementById("inp-prof-ano");
    if (anoSelect) anoSelect.innerHTML = '<option value="">Ano...</option>';
}

function excluirVeiculoAtivo() {
    editandoVeiculoId = null;
    const v = getVeiculoAtivo();
    if (!v) return;
    const nome = `${v.marca} ${v.modelo}`.trim() || "este veículo";
    if (!confirm(`Excluir "${nome}"?\n\nTodos os dados locais deste veículo serão removidos. Esta ação não pode ser desfeita.`)) return;

    const vehicles = getVeiculos();
    const idx = getIdxAtivo();
    vehicles.splice(idx, 1);

    if (vehicles.length === 0) {
        localStorage.removeItem("car_vehicles");
        localStorage.removeItem("car_active_idx");
    } else {
        setIdxAtivo(Math.min(idx, vehicles.length - 1));
        salvarVeiculos(vehicles);
    }

    renderizarDadosGlobais();
    renderizarSaudeVeiculo();
    renderizarHistoricoManutencao();
    renderizarPlanoNecessidades();
    showToast("Veículo excluído.", "info");
}

function popularSelectorVeiculos() {
    const sel = document.getElementById("inp-vehicle-selector");
    console.log("[PERFIL-DEBUG] popularSelectorVeiculos: sel:", !!sel);
    if (!sel) return;
    const vehicles = getVeiculos();
    const idx = getIdxAtivo();
    console.log("[PERFIL-DEBUG] popularSelectorVeiculos: vehicles:", vehicles.length, "idx:", idx);

    if (vehicles.length === 0) {
        sel.innerHTML = '<option value="">VEÍCULO NÃO CONFIGURADO</option>';
        return;
    }

    sel.innerHTML = vehicles.map((v, i) => {
        const nome = `${v.marca || 'Sem marca'} ${v.modelo || ''} ${v.ano || ''}`.trim();
        return `<option value="${v.id}" ${i === idx ? 'selected' : ''}>${nome || 'Veículo ' + (i + 1)}</option>`;
    }).join('');
    console.log("[PERFIL-DEBUG] popularSelectorVeiculos: HTML atualizado:", sel.innerHTML.substring(0, 100));
}

function sincronizarLegado() {
    const v = getVeiculoAtivo();
    console.log("[PERFIL-DEBUG] sincronizarLegado:", v ? `km=${v.km}, marca=${v.marca}` : "null");
    if (!v || !v.km) return;
    localStorage.setItem("car_km", v.km);
    localStorage.setItem("car_marca_nome", v.marca || "");
    localStorage.setItem("car_modelo_nome", v.modelo || "");
    localStorage.setItem("car_ano", v.ano || "");
    localStorage.setItem("car_ano_codigo", v.anoCodigo || "");
    localStorage.setItem("car_placa", v.placa || "");
    localStorage.setItem("car_vin", v.vin || "");
    localStorage.setItem("car_tanque_capacidade", v.tanqueCapacidade || "");
    localStorage.setItem("car_media_diaria", v.mediaDiaria || "40");
    localStorage.setItem("car_ultima_data", new Date().toISOString());
}

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
    console.log("[PERFIL-DEBUG] DOMContentLoaded INICIADO");
    try {
        simulationIntervalId = setInterval(simularDadosOBD, 3000);
        carregarRegistrosManutencao();
        popularDatalistManutencao();
        await initStaticSelects();
        console.log("[PERFIL-DEBUG] initStaticSelects OK");

        const btnToggle = document.getElementById("btn-toggle-form");
        console.log("[PERFIL-DEBUG] btn-toggle-form encontrado:", !!btnToggle);
        if (btnToggle) {
            btnToggle.addEventListener("click", () => {
                console.log("[PERFIL-DEBUG] BOTÃO TOGGLE CLICADO");
                toggleFormVeiculo();
            });
        }

        console.log("[PERFIL-DEBUG] Antes de verificarOnboardingESincronizacao");
        verificarOnboardingESincronizacao();
        console.log("[PERFIL-DEBUG] Depois de verificarOnboardingESincronizacao");
    } catch(e) {
        console.error("[PERFIL-DEBUG] ERRO NO DOMContentLoaded:", e);
    }
});

const MARCAS_FIPE = [
    { codigo: "59", nome: "Volkswagen" },
    { codigo: "60", nome: "GM (Chevrolet)" },
    { codigo: "22", nome: "Fiat" },
    { codigo: "17", nome: "Ford" },
    { codigo: "20", nome: "Honda" },
    { codigo: "56", nome: "Toyota" },
    { codigo: "21", nome: "Hyundai" },
    { codigo: "33", nome: "Kia" },
    { codigo: "35", nome: "Nissan" },
    { codigo: "42", nome: "Renault" },
    { codigo: "38", nome: "Peugeot" },
    { codigo: "12", nome: "Citroën" },
    { codigo: "26", nome: "Jeep" },
    { codigo: "5", nome: "Audi" },
    { codigo: "7", nome: "BMW" },
    { codigo: "34", nome: "Mercedes-Benz" },
    { codigo: "57", nome: "Volvo" },
    { codigo: "36", nome: "Mitsubishi" },
    { codigo: "47", nome: "Suzuki" },
    { codigo: "48", nome: "CAOA Chery" },
    { codigo: "63", nome: "BYD" },
    { codigo: "31", nome: "Land Rover" },
    { codigo: "50", nome: "Chery" },
    { codigo: "58", nome: "Troller" },
    { codigo: "54", nome: "Porsche" },
    { codigo: "29", nome: "Iveco" },
    { codigo: "3", nome: "Agrale" },
    { codigo: "32", nome: "MINI" },
    { codigo: "19", nome: "Alfa Romeo" },
    { codigo: "24", nome: "JAC" },
    { codigo: "62", nome: "RAM" },
    { codigo: "53", nome: "Subaru" },
    { codigo: "61", nome: "Dodge" }
];

const MARCAS_ALIASES = {
    'vw': 'Volkswagen', 'volks': 'Volkswagen', 'volkswagen': 'Volkswagen',
    'gm': 'GM (Chevrolet)', 'chevrolet': 'GM (Chevrolet)', 'chevy': 'GM (Chevrolet)',
    'fiat': 'Fiat', 'ford': 'Ford', 'honda': 'Honda', 'toyota': 'Toyota',
    'hyundai': 'Hyundai', 'kia': 'Kia', 'nissan': 'Nissan', 'renault': 'Renault',
    'peugeot': 'Peugeot', 'citroen': 'Citroën', 'citroën': 'Citroën',
    'jeep': 'Jeep', 'audi': 'Audi', 'bmw': 'BMW',
    'mercedes': 'Mercedes-Benz', 'mercedes-benz': 'Mercedes-Benz',
    'volvo': 'Volvo', 'mitsubishi': 'Mitsubishi', 'suzuki': 'Suzuki',
    'chery': 'Chery', 'caoa chery': 'CAOA Chery', 'caoa': 'CAOA Chery',
    'land rover': 'Land Rover', 'range rover': 'Land Rover',
    'dodge': 'Dodge', 'ram': 'RAM', 'porsche': 'Porsche', 'mini': 'MINI',
    'subaru': 'Subaru', 'byd': 'BYD', 'jac': 'JAC',
    'ssangyong': 'SsangYong', 'lifan': 'Lifan',
    'alfa': 'Alfa Romeo', 'alfa romeo': 'Alfa Romeo',
    'ferrari': 'Ferrari', 'lexus': 'Lexus',
    'gurgel': 'Gurgel', 'buggy': 'Buggy', 'troller': 'Troller'
};

function resolverMarca(texto) {
    const t = texto.toLowerCase().trim();
    if (!t) return null;
    let found = MARCAS_FIPE.find(m => m.nome.toLowerCase() === t);
    if (found) return found;
    const alias = MARCAS_ALIASES[t];
    if (alias) found = MARCAS_FIPE.find(m => m.nome === alias);
    if (found) return found;
    found = MARCAS_FIPE.find(m => m.nome.toLowerCase().startsWith(t));
    if (found) return found;
    found = MARCAS_FIPE.find(m => m.nome.toLowerCase().includes(t));
    return found || null;
}

async function initStaticSelects() {
    marcasCache = MARCAS_FIPE;
    ['inp-prof', 'onb'].forEach(prefix => {
        const input = document.getElementById(prefix + '-marca');
        if (!input) return;
        const wrap = document.createElement('div');
        wrap.className = 'combo-wrap';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        input.removeAttribute('list');
        input.setAttribute('autocomplete', 'off');

        const list = document.createElement('div');
        list.className = 'combo-list';
        list.id = prefix + '-combo-list';
        wrap.appendChild(list);

        marcasCache.forEach(m => {
            const item = document.createElement('div');
            item.className = 'combo-item';
            item.textContent = m.nome;
            item.dataset.value = m.nome;
            list.appendChild(item);
        });

        let highlighted = -1;
        const getVisible = () => [...list.querySelectorAll('.combo-item')].filter(i => i.style.display !== 'none');

        function showAll() {
            list.querySelectorAll('.combo-item').forEach(i => {
                i.style.display = '';
                i.classList.remove('highlighted');
            });
            highlighted = -1;
            list.classList.add('open');
        }

        function showFiltered(text) {
            const t = text.toLowerCase().trim();
            let count = 0;
            list.querySelectorAll('.combo-item').forEach(item => {
                const match = !t || item.dataset.value.toLowerCase().includes(t);
                item.style.display = match ? '' : 'none';
                if (match) count++;
            });
            highlighted = -1;
            list.querySelectorAll('.combo-item').forEach(i => i.classList.remove('highlighted'));
            list.classList.toggle('open', count > 0);
        }

        input.addEventListener('click', (e) => {
            e.stopPropagation();
            showAll();
        });

        input.addEventListener('input', () => {
            showFiltered(input.value);
        });

        input.addEventListener('keydown', (e) => {
            const visible = getVisible();
            if (!visible.length) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                highlighted = Math.min(highlighted + 1, visible.length - 1);
                visible.forEach((v, i) => v.classList.toggle('highlighted', i === highlighted));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                highlighted = Math.max(highlighted - 1, 0);
                visible.forEach((v, i) => v.classList.toggle('highlighted', i === highlighted));
            } else if (e.key === 'Enter' && highlighted >= 0) {
                e.preventDefault();
                selectItem(visible[highlighted]);
            } else if (e.key === 'Escape') {
                list.classList.remove('open');
            }
        });

        list.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('combo-item')) {
                e.preventDefault();
                selectItem(e.target);
            }
        });

        function selectItem(item) {
            input.value = item.dataset.value;
            list.classList.remove('open');
            executarMarcaChange(prefix);
        }

        document.addEventListener('click', () => {
            list.classList.remove('open');
        });
    });
}

let marcaDebounceTimers = {};

async function onMarcaChange(prefix) {
    clearTimeout(marcaDebounceTimers[prefix]);
    marcaDebounceTimers[prefix] = setTimeout(() => executarMarcaChange(prefix), 300);
}

async function executarMarcaChange(prefix) {
    const input = document.getElementById(prefix + '-marca');
    const anoSelect = document.getElementById(prefix + '-ano');
    const modSelect = document.getElementById(prefix + '-modelo');
    const brand = resolverMarca(input.value);

    if (!brand) return;

    input.value = brand.nome;
    anoSelect.innerHTML = '<option value="">Carregando anos...</option>';
    modSelect.innerHTML = '<option value="">Modelo...</option>';

    let anos = cacheGet(`fipe_v2_years_${brand.codigo}`);
    if (!anos) {
        try {
            const resp = await fetch(`${API_FIPE_V2}/${brand.codigo}/years`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            anos = await resp.json();
            cacheSet(`fipe_v2_years_${brand.codigo}`, anos);
        } catch (e) {
            console.error("Erro ao carregar anos:", e);
            anoSelect.innerHTML = '<option value="">Erro ao carregar. Toque para tentar</option>';
            anoSelect.onclick = () => executarMarcaChange(prefix);
            return;
        }
    }

    anoSelect.onclick = null;
    const anosUnicos = {};
    anos.forEach(a => {
        const anoNum = a.code.split('-')[0];
        if (!anosUnicos[anoNum]) anosUnicos[anoNum] = [];
        anosUnicos[anoNum].push(a);
    });
    const anosOrdenados = Object.keys(anosUnicos).sort((a, b) => b - a);
    anosPorModeloCache[`${prefix}_years`] = anosUnicos;
    anoSelect.innerHTML = '<option value="">Ano...</option>';
    anosOrdenados.forEach(ano => {
        anoSelect.innerHTML += `<option value="${ano}">${ano} (${anosUnicos[ano].length} ver.)</option>`;
    });
}

async function onAnoChange(prefix) {
    const brand = resolverMarca(document.getElementById(prefix + '-marca').value);
    const anoSel = document.getElementById(prefix + '-ano').value;
    const modSelect = document.getElementById(prefix + '-modelo');

    modSelect.innerHTML = '<option value="">Modelo...</option>';
    if (!brand || !anoSel) return;

    const anosUnicos = anosPorModeloCache[`${prefix}_years`] || {};
    const versoesDoAno = anosUnicos[anoSel] || [];
    const yearCodes = versoesDoAno.map(v => v.code);

    const cacheKey = `fipe_v2_mods_${brand.codigo}_${anoSel}`;
    let modelos = cacheGet(cacheKey);

    if (!modelos) {
        try {
            const allModels = {};
            for (const yearId of yearCodes) {
                try {
                    const resp = await fetch(`${API_FIPE_V2}/${brand.codigo}/years/${yearId}/models`);
                    if (!resp.ok) continue;
                    const batch = await resp.json();
                    batch.forEach(m => { allModels[m.code] = m; });
                } catch {}
            }
            modelos = Object.values(allModels);
            cacheSet(cacheKey, modelos);
        } catch (e) {
            console.error("Erro ao carregar modelos:", e);
            modSelect.innerHTML = '<option value="">Erro ao carregar</option>';
            return;
        }
    }

    modSelect.innerHTML = '<option value="">Modelo...</option>';
    modelos.forEach(mod => {
        modSelect.innerHTML += `<option value="${mod.code}">${mod.name}</option>`;
    });
}

function verificarOnboardingESincronizacao() {
    console.log("[PERFIL-DEBUG] verificarOnboardingESincronizacao INICIADO");
    migrarDadosLegadoSeNecessario();
    sincronizarLegado();

    const vehicles = getVeiculos();
    const km = parseInt(localStorage.getItem("car_km")) || 0;
    console.log("[PERFIL-DEBUG] vehicles:", vehicles, "km:", km, "length:", vehicles.length);

    if (vehicles.length === 0 && km <= 0) {
        console.log("[PERFIL-DEBUG] sem veículo → toast welcome");
        renderizarDadosGlobais();
        showToast("Bem-vindo! Preencha os dados do seu veículo na aba Perfil para ter acesso a todas as funcionalidades.", "info", 8000);
    } else {
        console.log("[PERFIL-DEBUG] com veículo → processarEstimativa + renderizar");
        processarEstimativaDeQuilometragem();
        renderizarDadosGlobais();
    }
    console.log("[PERFIL-DEBUG] verificarOnboardingESincronizacao FINALIZADO");
}

function concluirOnboarding() {
    const kmInput = document.getElementById("onb-km").value;
    const mSel = document.getElementById("onb-marca").value;
    const modSelect = document.getElementById("onb-modelo");
    const anoSelect = document.getElementById("onb-ano");
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

    const novoVeiculo = {
        id: Date.now().toString(36),
        km: parseInt(kmInput) || 0,
        marca: mSel || "",
        modelo: modSelect.selectedIndex > 0 ? modSelect.options[modSelect.selectedIndex].text : "",
        ano: anoSelect.selectedIndex > 0 ? anoSelect.options[anoSelect.selectedIndex].text : "",
        anoCodigo: anoSelect.value || "",
        placa: placaInput.toUpperCase(),
        vin: vinInput.toUpperCase(),
        tanqueCapacidade: document.getElementById("onb-tanque")?.value || "",
        mediaDiaria: "40"
    };

    const vehicles = getVeiculos();
    vehicles.push(novoVeiculo);
    salvarVeiculos(vehicles);
    setIdxAtivo(vehicles.length - 1);
    sincronizarLegado();

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
        let kmAtual = getKmAtual();
        let v = getVeiculoAtivo();
        let mediaDiaria = v ? (parseInt(v.mediaDiaria) || 40) : 40;
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
        const vehicles = getVeiculos();
        const idx = getIdxAtivo();
        if (vehicles[idx]) {
            vehicles[idx].km = kmFinal;
            salvarVeiculos(vehicles);
            sincronizarLegado();
        }
        renderizarDadosGlobais();
    }
    document.getElementById("modal-estimativa").classList.add("hidden");
}

function renderizarDadosGlobais() {
    console.log("[PERFIL-DEBUG] renderizarDadosGlobais INICIADO");
    const v = getVeiculoAtivo();
    console.log("[PERFIL-DEBUG] veiculo ativo:", v);
    const temVeiculo = !!(v && v.marca);

    const km = v ? (parseInt(v.km) || 0) : 0;
    const marcaNome = v ? (v.marca || "") : "";
    const modeloNome = v ? (v.modelo || "") : "";
    const ano = v ? (v.ano || "--") : "--";
    const placa = v ? (v.placa || "") : "";
    const vin = v ? (v.vin || "") : "";

    popularSelectorVeiculos();

    try {
        document.getElementById("txt-odometro").innerText = km.toLocaleString() + " KM";
        document.getElementById("lbl-veiculo-ano").innerText = `Ano: ${ano}`;
    } catch(e) {
        console.error("[PERFIL-DEBUG] Erro ao preencher odomômetro/ano:", e);
    }

    const lblPlaca = document.getElementById("lbl-placa");
    if (lblPlaca) {
        if (placa) {
            lblPlaca.innerText = placa;
            document.getElementById("lbl-placa-container").classList.remove("hidden");
        } else {
            document.getElementById("lbl-placa-container").classList.add("hidden");
        }
    }

    const lblVin = document.getElementById("lbl-vin");
    if (lblVin) {
        if (vin) {
            lblVin.innerText = vin;
            document.getElementById("lbl-vin-container").classList.remove("hidden");
        } else {
            document.getElementById("lbl-vin-container").classList.add("hidden");
        }
    }

    const btnExcluir = document.getElementById("btn-excluir-veiculo");
    if (btnExcluir) btnExcluir.classList.toggle("hidden", !temVeiculo);
    const btnEditar = document.getElementById("btn-editar-veiculo");
    if (btnEditar) btnEditar.classList.toggle("hidden", !temVeiculo);

    const txtToggle = document.getElementById("btn-toggle-text");
    if (txtToggle) txtToggle.innerText = "Adicionar novo Veículo";

    document.getElementById("inp-prof-km").value = km || "";
    const inpPlaca = document.getElementById("inp-prof-placa");
    if (inpPlaca) inpPlaca.value = placa;
    const inpVin = document.getElementById("inp-prof-vin");
    if (inpVin) inpVin.value = vin;
    const inpTanque = document.getElementById("inp-prof-tanque");
    if (inpTanque) inpTanque.value = v ? (v.tanqueCapacidade || "") : "";
    const inpKmDia = document.getElementById("inp-prof-km-dia");
    if (inpKmDia) inpKmDia.value = v ? (v.mediaDiaria || "40") : "";

    preencherPerfil(marcaNome, modeloNome, ano);

    const kmLitro = calcularKmPorLitro();
    const elConsumoMedio = document.getElementById("val-consumo-medio");
    if (elConsumoMedio) {
        elConsumoMedio.innerHTML = kmLitro ? `${kmLitro} <small style="font-size:10px">km/L</small>` : `-- <small style="font-size:10px">km/L</small>`;
    }

    renderizarAlertasManutencao();
    console.log("[PERFIL-DEBUG] renderizarDadosGlobais FINALIZADO");
}

async function preencherPerfil(marca, modelo, ano) {
    const marcaInput = document.getElementById("inp-prof-marca");
    const anoSelect = document.getElementById("inp-prof-ano");
    const modSelect = document.getElementById("inp-prof-modelo");

    if (!marca) return;
    marcaInput.value = marca;

    const brand = resolverMarca(marca);
    if (!brand) return;

    let anos = cacheGet(`fipe_v2_years_${brand.codigo}`);
    if (!anos) {
        try {
            const resp = await fetch(`${API_FIPE_V2}/${brand.codigo}/years`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            anos = await resp.json();
            cacheSet(`fipe_v2_years_${brand.codigo}`, anos);
        } catch (e) { return; }
    }

    const anosUnicos = {};
    anos.forEach(a => {
        const anoNum = a.code.split('-')[0];
        if (!anosUnicos[anoNum]) anosUnicos[anoNum] = [];
        anosUnicos[anoNum].push(a);
    });
    anosPorModeloCache['inp-prof_years'] = anosUnicos;

    const anosOrdenados = Object.keys(anosUnicos).sort((a, b) => b - a);
    anoSelect.innerHTML = '<option value="">Ano...</option>';
    anosOrdenados.forEach(a => {
        anoSelect.innerHTML += `<option value="${a}" ${a === ano ? 'selected' : ''}>${a} (${anosUnicos[a].length} ver.)</option>`;
    });

    if (ano && anosUnicos[ano]) {
        anoSelect.value = ano;
        await onAnoChange('inp-prof');
        if (modelo) {
            const modelOpts = Array.from(modSelect.options);
            const match = modelOpts.find(o => o.text.toLowerCase() === modelo.toLowerCase());
            if (match) modSelect.value = match.value;
        }
    }
}

function getKmAtual() {
    const v = getVeiculoAtivo();
    return v ? (parseInt(v.km) || 0) : (parseInt(localStorage.getItem("car_km")) || 0);
}

function getTanqueCapacidade() {
    const v = getVeiculoAtivo();
    return v ? (parseInt(v.tanqueCapacidade) || 50) : (parseInt(localStorage.getItem("car_tanque_capacidade")) || 50);
}

function renderizarSaudeVeiculo() {
    const container = document.getElementById('maint-saude');
    if (!container) return;

    const kmAtual = getKmAtual();
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
                    <span style="color:var(--accent); font-weight:700; font-size:10px; text-transform:uppercase;">Original de fábrica</span>
                </div>
                <div style="font-size:9px; color:#64748b;">Nenhum serviço registrado. Pode ser a peça original de fábrica.</div>
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
            alertas.push({ nome: catalogo.nome, tipo: 'info', msg: 'Original de fábrica', cor: 'var(--accent)' });
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

    const nomeLower = item.toLowerCase();
    const removidos = [];
    listaNecessidades = listaNecessidades.filter(n => {
        const match = n.nome.toLowerCase().includes(nomeLower) || nomeLower.includes(n.nome.toLowerCase().split(' ')[0]);
        if (match) removidos.push(n.nome);
        return !match;
    });
    if (removidos.length > 0) {
        localStorage.setItem("car_lista_necessidades", JSON.stringify(listaNecessidades));
        showToast(`${removidos.join(', ')} removido(s) do Checklist de Peças (já registrado na manutenção).`, "info");
    }

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
    console.log("[PERFIL-DEBUG] salvarPerfil CHAMADO");
    const kmInput = document.getElementById("inp-prof-km").value;
    const mInput = document.getElementById("inp-prof-marca").value;
    const modSelect = document.getElementById("inp-prof-modelo");
    const anoSelect = document.getElementById("inp-prof-ano");
    const placaInput = document.getElementById("inp-prof-placa")?.value.trim() || "";
    const vinInput = document.getElementById("inp-prof-vin")?.value.trim() || "";
    const tanqueInput = document.getElementById("inp-prof-tanque")?.value || "";
    const kmDiaInput = document.getElementById("inp-prof-km-dia")?.value || "40";
    console.log("[PERFIL-DEBUG] salvarPerfil inputs:", { kmInput, mInput, placaInput });

    if (!kmInput || kmInput <= 0) {
        showToast("Insira uma quilometragem válida.", "error");
        return;
    }
    if (placaInput && !validarPlaca(placaInput)) {
        showToast("Placa inválida. Formato correto: ABC1D23 (7 caracteres, letras e números).", "error");
        return;
    }
    if (vinInput && !validarVIN(vinInput)) {
        showToast("Chassi/VIN inválido. Deve conter exatamente 17 caracteres.", "error");
        return;
    }

    const veiculoData = {
        id: Date.now().toString(36),
        km: parseInt(kmInput) || 0,
        marca: mInput || "",
        modelo: modSelect.selectedIndex > 0 ? modSelect.options[modSelect.selectedIndex].text : "",
        ano: anoSelect.selectedIndex > 0 ? anoSelect.options[anoSelect.selectedIndex].text : "",
        anoCodigo: anoSelect.value || "",
        placa: placaInput.toUpperCase(),
        vin: vinInput.toUpperCase(),
        tanqueCapacidade: tanqueInput,
        mediaDiaria: kmDiaInput || "40"
    };

    const vehicles = getVeiculos();
    const existenteIdx = editandoVeiculoId ? vehicles.findIndex(v => v.id === editandoVeiculoId) : -1;
    const existente = existenteIdx >= 0 ? vehicles[existenteIdx] : null;
    console.log("[PERFIL-DEBUG] salvarPerfil editando:", !!existente, "editandoVeiculoId:", editandoVeiculoId, "total:", vehicles.length);

    if (existente) {
        veiculoData.id = existente.id;
        vehicles[existenteIdx] = veiculoData;
    } else {
        vehicles.push(veiculoData);
        setIdxAtivo(vehicles.length - 1);
    }

    salvarVeiculos(vehicles);
    sincronizarLegado();
    editandoVeiculoId = null;

    document.getElementById("card-form-veiculo").classList.add("hidden");
    const txtToggle = document.getElementById("btn-toggle-text");
    const btnToggle = document.getElementById("btn-toggle-form");
    if (txtToggle) txtToggle.innerText = "Adicionar novo Veículo";
    if (btnToggle) btnToggle.querySelector("i").className = "fas fa-plus";
    renderizarDadosGlobais();
    showToast(existente ? "Veículo atualizado com sucesso!" : "Veículo adicionado com sucesso!", "success");
    console.log("[PERFIL-DEBUG] salvarPerfil FINALIZADO");
}

// ==========================================
// BACKUP, TRANSFERÊNCIA E RELATÓRIO (PDF)
// ==========================================

// Reúne tudo que identifica o veículo e seu histórico num único objeto
function coletarDadosCompletos() {
    return {
        appNome: "AutoGestão X",
        versaoFormato: 7,
        exportadoEm: new Date().toISOString(),
        vehicles: getVeiculos(),
        activeIdx: getIdxAtivo(),
        veiculo: {
            km: localStorage.getItem("car_km"),
            marca: localStorage.getItem("car_marca_nome"),
            modelo: localStorage.getItem("car_modelo_nome"),
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
            if (!dados.veiculo && !dados.vehicles) {
                throw new Error("Formato de arquivo inválido.");
            }

            const resumo = dados.vehicles
                ? `${dados.vehicles.length} veículo(s) importado(s)`
                : `${dados.veiculo?.marca || '?'} ${dados.veiculo?.modelo || ''}`;
            if (!confirm(`Isso vai substituir os dados atuais deste dispositivo por:\n\n${resumo}\n\nDeseja continuar?`)) {
                inputEl.value = '';
                return;
            }

            if (dados.vehicles && Array.isArray(dados.vehicles)) {
                salvarVeiculos(dados.vehicles);
                if (typeof dados.activeIdx === 'number') setIdxAtivo(dados.activeIdx);
            } else {
                const v = dados.veiculo;
                const novoVeiculo = {
                    id: Date.now().toString(36),
                    km: parseInt(v.km) || 0,
                    marca: v.marca || "",
                    modelo: v.modelo || "",
                    ano: v.ano || "",
                    anoCodigo: "",
                    placa: v.placa || "",
                    vin: v.vin || "",
                    tanqueCapacidade: v.tanqueCapacidade || "",
                    motor: v.motor || "",
                    mediaDiaria: v.mediaDiaria || "40"
                };
                const vehicles = getVeiculos();
                const idxAtivo = getIdxAtivo();
                if (vehicles[idxAtivo]) {
                    vehicles[idxAtivo] = { ...vehicles[idxAtivo], ...novoVeiculo, id: vehicles[idxAtivo].id };
                } else {
                    vehicles.push(novoVeiculo);
                    setIdxAtivo(vehicles.length - 1);
                }
                salvarVeiculos(vehicles);
            }
            sincronizarLegado();

            registrosManutencao = dados.registrosManutencao || [];
            registrosManutencao.forEach(r => {
                if (r.custo !== undefined && r.custoPeca === undefined) {
                    r.custoPeca = r.custo;
                    r.custoMao = 0;
                    delete r.custo;
                }
            });
            salvarRegistrosManutencao();

            listaNecessidades = dados.checklistPecas || dados.planoAquisicao || [];

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
    const ano = localStorage.getItem("car_ano") || "--";
    const motor = localStorage.getItem("car_motor") || "";
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
    doc.roundedRect(margemEsquerda, y - 2, larguraUtil, 44, 2, 2, 'F');
    doc.setDrawColor(180);
    doc.roundedRect(margemEsquerda, y - 2, larguraUtil, 44, 2, 2, 'S');

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
    doc.text(`${marca} ${modelo} ${ano}`.trim(), col1X + 20, infoY);

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

    if (motor) {
        doc.setFont(undefined, 'bold');
        doc.text("Motor:", col2X, infoY);
        doc.setFont(undefined, 'normal');
        doc.text(motor, col2X + 16, infoY);
    }
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
            doc.text("Original de fábrica — nenhum serviço registrado para este item.", margemEsquerda + 4, y);
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
    "filtros": {
        label: "Filtros & Fluidos",
        subs: {
            "Filtros": [
                { id: "p1", nome: "Filtro de Óleo", vidaUtilKm: 10000, prioridade: "Alta" },
                { id: "p2", nome: "Filtro de Ar do Motor", vidaUtilKm: 15000, prioridade: "Média" },
                { id: "p3", nome: "Filtro de Combustível", vidaUtilKm: 10000, prioridade: "Alta" },
                { id: "p4", nome: "Filtro de Cabine (Ar Cond.)", vidaUtilKm: 15000, prioridade: "Baixa" }
            ],
            "Fluidos": [
                { id: "p5", nome: "Fluido de Arrefecimento", vidaUtilKm: 30000, prioridade: "Alta" },
                { id: "p6", nome: "Fluido de Freio DOT4", vidaUtilKm: 20000, prioridade: "Alta" },
                { id: "p7", nome: "Fluido de Direção Hidráulica", vidaUtilKm: 40000, prioridade: "Média" },
                { id: "p8", nome: "Óleo de Transmissão", vidaUtilKm: 40000, prioridade: "Média" }
            ]
        }
    },
    "ignicao": {
        label: "Ignição",
        subs: {
            "Velas": [
                { id: "p9", nome: "Jogo de Velas de Ignição", vidaUtilKm: 40000, prioridade: "Alta" },
                { id: "p11", nome: "Cabos de Vela (Jogo)", vidaUtilKm: 50000, prioridade: "Média" }
            ],
            "Bobinas": [
                { id: "p10", nome: "Bobina de Ignição", vidaUtilKm: 80000, prioridade: "Média" }
            ],
            "Sensores": [
                { id: "p12", nome: "Sensor CKP (Câmbio)", vidaUtilKm: 100000, prioridade: "Baixa" },
                { id: "p13", nome: "Sensor MAP", vidaUtilKm: 100000, prioridade: "Média" },
                { id: "p14", nome: "Sensor MAF / Fluxo de Ar", vidaUtilKm: 80000, prioridade: "Média" }
            ]
        }
    },
    "freios": {
        label: "Freios",
        subs: {
            "Pastilhas": [
                { id: "p15", nome: "Pastilha de Freio Dianteira", vidaUtilKm: 30000, prioridade: "Crítica" },
                { id: "p17", nome: "Pastilha de Freio Traseira", vidaUtilKm: 40000, prioridade: "Alta" }
            ],
            "Discos": [
                { id: "p16", nome: "Disco de Freio Dianteiro (Par)", vidaUtilKm: 60000, prioridade: "Média" },
                { id: "p18", nome: "Disco de Freio Traseiro (Par)", vidaUtilKm: 80000, prioridade: "Média" }
            ],
            "Fluido e Mangueiras": [
                { id: "p19", nome: "Mangueira de Freio", vidaUtilKm: 60000, prioridade: "Alta" },
                { id: "p20", nome: "Líquido de Freio (Troca)", vidaUtilKm: 20000, prioridade: "Alta" }
            ]
        }
    },
    "motor": {
        label: "Motor",
        subs: {
            "Óleo e Lubrificação": [
                { id: "p21", nome: "Óleo de Motor 5W40 Sintético", vidaUtilKm: 10000, prioridade: "Alta" },
                { id: "p26", nome: "Vedação de Tela do Óleo", vidaUtilKm: 40000, prioridade: "Média" },
                { id: "p27", nome: "Retentor do Virabrequim", vidaUtilKm: 100000, prioridade: "Média" }
            ],
            "Correias": [
                { id: "p22", nome: "Kit Correia Dentada e Tensor", vidaUtilKm: 60000, prioridade: "Crítica" },
                { id: "p23", nome: "Correia Alternador / Acessórios", vidaUtilKm: 50000, prioridade: "Alta" }
            ],
            "Resfriamento": [
                { id: "p24", nome: "Termostato do Motor", vidaUtilKm: 80000, prioridade: "Média" },
                { id: "p25", nome: "Bomba de Água / Radiador", vidaUtilKm: 80000, prioridade: "Média" }
            ]
        }
    },
    "suspensao": {
        label: "Suspensão & Embreagem",
        subs: {
            "Amortecedores": [
                { id: "p28", nome: "Amortecedor Dianteiro (Par)", vidaUtilKm: 60000, prioridade: "Média" },
                { id: "p29", nome: "Amortecedor Traseiro (Par)", vidaUtilKm: 60000, prioridade: "Média" },
                { id: "p30", nome: "Mola Dianteira (Par)", vidaUtilKm: 80000, prioridade: "Baixa" }
            ],
            "Direção": [
                { id: "p31", nome: "Bucha de Balança", vidaUtilKm: 50000, prioridade: "Média" },
                { id: "p32", nome: "Pivô de Direção", vidaUtilKm: 60000, prioridade: "Alta" },
                { id: "p33", nome: "Terminal de Direção", vidaUtilKm: 50000, prioridade: "Alta" }
            ],
            "Embreagem": [
                { id: "p34", nome: "Kit de Embreagem (Disco + Mola + Rolamento)", vidaUtilKm: 60000, prioridade: "Crítica" }
            ]
        }
    },
    "eletrica": {
        label: "Elétrica",
        subs: {
            "Bateria e Carga": [
                { id: "p35", nome: "Bateria 60Ah", vidaUtilKm: 0, prioridade: "Alta", vidaUtilMeses: 48 },
                { id: "p36", nome: "Alternador", vidaUtilKm: 120000, prioridade: "Média" },
                { id: "p37", nome: "Motor de Partida (Arranque)", vidaUtilKm: 150000, prioridade: "Média" }
            ],
            "Sensores": [
                { id: "p38", nome: "Sensor de Temperatura (ECT)", vidaUtilKm: 100000, prioridade: "Média" },
                { id: "p39", nome: "Sensor O₂ (Sonda Lambda)", vidaUtilKm: 80000, prioridade: "Alta" }
            ],
            "Iluminação": [
                { id: "p40", nome: "Farol Dianteiro (Par)", vidaUtilKm: 0, prioridade: "Baixa", vidaUtilMeses: 120 }
            ]
        }
    }
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

let buscaCatalogo = '';
let subCategoriaAtual = '';

function mudarCategoriaCatalogo(categoria) {
    categoriaAtualCatalogo = categoria;
    subCategoriaAtual = '';
    buscaCatalogo = '';
    renderizarCatalogoInteligente();
}

function mudarSubCategoria(sub) {
    subCategoriaAtual = sub;
    renderizarCatalogoInteligente();
}

function calcularStatusPeca(peca, kmAtual, kmLastMaintenance) {
    if (peca.vidaUtilKm <= 0) return { pct: 100, kmRestante: Infinity, vencida: false, proxima: false };
    const lastKm = kmLastMaintenance[peca.nome] || 0;
    const kmDesdeTroca = kmAtual - lastKm;
    const kmRestante = peca.vidaUtilKm - kmDesdeTroca;
    const pct = Math.max(0, Math.min(100, (kmRestante / peca.vidaUtilKm) * 100));
    return { pct, kmRestante, vencida: kmRestante <= 0, proxima: kmRestante > 0 && kmRestante <= 3000 };
}

function renderizarCatalogoInteligente() {
    const container = document.getElementById('catalogo-container');
    if (!container) return;
    
    const marca = localStorage.getItem("car_marca_nome") || "";
    const modelo = localStorage.getItem("car_modelo_nome") || "";
    const categoria = (typeof categoriaAtualCatalogo !== 'undefined') ? categoriaAtualCatalogo : 'filtros';
    const kmAtual = parseInt(localStorage.getItem("car_km")) || 0;
    
    const catData = BANCO_PECAS[categoria];
    if (!catData) return;
    const subKeys = Object.keys(catData.subs);
    const subAtiva = subCategoriaAtual || subKeys[0];

    const kmLastMaintenance = {};
    if (typeof registrosManutencao !== 'undefined') {
        registrosManutencao.forEach(r => {
            if (r.item && r.km) kmLastMaintenance[r.item] = Math.max(kmLastMaintenance[r.item] || 0, r.km);
        });
    }

    let html = `
        <div style="font-size:11px; color:#94a3b8; margin-bottom:5px; text-transform:uppercase;">
            PEÇAS COMPATÍVEIS${marca ? `: <strong style="color:var(--accent);">${marca} ${modelo}</strong>` : ''}
        </div>
        <div style="display:flex; gap:6px; margin-bottom:12px; overflow-x:auto; padding-bottom:8px; flex-wrap:nowrap;">
            ${Object.entries(BANCO_PECAS).map(([key, cat]) => `<button class="tab-btn ${categoria === key ? 'active' : ''}" onclick="mudarCategoriaCatalogo('${key}')" style="font-size:9px; padding:6px 10px; min-width:70px; white-space:nowrap;">${cat.label}</button>`).join('')}
        </div>
    `;

    const subCounts = {};
    subKeys.forEach(sk => {
        const pecasSub = catData.subs[sk];
        let count = 0;
        pecasSub.forEach(p => {
            const s = calcularStatusPeca(p, kmAtual, kmLastMaintenance);
            if (s.vencida || s.proxima) count++;
        });
        subCounts[sk] = count;
    });

    html += `<div style="display:flex; gap:6px; margin-bottom:14px; overflow-x:auto; padding-bottom:6px; flex-wrap:nowrap;">`;
    subKeys.forEach(sk => {
        const cnt = subCounts[sk];
        const isActive = subAtiva === sk;
        html += `<button class="tab-btn ${isActive ? 'active' : ''}" onclick="mudarSubCategoria('${sk}')" style="font-size:9px; padding:6px 10px; white-space:nowrap; display:flex; align-items:center; gap:4px;">
            ${sk}${cnt > 0 ? `<span style="background:${cnt > 2 ? 'var(--danger)' : 'var(--warning)'}; color:#000; font-size:7px; font-weight:900; padding:1px 5px; border-radius:8px; min-width:14px; text-align:center;">${cnt}</span>` : ''}
        </button>`;
    });
    html += `</div>`;

    const pecasFiltradas = catData.subs[subAtiva] || [];

    if (pecasFiltradas.length === 0) {
        html += `<div style="text-align:center; padding:30px; color:#475569; font-size:12px;">Nenhuma peça nesta categoria.</div>`;
        container.innerHTML = html;
        return;
    }

    pecasFiltradas.forEach(peca => {
        const status = calcularStatusPeca(peca, kmAtual, kmLastMaintenance);
        const jaNaLista = listaNecessidades.some(n => n.nome === peca.nome);
        
        let corBorda = 'rgba(255,255,255,0.05)';
        let badgeUrgencia = '';
        if (status.vencida) {
            corBorda = 'var(--danger)';
            badgeUrgencia = '<span style="background:var(--danger); color:#fff; font-size:7px; font-weight:900; padding:2px 5px; border-radius:3px; margin-left:6px;">TROCAR</span>';
        } else if (status.proxima) {
            corBorda = 'var(--warning)';
            badgeUrgencia = '<span style="background:var(--warning); color:#000; font-size:7px; font-weight:900; padding:2px 5px; border-radius:3px; margin-left:6px;">PRÓXIMO</span>';
        }

        const queryML = encodeURIComponent(`${peca.nome} ${marca} ${modelo}`);
        const urlML = `https://lista.mercadolivre.com.br/${queryML}`;
        const kmLabel = peca.vidaUtilKm > 0 ? (status.kmRestante > 0 ? `Trocar em ~${status.kmRestante.toLocaleString()} km` : 'Troca atrasada!') : (peca.vidaUtilMeses ? `Vida útil: ${peca.vidaUtilMeses} meses` : '');

        html += `
            <div class="glass-card" style="display:flex; justify-content:space-between; align-items:center; padding:14px; margin-bottom:10px; border-left:3px solid ${corBorda};">
                <div style="flex:1; padding-right:10px;">
                    <div style="display:flex; align-items:center; flex-wrap:wrap;">
                        <span style="font-size:9px; color:var(--accent); text-transform:uppercase;">Vida útil: ${peca.vidaUtilKm > 0 ? peca.vidaUtilKm.toLocaleString() + ' km' : (peca.vidaUtilMeses ? peca.vidaUtilMeses + ' meses' : '--')}</span>
                        ${badgeUrgencia}
                    </div>
                    <strong style="font-size:13px; color:#fff;">${peca.nome}</strong>
                    <span style="display:block; font-size:10px; color:${status.vencida ? 'var(--danger)' : status.proxima ? 'var(--warning)' : '#94a3b8'}; margin-top:2px;">${kmLabel}</span>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <a href="${urlML}" target="_blank" class="btn-main" style="width:auto; padding:8px 10px; font-size:9px; text-decoration:none; display:inline-block;">VER PREÇO</a>
                    <button class="btn-main" ${jaNaLista ? 'disabled style="width:32px;height:32px;padding:0;font-size:14px;background:rgba(34,197,94,0.1);color:var(--success);border:1px solid var(--success);opacity:0.5;cursor:default;"' : 'style="width:32px;height:32px;padding:0;font-size:14px;background:rgba(0,242,255,0.1);color:var(--accent);border:1px solid var(--accent);" onclick="adicionarPecaComPreco(\'' + peca.nome.replace(/'/g, "\\'") + '\', \'' + (peca.prioridade || 'Média') + '\')"'}>
                        ${jaNaLista ? '<i class="fas fa-check"></i>' : '+'}
                    </button>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function adicionarPecaComPreco(nome, prioridade) {
    if (listaNecessidades.some(item => item.nome === nome)) return;
    const precoStr = prompt(`Preço estimado para ${nome}:`, '');
    if (precoStr === null) return;
    const preco = parseFloat(precoStr.replace(',', '.')) || 0;
    listaNecessidades.push({ nome, motivo: 'Seleção Manual', preco, prioridade, vidaUtilPct: 85 });
    localStorage.setItem("car_lista_necessidades", JSON.stringify(listaNecessidades));
    showToast(`${nome} adicionado ao Checklist de Peças!`, "success");
    renderizarCatalogoInteligente();
    if (!document.getElementById('sacola-container').classList.contains('hidden')) renderizarPlanoNecessidades();
}

function adicionarAosNecessarios(nome, motivo, preco = 0, prioridade = "Média", vidaUtilPct = 90) {
    if (listaNecessidades.some(item => item.nome === nome)) return;
    listaNecessidades.push({ nome, motivo, preco, prioridade, vidaUtilPct });
    localStorage.setItem("car_lista_necessidades", JSON.stringify(listaNecessidades));
    showToast(`${nome} adicionado ao Checklist de Peças!`, "success");
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
    
    container.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <div style="font-size:12px; font-weight:800; color:var(--accent); text-transform:uppercase;">Checklist de Peças</div>
            <button class="btn-main" style="font-size:10px; padding:6px 12px;" onclick="adicionarPecaCustom()"><i class="fas fa-plus"></i> Adicionar Peça</button>
        </div>
    `;

    if (listaNecessidades.length === 0) {
        container.innerHTML += '<div style="text-align:center; padding:30px; color:#475569; font-size:12px;">Nenhuma peça no checklist.<br>Adicione do catálogo ou crie uma personalizada.</div>';
        return;
    }

    let totalEstimado = 0;
    listaNecessidades.sort((a, b) => {
        const ordem = { "Crítica": 0, "Alta": 1, "Média": 2, "Baixa": 3 };
        return (ordem[a.prioridade] ?? 2) - (ordem[b.prioridade] ?? 2);
    });

    listaNecessidades.forEach((item, index) => {
        totalEstimado += (item.preco || 0);
        const corAlerta = obterCorPrioridade(item.prioridade);
        
        container.innerHTML += `
            <div class="glass-card" style="border-left: 4px solid ${corAlerta}; padding: 14px; margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                    <div>
                        <span style="background: ${corAlerta}; color: #000; font-size: 8px; font-weight: 900; padding: 2px 6px; border-radius: 3px; text-transform: uppercase;">${item.prioridade}</span>
                        <strong style="font-size: 14px; color: #fff; display: block; margin-top: 4px;">${item.nome}</strong>
                        <span style="font-size: 10px; color: #94a3b8; display: block; margin-top: 2px;">${item.motivo}</span>
                    </div>
                    <div style="display:flex; gap:6px; align-items:center;">
                        <button style="background:none; border:none; color:#475569; cursor:pointer; font-size:12px;" onclick="editarPrecoPeca(${index})" title="Editar preço"><i class="fas fa-tag"></i></button>
                        <button style="background:none; border:none; color:#475569; cursor:pointer;" onclick="removerDosNecessarios(${index})"><i class="fas fa-trash-alt"></i></button>
                    </div>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
                    <span style="font-size:9px; color:#64748b;">Vida útil restante:</span>
                    <span style="font-size:10px; color:${item.vidaUtilPct <= 20 ? 'var(--danger)' : corAlerta}; font-weight:bold;">${item.vidaUtilPct}%</span>
                </div>
                <div style="width:100%; background:#1e293b; height:6px; border-radius:3px; overflow:hidden; margin-top:4px;">
                    <div style="width:${item.vidaUtilPct}%; background:${item.vidaUtilPct <= 20 ? 'var(--danger)' : corAlerta}; height:100%;"></div>
                </div>
                ${item.preco > 0 ? `<div style="font-size:11px; color:var(--success); margin-top:6px; font-weight:700;">R$ ${item.preco.toFixed(2)}</div>` : `<div style="font-size:10px; color:#475569; margin-top:6px; cursor:pointer;" onclick="editarPrecoPeca(${index})">+ Adicionar preço</div>`}
            </div>
        `;
    });

    if (totalEstimado > 0) {
        container.innerHTML += `
            <div class="glass-card" style="background:rgba(0,255,170,0.02); border-color:rgba(0,255,170,0.1); margin-top:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:11px; text-transform:uppercase; color:#94a3b8;">Orçamento Estimado:</span>
                    <strong style="font-size:1.3rem; color:var(--success);">R$ ${totalEstimado.toFixed(2)}</strong>
                </div>
            </div>
        `;
    }
}

function adicionarPecaCustom() {
    const nome = prompt("Nome da peça:", "");
    if (!nome || !nome.trim()) return;
    const motivo = prompt("Motivo / observação:", "Necessidade manual");
    const precoStr = prompt("Preço estimado (R$):", "");
    const preco = parseFloat((precoStr || '0').replace(',', '.')) || 0;
    const prioridade = prompt("Prioridade (Crítica, Alta, Média, Baixa):", "Média") || "Média";
    adicionarAosNecessarios(nome.trim(), motivo || "Necessidade manual", preco, prioridade, 85);
}

function editarPrecoPeca(index) {
    if (!listaNecessidades[index]) return;
    const atual = listaNecessidades[index].preco || 0;
    const precoStr = prompt(`Preço para ${listaNecessidades[index].nome}:`, atual > 0 ? atual.toFixed(2) : '');
    if (precoStr === null) return;
    listaNecessidades[index].preco = parseFloat(precoStr.replace(',', '.')) || 0;
    localStorage.setItem("car_lista_necessidades", JSON.stringify(listaNecessidades));
    showToast("Preço atualizado!", "success");
    renderizarPlanoNecessidades();
}

function removerDosNecessarios(index) {
    listaNecessidades.splice(index, 1);
    localStorage.setItem("car_lista_necessidades", JSON.stringify(listaNecessidades));
    renderizarPlanoNecessidades();
}

function verificarPecasVencidas() {
    const kmAtual = parseInt(localStorage.getItem("car_km")) || 0;
    const kmLastMaintenance = {};
    if (typeof registrosManutencao !== 'undefined') {
        registrosManutencao.forEach(r => {
            if (r.item && r.km) kmLastMaintenance[r.item] = Math.max(kmLastMaintenance[r.item] || 0, r.km);
        });
    }
    const vencidas = [];
    const proximas = [];
    Object.values(BANCO_PECAS).forEach(cat => {
        Object.values(cat.subs).flat().forEach(peca => {
            const s = calcularStatusPeca(peca, kmAtual, kmLastMaintenance);
            if (s.vencida) vencidas.push(peca.nome);
            else if (s.proxima) proximas.push(`${peca.nome} (${s.kmRestante.toLocaleString()} km)`);
        });
    });
    if (vencidas.length > 0) {
        setTimeout(() => showToast(`⚠️ ${vencidas.length} peça(s) com troca atrasada: ${vencidas.slice(0, 3).join(', ')}${vencidas.length > 3 ? '...' : ''}`, "warning"), 3000);
    } else if (proximas.length > 0) {
        setTimeout(() => showToast(`🔧 Próximas de vencer: ${proximas.slice(0, 2).join(', ')}`, "info"), 3000);
    }
}


// Força o carregamento inicial das peças e filtros assim que o app abre
document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
        if (typeof alternarSubAbaPecas === "function") {
            alternarSubAbaPecas('catalogo');
        }
        if (typeof verificarPecasVencidas === "function") {
            verificarPecasVencidas();
        }
    }, 150);
});
