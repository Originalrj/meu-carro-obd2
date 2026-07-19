// =============================================
// drive-sync.js — Sincronização com Google Drive
// =============================================

const GDRIVE_CONFIG = {
    CLIENT_ID: 'SEU_CLIENT_ID.apps.googleusercontent.com', // ← Substituir pelo seu Client ID
    SCOPES: 'https://www.googleapis.com/auth/drive.file',
    FILE_NAME: 'autogestaox_backup.json',
    FOLDER_NAME: 'AutoGestaoX',
    SYNC_INTERVAL_MS: 5 * 60 * 1000 // 5 minutos
};

let gdriveToken = null;
let gdriveFileId = null;
let gdriveSyncInterval = null;
let gdriveConnected = false;

// ==========================================
// INICIALIZAÇÃO DO GOOGLE IDENTITY SERVICES
// ==========================================

function initGoogleDrive() {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = () => {
        console.log('[GDRIVE] Google Identity Services loaded');
        verificarStatusDrive();
    };
    script.onerror = () => console.warn('[GDRIVE] Failed to load Google Identity Services');
    document.head.appendChild(script);
}

// ==========================================
// AUTENTICAÇÃO
// ==========================================

function conectarGoogleDrive() {
    if (!window.google || !window.google.accounts) {
        showToast('Biblioteca Google ainda carregando. Aguarde...', 'warning');
        return;
    }

    if (gdriveConnected) {
        desconectarGoogleDrive();
        return;
    }

    if (GDRIVE_CONFIG.CLIENT_ID === 'SEU_CLIENT_ID.apps.googleusercontent.com') {
        showToast('Configure seu Google Client ID no arquivo drive-sync.js', 'error', 5000);
        mostrarConfigDrive();
        return;
    }

    showToast('Abrindo autenticação Google...', 'info');

    const client = google.accounts.oauth2.initTokenClient({
        client_id: GDRIVE_CONFIG.CLIENT_ID,
        scope: GDRIVE_CONFIG.SCOPES,
        callback: (tokenResponse) => {
            if (tokenResponse.error) {
                console.error('[GDRIVE] Auth error:', tokenResponse);
                showToast('Erro na autenticação: ' + tokenResponse.error, 'error');
                return;
            }
            gdriveToken = tokenResponse.access_token;
            gdriveConnected = true;
            console.log('[GDRIVE] Autenticado com sucesso');
            showToast('Google Drive conectado!', 'success');
            atualizarUIDrive();
            iniciarAutoSync();
            // Primeira sincronização imediata
            sincronizarComDrive();
        },
        error_callback: (err) => {
            console.error('[GDRIVE] Error:', err);
            showToast('Erro ao conectar com Google Drive.', 'error');
        }
    });

    client.requestAccessToken();
}

function desconectarGoogleDrive() {
    if (gdriveToken && window.google && window.google.accounts) {
        google.accounts.oauth2.revoke(gdriveToken, () => {
            console.log('[GDRIVE] Token revogado');
        });
    }
    gdriveToken = null;
    gdriveFileId = null;
    gdriveConnected = false;
    pararAutoSync();
    localStorage.removeItem('gdrive_connected');
    atualizarUIDrive();
    showToast('Google Drive desconectado.', 'info');
}

function verificarStatusDrive() {
    // Tenta restaurar conexão (o token não persiste entre sessões,
    // mas marcamos que estava conectado para mostrar status correto)
    const wasConnected = localStorage.getItem('gdrive_connected') === 'true';
    if (wasConnected) {
        gdriveConnected = false; // Precisa re-autenticar
        atualizarUIDrive(true); // Mostra "reconectar"
    }
}

// ==========================================
// OPERAÇÕES DO GOOGLE DRIVE
// ==========================================

async function buscarArquivoBackup() {
    if (!gdriveToken) return null;

    try {
        const resp = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_CONFIG.FILE_NAME}' and trashed=false&fields=files(id,name,modifiedTime,size)`,
            { headers: { 'Authorization': `Bearer ${gdriveToken}` } }
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return data.files && data.files.length > 0 ? data.files[0] : null;
    } catch (e) {
        console.error('[GDRIVE] Erro ao buscar arquivo:', e);
        return null;
    }
}

async function buscarOuCriarPasta() {
    if (!gdriveToken) return null;

    try {
        // Busca pasta existente
        let resp = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_CONFIG.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
            { headers: { 'Authorization': `Bearer ${gdriveToken}` } }
        );
        let data = await resp.json();
        if (data.files && data.files.length > 0) return data.files[0].id;

        // Cria pasta
        resp = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${gdriveToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: GDRIVE_CONFIG.FOLDER_NAME,
                mimeType: 'application/vnd.google-apps.folder'
            })
        });
        data = await resp.json();
        return data.id;
    } catch (e) {
        console.error('[GDRIVE] Erro ao buscar/criar pasta:', e);
        return null;
    }
}

