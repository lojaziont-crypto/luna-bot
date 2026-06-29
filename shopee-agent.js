require('dotenv').config()
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const fs = require('fs')
const path = require('path')

const BASE_URL = 'https://seller.shopee.com.br'
const PRODUTOS_LIST_URL = `${BASE_URL}/portal/product/list/all`
const ORDERS_TOSHIP_URL = `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`
const ORDERS_ALL_URL = `${BASE_URL}/portal/sale/order`
const ADS_URL = `${BASE_URL}/portal/marketing/pas/index`
const INCOME_URL = `${BASE_URL}/portal/finance/income`
const WALLET_URL = `${BASE_URL}/portal/finance/wallet/shopeepay`
const DATACENTER_URL = `${BASE_URL}/datacenter/overview`
const PROFILE_DIR = path.join(__dirname, 'shopee_profile')
const DEBUG_DIR = path.join(__dirname, 'debug_shopee')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR)

function randomDelay(min = 3000, max = 8000) {
    return new Promise(r => setTimeout(r, Math.floor(min + Math.random() * (max - min))))
}

async function humanMouseMove(page, x, y) {
    const fromX = Math.floor(200 + Math.random() * 600)
    const fromY = Math.floor(100 + Math.random() * 400)
    await page.mouse.move(fromX, fromY, { steps: 4 })
    await new Promise(r => setTimeout(r, 80 + Math.random() * 120))
    await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 8) })
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100))
}

// ──────────────────────── Navegação humana pela sidebar ──────────────────────────────────

async function comportamentoHumano(page) {
    await page.evaluate(() => {
        window.scrollTo({ top: Math.floor(Math.random() * 500), behavior: 'smooth' })
    }).catch(() => {})
    await randomDelay(800, 2000)
    await humanMouseMove(page, 300 + Math.floor(Math.random() * 700), 200 + Math.floor(Math.random() * 400)).catch(() => {})
    await randomDelay(1000, 2500)
}

async function tentarNavegacaoMenu(page, textosPai, textosFilho) {
    const clicouPai = await page.evaluate((textos) => {
        const sidebar = document.querySelector(
            '[class*="sidebar"], [class*="nav-menu"], [class*="left-menu"], [class*="shop-sidebar"], [class*="side-nav"]'
        ) || document.body
        const allItems = Array.from(sidebar.querySelectorAll('a, li, span, div'))

        // Passo 1: match EXATO em todos os textos — evita clicar em "Desempenho de Produtos"
        // quando o alvo é "Desempenho da Conta"
        for (const texto of textos) {
            const item = allItems.find(el => {
                const t = (el.childNodes[0]?.textContent || el.textContent || '').trim()
                return t === texto && el.offsetParent !== null
            })
            if (item) { item.click(); return texto }
        }
        // Passo 2: startsWith como fallback (somente se exato falhou)
        for (const texto of textos) {
            const item = allItems.find(el => {
                const t = (el.childNodes[0]?.textContent || el.textContent || '').trim()
                return t.startsWith(texto) && el.offsetParent !== null
            })
            if (item) { item.click(); return texto }
        }
        return null
    }, textosPai)

    if (!clicouPai) return false
    console.log(`🖱️  [Zyon] Menu clicado: "${clicouPai}"`)
    await randomDelay(900, 1800)

    if (!textosFilho || textosFilho.length === 0) return true

    const clicouFilho = await page.evaluate((textos) => {
        const allItems = Array.from(document.querySelectorAll('a, li, span'))
        // Exact match primeiro, depois startsWith
        for (const texto of textos) {
            const item = allItems.find(el => {
                const t = (el.childNodes[0]?.textContent || el.textContent || '').trim()
                return t === texto && el.offsetParent !== null
            })
            if (item) { item.click(); return texto }
        }
        for (const texto of textos) {
            const item = allItems.find(el => {
                const t = (el.childNodes[0]?.textContent || el.textContent || '').trim()
                return t.startsWith(texto) && el.offsetParent !== null
            })
            if (item) { item.click(); return texto }
        }
        return null
    }, textosFilho)

    if (clicouFilho) console.log(`🖱️  [Zyon] Sub-menu clicado: "${clicouFilho}"`)
    return !!clicouFilho
}

const DESTINOS_MENU = {
    pedidos_aenviar: {
        url: `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`,
        paiTextos: ['Pedidos', 'Meus Pedidos', 'Orders'],
        filhoTextos: ['A Enviar', 'Prepare to Ship'],
    },
    pedidos_todos: {
        url: `${BASE_URL}/portal/sale/order`,
        paiTextos: ['Pedidos', 'Meus Pedidos', 'Orders'],
        filhoTextos: ['Todos', 'Todos os Pedidos', 'All Orders'],
    },
    produtos: {
        url: `${BASE_URL}/portal/product/list/all`,
        paiTextos: ['Produtos', 'Meus Produtos', 'My Products'],
        filhoTextos: ['Todos os Produtos', 'Todos', 'All Products'],
    },
    marketing_ads: {
        url: `${BASE_URL}/portal/marketing/pas/index`,
        paiTextos: ['Marketing'],
        filhoTextos: ['Shopee Ads', 'Ads'],
    },
    financas_renda: {
        url: `${BASE_URL}/portal/finance/income`,
        paiTextos: ['Finanças', 'Finance'],
        filhoTextos: ['Minha Renda', 'Renda', 'My Income'],
    },
    financas_carteira: {
        url: `${BASE_URL}/portal/finance/wallet/shopeepay`,
        paiTextos: ['Finanças', 'Finance'],
        filhoTextos: ['Carteira', 'ShopeePay', 'Wallet'],
    },
    datacenter: {
        url: `${BASE_URL}/datacenter/overview`,
        paiTextos: ['Central de Dados', 'Data Center', 'Dados'],
        filhoTextos: [],
    },
    // Textos do mais específico para o mais genérico — evita clicar em "Desempenho de Produtos"
    saude_conta: {
        url: `${BASE_URL}/portal/performance`,
        paiTextos: ['Desempenho da Conta', 'Account Health', 'Saúde da Conta', 'Desempenho', 'Performance'],
        filhoTextos: [],
    },
}

