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

// Acessa a página de Informações Gerenciais da Shopee, trata o diálogo de senha,
// intercepta as respostas de API e extrai o faturamento do dia e do mês.
// Chamada pelo Zyon a cada 30 min; os valores são enviados à Zaya via POST.
async function coletarFaturamentoGerencial() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        // Intercepta respostas JSON da API antes de navegar
        // fullPath inclui query string para diagnóstico; url é só o path (sem query)
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
                    const fullPath = url.replace(/^https?:\/\/[^/]+/, '')
                    const shortUrl = fullPath.replace(/\?.*$/, '')
                    respostasApi.push({ url: shortUrl, fullPath: fullPath, json: json })
                } catch (_) {}
            }).catch(function() {})
        })

        // Informações Gerenciais (Data Center)
        await page.goto(`${BASE_URL}/datacenter/overview`, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 5000))

        const urlAtual = page.url()
        console.log(`🌐 [Zyon/gerencial] URL: ${urlAtual}`)

        if (urlAtual.includes('/account/login')) {
            throw new Error('Sessão Shopee expirada. Execute: node shopee-login.js')
        }

        // Shopee exige confirmação de senha em páginas financeiras — preenche automaticamente
        try {
            await page.waitForSelector('input[type="password"]', { timeout: 6000, visible: true })
            console.log('🔐 [Zyon] Diálogo de senha detectado — inserindo...')
            await page.type('input[type="password"]', process.env.SHOPEE_PASSWORD || '', { delay: 80 })
            await page.keyboard.press('Enter')
            await new Promise(r => setTimeout(r, 5000))
            console.log('🔐 [Zyon] Senha inserida')
        } catch (_) {
            console.log('🔓 [Zyon] Sem diálogo de senha (ou já autenticado)')
        }

        // Aguarda APIs assíncronas após possível autenticação
        await new Promise(r => setTimeout(r, 5000))

        await page.screenshot({ path: path.join(DEBUG_DIR, 'gerencial.png') })
        console.log('📸 [Zyon] Screenshot inicial: debug_shopee/gerencial.png')
        console.log(`📡 [Zyon/gerencial] APIs iniciais: ${respostasApi.length}`)
        respostasApi.forEach(function(r) { console.log('  → ' + r.url) })

        // ── Extração do faturamento DO DIA ────────────────────────────────────
        // /api/mydata/v3/dashboard/key-metrics/ → result.paid_gmv.value
        let fatDia = null, fatMes = null
        for (const { url, json } of respostasApi) {
            if (url.includes('/mydata/') && url.includes('/key-metric')) {
                const paid = json && json.result && json.result.paid_gmv
                if (paid != null && typeof paid.value === 'number' && !fatDia) {
                    fatDia = formatarBRL(paid.value)
                    console.log('💰 [Zyon] key-metrics paid_gmv.value = ' + paid.value + ' → fatDia = ' + fatDia)
                }
            }
            // fallback: traffic-sources carga inicial (período = dia)
            if (!fatDia && url.includes('/mydata/') && url.includes('/traffic-source')) {
                const sales = json && json.result && json.result.overview && json.result.overview.total_sales
                if (typeof sales === 'number') {
                    fatDia = formatarBRL(sales)
                    console.log('💰 [Zyon] traffic-sources[dia] total_sales = ' + sales + ' → fatDia = ' + fatDia)
                }
            }
        }

        // ── Extração do faturamento DO MÊS ────────────────────────────────────
        // O valor mensal fica em Fontes de Tráfego → Total de Vendas com filtro "Por Mês".
        // A página carrega dados do dia por padrão; é preciso clicar no filtro para obter o mês.
        const preClickCount = respostasApi.length

        const filtroClicado = await page.evaluate(function() {
            var candidatos = ['Por Mês', 'Por mês', 'Mês', 'Month']
            for (var i = 0; i < candidatos.length; i++) {
                var texto = candidatos[i]
                var els = Array.prototype.slice.call(document.querySelectorAll('*'))
                for (var j = 0; j < els.length; j++) {
                    var el = els[j]
                    if (el.children.length > 0) continue
                    if (el.textContent.trim() === texto && el.offsetParent !== null) {
                        el.click()
                        return texto
                    }
                }
            }
            return null
        })

        if (filtroClicado) {
            console.log('🖱️  [Zyon] Filtro "' + filtroClicado + '" clicado — aguardando API mensal...')
            await new Promise(r => setTimeout(r, 5000))

            // Procura a nova chamada a traffic-sources (posterior ao clique)
            var novasRespostas = respostasApi.slice(preClickCount)
            for (var i = 0; i < novasRespostas.length; i++) {
                var r = novasRespostas[i]
                if (r.url.includes('/traffic-source') && !r.url.includes('/product-contribution')) {
                    var sales = r.json && r.json.result && r.json.result.overview && r.json.result.overview.total_sales
                    if (typeof sales === 'number') {
                        fatMes = formatarBRL(sales)
                        console.log('💰 [Zyon] traffic-sources[mês] total_sales = ' + sales + ' → fatMes = ' + fatMes)
                        console.log('🔗 [Zyon] URL completa: ' + r.fullPath)
                        break
                    }
                }
            }
        } else {
            console.log('⚠️  [Zyon] Filtro "Por Mês" não encontrado — verifique debug_shopee/gerencial.png')
        }

        // Salva screenshot e todas as APIs (dia + mês) para debug
        await page.screenshot({ path: path.join(DEBUG_DIR, 'gerencial_mes.png') })
        console.log('📸 [Zyon] Screenshot (após filtro): debug_shopee/gerencial_mes.png')

        try {
            fs.writeFileSync(
                path.join(DEBUG_DIR, 'gerencial_api.json'),
                JSON.stringify(respostasApi, null, 2).substring(0, 500000)
            )
            console.log('💾 [Zyon] Salvo: debug_shopee/gerencial_api.json (' + respostasApi.length + ' APIs)')
        } catch (_) {}

        console.log('💰 [Zyon] Faturamento — Dia: ' + (fatDia || 'não encontrado') + ', Mês: ' + (fatMes || 'não encontrado'))

        return { fatDia: fatDia, fatMes: fatMes }
    } finally {
        await browser.close()
    }
}

// Busca apenas a contagem de pedidos A Enviar — faturamento vem do Zyon via /update-faturamento
async function coletarStatusPedidos() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        await page.goto(
            `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`,
            { waitUntil: 'networkidle2', timeout: 30000 }
        )
        await new Promise(r => setTimeout(r, 15000))

        if (page.url().includes('/account/login')) {
            throw new Error('Sessão Shopee expirada. Execute: node shopee-login.js')
        }

        const orderText = await page.evaluate(function() {
            return document.body.innerText.replace(/\s+/g, ' ').trim()
        })
        console.log('📊 [Zyon/orders] ' + orderText.substring(0, 600))

        return { orderText: orderText }
    } finally {
        await browser.close()
    }
}

module.exports = { coletarDadosShopee, verificarNovosPedidos, coletarStatusPedidos, coletarFaturamentoGerencial }
