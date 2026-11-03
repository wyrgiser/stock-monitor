import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stocksPath = path.join(root, 'dist', 'stocks.json');
const metaPath = path.join(root, 'dist', 'fundamentals-meta.json');
const stocks = JSON.parse(await fs.readFile(stocksPath, 'utf8'));
const aShares = stocks.filter(({ code }) => /\.(SH|SZ)$/.test(code));
const userAgent = 'Mozilla/5.0 (compatible; stock-monitor-fundamentals/1.0)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(Number(value) * 100) / 100;

async function getJson(url, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

async function fetchRoe(code) {
  const [number, market] = code.split('.');
  const url = new URL('https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew');
  url.search = new URLSearchParams({ type: '1', code: `${market}${number}` });
  const json = await getJson(url);
  const rows = Array.isArray(json.data) ? json.data : [];
  const latest = rows.sort((a, b) => String(b.REPORT_DATE).localeCompare(String(a.REPORT_DATE)))[0];
  const value = Number(latest?.ROEJQ);
  return Number.isFinite(value) && value !== 0 ? round(value) : null;
}

async function fetchDividendYield(code) {
  const url = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get');
  url.search = new URLSearchParams({
    reportName: 'RPT_F10_DIVIDEND_CURVE',
    columns: 'DIVIDEND_LFYRATIO,DIVIDEND_RATIO_HYY',
    quoteColumns: '',
    filter: `(SECUCODE="${code}")`,
    pageNumber: '1',
    pageSize: '1',
    sortTypes: '-1',
    sortColumns: 'TRADE_DATE',
    source: 'HSF10',
  });
  const json = await getJson(url);
  const row = json?.result?.data?.[0];
  const value = Number(row?.DIVIDEND_LFYRATIO ?? row?.DIVIDEND_RATIO_HYY);
  return Number.isFinite(value) ? round(value) : null;
}

async function mapWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  });
  await Promise.all(runners);
}

let roeUpdated = 0;
let yieldUpdated = 0;
let failures = 0;

await mapWithConcurrency(aShares, 8, async (stock) => {
  const [roe, dividend] = await Promise.allSettled([
    fetchRoe(stock.code),
    fetchDividendYield(stock.code),
  ]);

  if (roe.status === 'fulfilled' && roe.value !== null) {
    stock.roe = roe.value;
    roeUpdated += 1;
  }
  if (dividend.status === 'fulfilled' && dividend.value !== null) {
    stock.yield = dividend.value;
    yieldUpdated += 1;
  }
  if (roe.status === 'rejected' || dividend.status === 'rejected') failures += 1;
});

if (roeUpdated === 0 && yieldUpdated === 0) {
  throw new Error('No fundamental data was returned; keeping the previous file unchanged.');
}

await fs.writeFile(stocksPath, `${JSON.stringify(stocks, null, 2)}\n`, 'utf8');
await fs.writeFile(metaPath, `${JSON.stringify({
  updatedAt: new Date().toISOString(),
  source: 'Eastmoney public financial data',
  scope: 'A shares',
  totalAShares: aShares.length,
  roeUpdated,
  yieldUpdated,
  failures,
}, null, 2)}\n`, 'utf8');

console.log(`Updated ROE ${roeUpdated}/${aShares.length}; dividend yield ${yieldUpdated}/${aShares.length}; partial failures ${failures}.`);