async function navegarParaDestino(page, destino) {
    const config = DESTINOS_MENU[destino]
    if (!config) throw new Error(`Destino desconhecido: ${destino}`)

    const urlAtual = page.url()

    // Verifica se já está na página certa (incluindo query params relevantes)
    const jaEstaNaPagina = (() => {
        try {
            const alvo = new URL(config.url)
            const atual = new URL(urlAtual)
            if (atual.pathname !== alvo.pathname) return false
            const alvoType = alvo.searchParams.get('type')
            const atualType = atual.searchParams.get('type')
            return alvoType === atualType
        } catch { return false }
    })()

    if (jaEstaNaPagina) {
        await comportamentoHumano(page)
        return
    }

    // Tenta navegar via menu da sidebar
    const emShopee = urlAtual.includes('seller.shopee.com.br') && !urlAtual.includes('/login')
    if (emShopee && config.paiTextos.length > 0) {
        const navegou = await tentarNavegacaoMenu(page, config.paiTextos, config.filhoTextos)
        if (navegou) {
            await randomDelay(5000, 10000)
            await verificarAutenticacaoPendente(page, config.url)
            await comportamentoHumano(page)
            return
        }
        console.log(`⚠️  [Zyon] Sidebar não encontrada para "${destino}" — usando URL direta como fallback`)
    }

    // Fallback: URL direta
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(4000, 8000)
    await verificarAutenticacaoPendente(page, config.url)
    await comportamentoHumano(page)
}

// Abre a sessão partindo sempre do dashboard — simula entrada humana
async function iniciarSessaoShopee(page) {
    console.log('🏠 [Zyon] Abrindo dashboard da Shopee...')
    await page.goto(`${BASE_URL}/portal/sale/overview`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await randomDelay(3000, 6000)
    if (page.url().includes('/login')) throw new Error('Sessão Shopee expirada — execute node shopee-login.js')
    await verificarAutenticacaoPendente(page, `${BASE_URL}/portal/sale/overview`)
    await comportamentoHumano(page)
    console.log('✅ [Zyon] Sessão ativa — no dashboard')
}

// ─────────────────────────────────────────────────────────────────────────────────────────

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function configurarPagina(page) {
    await page.setViewport({ width: 1366, height: 768 })
    await page.setUserAgent(USER_AGENT)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' })
}

function launchBrowser(executablePath) {
    return puppeteer.launch({
        headless: false,
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
    for (const ev of [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH]) {
        if (ev && fs.existsSync(ev)) return ev
    }
    try {
        const ep = require('puppeteer').executablePath()
        if (ep && fs.existsSync(ep)) return ep
    } catch {}

    const linuxPaths = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/run/current-system/sw/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ]
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
        await configurarPagina(page)

        await iniciarSessaoShopee(page)

        console.log('📊 [Zyon] Coletando vendas...')
        await page.evaluate(() => window.scrollTo(0, 400))
        await new Promise(r => setTimeout(r, 2000))
        await page.screenshot({ path: path.join(DEBUG_DIR, 'vendas.png') })
        const vendas = await page.evaluate(() => {
            document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove())
            return document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 8000)
        })

        console.log('📦 [Zyon] Coletando pedidos...')
        const pedidos = await extrairPagina(page, `${BASE_URL}/order/list/all`, 'pedidos')

        return { vendas, pedidos }
    } finally {
        await browser.close()
    }
}

