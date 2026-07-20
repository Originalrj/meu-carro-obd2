# Estado do Projeto — AutoGestao X

> Ultimo commit: `f9ec587` | Branch: `main` | Atualizado: 20/07/2026

## Repositorio

- **Repo**: `https://github.com/Originalrj/meu-carro-obd2`
- **Pages**: `https://originalrj.github.io/meu-carro-obd2/`
- **Clone local (backup)**: `C:\Users\Cadinho\Documents\AutoGestao-OBD2\`
- **Clone para edicao**: `C:\Users\Cadinho\AppData\Local\Temp\opencode\meu-carro-obd2\`
- **Git**: `C:\Program Files\Git\bin\git.exe` | **gh**: `C:\Program Files\GitHub CLI\gh.exe`

### Workflow de deploy
```
clone/pull em temp -> editar -> git add -A -> git commit -> git push origin main
```
Refresh path antes de usar git: `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`

**GitHub e a fonte de verdade.** A pasta local do PC e backup apenas.

---

## Arquitetura

- App 100% client-side (HTML/CSS/JS), sem servidor — roda via `index.html`
- Hospedado no GitHub Pages (branch `main`)
- CDN: Font Awesome, jsPDF 2.5.1, html2canvas 1.4.1
- Scripts: `logger.js` -> `obd2.js` -> `ui.js` -> `drive-sync.js`

### Arquivos principais
| Arquivo | Linhas | Descricao |
|---------|--------|-----------|
| `index.html` | ~463 | Painel 3x3, scanner, diagnostico, perfil, pecas, backup |
| `obd2.js` | ~2010 | 33 PIDs, ELM327 init, BLE/Serial, parseObdResponse, simulacao |
| `ui.js` | ~2870 | Multi-veiculo, VIN decoder, FIPE, saude/alertas, manutencao |
| `style.css` | — | Glassmorphism, dock, scroll, abas |
| `logger.js` | ~115 | AGXLogger: BLE/ELM/sensor/user/error, exportavel como JSON |
| `drive-sync.js` | ~260 | Google Drive OAuth2 + upload/download (deferido) |
| `service-worker.js` | ~43 | Cache-first com network fallback |
| `manifest.json` | — | PWA: AutoGestao X, standalone, theme #00f2ff |
| `veiculos_db.json` | — | 15 veiculos BR com specs completos (compilacao manual) |
| `backup_localstorage.html` | — | Ferramenta local para exportar dados |

---

## Bugs corrigidos nesta sessao (20/07/2026)

### 1. `_obdexCache` TDZ Error (obd2.js)
- **Problema**: `_obdexCache` declarado com `let` na linha 708, mas `loadOBDex()` chamado na linha 56 (antes da declaracao). `let` cria "zona morta temporal".
- **Fix**: Declaracoes movidas para topo do arquivo.

### 2. `parseObdResponse` BLE Format (obd2.js:842)
- **Problema CRITICO**: OBLE envia dados SEM espacos (`410C028C\r\r>`), mas o parser regex esperava COM espacos (`41 0C`). Resultado: NENHUM sensor era exibido no painel Bluetooth.
- **Fix**: Normalizacao automatica:
  - Converte terminador BLE (`\r\r>`) para `\n`
  - Insere espacos entre bytes hex quando linha comeca com `4` (resposta OBD)
- **Validacao**: Log mostra RPM 652, 2848, 3512 — dados reais fluindo

### 3. Service Worker Cache Eterno
- **Problema**: `CACHE_NAME = 'autogestaox-v1'` nunca mudava — Chrome Android cacheava `obd2.js` antigo indefinidamente, ignorando pushes.
- **Fix**: Bump para `autogestaox-v2`. Usuario precisa hard refresh uma vez.

### Bugs anteriores (commits `95b66c4`, `396bdc0`, `bd37070`)
- `badge.borderColor` -> `badge.style.borderColor`
- `drive-sync.js` CSS syntax
- `sincronizarLegado()` em `excluirVeiculoRecente()`
- Badge "AO VIVO" dinamico (Simulado/AO VIVO + tipo conexao)
- `simularDadosOBD()` usa `getKmAtual()`
- Limpeza de dados orfaos ao excluir ultimo veiculo
- BLE command queue limitado a 10
- `confirmarEstimativa()` sem parametro
- PWA (manifest + service-worker)
- 36 linhas `PERFIL-DEBUG` removidas
- Diagnostic logging system (logger.js)
- Google Drive sync UI (drive-sync.js)

---

## Sistema Bluetooth (ELM327)

### Protocolo confirmado
- **ISO 15765-4 CAN** (11bit ID, 500 kbaud) — detectado automaticamente via ATSP0
- ELM327 mini: dispositivo `OBDBLE` (BLE, funciona) vs `OBDII` (Classic SPP, nao funciona)

### Multi-UUID para adaptadores
- `FFF0` — clones genericos
- `18F0` — vLinker
- `FFE0` — HC-05/06 (confirmado funcionando neste setup)

### Formato de dados BLE
- Respostas: `410C028C\r\r>` (SEM espacos, terminador `\r\r>`)
- Serial/USB: `41 0C 02 8C\r\n` (COM espacos, terminador `\r\n`)
- `writeWithoutResponse` e critico para clones BLE baratos

### Init sequence (bem-sucedida)
```
ATD -> ATZ -> ATE0 -> ATL0 -> ATS0 -> ATH0 -> ATAT1 -> ATSP0 -> ATST64
```
- `ATSP0` = auto-detect (pode levar 3-4 tentativas em adaptadores baratos)
- Primeiras respostas podem ser `UNABLE TO CONNECT` (normal)

### PIDs confirmados funcionando
| PID | Dados | Exemplo |
|-----|-------|---------|
| 010C | RPM | 410C028C = 652 RPM |
| 0105 | Temp motor | 410559 = 89C |
| 010F | Temp admissao | 410F42 = 66C |
| 0142 | Tensao | 414235E8 |
| 012F | Combustivel | 412FAB = 67% |
| 010B | MAP | 410B5D = 93 kPa |
| 0104 | Carga motor | 410460 |
| 010D | Velocidade | 410D00 = 0 km/h (parado) |
| 0101 | Status MIL | 410100056100 |

---

## Decisoes de design

### Original de fabrica
- Substituiu "Sem registro" em dashboard e painel de saude
- Itens com 30% ou menos aparecem nos alertas (threshold mudou de 50% para 30%)

### Painel 3+3
- Topo: Temp Motor, Combustivel, Tensao Bateria
- Fundo: Consumo Medio, KM Restantes, Instantaneo

### Tabela de tanque (TANQUE_POR_MODELO)
- Hardcoded para ~50 modelos — preenchimento automatico ao selecionar modelo FIPE
- Gol=55L, Strada=58L, Montana=49L, Onix=48L, Mobi=47L, Pulse=47L, Spin=54L, Kicks=41L, Sportage=62L, Kwid=38L, etc.

### Onboarding nao-bloqueante
- Perfil nao e mais obrigatorio no primeiro acesso
- Toast notification sugere preencher perfil

---

## Diagnostico Detalhado de Sensores (adicionado 20/07/2026)

### Novo painel "Analise Detalhada dos Sensores" (obd2.js:analyzeSensorDiagnostics)
- Coleta historico dos ultimos 60 samples (sensorHistory array)
- Atualizado a cada segundo em modo simulado e real

### Fuel Trim Decision Tree (correlacao multi-sensor)
- **STFT > 5 + MAP > 65 kPa + O2 < 0.3V** → VAZAMENTO DE AR (com spray de partida)
- **STFT > 5 + MAP 30-65 kPa + O2 < 0.3V** → SENSOR MAP DESCALIBRADO (substituir)
- **STFT > 5 + MAP 30-65 kPa + O2 > 0.6V** → SENSOR MAF SUJO (limpar/substituir)
- **STFT > 5 + MAP > 65 kPa + O2 > 0.6V** → ENTRADA DE AR + SENSOR MAF
- **STFT < -5 + O2 > 0.6V** → INJETOR VAZANDO / REGULADOR DE PRESSAO
- **STFT < -5 + O2 < 0.3V** → SENSOR O2 DESCALIBRADO

### MAP Sensor Health Test (Key-On vs Engine-Running)
- **Chave-ON, motor OFF**: MAP deve ler ~101 kPa (atmosferica, sem vacuo)
- **Motor ligado, idle**: MAP deve cair para 25-45 kPa (motor cria vacuo)
- **Se delta < 15 kPa**: SENSOR MAP TRAVADO (substituir)
- **Se delta < 30 kPa**: Vazamento de admissao (verificar mangueiras/coletor)
- **Idle vs carga**: Se MAP nao varia >20 kPa, sensor travado
- Variaveis: `mapKeyOn`, `mapIdleEstabilizado`, `engineStarted`

### MAF Sensor Validation
- Compara MAF real com esperado = (RPM × carga) / 10000 × 8
- Se MAF < 30% abaixo do esperado → sensor sujo
- Se MAF > 30% acima → vazamento apos o sensor

### O2 Sensor Response Test
- Analisa oscilacao dos ultimos 10 samples
- Amplitude < 0.1V → sensor descalibrado/travado
- Media > 0.7V → tendencia rica
- Media < 0.3V → tendencia pobre

### IAT vs Temperatura Ambiente
- Diferenca > 25°C → problema no intercooler/dutos
- Diferenca < -10°C → sensor IAT descalibrado

### PID Support Tracking (adicionado 20/07/2026)
- `pidSupport` object rastreia quais PIDs sao suportados pelo veiculo
- `pidToKey` mapeia comandos ELM para chaves do pidSupport
- `lastPidSent` rastreia ultimo PID enviado para detectar NO DATA
- Quando NO_DATA retornado → `pidSupport[key] = false` → sensor ocultado
- Diagnostico mostra "Nao disponivel" para sensores ausentes (ex: MAF)
- Arvore de decisao fuel trim ajustada: sem MAF → diagnóstico diferente
- **Muitos carros BR flex-fuel NAO tem MAF** — usam speed-density (MAP+RPM+IAT)

---

## APIs e servicos

### Funcionando
- **FIPE v1** (`veiculos.fipe.org.br/api/v1`): Valor/Combustivel/CodigoFipe
- **FIPE v2** (`fipe.parallelum.com.br/api/v2/cars`): Marcas/Anos/Modelos
- **NHTSA vPIC** (`vpic.nhtsa.dot.gov/api`): VIN -> Marca + Ano
- **OBDex DTC** (`foerbsnavi.github.io/obdex/generic.min.json`): Dicionario de codigos de erro

### Nao funciona / Limitacoes
- **API Brasil** (`apibrasil.io`): JWT disponivel mas requer DeviceToken (pago R$49+/mes)
- **BrasilAPI** (`brasilapi.com.br`): Descontinuada — placa 404, FIPE 500
- **Carros na Web** (`carrosnaweb.com.br`): Todas paginas retornam 500 (fora do ar)
- **Nenhum API gratuita de placa->veiculo** existe (testamos todas as opcoes)
- **VIN decoding limitado no BR**: Pos 1-3 WMI + pos 10 ano = marca+ano apenas

### FIPE naming quirk
- Usa nomes de sistema de injecao (ex: "MSFI") nao codigos de motor (ex: "EA111")

---

## Proximos passos

1. **Imediato**: Usuario faz hard refresh (ou limpa dados do site) e testa sensores reais
2. **Proximo**: Isolamento de dados por veiculo (chaves localStorage com prefixo ID)
3. **Deferido**: Google Drive sync (bloqueado por verificacao Google — `Acesso bloqueado`)
4. **Deferido**: Expandir `veiculos_db.json` quando Carros na Web voltar

---

## Notas para debug futuro

- `obd2.js` trava no editor OpenCode — editar sempre via clone temp + git push
- Service worker precisa de bump de versao para forcar atualizacao no mobile
- BLE clones baratos so suportam `writeWithoutResponse`
- `UNABLE TO CONNECT` nos primeiros comandos e normal (auto-detect do protocolo)
- `01A6` (odometro apos limpeza DTC): Alguns carros reseta odometro — app protege salvando/restaurando `car_km`
- `.toFixed()` em PIDs: Varios atributos salvavam string em vez de numero — todos corrigidos
