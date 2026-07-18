const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const DELAY_MS = 2500;
const BASE_URL = 'https://www.carrosnaweb.com.br';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
};

// CNW ficha codes found via web search: { chave: codigo }
// chave = "marca_modelo_versao_ano"
const CODES = {
    // Fiat Strada
    'strada_endurance_13_2025': 34229,
    'strada_adventure_18_2013': 1437,
    'strada_14_ce_2006': 719,

    // Fiat Pulse
    'pulse_drive_13_2024': 28266,
    'pulse_drive_13_2025': 34352,
    'pulse_10_turbo_2026': 42306,

    // Fiat Argo
    'argo_drive_10_2025': 33067,

    // Fiat Cronos
    'cronos_13_2022': 18457,
    'cronos_drive_13_2022': 18458,

    // Fiat Mobi
    'mobi_like_10_2025': 33053,

    // VW Gol
    'gol_10_2021': 13814,

    // VW Polo
    'polo_comfortline_10_tsi_2024': 26521,
    'polo_gts_14_tsi_2025': 33617,
    'polo_10_tsi_2026': 44962,

    // VW T-Cross
    'tcross_10_tsi_2023': 21699,
    'tcross_comfortline_10_tsi_2026': 44466,
    'tcross_highline_250_tsi_14_2026': 44468,

    // Chevrolet Onix
    'onix_lt_10_2024': 23723,
    'onix_lt_10_turbo_2024': 23727,
    'onix_sedan_lt_10_turbo_2022': 18023,
    'onix_premier_10_2020': 20063,

    // Fiat Strada (additional)
    'strada_adventure_18_2013_2': 1437,

    // Hyundai HB20
    'hb20_sense_10_2023': 19259,
    'hb20_active_10_2023': 19258,

    // VW Virtus (bonus - good for reference)
    'virtus_comfortline_10_tsi_2026': 41049,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizar(str) {
    return str.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
}

function parseNumber(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^\d.,]/g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
}

function parseText(text) {
    if (!text) return null;
    const cleaned = text.replace(/\s+/g, ' ').replace(/imgValor\d+\.asp/g, '').trim();
    return cleaned || null;
}

function extrairCelulas(html) {
    const $ = cheerio.load(html);
    const rows = [];
    $('table tr').each((i, tr) => {
        const cells = [];
        $(tr).find('td').each((j, td) => {
            let text = $(td).text().trim();
            text = text.replace(/\s+/g, ' ').trim();
            cells.push(text);
        });
        if (cells.length >= 2) rows.push(cells);
    });
    return rows;
}

function buscarValor(rows, label, exactMatch = false) {
    for (const row of rows) {
        const rowJoined = row.join(' ');
        if (rowJoined.includes('Página Principal') || rowJoined.includes('Compartilhe') || rowJoined.includes('Busca detalhada')) continue;
        if (/NCAP|Ranking|Proteção|segurança|SEGURAN|CONFORTO|INFOTENIMENTO/.test(rowJoined)) continue;
        if (row.length < 2 || row.length > 6) continue;
        for (let i = 0; i < row.length - 1; i++) {
            const cellText = row[i].toLowerCase();
            const labelLower = label.toLowerCase();
            const match = exactMatch ? cellText === labelLower : cellText.includes(labelLower);
            if (match) {
                return row[i + 1] || null;
            }
        }
    }
    return null;
}