async function uploadBackup(dados) {
    if (!gdriveToken) return false;

    try {
        const conteudo = JSON.stringify(dados, null, 2);
        const blob = new Blob([conteudo], { type: 'application/json' });

        if (gdriveFileId) {
            // Atualiza arquivo existente
            const resp = await fetch(
                `https://www.googleapis.com/upload/drive/v3/files/${gdriveFileId}?uploadType=media`,
                {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${gdriveToken}` },
                    body: blob
                }
            );
            if (!resp.ok) throw new Error(`Update failed: ${resp.status}`);
            console.log('[GDRIVE] Arquivo atualizado:', gdriveFileId);
        } else {
            // Cria novo arquivo
            const folderId = await buscarOuCriarPasta();
            const metadata = {
                name: GDRIVE_CONFIG.FILE_NAME,
                mimeType: 'application/json'
            };
            if (folderId) metadata.parents = [folderId];

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', blob);

            const resp = await fetch(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
                {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${gdriveToken}` },
                    body: form
                }
            );
            if (!resp.ok) throw new Error(`Create failed: ${resp.status}`);
            const result = await resp.json();
            gdriveFileId = result.id;
            console.log('[GDRIVE] Arquivo criado:', gdriveFileId);
        }

        localStorage.setItem('gdrive_file_id', gdriveFileId);
        return true;
    } catch (e) {
        console.error('[GDRIVE] Erro no upload:', e);
        return false;
    }
}

async function downloadBackup() {
    if (!gdriveToken || !gdriveFileId) return null;

    try {
        const resp = await fetch(
            `https://www.googleapis.com/drive/v3/files/${gdriveFileId}?alt=media`,
            { headers: { 'Authorization': `Bearer ${gdriveToken}` } }
        );
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
        return await resp.json();
    } catch (e) {
        console.error('[GDRIVE] Erro no download:', e);
        return null;
    }
}

// ==========================================
// SINCRONIZAÇÃO INTELIGENTE
// ==========================================

async function sincronizarComDrive() {
    if (!gdriveConnected || !gdriveToken) return;

    const statusEl = document.getElementById('gdrive-status');
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-sync fa-spin"></i> Sincronizando...';

    try {
        // 1. Busca arquivo existente no Drive
        const arquivo = await buscarArquivoBackup();
        const dadosLocais = coletarDadosCompletos();

        if (arquivo) {
            gdriveFileId = arquivo.id;
            localStorage.setItem('gdrive_file_id', arquivo.id);

            // 2. Baixa versão do Drive
            const dadosRemotos = await downloadBackup();

            if (dadosRemotos) {
                // 3. Compara datas
                const dataLocal = new Date(dadosLocais.exportadoEm || 0);
                const dataRemota = new Date(dadosRemotos.exportadoEm || 0);

                if (dataRemota > dataLocal) {
                    // Drive é mais recente → pergunta ao usuário
                    if (confirm('O Google Drive tem dados mais recentes.\n\n' +
                        `Drive: ${dataRemota.toLocaleString('pt-BR')}\nLocal: ${dataLocal.toLocaleString('pt-BR')}\n\n` +
                        'Deseja importar os dados do Drive?')) {
                        await importarDadosDoDrive(dadosRemotos);
                        showToast('Dados importados do Google Drive!', 'success');
                    } else {
                        // Usuário quer manter local → sobrescreve Drive
                        await uploadBackup(dadosLocais);
                        showToast('Dados locais enviados ao Drive.', 'info');
                    }
                } else if (dataLocal > dataRemota) {
                    // Local é mais recente → sobrescreve Drive
                    await uploadBackup(dadosLocais);
                    showToast('Backup enviado ao Drive (mais recente).', 'success');
                } else {
                    // Mesma data → nada a fazer
                    console.log('[GDRIVE] Dados já sincronizados');
                }
            } else {
                // Falhou o download → sobrescreve com local
                await uploadBackup(dadosLocais);
            }
        } else {
            // Arquivo não existe → cria
            await uploadBackup(dadosLocais);
            showToast('Primeiro backup criado no Google Drive!', 'success');
        }

        if (statusEl) {
            statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:var(--success)"></i> Sincronizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
        }
        localStorage.setItem('gdrive_last_sync', new Date().toISOString());

    } catch (e) {
        console.error('[GDRIVE] Erro na sincronização:', e);
        if (statusEl) statusEl.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:var(--warning)"></i> Erro na sincronização';
    }
}

