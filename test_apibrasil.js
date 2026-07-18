const https = require('https');

const JWT = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJodHRwczovL2FwcC5hcGlicmFzaWwuaW8vYXBpL3YyL2F1dGhvLmxvZ2luIiwiaWF0IjoxNzgzNzg1OTAwLCJleHAiOjE4MTUzMjE5MDAsIm5iZiI6MTc4Mzc4NTkwMCwianRpIjoiS0tEZkM5ZFhVa0xNRGlqIiwic3ViIjoiNTYwNzIifQ.QFPn5BQ1uXaWT9zsAqLSwTG60IOKAmR4o0ap_rptizo';

const testPlate = 'NPW3C74'; // Example plate

function makeRequest(path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const options = {
            hostname: 'gateway.apibrasil.io',
            path: path,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${JWT}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                console.log(`\n=== ${path} ===`);
                console.log(`Status: ${res.statusCode}`);
                console.log(`Headers:`, JSON.stringify(res.headers, null, 2));
                try {
                    const json = JSON.parse(body);
                    console.log('Response:', JSON.stringify(json, null, 2).substring(0, 2000));
                } catch {
                    console.log('Response (raw):', body.substring(0, 1000));
                }
                resolve({ status: res.statusCode, body });
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function main() {
    console.log('Testing API Brasil with Bearer token only (no DeviceToken)...');
    
    // Test 1: Vehicle data
    try {
        await makeRequest('/api/v2/vehicles/dados', { placa: testPlate });
    } catch (e) {
        console.error('Erro dados:', e.message);
    }

    // Test 2: FIPE
    try {
        await makeRequest('/api/v2/vehicles/fipe', { placa: testPlate });
    } catch (e) {
        console.error('Erro fipe:', e.message);
    }

    // Test 3: Try without body
    try {
        await makeRequest('/api/v2/vehicles/dados', {});
    } catch (e) {
        console.error('Erro vazio:', e.message);
    }
}

main();