function extrairSpecs(rows) {
    const specs = {};

    // Motor
    specs.aspiracao = parseText(buscarValor(rows, 'Aspiração'));

    const cilUnit = parseNumber(buscarValor(rows, 'Cilindrada unitária'));
    const cilindros = parseNumber(buscarValor(rows, 'Cilindros'));
    specs.cilindros = cilindros;

    const valvCil = parseNumber(buscarValor(rows, 'Válvulas por cilindro'));
    if (valvCil && cilindros) specs.valvulas = valvCil * cilindros;

    const despRaw = buscarValor(rows, 'Deslocamento');
    if (despRaw && !despRaw.includes('imgValor') && /\d/.test(despRaw)) {
        specs.cilindrada = parseNumber(despRaw);
    } else if (cilUnit && cilindros) {
        specs.cilindrada = cilUnit * cilindros;
    }

    const potRaw = buscarValor(rows, 'Potência');
    if (potRaw) {
        const cvG = potRaw.match(/(\d+[\.,]?\d*)\s*cv\s*\(G\)/i);
        const cvA = potRaw.match(/(\d+[\.,]?\d*)\s*cv\s*\(A\)/i);
        const cv = potRaw.match(/(\d+[\.,]?\d*)\s*cv/i);
        specs.potenciaCv = cvG ? parseNumber(cvG[1]) : cvA ? parseNumber(cvA[1]) : cv ? parseNumber(cv[1]) : null;
        const rpm = potRaw.match(/(\d[\d.]*)\s*rpm/i);
        specs.potenciaRpm = rpm ? parseNumber(rpm[1]) : null;
    }

    const torqRaw = buscarValor(rows, 'Torque');
    if (torqRaw) {
        const tG = torqRaw.match(/(\d+[\.,]?\d*)\s*kgfm\s*\(G\)/i);
        const tA = torqRaw.match(/(\d+[\.,]?\d*)\s*kgfm\s*\(A\)/i);
        const t = torqRaw.match(/(\d+[\.,]?\d*)\s*kgfm/i);
        specs.torqueKgfm = tG ? parseNumber(tG[1]) : tA ? parseNumber(tA[1]) : t ? parseNumber(t[1]) : null;
        const rpm = torqRaw.match(/(\d[\d.]*)\s*rpm/i);
        specs.torqueRpm = rpm ? parseNumber(rpm[1]) : null;
    }

    specs.codigoMotor = parseText(buscarValor(rows, 'Código do motor'));
    specs.injecao = parseText(buscarValor(rows, 'Alimentação'));
    specs.fabricanteMotor = parseText(buscarValor(rows, 'Fabricante'));

    // Transmissão
    const cambRaw = buscarValor(rows, 'Câmbio');
    if (cambRaw) {
        specs.cambio = /manual/i.test(cambRaw) ? 'Manual' :
                       /automátic|automat/i.test(cambRaw) ? 'Automático' :
                       /cvt/i.test(cambRaw) ? 'CVT' : parseText(cambRaw);
        const m = cambRaw.match(/(\d+)\s*marchas/i);
        specs.marchas = m ? parseNumber(m[1]) : null;
    }
    specs.tracao = parseText(buscarValor(rows, 'Tração'));

    // Chassi/Direção/Freios
    specs.direcao = parseText(buscarValor(rows, 'Assistência', true));
    specs.freiosDianteiros = parseText(buscarValor(rows, 'Dianteiros'));
    specs.freiosTraseiros = parseText(buscarValor(rows, 'Traseiros'));

    // Dimensões
    const compRaw = buscarValor(rows, 'Comprimento');
    if (compRaw && !compRaw.includes('imgValor') && /\d/.test(compRaw)) {
        specs.comprimento = parseNumber(compRaw);
    }
    specs.entreEixos = parseNumber(buscarValor(rows, 'Distância entre-eixos'));
    specs.portaMalas = parseNumber(buscarValor(rows, 'Porta-malas'));
    specs.tanque = parseNumber(buscarValor(rows, 'Tanque de combustível'));

    const pesoRaw = buscarValor(rows, 'Peso', true);
    if (pesoRaw && !pesoRaw.includes('imgValor') && /\d/.test(pesoRaw)) {
        specs.peso = parseNumber(pesoRaw);
    }

    // Consumo
    const consUrbRaw = buscarValor(rows, 'Urbano');
    if (consUrbRaw) {
        const g = consUrbRaw.match(/(\d+[\.,]?\d*)\s*km\/l\s*\(G\)/i);
        const a = consUrbRaw.match(/(\d+[\.,]?\d*)\s*km\/l\s*\(A\)/i);
        const p = consUrbRaw.match(/(\d+[\.,]?\d*)\s*km/i);
        specs.consumoUrbano = g ? parseNumber(g[1]) : a ? parseNumber(a[1]) : p ? parseNumber(p[1]) : null;
    }
    const consRodRaw = buscarValor(rows, 'Rodoviário');
    if (consRodRaw) {
        const g = consRodRaw.match(/(\d+[\.,]?\d*)\s*km\/l\s*\(G\)/i);
        const a = consRodRaw.match(/(\d+[\.,]?\d*)\s*km\/l\s*\(A\)/i);
        const p = consRodRaw.match(/(\d+[\.,]?\d*)\s*km/i);
        specs.consumoRodoviario = g ? parseNumber(g[1]) : a ? parseNumber(a[1]) : p ? parseNumber(p[1]) : null;
    }
    const consMixRaw = buscarValor(rows, 'Misto');
    if (consMixRaw) {
        const g = consMixRaw.match(/(\d+[\.,]?\d*)\s*km\/l\s*\(G\)/i);
        const a = consMixRaw.match(/(\d+[\.,]?\d*)\s*km\/l\s*\(A\)/i);
        const p = consMixRaw.match(/(\d+[\.,]?\d*)\s*km/i);
        specs.consumoMisto = g ? parseNumber(g[1]) : a ? parseNumber(a[1]) : p ? parseNumber(p[1]) : null;
    }

    specs.configuracao = parseText(buscarValor(rows, 'Configuração'));
    specs.porte = parseText(buscarValor(rows, 'Porte'));

    return specs;
}

async function scrapeFicha(codigo) {
    const url = `${BASE_URL}/fichadetalhe.asp?codigo=${codigo}`;
    try {
        const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, headers: HEADERS });
        const html = new TextDecoder('iso-8859-1').decode(resp.data);
        const rows = extrairCelulas(html);

        // Extract title from page for version name
        const $ = cheerio.load(html);
        const title = $('title').text().trim();

        const specs = extrairSpecs(rows);
        specs._titulo = title;
        return specs;
    } catch (e) {
        console.error(`  ERRO ficha ${codigo}: ${e.message}`);
        return null;
    }
}

async function main() {
    const resultado = {};
    let ok = 0, fail = 0;

    const entries = Object.entries(CODES);
    console.log(`=== Scraper Carros na Web ===`);
    console.log(`Total fichas: ${entries.length}\n`);

    for (const [chave, codigo] of entries) {
        process.stdout.write(`${chave} (codigo ${codigo}): `);

        const specs = await scrapeFicha(codigo);
        if (!specs || (!specs.potenciaCv && !specs.cilindrada && !specs.codigoMotor)) {
            console.log('FALHA');
            fail++;
        } else {
            resultado[chave] = specs;
            console.log(`OK - ${specs.codigoMotor || '?'} ${specs.potenciaCv || '?'}cv ${specs.cambio || '?'} ${specs.tanque || '?'}L`);
            ok++;
        }
        await sleep(DELAY_MS);
    }

    const out = path.join(__dirname, 'veiculos_db.json');
    fs.writeFileSync(out, JSON.stringify(resultado, null, 2), 'utf8');
    console.log(`\n=== CONCLUIDO ===`);
    console.log(`Sucesso: ${ok} | Falhas: ${fail}`);
    console.log(`Salvo: ${out}`);
}

main().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
