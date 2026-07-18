const https = require('https');

function fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const reqOptions = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'AutoGestaoX/1.0',
                'Accept': 'application/json',
                ...options.headers
            }
        };
        const req = https.request(reqOptions, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                console.log(`\n=== ${url} ===`);
                console.log(`Status: ${res.statusCode}`);
                try {
                    const json = JSON.parse(body);
                    console.log('Response:', JSON.stringify(json, null, 2).substring(0, 3000));
                } catch {
                    console.log('Response:', body.substring(0, 500));
                }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function main() {
    const placa = 'NPW3C74';
    const placa2 = 'HJB2D68';

    // Test 1: DETRAN SP API (free, no auth)
    console.log('\n--- DETRAN SP ---');
    try {
        await fetch(`https://www.detran.sp.gov.br/wps/portal/portaldetran/cidadao/veiculos/fichaservico/consultaplaca?placa=${placa}`);
    } catch(e) { console.log('Erro:', e.message); }

    // Test 2: wsdetran API (government)
    console.log('\n--- WSDenatran ---');
    try {
        await fetch(`https://www.wsdetran.mg.gov.br/api/consulta-placa?placa=${placa}`);
    } catch(e) { console.log('Erro:', e.message); }

    // Test 3: FIPE API v1 - try by code (we know this works)
    console.log('\n--- FIPE v1 (known working) ---');
    try {
        await fetch(`https://parallelum.com.br/fipe/api/v1/carros/marcas/59/modelos/8112/anos/2023-1`);
    } catch(e) { console.log('Erro:', e.message); }

    // Test 4: Try another free API - consultaplaca
    console.log('\n--- Open Placa API ---');
    try {
        await fetch(`https://api.consultafipe.com.br/placa/${placa}`);
    } catch(e) { console.log('Erro:', e.message); }

    // Test 5: ViaCEP (just to test if the server works)
    console.log('\n--- ViaCEP (test) ---');
    try {
        await fetch(`https://viacep.com.br/ws/01310100/json/`);
    } catch(e) { console.log('Erro:', e.message); }

    // Test 6: Try the API Brasil with proper auth header format
    console.log('\n--- API Brasil v2 (retry) ---');
    const JWT = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2FwcC5hcGlicmFzaWwuaW8vYXBpL3YyL2F1dGhvLmxvZ2luIiwiaWF0IjoxNzgzNzg1OTAwLCJleHAiOjE4MTUzMjE5MDAsIm5iZiI6MTc4Mzc4NTkwMCwianRpIjoiS0tEZkM5ZFhVa0xNRGlqIiwic3ViIjoiNTYwNzIifQ.QFPn5BQ1uXaWT9zsAqLSwTG60IOKAmR4o0ap_rptizo';
    try {
        const data = JSON.stringify({ placa: placa });
        await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'gateway.apibrasil.io',
                path: '/api/v2/vehicles/dados',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${JWT}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    console.log(`Status: ${res.statusCode}`);
                    try { console.log('Response:', JSON.stringify(JSON.parse(body), null, 2)); } catch { console.log('Body:', body.substring(0, 500)); }
                    resolve();
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    } catch(e) { console.log('Erro:', e.message); }
}

main();
