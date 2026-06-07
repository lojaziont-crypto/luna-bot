require('dotenv').config()
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const fs = require('fs')
const path = require('path')

const BASE_URL = 'https://seller.shopee.com.br'
const PROFILE_DIR = path.join(__dirname, 'shopee_profile')
const DEBUG_DIR = path.join(__dirname, 'debug_shopee')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR)

function launchBrowser(executablePath) {
    return puppeteer.launch({
        headless: 'new',
        executablePath,
        userDataDir: PROFILE_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1366,768',
            '--lang=pt-BR',
        ],
    })
}

function resolverChrome() {
    // 1. Variável de ambiente explícita
    for (const ev of [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH]) {
        if (ev && fs.existsSync(ev)) return ev
    }

    // 2. Chrome embutido no puppeteer — baixado em .cache/puppeteer durante npm install
    try {
        const ep = require('puppeteer').executablePath()
        if (ep && fs.existsSync(ep)) return ep
    } catch {}

    // 3. Caminhos Linux (sistema)
    const linuxPaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/run/current-system/sw/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ]

    // 4. Windows (desenvolvimento local)
    const winPaths = [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : null,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean)

    const found = [...linuxPaths, ...winPaths].find(p => fs.existsSync(p))
    if (!found) throw new Error('Chrome não encontrado. Defina CHROME_PATH nas variáveis de ambiente.')
    return found
}

async function extrairPagina(page, url, nome, waitMs = 8000) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await new Promise(r => setTimeout(r, waitMs))
    await page.evaluate(() => window.scrollTo(0, 400))
    await new Promise(r => setTimeout(r, 2000))

    await page.screenshot({ path: path.join(DEBUG_DIR, `${nome}.png`) })
    console.log(`📸 [Zyon] Screenshot: debug_shopee/${nome}.png`)

    const texto = await page.evaluate(() => {
        document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove())
        return document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 8000)
    })
    console.log(`📄 [Zyon/${nome}] ${texto.length} chars: ${texto.substring(0, 200)}...`)
    return texto
}

async function coletarDadosShopee() {
    const browser = await launchBrowser(resolverChrome())

    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        await page.goto(`${BASE_URL}/portal/sale/overview`, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await new Promise(r => setTimeout(r, 4000))

        if (page.url().includes('/account/login')) {
            throw new Error('Sessão Shopee expirada. Execute novamente: node shopee-login.js')
        }
        console.log('✅ [Zyon] Sessão ativa')

        console.log('📊 [Zyon] Coletando vendas...')
        await page.evaluate(() => window.scrollTo(0, 400))
        await new Promise(r => setTimeout(r, 2000))
        await page.screenshot({ path: path.join(DEBUG_DIR, 'vendas.png') })
        const vendas = await page.evaluate(() => {
            document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove())
            return document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 8000)
        })
        console.log(`📄 [Zyon/vendas] ${vendas.length} chars: ${vendas.substring(0, 200)}...`)

        console.log('📦 [Zyon] Coletando pedidos...')
        const pedidos = await extrairPagina(page, `${BASE_URL}/order/list/all`, 'pedidos')

        console.log('💬 [Zyon] Coletando mensagens...')
        const mensagens = await extrairPagina(page, `${BASE_URL}/chat/`, 'mensagens')

        return { vendas, pedidos, mensagens }
    } finally {
        await browser.close()
    }
}

