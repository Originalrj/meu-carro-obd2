// =============================================
// drive-sync.js — Sincronização com Google Drive
// =============================================

const GDRIVE_CONFIG = {
    CLIENT_ID: localStorage.getItem('gdrive_client_id') || '',
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
// INICIALIZAÇÃO
// ==========================================

function initGoogleDrive() {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.onload = () => console.log('[GDRIVE] Google Identity Services loaded');
    script.onerror = () => console.warn('[GDRIVE] Falha ao carregar Google Identity Services');
    document.head.appendChild(script);
    atualizarUIDrive();
}

// ==========================================
// AUTENTICAÇÃO
// ==========================================

function conectarGoogleDrive() {
    if (gdriveConnected) { desconectarGoogleDrive(); return; }

    if (!GDRIVE_CONFIG.CLIENT_ID) {
        mostrarAssistenteConfig();
        return;
    }

    if (!window.google || !window.google.accounts) {
        showToast('Biblioteca Google ainda carregando. Aguarde...', 'warning');
        return;
    }

    showToast('Abrindo autenticação Google...', 'info');

    const client = google.accounts.oauth2.initTokenClient({
        client_id: GDRIVE_CONFIG.CLIENT_ID,
        scope: GDRIVE_CONFIG.SCOPES,
        callback: (resp) => {
            if (resp.error) {
                showToast('Erro na autenticação: ' + resp.error, 'error');
                return;
            }
            gdriveToken = resp.access_token;
            gdriveConnected = true;
            localStorage.setItem('gdrive_connected', 'true');
            showToast('Google Drive conectado!', 'success');
            atualizarUIDrive();
            iniciarAutoSync();
            sincronizarComDrive();
        },
        error_callback: () => showToast('Erro ao conectar com Google Drive.', 'error')
    });

    client.requestAccessToken();
}

function desconectarGoogleDrive() {
    if (gdriveToken && window.google && window.google.accounts) {
        google.accounts.oauth2.revoke(gdriveToken);
    }
    gdriveToken = null;
    gdriveFileId = null;
    gdriveConnected = false;
    pararAutoSync();
    localStorage.removeItem('gdrive_connected');
    localStorage.removeItem('gdrive_file_id');
    atualizarUIDrive();
    showToast('Google Drive desconectado.', 'info');
}

// ==========================================
// ASSISTENTE DE CONFIGURAÇÃO (5 passos)
// ==========================================

function mostrarAssistenteConfig() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'modal-gdrive-setup';
    modal.innerHTML = `
        <div class="modal-content glass-card" style="max-width:420px; max-height:85vh; overflow-y:auto;">
            <div style="text-align:center; margin-bottom:15px;">
                <i class="fab fa-google-drive" style="font-size:2rem; color:var(--accent);"></i>
                <h4 style="margin:8px 0 0; color:var(--accent);">Configurar Google Drive</h4>
                <p style="font-size:11px; color:#94a3b8; margin:5px 0 0;">Siga os passos abaixo (leva ~3 minutos)</p>
            </div>

            <div style="font-size:12px; color:var(--text); line-height:1.6;">

                <div style="background:rgba(0,242,255,0.06); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
                    <strong style="color:var(--accent);">Passo 1</strong> — Acesse o Google Cloud<br>
                    <a href="https://console.cloud.google.com" target="_blank" style="color:#60a5fa;">console.cloud.google.com</a><br>
                    <small style="color:#94a3b8;">Faça login com sua conta Google</small>
                </div>

                <div style="background:rgba(0,242,255,0.06); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
                    <strong style="color:var(--accent);">Passo 2</strong> — Crie um projeto<br>
                    <small style="color:#94a3b8;">No menu superior, clique em "Selecionar projeto" → "Novo projeto"<br>
                    Nome: <code style="background:rgba(0,0,0,0.3); padding:2px 5px; border-radius:3px;">AutoGestaoX</code> → Clique em "Criar"</small>
                </div>

                <div style="background:rgba(0,242,255,0.06); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
                    <strong style="color:var(--accent);">Passo 3</strong> — Ative a Google Drive API<br>
                    <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" style="color:#60a5fa;">Clique aqui para abrir direto</a><br>
                    <small style="color:#94a3b8;">Clique em "Ativar"</small>
                </div>

                <div style="background:rgba(0,242,255,0.06); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
                    <strong style="color:var(--accent);">Passo 4</strong> — Crie as credenciais<br>
                    <small style="color:#94a3b8;">Vá em "Credenciais" (menu lateral) → "Criar credenciais" → "ID do cliente OAuth 2.0"<br><br>
                    <strong>Tipo:</strong> Aplicativo da Web<br>
                    <strong>Nome:</strong> AutoGestaoX<br>
                    <strong>Origens autorizadas:</strong> adicione:<br>
                    <code style="background:rgba(0,0,0,0.3); padding:2px 5px; border-radius:3px; display:inline-block; margin:3px 0;">https://originalrj.github.io</code><br>
                    Clique em "Criar" e copie o <strong>Client ID</strong></small>
                </div>

                <div style="background:rgba(0,242,255,0.06); border-radius:8px; padding:10px 12px; margin-bottom:12px;">
                    <strong style="color:var(--accent);">Passo 5</strong> — Cole o Client ID aqui<br>
                    <small style="color:#94a3b8;">Cole o Client ID que você copiou no campo abaixo</small><br>
                    <input type="text" id="gdrive-input-clientid" placeholder="Ex: 123456789-abc...apps.googleusercontent.com"
                        style="width:100%; margin-top:6px; padding:8px; border-radius:6px; border:1px solid rgba(255,255,255,0.15);
                        background:var(--glass); color:var(--text); font-size:11px; box-sizing:border-box;">
                </div>

            </div>

            <div style="display:flex; gap:10px;">
                <button class="btn-main" style="flex:1; background:var(--glass); color:var(--text); border:1px solid rgba(255,255,255,0.1);"
                    onclick="fecharAssistenteDrive()">Cancelar</button>
                <button class="btn-main" style="flex:1;" onclick="salvarClientIdEConectar()">
                    <i class="fas fa-check"></i> Salvar e Conectar
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

function fecharAssistenteDrive() {
    const m = document.getElementById('modal-gdrive-setup');
    if (m) m.remove();
}

function salvarClientIdEConectar() {
    const input = document.getElementById('gdrive-input-clientid');
    const clientId = input ? input.value.trim() : '';

    if (!clientId || !clientId.includes('.apps.googleusercontent.com')) {
        showToast('Client ID inválido. Cole o ID completo.', 'error');
        return;
    }

    GDRIVE_CONFIG.CLIENT_ID = clientId;
    localStorage.setItem('gdrive_client_id', clientId);
    fecharAssistenteDrive();
    showToast('Client ID salvo! Conectando...', 'success');

    setTimeout(() => conectarGoogleDrive(), 500);
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
        let resp = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_CONFIG.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
            { headers: { 'Authorization': `Bearer ${gdriveToken}` } }
        );
        let data = await resp.json();
        if (data.files && data.files.length > 0) return data.files[0].id;

        resp = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${gdriveToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: GDRIVE_CONFIG.FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
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
            const resp = await fetch(
                `https://www.googleapis.com/upload/drive/v3/files/${gdriveFileId}?uploadType=media`,
                { method: 'PATCH', headers: { 'Authorization': `Bearer ${gdriveToken}` }, body: blob }
            );
            if (!resp.ok) throw new Error(`Update: ${resp.status}`);
        } else {
            const folderId = await buscarOuCriarPasta();
            const metadata = { name: GDRIVE_CONFIG.FILE_NAME, mimeType: 'application/json' };
            if (folderId) metadata.parents = [folderId];

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', blob);

            const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${gdriveToken}` },
                body: form
            });
            if (!resp.ok) throw new Error(`Create: ${resp.status}`);
            const result = await resp.json();
            gdriveFileId = result.id;
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
        if (!resp.ok) throw new Error(`Download: ${resp.status}`);
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
    const btnSync = document.getElementById('btn-gdrive-sync');
    if (btnSync) { btnSync.innerHTML = '<i class="fas fa-sync fa-spin"></i> Sincronizando...'; btnSync.disabled = true; }

    try {
        const arquivo = await buscarArquivoBackup();
        const dadosLocais = coletarDadosCompletos();

        if (arquivo) {
            gdriveFileId = arquivo.id;
            localStorage.setItem('gdrive_file_id', arquivo.id);

            const dadosRemotos = await downloadBackup();
            if (dadosRemotos) {
                const dataLocal = new Date(dadosLocais.exportadoEm || 0);
                const dataRemota = new Date(dadosRemotos.exportadoEm || 0);

                if (dataRemota > dataLocal) {
                    if (confirm('O Google Drive tem dados mais recentes.\n\n' +
                        `Drive: ${dataRemota.toLocaleString('pt-BR')}\nLocal: ${dataLocal.toLocaleString('pt-BR')}\n\n` +
                        'Deseja importar os dados do Drive?')) {
                        await importarDadosDoDrive(dadosRemotos);
                        showToast('Dados importados do Google Drive!', 'success');
                    } else {
                        await uploadBackup(dadosLocais);
                        showToast('Dados locais enviados ao Drive.', 'info');
                    }
                } else if (dataLocal > dataRemota) {
                    await uploadBackup(dadosLocais);
                    showToast('Backup enviado ao Drive (mais recente).', 'success');
                }
            } else {
                await uploadBackup(dadosLocais);
            }
        } else {
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
    } finally {
        if (btnSync) { btnSync.innerHTML = '<i class="fas fa-sync-alt"></i> Sincronizar Agora'; btnSync.disabled = false; }
    }
}

async function importarDadosDoDrive(dados) {
    if (dados.vehicles && Array.isArray(dados.vehicles)) {
        salvarVeiculos(dados.vehicles);
        if (typeof dados.activeIdx === 'number') setIdxAtivo(dados.activeIdx);
    } else if (dados.veiculo) {
        const v = dados.veiculo;
        const novoVeiculo = {
            id: Date.now().toString(36),
            km: parseInt(v.km) || 0,
            marca: v.marca || "", modelo: v.modelo || "", ano: v.ano || "",
            placa: v.placa || "", vin: v.vin || "",
            tanqueCapacidade: v.tanqueCapacidade || "", mediaDiaria: v.mediaDiaria || "40",
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

    if (dados.registrosManutencao) { registrosManutencao = dados.registrosManutencao; salvarRegistrosManutencao(); }
    if (dados.planoAquisicao || dados.checklistPecas) {
        listaNecessidades = dados.planoAquisicao || dados.checklistPecas || [];
        localStorage.setItem("car_lista_necessidades", JSON.stringify(listaNecessidades));
    }
    if (dados.abastecimentos) { abastecimentos = dados.abastecimentos; salvarAbastecimentos(); }

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
}

function pararAutoSync() {
    if (gdriveSyncInterval) { clearInterval(gdriveSyncInterval); gdriveSyncInterval = null; }
}

// ==========================================
// UI
// ==========================================

function atualizarUIDrive() {
    const btn = document.getElementById('btn-gdrive');
    const btnSync = document.getElementById('btn-gdrive-sync');
    const status = document.getElementById('gdrive-status');
    if (!btn) return;

    const hasClientId = !!GDRIVE_CONFIG.CLIENT_ID;

    if (gdriveConnected) {
        btn.innerHTML = '<i class="fas fa-cloud"></i> Desconectar';
        btn.style.borderColor = 'rgba(34,197,94,0.3)';
        btn.style.color = 'var(--success)';
        if (btnSync) { btnSync.style.opacity = '1'; btnSync.style.pointerEvents = 'auto'; }
        if (status) {
            const lastSync = localStorage.getItem('gdrive_last_sync');
            status.innerHTML = lastSync
                ? `<i class="fas fa-check-circle" style="color:var(--success)"></i> Conectado`
                : '<i class="fas fa-check-circle" style="color:var(--success)"></i> Conectado';
            status.style.color = 'var(--success)';
        }
    } else if (hasClientId) {
        btn.innerHTML = '<i class="fas fa-cloud"></i> Conectar Google Drive';
        btn.style.borderColor = 'rgba(255,255,255,0.1)';
        btn.style.color = 'var(--text)';
        if (btnSync) { btnSync.style.opacity = '0.5'; btnSync.style.pointerEvents = 'none'; }
        if (status) { status.innerHTML = '<i class="fas fa-cloud" style="color:#64748b"></i> Não conectado'; status.style.color = '#64748b'; }
    } else {
        btn.innerHTML = '<i class="fas fa-cog"></i> Configurar Google Drive';
        btn.style.borderColor = 'rgba(234,179,8,0.3)';
        btn.style.color = 'var(--warning)';
        if (btnSync) { btnSync.style.opacity = '0.5'; btnSync.style.pointerEvents = 'none'; }
        if (status) { status.innerHTML = '<i class="fas fa-info-circle" style="color:var(--warning)"></i> Primeira vez? Configure abaixo'; status.style.color = 'var(--warning);'; }
    }
}
