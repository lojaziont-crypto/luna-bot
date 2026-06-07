require('dotenv').config()
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const fs = require('fs')
const path = require('path')

const BASE_URL = 'https://seller.shopee.com.br'
const CHAT_URL = `${BASE_URL}/new-webchat/conversations`
const PRODUTOS_LIST_URL = `${BASE_URL}/portal/product/list/all`
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
        // Abordagem 1: fetch direto com parâmetros de período mensal (não depende de UI)
        const resultMes = await page.evaluate(async function() {
            var tentativas = [
                'period=month',
                'date_range_type=1',
                'period=3',
                'date_type=2',
                'time_type=2',
                'data_interval=month',
                'period_type=2',
                'time_granularity=2',
                'period=2',
                'time_period=month',
            ]
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
            console.log('💰 [Zyon] fatMes fetch direto (' + resultMes.param + ') = ' + resultMes.sales + ' → ' + fatMes)
        } else {
            // Abordagem 2: clicar no filtro de período mensal na página
            console.log('🖱️  [Zyon] Fetch direto sem resultado — tentando clicar no filtro "Por Mês"...')
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
                                el.click()
                                return textos[t]
                            }
                        }
                    }
                }
                return null
            })

            if (filtroClicado) {
                console.log('🖱️  [Zyon] Clicado: "' + filtroClicado + '" — aguardando API mensal...')
                await new Promise(r => setTimeout(r, 5000))
                var novasRespostas = respostasApi.slice(preClickCount)
                for (var i = 0; i < novasRespostas.length; i++) {
                    var r = novasRespostas[i]
                    if (r.url.includes('/traffic-source') && !r.url.includes('/product-contribution')) {
                        var salesVal = r.json && r.json.result && r.json.result.overview && r.json.result.overview.total_sales
                        if (typeof salesVal === 'number') {
                            fatMes = formatarBRL(salesVal)
                            console.log('💰 [Zyon] fatMes via clique = ' + salesVal + ' → ' + fatMes + ' | URL: ' + r.fullPath)
                            break
                        }
                    }
                }
                if (!fatMes) console.log('⚠️  [Zyon] Clique feito mas API não retornou total_sales mensal')
            } else {
                console.log('⚠️  [Zyon] Filtro "Por Mês" não encontrado na página')
            }
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

// ───────────────────────────── Chat de clientes ─────────────────────────────

// Abre a aba de Chat do Seller Center e aguarda a lista de conversas carregar de fato
// (a SPA do new-webchat continua buscando dados após o "networkidle" do goto)
async function abrirChat(page) {
    await page.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 5000))

    if (page.url().includes('/account/login')) {
        throw new Error('Sessão Shopee expirada. Execute: node shopee-login.js')
    }

    const seletorLista = '[class*="conversation"], [class*="chat-list"], [class*="session-list"], [class*="webchat"]'
    try {
        await page.waitForSelector(seletorLista, { timeout: 25000 })
        await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20000 })
    } catch (_) {
        console.log('⚠️  [Zyon/chat] Lista de conversas não apareceu dentro do tempo esperado — screenshot ainda será salvo para diagnóstico')
    }
    await new Promise(r => setTimeout(r, 3000))

    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_lista.png') })
    console.log(`📸 [Zyon/chat] Screenshot: debug_shopee/chat_lista.png (URL atual: ${page.url()})`)
}

// Procura na lista o próximo item com indicador visual de "não lida" (badge/contador/ponto)
// e clica para abri-lo. Retorna o nome do cliente ou null se não houver pendências.
async function abrirProximaConversaNaoRespondida(page) {
    const cliente = await page.evaluate(() => {
        const itens = document.querySelectorAll(
            '[class*="conversation"], [class*="chat-list"] [class*="item"], [class*="session-item"], [class*="ChatList"] li, aside li, [role="listitem"]'
        )
        for (const item of itens) {
            if (item.offsetParent === null) continue
            const indicador = item.querySelector('[class*="unread"], [class*="badge"], [class*="dot"], [class*="red-dot"], [class*="notif"]')
            if (!indicador) continue
            const texto = (item.innerText || '').replace(/\s+/g, ' ').trim()
            if (!texto) continue
            const nome = texto.split(/\s{2,}|\d{1,2}:\d{2}|·|\|/)[0].trim().substring(0, 60)
            item.click()
            return nome || texto.substring(0, 60)
        }
        return null
    })

    if (cliente) {
        await new Promise(r => setTimeout(r, 4000))
        await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_conversa.png') })
        console.log(`💬 [Zyon/chat] Conversa aberta: ${cliente}`)
    }
    return cliente
}

