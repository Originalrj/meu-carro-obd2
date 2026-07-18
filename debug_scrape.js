const axios = require('axios');
const cheerio = require('cheerio');

(async()=>{
  const url='https://www.carrosnaweb.com.br/fichadetalhe.asp?codigo=41049';
  console.log('Fetching CNW...');
  const r=await axios.get(url,{timeout:20000,headers:{
    'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language':'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding':'identity',
    'Referer':'https://www.carrosnaweb.com.br/catalogo.asp'
  }});
  
  let html;
  if(r.data instanceof Buffer) {
    html = new TextDecoder('iso-8859-1').decode(r.data);
  } else {
    html = r.data;
  }
  
  console.log('Status:',r.status,'Length:',html.length);
  console.log('First 500 chars:', html.substring(0,500));
  console.log('\n--- Title ---');
  const $=cheerio.load(html);
  console.log($('title').text());
  
  console.log('\n--- Table rows ---');
  const rows=[];
  $('table tr').each((i,tr)=>{
    const cells=[];
    $(tr).find('td').each((j,td)=>{cells.push($(td).text().trim().replace(/\s+/g,' '));});
    if(cells.length>=2 && cells.some(c=>c.length>0)) rows.push(cells);
  });
  console.log('Non-empty rows:',rows.length);
  rows.forEach((r,i)=>console.log('ROW '+i+':',JSON.stringify(r)));
})();