async function verificarNovosPedidos() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

        await page.goto(`${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 15000))
        await verificarAutenticacaoPendente(page, `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`)
        await page.evaluate(() => window.scrollTo(0, 400))
        await randomDelay()

        const urlAtual = page.url()
        const bodyText = await page.evaluate(() =>
            document.body.innerText.replace(/\s+/g, ' ').trim()
        )
        console.log(`🌐 [Zyon] URL: ${urlAtual}`)
        console.log(`📋 [Zyon] Body preview: ${bodyText.substring(0, 1000)}`)

        const match = bodyText.match(/ID do Pedido\s+([A-Z0-9]{6,20})/i)
        return match ? match[1] : null
    } finally {
        await browser.close()
    }
}

function formatarBRL(valor) {
    return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

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

async function coletarFaturamentoGerencial() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

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

        await page.goto(DATACENTER_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await randomDelay()
        await verificarAutenticacaoPendente(page, DATACENTER_URL)

        const urlAtual = page.url()
        console.log(`🌐 [Zyon/gerencial] URL: ${urlAtual}`)

        try {
            await page.waitForSelector('input[type="password"]', { timeout: 6000, visible: true })
            console.log('🔐 [Zyon] Diálogo de senha detectado — inserindo...')
            await page.type('input[type="password"]', process.env.SHOPEE_PASSWORD || '', { delay: 70 + Math.floor(Math.random() * 60) })
            await page.keyboard.press('Enter')
            await randomDelay()
        } catch (_) {
            console.log('🔓 [Zyon] Sem diálogo de senha')
        }

        await randomDelay()
        await page.screenshot({ path: path.join(DEBUG_DIR, 'gerencial.png') })

        let fatDia = null, fatMes = null
        for (const { url, json } of respostasApi) {
            if (url.includes('/mydata/') && url.includes('/key-metric')) {
                const paid = json && json.result && json.result.paid_gmv
                if (paid != null && typeof paid.value === 'number' && !fatDia) {
                    fatDia = formatarBRL(paid.value)
                }
            }
            if (!fatDia && url.includes('/mydata/') && url.includes('/traffic-source')) {
                const sales = json && json.result && json.result.overview && json.result.overview.total_sales
                if (typeof sales === 'number') fatDia = formatarBRL(sales)
            }
        }

        const resultMes = await page.evaluate(async function() {
            var tentativas = ['period=month', 'date_range_type=1', 'period=3', 'date_type=2', 'time_type=2']
            for (var i = 0; i < tentativas.length; i++) {
                try {
                    var resp = await fetch('/api/mydata/v1/dashboard/traffic-sources/?' + tentativas[i], {
                        credentials: 'include',
                        headers: { 'Accept': 'application/json' }
                    })
                    if (!resp.ok) continue
                    var json = await resp.json()
                    if (!json || json.code !== 0 || !json.result || !json.result.overview) continue
                    var sales = json.result.overview.total_sales
                    if (typeof sales === 'number') return { param: tentativas[i], sales: sales }
                } catch (e) {}
            }
            return null
        })

        if (resultMes) {
            fatMes = formatarBRL(resultMes.sales)
        } else {
            const preClickCount = respostasApi.length
            const filtroClicado = await page.evaluate(function() {
                var textos = ['Por Mês', 'Por mês', 'Mês', 'Month']
                var seletores = ['span', 'button', 'li', 'a', 'div']
                for (var t = 0; t < textos.length; t++) {
                    for (var s = 0; s < seletores.length; s++) {
                        var els = document.querySelectorAll(seletores[s])
                        for (var i = 0; i < els.length; i++) {
                            var el = els[i]
                            if (el.textContent.trim() === textos[t] && el.offsetParent !== null) {
                                el.click(); return textos[t]
                            }
                        }
                    }
                }
                return null
            })
            if (filtroClicado) {
                await randomDelay()
                var novasRespostas = respostasApi.slice(preClickCount)
                for (var i = 0; i < novasRespostas.length; i++) {
                    var r = novasRespostas[i]
                    if (r.url.includes('/traffic-source') && !r.url.includes('/product-contribution')) {
                        var salesVal = r.json && r.json.result && r.json.result.overview && r.json.result.overview.total_sales
                        if (typeof salesVal === 'number') {
                            fatMes = formatarBRL(salesVal)
                            break
                        }
                    }
                }
            }
        }

        await page.screenshot({ path: path.join(DEBUG_DIR, 'gerencial_mes.png') })
        console.log('💰 [Zyon] Faturamento — Dia: ' + (fatDia || 'não encontrado') + ', Mês: ' + (fatMes || 'não encontrado'))
        return { fatDia, fatMes }
    } finally {
        await browser.close()
    }
}

async function coletarStatusPedidos() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

        await page.goto(
            `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`,
            { waitUntil: 'networkidle2', timeout: 30000 }
        )
        await new Promise(r => setTimeout(r, 15000))
        await verificarAutenticacaoPendente(page, `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`)

        const orderText = await page.evaluate(function() {
            return document.body.innerText.replace(/\s+/g, ' ').trim()
        })
        console.log('📊 [Zyon/orders] ' + orderText.substring(0, 600))
        return { orderText }
    } finally {
        await browser.close()
    }
}

// ─────────────────────────────────────── Produtos ────────────────────────────────────────

async function primeiroVisivel(handles) {
    for (const handle of handles) {
        const visivel = await handle.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
        }).catch(() => false)
        if (visivel) return handle
        await handle.dispose().catch(() => {})
    }
    return null
}

async function extrairInfoProduto(page, nomeProduto) {
    const paginaLista = await page.browser().newPage()
    try {
        await configurarPagina(paginaLista)
        await paginaLista.goto(PRODUTOS_LIST_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await randomDelay()

        if (paginaLista.url().includes('/account/login')) {
            throw new Error('Sessão Shopee expirada.')
        }

        const termoBusca = (nomeProduto || '').substring(0, 60).trim()
        const camposBusca = await paginaLista.$$('input[placeholder*="roduto"], input[placeholder*="esquisar"], input[type="search"]')
        const campoBusca = await primeiroVisivel(camposBusca)
        if (campoBusca && termoBusca) {
            await campoBusca.click({ clickCount: 3 })
            await randomDelay(500, 1000)
            await campoBusca.type(termoBusca, { delay: 60 + Math.floor(Math.random() * 50) })
            await paginaLista.keyboard.press('Enter')
            await randomDelay()
        }

        const menuAberto = await paginaLista.evaluate(() => {
            const botoes = Array.from(document.querySelectorAll('[class*="more"], [class*="ellipsis"], [class*="dropdown-trigger"], button[class*="action"], [class*="operation"] button'))
            const btn = botoes.find(b => b.offsetParent !== null)
            if (btn) { btn.click(); return true }
            return false
        })
        if (!menuAberto) return null

        await randomDelay(1500, 3000)

        const novaAbaPromise = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 7000)
            page.browser().once('targetcreated', async (target) => {
                clearTimeout(timer)
                try { resolve(await target.page()) } catch { resolve(null) }
            })
        })

        const clicado = await paginaLista.evaluate(() => {
            const opcoes = Array.from(document.querySelectorAll('li, a, span, div'))
            const alvo = opcoes.find(el =>
                /visualizar p[áa]gina do produto|ver p[áa]gina do produto|view product page/i.test((el.textContent || '').trim())
                && el.offsetParent !== null
            )
            if (alvo) { alvo.click(); return true }
            return false
        })
        if (!clicado) return null

        let paginaProduto = await novaAbaPromise
        const abriuNovaAba = !!paginaProduto
        if (!paginaProduto) paginaProduto = paginaLista
        await randomDelay()

        const info = await paginaProduto.evaluate(() => {
            document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove())
            const titulo = document.querySelector('h1, [class*="product-title"], [class*="item-name"], [class*="product-name"]')?.innerText?.trim() || null
            const preco = document.querySelector('[class*="price"]')?.innerText?.replace(/\s+/g, ' ').trim() || null
            const descricao = document.querySelector('[class*="description"], [class*="detail"]')?.innerText?.replace(/\s+/g, ' ').trim().substring(0, 4000) || null
            const corpo = document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 6000)
            return { titulo, preco, descricao, corpo }
        })

        const urlProduto = paginaProduto.url()
        const matchId = urlProduto.match(/i\.\d+\.(\d+)/) || urlProduto.match(/product\/\d+\/(\d+)/)
        const produtoId = matchId ? matchId[1] : null

        if (abriuNovaAba) await paginaProduto.close().catch(() => {})
        return {
            produtoId,
            titulo: info.titulo,
            preco: info.preco,
            descricao: info.descricao || info.corpo,
            url: urlProduto,
            atualizadoEm: new Date().toISOString(),
        }
    } finally {
        await paginaLista.close().catch(() => {})
    }
}

// ────────────────────────────── Pedidos A Enviar (detalhado) ─────────────────────────────

// Adiciona prazo de despacho (5 dias corridos a partir da data de confirmação).
// Classifica cada pedido como 'hoje', 'amanha' ou 'outros'.
function calcularPrazoDespacho(dataConfirmacaoStr) {
    if (!dataConfirmacaoStr) return null
    const match = dataConfirmacaoStr.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/)
    if (!match) return null
    const dia = parseInt(match[1]), mes = parseInt(match[2]) - 1
    const ano = match[3] ? (match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3])) : new Date().getFullYear()
    const confirmacao = new Date(ano, mes, dia)
    const prazo = new Date(confirmacao)
    prazo.setDate(prazo.getDate() + 5)
    return prazo
}

function classificarUrgencia(prazo) {
    if (!prazo) return 'outros'
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
    const amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1)
    const p = new Date(prazo); p.setHours(0, 0, 0, 0)
    if (p <= hoje) return 'hoje'
    if (p.getTime() === amanha.getTime()) return 'amanha'
    return 'outros'
}

async function coletarPedidosAEnviar() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

        await page.goto(ORDERS_TOSHIP_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 15000))
        await verificarAutenticacaoPendente(page, ORDERS_TOSHIP_URL)

        await page.screenshot({ path: path.join(DEBUG_DIR, 'pedidos_aenviar.png') })

        const pedidos = await page.evaluate(() => {
            const resultado = []
            const folhas = Array.from(document.querySelectorAll('body *')).filter(el => el.children.length === 0)
            const marcadores = folhas.filter(el => /ID do Pedido\s+[A-Z0-9]{6,20}/i.test(el.textContent || ''))

            for (const marcador of marcadores) {
                const idMatch = (marcador.textContent || '').match(/ID do Pedido\s+([A-Z0-9]{6,20})/i)
                if (!idMatch) continue
                const orderId = idMatch[1]
                if (resultado.some(p => p.orderId === orderId)) continue

                let produtoNome = null, comprador = null, dataConfirmacao = null
                let container = marcador
                for (let i = 0; i < 12 && container; i++) {
                    if (!produtoNome) {
                        const el = container.querySelector('[class*="item-name"]')
                        const t = (el?.textContent || '').trim()
                        if (t.length > 3) produtoNome = t.substring(0, 200)
                    }
                    if (!comprador) {
                        const el = container.querySelector('[class*="buyer-username"]')
                        const t = (el?.textContent || '').trim()
                        if (t.length > 1 && t.length < 60) comprador = t
                    }
                    if (!dataConfirmacao) {
                        // busca padrão de data "DD/MM/AAAA" ou "DD/MM" num elemento folha dentro do container
                        const candidatos = Array.from(container.querySelectorAll('*')).filter(el => el.children.length === 0)
                        for (const c of candidatos) {
                            const txt = (c.textContent || '').trim()
                            if (/Confirmad|Pago em|Data de confirm/i.test(txt) && /\d{2}\/\d{2}/.test(txt)) {
                                const m = txt.match(/(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/)
                                if (m) { dataConfirmacao = m[1]; break }
                            }
                        }
                    }
                    if (produtoNome && comprador) break
                    container = container.parentElement
                }
                if (!produtoNome) continue
                resultado.push({ orderId, produtoNome, comprador, dataConfirmacao })
            }
            return resultado
        })

        const pedidosComPrazo = pedidos.map(p => {
            const prazo = calcularPrazoDespacho(p.dataConfirmacao)
            return {
                ...p,
                prazoDespacho: prazo ? prazo.toLocaleDateString('pt-BR') : null,
                urgencia: classificarUrgencia(prazo),
            }
        })

        // Ordena por prazo mais antigo primeiro
        pedidosComPrazo.sort((a, b) => {
            const ua = a.urgencia === 'hoje' ? 0 : a.urgencia === 'amanha' ? 1 : 2
            const ub = b.urgencia === 'hoje' ? 0 : b.urgencia === 'amanha' ? 1 : 2
            return ua - ub
        })

        const hoje = pedidosComPrazo.filter(p => p.urgencia === 'hoje')
        const amanha = pedidosComPrazo.filter(p => p.urgencia === 'amanha')
        const outros = pedidosComPrazo.filter(p => p.urgencia === 'outros')

        console.log(`📦 [Zyon] Pedidos A Enviar — HOJE: ${hoje.length}, AMANHÃ: ${amanha.length}, Outros: ${outros.length}`)
        return { hoje, amanha, outros, total: pedidosComPrazo.length }
    } finally {
        await browser.close()
    }
}

// ────────────────────────────────── Anúncios / Boost ─────────────────────────────────────

async function impulsionarAnuncios() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

        await page.goto(PRODUTOS_LIST_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 12000))
        await verificarAutenticacaoPendente(page, PRODUTOS_LIST_URL)
        await randomDelay()

        await page.screenshot({ path: path.join(DEBUG_DIR, 'boost_antes.png') })

        // Tenta clicar em todos os botões de boost/impulsionar disponíveis
        const impulsionados = await page.evaluate(() => {
            const textosBotao = ['Impulsionar', 'Boost', 'Impuls', 'Promover']
            const botoes = Array.from(document.querySelectorAll('button, a, span, div'))
            const alvos = botoes.filter(el => {
                if (el.offsetParent === null) return false
                const txt = (el.textContent || '').trim()
                return textosBotao.some(t => txt.startsWith(t)) && txt.length < 20
            })
            const clicados = []
            for (const btn of alvos) {
                try { btn.click(); clicados.push(btn.textContent.trim()) } catch {}
            }
            return clicados
        })

        await randomDelay(3000, 6000)
        await page.screenshot({ path: path.join(DEBUG_DIR, 'boost_depois.png') })

        const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').substring(0, 3000))
        const boostedCount = (bodyText.match(/Impulsionado|Boosted|Em destaque/gi) || []).length

        console.log(`🚀 [Zyon/boost] ${impulsionados.length} botão(ões) clicado(s) | ${boostedCount} produto(s) em destaque detectados`)
        return { clicados: impulsionados.length, emDestaque: boostedCount, timestamp: new Date().toISOString() }
    } finally {
        await browser.close()
    }
}

// ──────────────────────────────────── Shopee Ads ──────────────────────────────────────────

async function verificarSaldoAds() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

        const respostasApi = []
        page.on('response', response => {
            const url = response.url()
            if (!url.includes('shopee.com')) return
            const ct = response.headers()['content-type'] || ''
            if (!ct.includes('json')) return
            response.text().then(text => {
                try { respostasApi.push({ url: url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''), json: JSON.parse(text) }) } catch {}
            }).catch(() => {})
        })

        await page.goto(ADS_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 12000))
        await verificarAutenticacaoPendente(page, ADS_URL)
        await randomDelay()

        try {
            await page.waitForSelector('input[type="password"]', { timeout: 5000, visible: true })
            await page.type('input[type="password"]', process.env.SHOPEE_PASSWORD || '', { delay: 70 })
            await page.keyboard.press('Enter')
            await randomDelay()
        } catch (_) {}

        await randomDelay()
        await page.screenshot({ path: path.join(DEBUG_DIR, 'ads_saldo.png') })

        const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 5000))
        console.log(`📊 [Zyon/ads] Body preview: ${bodyText.substring(0, 400)}`)

        // Tenta extrair saldo de APIs interceptadas
        let saldo = null, gastoDia = null
        for (const { url, json } of respostasApi) {
            if (/ads|credit|wallet|balance/i.test(url)) {
                const v = json?.data?.credit_balance ?? json?.result?.balance ?? json?.balance
                if (typeof v === 'number' && saldo === null) saldo = v / 100  // geralmente em centavos
                const g = json?.data?.today_cost ?? json?.result?.today_spend
                if (typeof g === 'number' && gastoDia === null) gastoDia = g / 100
            }
        }

        // Fallback: extrai do texto da página
        if (saldo === null) {
            const matchSaldo = bodyText.match(/(?:Saldo|Crédit[o]?|Balance)[^\d]*R?\$?\s*([\d.,]+)/i)
            if (matchSaldo) saldo = parseFloat(matchSaldo[1].replace(/\./g, '').replace(',', '.')) || null
        }

        console.log(`💳 [Zyon/ads] Saldo: ${saldo !== null ? `R$ ${saldo.toFixed(2)}` : 'não encontrado'} | Gasto hoje: ${gastoDia !== null ? `R$ ${gastoDia.toFixed(2)}` : 'não encontrado'}`)
        return { saldo, gastoDia, saldoBaixo: saldo !== null && saldo < 5, timestamp: new Date().toISOString() }
    } finally {
        await browser.close()
    }
}

// ────────────────────────────────── Minha Renda ──────────────────────────────────────────

async function coletarRenda() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

        await page.goto(INCOME_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 12000))
        await verificarAutenticacaoPendente(page, INCOME_URL)

        try {
            await page.waitForSelector('input[type="password"]', { timeout: 5000, visible: true })
            await page.type('input[type="password"]', process.env.SHOPEE_PASSWORD || '', { delay: 70 })
            await page.keyboard.press('Enter')
            await randomDelay()
        } catch (_) {}

        await randomDelay()
        await page.screenshot({ path: path.join(DEBUG_DIR, 'renda.png') })

        const bodyText = await page.evaluate(() => {
            document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove())
            return document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 6000)
        })
        console.log(`💰 [Zyon/renda] ${bodyText.substring(0, 400)}`)

        // Extrai valores principais com regex best-effort
        const matchPendente = bodyText.match(/(?:Renda Pendente|Pending Income|A receber)[^\d]*R?\$?\s*([\d.,]+)/i)
        const matchSemana = bodyText.match(/(?:esta semana|this week|7 dias)[^\d]*R?\$?\s*([\d.,]+)/i)
        const matchMes = bodyText.match(/(?:este m[eê]s|this month|30 dias)[^\d]*R?\$?\s*([\d.,]+)/i)
        const matchUltimoPedido = bodyText.match(/ID do Pedido\s+([A-Z0-9]{6,20})/i)
        const matchValorUltimoPedido = bodyText.match(/R?\$?\s*([\d.,]+)/)

        const toFloat = m => m ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) || null : null

        return {
            rendaPendente: toFloat(matchPendente),
            rendaSemana: toFloat(matchSemana),
            rendaMes: toFloat(matchMes),
            ultimoPedidoId: matchUltimoPedido ? matchUltimoPedido[1] : null,
            timestamp: new Date().toISOString(),
        }
    } finally {
        await browser.close()
    }
}

// ──────────────────────────────── Saldo Carteira ─────────────────────────────────────────

async function coletarSaldoCarteira() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

        await page.goto(WALLET_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 12000))
        await verificarAutenticacaoPendente(page, WALLET_URL)

        try {
            await page.waitForSelector('input[type="password"]', { timeout: 5000, visible: true })
            await page.type('input[type="password"]', process.env.SHOPEE_PASSWORD || '', { delay: 70 })
            await page.keyboard.press('Enter')
            await randomDelay()
        } catch (_) {}

        await randomDelay()
        await page.screenshot({ path: path.join(DEBUG_DIR, 'carteira.png') })

        const bodyText = await page.evaluate(() => {
            document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove())
            return document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 4000)
        })

        const matchSaldo = bodyText.match(/(?:Saldo|Balance|ShopeePay)[^\d]*R?\$?\s*([\d.,]+)/i)
        const saldo = matchSaldo ? parseFloat(matchSaldo[1].replace(/\./g, '').replace(',', '.')) || null : null

        const retiradaAtiva = /retirada autom[aá]tica ativada|automatic withdrawal enabled/i.test(bodyText)

        console.log(`💳 [Zyon/carteira] Saldo: ${saldo !== null ? `R$ ${saldo.toFixed(2)}` : 'não encontrado'} | Retirada automática: ${retiradaAtiva ? 'Ativa' : 'Inativa/Desconhecida'}`)
        return { saldo, retiradaAutomatica: retiradaAtiva, timestamp: new Date().toISOString() }
    } finally {
        await browser.close()
    }
}

// ──────────────────────────── Métricas completas (Datacenter) ────────────────────────────

async function coletarMetricasCompletas() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)

        const respostasApi = []
        page.on('response', response => {
            const url = response.url()
            if (!url.includes('shopee.com')) return
            const ct = response.headers()['content-type'] || ''
            if (!ct.includes('json')) return
            response.text().then(text => {
                try {
                    const json = JSON.parse(text)
                    respostasApi.push({ url: url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''), json })
                } catch {}
            }).catch(() => {})
        })

        await page.goto(DATACENTER_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await randomDelay()
        await verificarAutenticacaoPendente(page, DATACENTER_URL)

        try {
            await page.waitForSelector('input[type="password"]', { timeout: 5000, visible: true })
            await page.type('input[type="password"]', process.env.SHOPEE_PASSWORD || '', { delay: 70 })
            await page.keyboard.press('Enter')
            await randomDelay()
        } catch (_) {}

        await randomDelay(5000, 8000)
        await page.screenshot({ path: path.join(DEBUG_DIR, 'metricas.png') })

        const bodyText = await page.evaluate(() => {
            document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove())
            return document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 8000)
        })

        // Extrai dados das APIs interceptadas
        let fatDia = null, fatMes = null, totalPedidosMes = null, taxaConversao = null
        for (const { url, json } of respostasApi) {
            if (url.includes('/mydata/') && url.includes('/key-metric')) {
                const paid = json?.result?.paid_gmv
                if (paid != null && typeof paid.value === 'number') fatDia = paid.value
                const orders = json?.result?.paid_orders
                if (orders != null && typeof orders.value === 'number') totalPedidosMes = orders.value
                const cvr = json?.result?.conversion_rate
                if (cvr != null && typeof cvr.value === 'number') taxaConversao = cvr.value
            }
            if (!fatDia && url.includes('/traffic-source')) {
                const s = json?.result?.overview?.total_sales
                if (typeof s === 'number') fatDia = s
            }
        }

        console.log(`📊 [Zyon/metricas] Dia: ${fatDia || '?'} | Pedidos mês: ${totalPedidosMes || '?'} | Conversão: ${taxaConversao || '?'}%`)

        return {
            fatDia: fatDia !== null ? formatarBRL(fatDia) : null,
            fatMes: fatMes !== null ? formatarBRL(fatMes) : null,
            totalPedidosMes,
            taxaConversao,
            resumoTexto: bodyText.substring(0, 2000),
            timestamp: new Date().toISOString(),
        }
    } finally {
        await browser.close()
    }
}

// ─────────────────────────── Pedidos em aberto (listagem) ────────────────────────────────

async function listarPedidosEmAberto(page) {
    await page.goto(ORDERS_TOSHIP_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 15000))
    await verificarAutenticacaoPendente(page, ORDERS_TOSHIP_URL)

    await page.screenshot({ path: path.join(DEBUG_DIR, 'pedidos_personalizacao.png') })

    const pedidos = await page.evaluate(() => {
        const resultado = []
        const folhas = Array.from(document.querySelectorAll('body *')).filter(el => el.children.length === 0)
        const marcadores = folhas.filter(el => /ID do Pedido\s+[A-Z0-9]{6,20}/i.test(el.textContent || ''))

        for (const marcador of marcadores) {
            const idMatch = (marcador.textContent || '').match(/ID do Pedido\s+([A-Z0-9]{6,20})/i)
            if (!idMatch) continue
            const orderId = idMatch[1]
            if (resultado.some(p => p.orderId === orderId)) continue

            let produtoNome = null, comprador = null
            let container = marcador
            for (let i = 0; i < 10 && container; i++) {
                if (!produtoNome) {
                    const produtoEl = container.querySelector('[class*="item-name"]')
                    const txt = (produtoEl?.textContent || '').trim()
                    if (txt.length > 3) produtoNome = txt.substring(0, 200)
                }
                if (!comprador) {
                    const compradorEl = container.querySelector('[class*="buyer-username"]')
                    const txt = (compradorEl?.textContent || '').trim()
                    if (txt.length > 1 && txt.length < 60) comprador = txt
                }
                if (produtoNome && comprador) break
                container = container.parentElement
            }
            if (!produtoNome) continue
            resultado.push({ orderId, produtoNome, comprador })
        }
        return resultado
    })

    console.log(`📦 [Zyon/arte] ${pedidos.length} pedido(s) lido(s) em "A Enviar — Em aberto"`)
    return pedidos
}

// ──────────────────────────── Autenticação pendente ──────────────────────────────────────

async function verificarAutenticacaoPendente(page, urlRetomar) {
    let avisou = false
    while (true) {
        let pendente = false
        try {
            const url = page.url()
            if (/\/login|\/verify\/|account\/login/.test(url)) {
                pendente = true
            } else {
                pendente = await page.evaluate(() => {
                    const t = document.body?.innerText || ''
                    return /verifique sua identidade|verificar (sua )?identidade|verify (your )?identity/i.test(t)
                }).catch(() => false)
            }
        } catch (_) {}

        if (!pendente) {
            if (avisou) {
                console.log('✅ [Zyon] Sessão verificada — retomando ciclos automáticos.')
                if (urlRetomar) {
                    try { await page.goto(urlRetomar, { waitUntil: 'domcontentloaded', timeout: 20000 }) } catch (_) {}
                }
            }
            return
        }

        if (!avisou) {
            console.log('⏸️  [Zyon] Verificação manual pendente na Shopee — pausando até a sessão ficar estável.')
            avisou = true
        } else {
            console.log('⏸️  [Zyon] Ainda aguardando verificação manual...')
        }
        await new Promise(r => setTimeout(r, 30000))
    }
}

// ──────────────────────────── Verificar status de pedidos ────────────────────────────────

async function verificarStatusPedidos(page, orderIds) {
    await page.goto(ORDERS_ALL_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await randomDelay(7000, 11000)
    await verificarAutenticacaoPendente(page, ORDERS_ALL_URL)

    const SEL_INPUT = [
        'input[placeholder*="ID do pedido"]',
        'input[placeholder*="Inserir ID"]',
        'input[placeholder*="inserir"]',
        'input[placeholder*="pedido"]',
    ].join(', ')

    const resultados = []

    for (let i = 0; i < orderIds.length; i++) {
        const orderId = orderIds[i]
        console.log(`🔍 [Zyon] Verificando pedido ${orderId}... (${i + 1}/${orderIds.length})`)
        let itemResultado = { orderId, enviado: false, status: 'desconhecido', motivo: 'status_nao_lido' }

        try {
            await page.waitForSelector(SEL_INPUT, { visible: true, timeout: 12000 })
            const searchInput = await page.$(SEL_INPUT)
            if (!searchInput) throw new Error('Campo de busca por ID não encontrado')

            const [cx, cy] = await page.evaluate(el => {
                const r = el.getBoundingClientRect()
                return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]
            }, searchInput)
            await humanMouseMove(page, cx, cy)
            await searchInput.click({ clickCount: 3 })
            await randomDelay(300, 600)
            await searchInput.type(orderId, { delay: 80 + Math.floor(Math.random() * 60) })
            await randomDelay(1200, 2000)

            const clicouSugestao = await page.evaluate((id) => {
                const sels = '[class*="dropdown"] [class*="item"], [class*="option-item"], [class*="autocomplete"] li, [class*="suggest"] li'
                for (const el of document.querySelectorAll(sels)) {
                    if ((el.textContent || '').includes(id)) { el.click(); return true }
                }
                return false
            }, orderId)

            if (!clicouSugestao) {
                const clicouAplicar = await page.evaluate(() => {
                    for (const btn of document.querySelectorAll('button')) {
                        if (/\bAplicar\b/i.test(btn.textContent || '') && !btn.disabled) { btn.click(); return true }
                    }
                    return false
                })
                if (!clicouAplicar) await page.keyboard.press('Enter')
            }

            await randomDelay(3000, 5000)

            const dadosPedido = await page.evaluate((id) => {
                const bodyText = document.body.innerText || ''
                if (/\b0\s*[Rr]esult|\b0\s+resultado|\b0 pedido/i.test(bodyText)) return { status: '0 Results', motivo: 'nao_encontrado' }
                const statusConhecidos = ['Enviado', 'A Enviar', 'Não pago', 'Cancelado', 'Devolvido', 'Retornado']
                const folhas = Array.from(document.querySelectorAll('body *')).filter(el => el.children.length === 0)
                const marcador = folhas.find(el => { const t = (el.textContent || '').trim(); return t === id || t.includes(id) })
                if (marcador) {
                    let container = marcador
                    for (let j = 0; j < 15 && container; j++) {
                        const textos = Array.from(container.querySelectorAll('*')).filter(el => el.children.length === 0).map(el => (el.textContent || '').trim())
                        for (const t of textos) {
                            if (statusConhecidos.includes(t)) return { status: t }
                            if (/cancelado|devolvido|retornado/i.test(t)) return { status: t }
                        }
                        container = container.parentElement
                    }
                }
                for (const s of statusConhecidos) { if (bodyText.includes(s)) return { status: s } }
                return { status: 'desconhecido', motivo: 'status_nao_lido' }
            }, orderId)

            const status = dadosPedido.status || 'desconhecido'
            let enviado = false, motivo = dadosPedido.motivo || null, codigoRastreamento = null

            if (status === 'Enviado') {
                enviado = true
                codigoRastreamento = await page.evaluate(() => {
                    const folhas = Array.from(document.querySelectorAll('body *')).filter(el => el.children.length === 0)
                    const el = folhas.find(el => /^[A-Z]{2}\d{8,12}[A-Z]{2}$/.test((el.textContent || '').trim()))
                    return el ? el.textContent.trim() : null
                })
            } else if (status === 'A Enviar') {
                motivo = 'a_enviar'
            } else if (/não pago/i.test(status)) {
                motivo = 'nao_pago'
            } else if (/cancelado|devolvido|retornado/i.test(status)) {
                motivo = 'cancelado'
            } else if (status === '0 Results') {
                motivo = 'nao_encontrado'
            }

            itemResultado = { orderId, enviado, status }
            if (codigoRastreamento) itemResultado.codigoRastreamento = codigoRastreamento
            if (motivo) itemResultado.motivo = motivo

        } catch (err) {
            console.error(`❌ [Zyon] Erro ao verificar pedido ${orderId}: ${err.message}`)
            itemResultado = { orderId, enviado: false, status: 'erro', motivo: 'erro_interno', erro: err.message }
        }

        resultados.push(itemResultado)
        console.log(`   → ${orderId}: ${itemResultado.enviado ? '✅ enviado' : '⏳ pendente'} (${itemResultado.status})`)

        if (i < orderIds.length - 1) {
            try {
                const reiniciou = await page.evaluate(() => {
                    for (const btn of document.querySelectorAll('button')) {
                        if (/\bReiniciar\b/i.test(btn.textContent || '')) { btn.click(); return true }
                    }
                    return false
                })
                await randomDelay(reiniciou ? 2000 : 4000, reiniciou ? 3500 : 6000)
                if (!reiniciou) {
                    await page.reload({ waitUntil: 'networkidle2', timeout: 20000 })
                    await randomDelay(5000, 8000)
                    await verificarAutenticacaoPendente(page, ORDERS_ALL_URL)
                }
            } catch (err) {
                try { await page.reload({ waitUntil: 'networkidle2', timeout: 20000 }); await randomDelay(5000, 8000) } catch {}
            }
            await randomDelay(2000, 4000)
        }
    }

    const totalEnviados = resultados.filter(r => r.enviado).length
    console.log(`✅ [Zyon] Verificação concluída — ${totalEnviados} enviado(s), ${resultados.length - totalEnviados} pendente(s)`)
    return resultados
}

// ──────────────────────────── Saúde da Conta / Desempenho ───────────────────────────────

async function coletarSaudeConta() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await configurarPagina(page)
        await iniciarSessaoShopee(page)

        // Tenta via menu (mais específico primeiro para evitar clicar no item errado)
        const destSaude = DESTINOS_MENU.saude_conta
        const navegouPorMenu = await tentarNavegacaoMenu(page, destSaude.paiTextos, destSaude.filhoTextos)
        if (!navegouPorMenu) {
            console.log('⚠️  [Zyon/saude] Sidebar não encontrou "Desempenho da Conta" — tentando URLs diretas')
            // Tenta URLs conhecidas do Shopee BR para Desempenho/Account Health
            for (const tentativaUrl of [
                `${BASE_URL}/portal/performance`,
                `${BASE_URL}/portal/account/performance`,
                `${BASE_URL}/portal/seller/performance`,
                `${BASE_URL}/portal/business-insights/shop-performance`,
                `${BASE_URL}/portal/service/performance`,
            ]) {
                try {
                    await page.goto(tentativaUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
                    await randomDelay(3000, 6000)
                    const urlAtual = page.url()
                    if (!urlAtual.includes('/login') && !urlAtual.includes('/verify') && !urlAtual.includes('overview')) {
                        console.log(`✅ [Zyon/saude] URL funcionou: ${urlAtual}`)
                        break
                    }
                } catch {}
            }
        } else {
            await randomDelay(4000, 8000)
        }

        await verificarAutenticacaoPendente(page, `${BASE_URL}/portal/performance`)
        await comportamentoHumano(page)
        await page.screenshot({ path: path.join(DEBUG_DIR, 'saude_conta.png') })
        console.log(`🏥 [Zyon/saude] URL: ${page.url()} — screenshot salvo`)

        const bodyText = await page.evaluate(() => {
            document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove())
            return document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 10000)
        })
        console.log(`🏥 [Zyon/saude] Texto extraído (${bodyText.length} chars): ${bodyText.substring(0, 500)}`)

        // Detecta penalidades — palavras em PT e EN
        const temPenalidade = /penalidade|penalty|punição|restricão|restrição|suspensão|sanção|bloqueio|proibido|banido|redução de pedido|bloqueado/i.test(bodyText)
        const temPenalidadeGrave = /80%|grave|grave viola|proibid|banid|encerramento|21 dias|7 dias/i.test(bodyText)

        // Tenta extrair bloco de texto de penalidade
        const penalidadesAtivas = []
        if (temPenalidade) {
            // Extrai a sentença mais relevante sobre a penalidade
            const sentencas = bodyText.split(/[.!?]/)
            const senPenalidade = sentencas.filter(s =>
                /penalidade|penalty|punição|restricão|restrição|suspensão|sanção|bloqueio|proibido|redução de pedido/i.test(s)
            ).slice(0, 5)

            // Tenta extrair datas
            const matchInicio = bodyText.match(/(?:desde|from|iniciou|started|vigente desde|a partir de)[^\d]*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i)
            const matchFim = bodyText.match(/(?:até|until|encerra|ends|válido até|terminará)[^\d]*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i)
            const matchDias = bodyText.match(/(\d+)\s*dias?/i)

            penalidadesAtivas.push({
                tipo: temPenalidadeGrave ? 'grave' : 'moderada',
                descricao: senPenalidade.join('. ').trim().substring(0, 600) || 'Penalidade detectada — veja screenshot saude_conta.png',
                inicio: matchInicio?.[1] || null,
                fimPrevisto: matchFim?.[1] || null,
                duracaoDias: matchDias ? parseInt(matchDias[1]) : null,
            })
        }

        // Extrai métricas numéricas com regex
        const toFloat = (m) => m ? parseFloat(m[1].replace(',', '.')) : null
        const metricas = {
            taxaCancelamento: toFloat(bodyText.match(/(?:cancelamento|cancellation)[^\d]*(\d+(?:[.,]\d+)?)\s*%/i)),
            taxaAtraso: toFloat(bodyText.match(/(?:atraso|atraso no envio|late shipment|envio atrasado)[^\d]*(\d+(?:[.,]\d+)?)\s*%/i)),
            taxaNaoEnvio: toFloat(bodyText.match(/(?:não enviado|non-delivery|não despacho)[^\d]*(\d+(?:[.,]\d+)?)\s*%/i)),
            pontuacao: toFloat(bodyText.match(/(?:pontuação|score|rating)[^\d]*(\d+(?:[.,]\d+)?)/i)),
            avaliacaoMedia: toFloat(bodyText.match(/(?:avaliação média|average rating)[^\d]*(\d+(?:[.,]\d+)?)/i)),
        }

        console.log(`🏥 [Zyon/saude] Penalidade: ${temPenalidade} | Grave: ${temPenalidadeGrave} | Metricas: ${JSON.stringify(metricas)}`)

        return {
            penalidadesAtivas,
            temPenalidade,
            temPenalidadeGrave,
            metricas,
            urlVisitada: page.url(),
            resumoTexto: bodyText.substring(0, 3000),
            timestamp: new Date().toISOString(),
        }
    } finally {
        await browser.close()
    }
}

module.exports = {
    coletarDadosShopee, verificarNovosPedidos, coletarStatusPedidos, coletarFaturamentoGerencial,
    coletarPedidosAEnviar, impulsionarAnuncios, verificarSaldoAds, coletarRenda,
    coletarSaldoCarteira, coletarMetricasCompletas, coletarSaudeConta,
    launchBrowser, resolverChrome, configurarPagina,
    extrairInfoProduto, listarPedidosEmAberto,
    verificarStatusPedidos, ORDERS_TOSHIP_URL, ORDERS_ALL_URL,
    verificarAutenticacaoPendente,
}