async function verificarNovosPedidos() {
    const browser = await launchBrowser(resolverChrome())

    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        await page.goto(`${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 15000))
        await page.evaluate(() => window.scrollTo(0, 400))
        await new Promise(r => setTimeout(r, 2000))

        const urlAtual = page.url()
        const bodyText = await page.evaluate(() =>
            document.body.innerText.replace(/\s+/g, ' ').trim()
        )
        console.log(`🌐 [Zyon] URL: ${urlAtual}`)
        console.log(`📋 [Zyon] Body preview: ${bodyText.substring(0, 1000)}`)

        if (urlAtual.includes('/account/login')) {
            throw new Error('Sessão Shopee expirada. Execute: node shopee-login.js')
        }

        // Captura o primeiro "ID do Pedido XXXXXX" — o mais recente da lista ordenada
        const match = bodyText.match(/ID do Pedido\s+([A-Z0-9]{6,20})/i)
        return match ? match[1] : null
    } finally {
        await browser.close()
    }
}

// Formata número como moeda BR — sem assumir centavos vs real
function formatarBRL(valor) {
    return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Busca recursiva em JSON por campos com nomes de receita (revenue, gmv, etc.)
// Detecta contexto "hoje/today" vs "mês/month" pelo caminho completo do campo
function buscarReceitaRecursivo(obj, caminho, profundidade) {
    if (profundidade === undefined) profundidade = 0
    if (caminho === undefined) caminho = ''
    const resultado = { dia: null, mes: null, campos: [] }
    if (!obj || typeof obj !== 'object' || profundidade > 8) return resultado

    const entradas = Array.isArray(obj)
        ? obj.map(function(v, i) { return [String(i), v] })
        : Object.entries(obj)

    for (const par of entradas) {
        const chave = par[0], valor = par[1]
        const path = caminho ? caminho + '.' + chave : chave
        const pl = path.toLowerCase()

        if (typeof valor === 'number' && valor >= 0) {
            const eReceita = /revenue|gmv|income|earning|sales_amount|total_sales|sale_amount|receita|faturamento/.test(pl)
            if (eReceita) {
                const fmt = formatarBRL(valor)
                resultado.campos.push({ campo: path, valor: valor, formatado: fmt })
                const eHoje = /today|_dia|dia_|diario|daily/.test(pl)
                const eMes  = /month|_mes|mes_|mensal|monthly/.test(pl)
                if (eHoje && !resultado.dia) resultado.dia = fmt
                if (eMes  && !resultado.mes) resultado.mes = fmt
            }
        } else if (typeof valor === 'object') {
            const sub = buscarReceitaRecursivo(valor, path, profundidade + 1)
            resultado.campos = resultado.campos.concat(sub.campos)
            if (!resultado.dia && sub.dia) resultado.dia = sub.dia
            if (!resultado.mes && sub.mes) resultado.mes = sub.mes
        }
    }
    return resultado
}

async function coletarStatusPedidos() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        // Intercepta respostas JSON da API Shopee antes de navegar
        // A Shopee usa obfuscação de fonte no DOM — os valores reais estão nas chamadas à API
        const respostasApi = []
        page.on('response', function(response) {
            const url = response.url()
            if (!url.includes('shopee.com')) return
            const ct = response.headers()['content-type'] || ''
            if (!ct.includes('json')) return
            response.text().then(function(text) {
                if (!text || text.length < 10) return
                try {
                    const json = JSON.parse(text)
                    const shortUrl = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
                    respostasApi.push({ url: shortUrl, json: json })
                } catch (_) {}
            }).catch(function() {})
        })

        // 1. Overview — faturamento do dia e do mês
        await page.goto(`${BASE_URL}/portal/`, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 8000))

        const urlOverview = page.url()
        console.log(`🌐 [Zyon/overview] URL real: ${urlOverview}`)

        if (urlOverview.includes('/account/login')) {
            throw new Error('Sessão Shopee expirada. Execute: node shopee-login.js')
        }

        // Aguarda mais 3s para que chamadas de API assíncronas completem
        await new Promise(r => setTimeout(r, 3000))

        await page.screenshot({ path: path.join(DEBUG_DIR, 'overview.png') })
        console.log('📸 [Zyon] Screenshot: debug_shopee/overview.png')
        console.log(`📡 [Zyon] APIs JSON capturadas: ${respostasApi.length}`)
        respostasApi.forEach(function(r) { console.log('  → ' + r.url) })

        // Salva todas as respostas para debug
        try {
            fs.writeFileSync(
                path.join(DEBUG_DIR, 'api_responses.json'),
                JSON.stringify(respostasApi, null, 2).substring(0, 500000)
            )
            console.log('💾 [Zyon] APIs salvas em debug_shopee/api_responses.json')
        } catch (_) {}

        // Procura receita nas respostas de API
        let fatDia = null, fatMes = null
        for (const resp of respostasApi) {
            if (fatDia && fatMes) break
            const urlL = resp.url.toLowerCase()
            const snippet = JSON.stringify(resp.json).substring(0, 1000).toLowerCase()
            const relevante = /revenue|gmv|income|earning|sales|overview|dashboard|performance|finance/.test(urlL + snippet)
            if (!relevante) continue

            const encontrado = buscarReceitaRecursivo(resp.json, '', 0)
            if (encontrado.campos.length) {
                console.log('📡 [Zyon/api] ' + resp.url + ': ' + JSON.stringify(encontrado.campos).substring(0, 300))
            }
            if (!fatDia && encontrado.dia) fatDia = encontrado.dia
            if (!fatMes && encontrado.mes) fatMes = encontrado.mes
        }

        console.log('💰 [Zyon] API — Dia: ' + (fatDia || 'não encontrado') + ', Mês: ' + (fatMes || 'não encontrado'))

        const overviewText = await page.evaluate(function() {
            return document.body.innerText.replace(/\s+/g, ' ').trim()
        })
        console.log('📊 [Zyon/overview] ' + overviewText.substring(0, 500))

        // 2. Pedidos — A Enviar
        await page.goto(
            `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`,
            { waitUntil: 'networkidle2', timeout: 30000 }
        )
        await new Promise(r => setTimeout(r, 15000))

        const orderText = await page.evaluate(function() {
            return document.body.innerText.replace(/\s+/g, ' ').trim()
        })
        console.log('📊 [Zyon/orders] ' + orderText.substring(0, 600))

        return { overviewText: overviewText, orderText: orderText, fatDia: fatDia, fatMes: fatMes }
    } finally {
        await browser.close()
    }
}

module.exports = { coletarDadosShopee, verificarNovosPedidos, coletarStatusPedidos }
