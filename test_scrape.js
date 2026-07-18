const axios = require('axios');

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'X-Requested-With': 'XMLHttpRequest'
};

async function test() {
    // Check if there's an API endpoint
    const urls = [
        'https://www.carrosnaweb.com.br/catalogo.asp?fabricante=Volkswagen&modelo=Gol&ano1=2019&ano2=2019&ajax=1',
        'https://www.carrosnaweb.com.br/catalogoajax.asp?fabricante=Volkswagen&modelo=Gol&ano1=2019&ano2=2019',
        'https://www.carrosnaweb.com.br/api/catalogo?fabricante=Volkswagen&modelo=Gol&ano1=2019&ano2=2019',
    ];
    
    for (const url of urls) {
        try {
            const resp = await axios.get(url, { 
                responseType: 'arraybuffer', 
                timeout: 10000, 
                headers: HEADERS 
            });
            const data = new TextDecoder('iso-8859-1').decode(resp.data);
            console.log(`\n${url}`);
            console.log(`Status: ${resp.status}, Length: ${data.length}`);
            console.log(`Content: ${data.substring(0, 300)}`);
        } catch (e) {
            console.log(`\n${url}`);
            console.log(`Error: ${e.message}`);
        }
    }
    
    // Try the fichadetalhe page directly - this is what we KNOW works
    // Let's search for a known VW Gol code
    // From our earlier test, VW Gol 2019 catalog returned codes
    // Let me try fetching the catalog page with the same URL that webfetch used
    console.log('\n=== Trying catalog with referer ===');
    try {
        const resp = await axios.get('https://www.carrosnaweb.com.br/catalogo.asp?fabricante=Volkswagen&modelo=Gol&ano1=2019&ano2=2019', {
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: {
                ...HEADERS,
                'Referer': 'https://www.carrosnaweb.com.br/catalogo.asp',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Cookie': ''
            }
        });
        const html = new TextDecoder('iso-8859-1').decode(resp.data);
        console.log('Status:', resp.status);
        console.log('Length:', html.length);
        console.log('Has fichadetalhe:', html.includes('fichadetalhe'));
        console.log('Has Gol:', html.includes('Gol'));
        
        // Check for script tags that load data
        const scriptMatches = html.match(/<script[^>]*src="([^"]*)"/gi);
        if (scriptMatches) {
            console.log('\nScript tags:');
            scriptMatches.forEach(s => console.log(' ', s));
        }
        
        // Check for AJAX calls in inline scripts
        const inlineScripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
        if (inlineScripts) {
            console.log('\nInline scripts:');
            inlineScripts.forEach(s => {
                if (s.includes('ajax') || s.includes('fetch') || s.includes('XMLHttpRequest') || s.includes('$.get') || s.includes('$.post')) {
                    console.log('  AJAX script found:', s.substring(0, 200));
                }
            });
        }
    } catch (e) {
        console.log('Error:', e.message);
    }
}

test().catch(console.error);