// Rola para o topo do histórico (carrega mensagens antigas) e extrai toda a conversa visível,
// classificando cada mensagem como 'cliente' ou 'loja' pelo alinhamento/classe do balão.
// Também tenta identificar o produto referenciado (card de anúncio exibido no painel do chat).
async function lerConversaCompleta(page) {
    for (let i = 0; i < 2; i++) {
        await page.evaluate(() => {
            const painel = document.querySelector('[class*="message-list"], [class*="chat-content"], [class*="conversation-content"], [class*="msg-list"]')
            if (painel) painel.scrollTop = 0
        })
        await new Promise(r => setTimeout(r, 2500))
    }

    const dados = await page.evaluate(() => {
        const mensagens = []
        const itens = document.querySelectorAll('[class*="message-item"], [class*="msg-item"], [class*="bubble"], [class*="message-bubble"], [class*="chat-msg"]')
        itens.forEach((el) => {
            const texto = (el.innerText || '').replace(/\s+/g, ' ').trim()
            if (!texto) return
            const ehLoja = !!el.closest('[class*="self"], [class*="sent"], [class*="right"], [class*="seller"], [class*="outgoing"]')
            mensagens.push({ remetente: ehLoja ? 'loja' : 'cliente', texto: texto.substring(0, 1000) })
        })

        let produtoNome = null
        const cardProduto = document.querySelector('[class*="product-card"], [class*="product-item"], [class*="goods-card"], [class*="item-card"], [class*="product-info"]')
        if (cardProduto) {
            produtoNome = (cardProduto.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 200) || null
        }

        return { mensagens, produtoNome }
    })

    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_historico.png') })
    console.log(`📖 [Zyon/chat] Conversa lida: ${dados.mensagens.length} mensagens | Produto: ${dados.produtoNome || '(não identificado)'}`)
    return dados
}

// Digita e envia uma mensagem no campo de texto da conversa atualmente aberta
async function enviarMensagemNoChat(page, texto) {
    const seletorCampo = '[class*="chat"] textarea, [class*="message-input"] [contenteditable="true"], [contenteditable="true"], textarea[class*="input"]'
    await page.waitForSelector(seletorCampo, { timeout: 8000, visible: true })
    await page.click(seletorCampo)
    await page.type(seletorCampo, texto, { delay: 25 })
    await new Promise(r => setTimeout(r, 500))
    await page.keyboard.press('Enter')
    await new Promise(r => setTimeout(r, 2500))
    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_enviado.png') })
    console.log(`📤 [Zyon/chat] Mensagem enviada (${texto.length} chars)`)
}

// Localiza o produto pelo nome na aba de Cadastro de Produtos, abre o menu de "3 pontinhos"
// da linha correspondente e clica em "Visualizar página do produto" (sem editar o anúncio),
// extraindo título, preço e descrição da página pública.
async function extrairInfoProduto(page, nomeProduto) {
    await page.goto(PRODUTOS_LIST_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 6000))

    if (page.url().includes('/account/login')) {
        throw new Error('Sessão Shopee expirada. Execute: node shopee-login.js')
    }

    const termoBusca = (nomeProduto || '').substring(0, 60).trim()
    const campoBusca = await page.$('input[placeholder*="roduto"], input[placeholder*="esquisar"], input[type="search"]')
    if (campoBusca && termoBusca) {
        await campoBusca.click({ clickCount: 3 })
        await campoBusca.type(termoBusca, { delay: 40 })
        await page.keyboard.press('Enter')
        await new Promise(r => setTimeout(r, 4000))
    }
    await page.screenshot({ path: path.join(DEBUG_DIR, 'produto_busca.png') })
    console.log(`📸 [Zyon/produto] Screenshot: debug_shopee/produto_busca.png (busca: "${termoBusca}")`)

    const menuAberto = await page.evaluate(() => {
        const botoes = Array.from(document.querySelectorAll('[class*="more"], [class*="ellipsis"], [class*="dropdown-trigger"], button[class*="action"], [class*="operation"] button'))
        const btn = botoes.find(b => b.offsetParent !== null)
        if (btn) { btn.click(); return true }
        return false
    })
    if (!menuAberto) {
        console.log('⚠️  [Zyon/produto] Menu de "3 pontinhos" não encontrado na lista de produtos')
        return null
    }
    await new Promise(r => setTimeout(r, 1500))

    const novaAbaPromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 7000)
        page.browser().once('targetcreated', async (target) => {
            clearTimeout(timer)
            try { resolve(await target.page()) } catch { resolve(null) }
        })
    })

    const clicado = await page.evaluate(() => {
        const opcoes = Array.from(document.querySelectorAll('li, a, span, div'))
        const alvo = opcoes.find(el =>
            /visualizar p[áa]gina do produto|ver p[áa]gina do produto|view product page/i.test((el.textContent || '').trim())
            && el.offsetParent !== null
        )
        if (alvo) { alvo.click(); return true }
        return false
    })
    if (!clicado) {
        console.log('⚠️  [Zyon/produto] Opção "Visualizar página do produto" não encontrada no menu')
        return null
    }

    let paginaProduto = await novaAbaPromise
    const abriuNovaAba = !!paginaProduto
    if (!paginaProduto) paginaProduto = page
    await new Promise(r => setTimeout(r, 5000))
    await paginaProduto.screenshot({ path: path.join(DEBUG_DIR, 'produto_pagina.png') })
    console.log('📸 [Zyon/produto] Screenshot: debug_shopee/produto_pagina.png')

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

    if (abriuNovaAba) await paginaProduto.close()
    if (!produtoId) console.log(`⚠️  [Zyon/produto] Não foi possível extrair o ID do produto da URL: ${urlProduto}`)

    return {
        produtoId,
        titulo: info.titulo,
        preco: info.preco,
        descricao: info.descricao || info.corpo,
        url: urlProduto,
        atualizadoEm: new Date().toISOString(),
    }
}

module.exports = {
    coletarDadosShopee, verificarNovosPedidos, coletarStatusPedidos, coletarFaturamentoGerencial,
    launchBrowser, resolverChrome,
    abrirChat, abrirProximaConversaNaoRespondida, lerConversaCompleta, enviarMensagemNoChat, extrairInfoProduto,
}