async function importarDadosDoDrive(dados) {
    // Importa veículos
    if (dados.vehicles && Array.isArray(dados.vehicles)) {
        salvarVeiculos(dados.vehicles);
        if (typeof dados.activeIdx === 'number') setIdxAtivo(dados.activeIdx);
    } else if (dados.veiculo) {
        // Formato legado
        const v = dados.veiculo;
        const novoVeiculo = {
            id: Date.now().toString(36),
            km: parseInt(v.km) || 0,
            marca: v.marca || "",
            modelo: v.modelo || "",
            ano: v.ano || "",
            placa: v.placa || "",
            vin: v.vin || "",
            tanqueCapacidade: v.tanqueCapacidade || "",
            mediaDiaria: v.mediaDiaria || "40",
            motor: v.motor || ""
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

    // Importa manutenções
    if (dados.registrosManutencao) {
        registrosManutencao = dados.registrosManutencao;
        salvarRegistrosManutencao();
    }

    // Importa necessidades
    if (dados.planoAquisicao || dados.checklistPecas) {
        listaNecessidades = dados.planoAquisicao || dados.checklistPecas || [];
        localStorage.setItem("car_lista_necessidades", JSON.stringify(listaNecessidades));
    }

    // Importa abastecimentos
    if (dados.abastecimentos) {
        abastecimentos = dados.abastecimentos;
        salvarAbastecimentos();
    }

    sincronizarLegado();
    renderizarDadosGlobais();
    renderizarSaudeVeiculo();
    renderizarHistoricoManutencao();
    renderizarPlanoNecessidades();
}

// ==========================================
// AUTO-SYNC
// ==========================================

function iniciarAutoSync() {
    pararAutoSync();
    gdriveSyncInterval = setInterval(sincronizarComDrive, GDRIVE_CONFIG.SYNC_INTERVAL_MS);
    console.log('[GDRIVE] Auto-sync iniciado (intervalo:', GDRIVE_CONFIG.SYNC_INTERVAL_MS / 1000, 's)');
}

function pararAutoSync() {
    if (gdriveSyncInterval) {
        clearInterval(gdriveSyncInterval);
        gdriveSyncInterval = null;
    }
}

// ==========================================
// UI — BOTÃO E STATUS NO PERFIL
// ==========================================

function atualizarUIDrive(requiresReconnect = false) {
    const btn = document.getElementById('btn-gdrive');
    const btnSync = document.getElementById('btn-gdrive-sync');
    const status = document.getElementById('gdrive-status');
    if (!btn || !status) return;

    if (gdriveConnected) {
        btn.innerHTML = '<i class="fas fa-cloud"></i> Desconectar Google Drive';
        btn.style.borderColor = 'rgba(34,197,94,0.3)';
        btn.style.color = 'var(--success)';
        if (btnSync) { btnSync.style.opacity = '1'; btnSync.style.pointerEvents = 'auto'; }
        const lastSync = localStorage.getItem('gdrive_last_sync');
        status.innerHTML = lastSync
            ? `<i class="fas fa-check-circle" style="color:var(--success)"></i> Conectado — Última sync: ${new Date(lastSync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
            : '<i class="fas fa-check-circle" style="color:var(--success)"></i> Conectado';
        status.style.color = 'var(--success)';
    } else if (requiresReconnect) {
        btn.innerHTML = '<i class="fas fa-cloud"></i> Reconectar Google Drive';
        btn.style.borderColor = 'rgba(234,179,8,0.3)';
        btn.style.color = 'var(--warning)';
        if (btnSync) { btnSync.style.opacity = '0.5'; btnSync.style.pointerEvents = 'none'; }
        status.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:var(--warning)"></i> Sessão expirada — clique para reconectar';
        status.style.color = 'var(--warning)';
    } else {
        btn.innerHTML = '<i class="fas fa-cloud"></i> Conectar Google Drive';
        btn.style.borderColor = 'rgba(255,255,255,0.1)';
        btn.style.color = 'var(--text)';
        if (btnSync) { btnSync.style.opacity = '0.5'; btnSync.style.pointerEvents = 'none'; }
        status.innerHTML = '<i class="fas fa-cloud" style="color:#64748b"></i> Não conectado';
        status.style.color = '#64748b';
    }
}

function mostrarConfigDrive() {
    const novoId = prompt(
        'Cole seu Google Client ID aqui:\n\n' +
        '1. Acesse https://console.cloud.google.com\n' +
        '2. Crie um projeto (ou selecione um existente)\n' +
        '3. Ative a "Google Drive API"\n' +
        '4. Vá em "Credenciais" → "ID do cliente OAuth 2.0"\n' +
        '5. Tipo: "Aplicativo da Web"\n' +
        '6. Origens autorizadas: https://originalrj.github.io\n' +
        '7. Copie o Client ID e cole aqui:\n',
        GDRIVE_CONFIG.CLIENT_ID
    );
    if (novoId && novoId !== GDRIVE_CONFIG.CLIENT_ID) {
        GDRIVE_CONFIG.CLIENT_ID = novoId;
        localStorage.setItem('gdrive_client_id', novoId);
        showToast('Client ID salvo! Clique em "Conectar" novamente.', 'success');
    }
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================

// Restaura Client ID salvo
(function() {
    const savedClientId = localStorage.getItem('gdrive_client_id');
    if (savedClientId) GDRIVE_CONFIG.CLIENT_ID = savedClientId;

    const savedFileId = localStorage.getItem('gdrive_file_id');
    if (savedFileId) gdriveFileId = savedFileId;
})();
