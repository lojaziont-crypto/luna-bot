require('dotenv').config()
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const fs = require('fs')
const path = require('path')

const BASE_URL = 'https://seller.shopee.com.br'
const CHAT_URL = `${BASE_URL}/new-webchat/conversations`
const PRODUTOS_LIST_URL = `${BASE_URL}/portal/product/list/all`
const ORDERS_TOSHIP_URL = `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`
const PROFILE_DIR = 'C:\\Users\\Micro\\AppData\\Local\\Google\\Chrome\\User Data'
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
        await configurarPagina(page)

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
        await configurarPagina(page)

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
        await randomDelay()
        await verificarAutenticacaoPendente(page, `${BASE_URL}/datacenter/overview`)

        const urlAtual = page.url()
        console.log(`🌐 [Zyon/gerencial] URL: ${urlAtual}`)

        // Shopee exige confirmação de senha em páginas financeiras — preenche automaticamente
        try {
            await page.waitForSelector('input[type="password"]', { timeout: 6000, visible: true })
            console.log('🔐 [Zyon] Diálogo de senha detectado — inserindo...')
            await page.type('input[type="password"]', process.env.SHOPEE_PASSWORD || '', { delay: 70 + Math.floor(Math.random() * 60) })
            await page.keyboard.press('Enter')
            await randomDelay()
            console.log('🔐 [Zyon] Senha inserida')
        } catch (_) {
            console.log('🔓 [Zyon] Sem diálogo de senha (ou já autenticado)')
        }

        // Aguarda APIs assíncronas após possível autenticação
        await randomDelay()

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
                await randomDelay()
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

        return { orderText: orderText }
    } finally {
        await browser.close()
    }
}

// ───────────────────────────── Chat de clientes ─────────────────────────────

// Salva uma versão simplificada do HTML (sem scripts/estilos/imagens) em debug_shopee/
// para permitir localizar os seletores exatos da interface do chat
async function salvarHtmlDebug(page, nome) {
    try {
        const html = await page.evaluate(() => {
            const clone = document.body.cloneNode(true)
            clone.querySelectorAll('script, style, svg, noscript, iframe, link, img').forEach(el => el.remove())
            return clone.outerHTML.replace(/\s{2,}/g, ' ')
        })
        fs.writeFileSync(path.join(DEBUG_DIR, `${nome}.html`), html.substring(0, 400000))
        console.log(`💾 [Zyon/chat] HTML salvo p/ inspeção: debug_shopee/${nome}.html (${html.length} chars)`)
    } catch (err) {
        console.error(`❌ [Zyon/chat] Erro ao salvar HTML (${nome}): ${err.message}`)
    }
}

// Abre a aba de Chat do Seller Center e aguarda a lista de conversas carregar de fato
// (a SPA do new-webchat continua buscando dados após o "networkidle" do goto)
async function abrirChat(page) {
    await page.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await randomDelay()
    await verificarAutenticacaoPendente(page, CHAT_URL)

    const seletorLista = '[class*="conversation"], [class*="chat-list"], [class*="session-list"], [class*="webchat"]'
    let listaCarregou = false
    for (let tentativa = 1; tentativa <= 2 && !listaCarregou; tentativa++) {
        try {
            await page.waitForSelector(seletorLista, { timeout: 40000 })
            await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20000 })
            listaCarregou = true
        } catch (_) {
            if (tentativa === 1) {
                // O seletor falha intermitentemente porque a SPA às vezes trava no carregamento
                // inicial — recarregar a página costuma resolver antes de desistir de vez.
                console.log('⚠️  [Zyon/chat] Lista de conversas não apareceu — recarregando a página e tentando novamente')
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 })
                await randomDelay()
                await verificarAutenticacaoPendente(page, CHAT_URL)
            } else {
                console.log('⚠️  [Zyon/chat] Lista de conversas não apareceu dentro do tempo esperado — screenshot ainda será salvo para diagnóstico')
            }
        }
    }
    await randomDelay()

    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_lista.png') })
    console.log(`📸 [Zyon/chat] Screenshot: debug_shopee/chat_lista.png (URL atual: ${page.url()})`)
    await salvarHtmlDebug(page, 'chat_lista')
}

// A lista de conversas é virtualizada (ReactVirtualized) e organizada em seções marcadas
// por linhas separadoras com id="tab_unreplied" ("Sem resposta (N)") e id="tab_manually_replied"
// ("Replied (N)"), irmãs diretas das células de conversa ([data-cy="webchat-conversation-cell-root"]).
// Pega a primeira célula entre essas duas marcações — a Shopee já filtra "sem resposta" para nós.
// `ignorar` lista nomes de conversas já abertas neste ciclo — evita reabrir a mesma
// conversa em loop quando a Shopee não a remove imediatamente da seção "Sem resposta"
// após o envio da resposta (ex: indicador de não lida com atraso para atualizar)
async function abrirProximaConversaNaoRespondida(page, ignorar = []) {
    await humanMouseMove(page, 200 + Math.floor(Math.random() * 150), 250 + Math.floor(Math.random() * 200))
    const resultado = await page.evaluate((ignorar) => {
        const container = document.querySelector('[data-cy="webchat-conversation-list"] .ReactVirtualized__Grid__innerScrollContainer')
        if (!container) return { erro: 'lista de conversas não encontrada (container ReactVirtualized ausente)' }

        const filhos = Array.from(container.children)
        const inicio = filhos.findIndex(el => el.id === 'tab_unreplied')
        if (inicio === -1) return { erro: 'seção "Sem resposta" (#tab_unreplied) não encontrada' }
        let fim = filhos.findIndex((el, i) => i > inicio && el.id === 'tab_manually_replied')
        if (fim === -1) fim = filhos.length

        for (let i = inicio + 1; i < fim; i++) {
            const cell = filhos[i].querySelector('[data-cy="webchat-conversation-cell-root"]')
            if (!cell) continue

            const nomeEl = cell.querySelector('[data-cy="webchat-conversation-cell-name"]')
            const nome = (nomeEl?.getAttribute('title') || nomeEl?.textContent || '').trim()
            if (!nome || ignorar.includes(nome)) continue

            const badgeEl = cell.querySelector('[data-cy="webchat-conversation-cell-message"]')?.nextElementSibling
            const badge = (badgeEl?.textContent || '').trim() || null

            const rect = cell.getBoundingClientRect()
            return { nome, badge, x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2) }
        }
        return { nome: null }
    }, ignorar)

    if (resultado.erro) {
        console.log(`⚠️  [Zyon/chat] ${resultado.erro}`)
        return null
    }
    if (!resultado.nome) return null

    console.log(`💬 [Zyon/chat] Abrindo conversa: ${resultado.nome} (badge: ${resultado.badge || 'sem indicador'})`)

    await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 1200)))
    const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {})
    await page.mouse.move(resultado.x, resultado.y, { steps: 10 + Math.floor(Math.random() * 8) })
    await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 120)))
    await page.mouse.click(resultado.x, resultado.y)
    await navPromise

    const SELETOR_CONTEUDO_CONV = '[data-cy="webchat-message-receive"], [data-cy="webchat-message-send"], [data-cy="webchat-conversation-detail-input"]'
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
        let conteudoCarregou = false
        try {
            await page.waitForSelector(SELETOR_CONTEUDO_CONV, { timeout: 9000 })
            conteudoCarregou = true
        } catch (_) {}

        const paginaErro = !conteudoCarregou && await page.evaluate(() => {
            const texto = (document.body?.innerText || '').toLowerCase()
            return /p[áa]gina indispon[íi]vel|desculpe.*algo deu errado|something went wrong|page not available/.test(texto)
        })

        if (!paginaErro) break

        if (tentativa < 3) {
            console.log(`⚠️  [Zyon/chat] Página de erro ao abrir "${resultado.nome}" (tentativa ${tentativa}/3) — aguardando 15-20s antes de tentar novamente...`)
            await page.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 30000 })
            await randomDelay(15000, 20000)
            const cellPos = await page.evaluate((nomeAlvo) => {
                const cells = document.querySelectorAll('[data-cy="webchat-conversation-cell-root"]')
                for (const cell of cells) {
                    const nomeEl = cell.querySelector('[data-cy="webchat-conversation-cell-name"]')
                    const nome = (nomeEl?.getAttribute('title') || nomeEl?.textContent || '').trim()
                    if (nome === nomeAlvo) {
                        const rect = cell.getBoundingClientRect()
                        return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2) }
                    }
                }
                return null
            }, resultado.nome)
            if (!cellPos) {
                console.log(`⚠️  [Zyon/chat] Conversa "${resultado.nome}" não encontrada na lista após recarregamento — pulando`)
                return null
            }
            const retryNavPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {})
            await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 1200)))
            await page.mouse.move(cellPos.x, cellPos.y, { steps: 10 + Math.floor(Math.random() * 8) })
            await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 120)))
            await page.mouse.click(cellPos.x, cellPos.y)
            await retryNavPromise
        } else {
            console.log(`❌ [Zyon/chat] Conversa "${resultado.nome}" continua com erro após 3 tentativas — pulando`)
            await page.goto(CHAT_URL, { waitUntil: 'networkidle2', timeout: 30000 })
            await randomDelay()
            return null
        }
    }

    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_conversa.png') })
    await salvarHtmlDebug(page, 'chat_conversa')
    return resultado.nome
}

// Percorre a lista virtualizada de mensagens do topo ao fim, coletando e deduplicando
// cada mensagem visível a cada passo. Todo o scroll é feito via page.mouse.wheel() —
// eventos de wheel nativos do Chrome, indistinguíveis de scroll real de usuário — nunca
// via scrollTop direto (sintético), que sistemas anti-bot conseguem detectar.
// Deduplicação pela posição CSS "top" de cada linha (estável entre re-renderizações do
// ReactVirtualized). Extração de produtoId, prazoEnvio e dados do anúncio inalterada.
async function lerConversaCompleta(page) {
    // Localiza o grid e posiciona o mouse sobre ele antes de qualquer interação
    const gridPos = await page.evaluate(() => {
        const grid = document.querySelector('#messageSection .ReactVirtualized__Grid')
        if (!grid) return null
        const rect = grid.getBoundingClientRect()
        return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2) }
    }).catch(() => null)

    if (gridPos) {
        await page.mouse.move(gridPos.x, gridPos.y, { steps: 5 + Math.floor(Math.random() * 4) })
        await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 150)))
    }

    // Rola ao topo com wheel real (2 passagens) para forçar carregamento do histórico antigo.
    // ~40 eventos × ~120px = ~4800px de scroll para cima por passagem.
    for (let i = 0; i < 2; i++) {
        const numScrollsSubida = 35 + Math.floor(Math.random() * 10)
        for (let j = 0; j < numScrollsSubida; j++) {
            await page.mouse.wheel({ deltaY: -(100 + Math.floor(Math.random() * 60)) }).catch(() => {})
            await new Promise(r => setTimeout(r, 18 + Math.floor(Math.random() * 25)))
        }
        await new Promise(r => setTimeout(r, 3000 + Math.floor(Math.random() * 2000)))
    }

    // Aguarda o card do produto (assíncrono — pode aparecer depois do scroll inicial)
    await page.waitForSelector('[data-cy="webchat-station-root"] [title][style*="word-break"]', { timeout: 8000 }).catch(() => {})

    // Coleta mensagens visíveis no DOM e retorna array serializável para o Node.js.
    // A deduplicação é feita no Map do Node (não dentro do evaluate) para poder acumular
    // entre múltiplas chamadas conforme o scroll avança.
    const coletadas = new Map()

    const coletarVisiveis = async () => {
        const msgs = await page.evaluate(() => {
            const resultado = []
            const itens = document.querySelectorAll('[data-cy="webchat-message-receive"], [data-cy="webchat-message-send"]')
            itens.forEach((el) => {
                const remetente = el.getAttribute('data-cy') === 'webchat-message-send' ? 'loja' : 'cliente'
                // O texto vem com o horário colado (ex: "Boa noite21:47") porque o timestamp fica
                // num <div> aninhado dentro do próprio texto — removemos o sufixo "HH:MM" do final.
                let texto = (el.innerText || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .replace(/\s*\d{1,2}:\d{2}\s*$/, '')
                    .trim()

                // Mensagens de imagem/arquivo não têm texto (ou só o nome do arquivo) — sem isso
                // elas seriam descartadas silenciosamente e a IA nunca saberia que algo foi enviado.
                // Marcamos explicitamente para que o prompt possa orientar a não pedir a arte de novo.
                const temAnexo = !!el.querySelector('img, [class*="image" i], [class*="photo" i], [class*="attachment" i], [class*="thumbnail" i], [class*="file-message" i]')
                if (temAnexo) texto = texto ? `${texto} [imagem/arquivo enviado]` : '[imagem/arquivo enviado]'
                if (!texto) return

                const linha = el.closest('[style*="position: absolute"]')
                const topMatch = linha?.getAttribute('style')?.match(/top:\s*([\d.]+)px/)
                const chave = topMatch ? `${topMatch[1]}::${remetente}` : `${remetente}::${texto.substring(0, 80)}`
                resultado.push({ chave, remetente, texto: texto.substring(0, 1000), ordem: topMatch ? parseFloat(topMatch[1]) : resultado.length })
            })
            return resultado
        }).catch(() => [])
        msgs.forEach(m => {
            if (!coletadas.has(m.chave)) coletadas.set(m.chave, { remetente: m.remetente, texto: m.texto, ordem: m.ordem })
        })
    }

    // Coleta inicial no topo, depois percorre para baixo em passos com wheel real
    await coletarVisiveis()

    let passosFeitos = 0
    const MAX_PASSOS = 15

    while (passosFeitos < MAX_PASSOS) {
        const gridAinda = await page.evaluate(() => !!document.querySelector('#messageSection .ReactVirtualized__Grid')).catch(() => false)
        if (!gridAinda) break

        // Simula uma "rolada" humana: 3-6 eventos de wheel pequenos em sequência
        const numWheels = 3 + Math.floor(Math.random() * 4)
        for (let k = 0; k < numWheels; k++) {
            await page.mouse.wheel({ deltaY: 80 + Math.floor(Math.random() * 70) }).catch(() => {})
            await new Promise(r => setTimeout(r, 28 + Math.floor(Math.random() * 45)))
        }
        passosFeitos++

        await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 800)))
        await coletarVisiveis()

        if (passosFeitos % 3 === 0) {
            await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 1000)))
        }

        // Para quando chegar ao fim da lista
        const chegouAoFim = await page.evaluate(() => {
            const grid = document.querySelector('#messageSection .ReactVirtualized__Grid')
            if (!grid) return true
            return grid.scrollTop >= grid.scrollHeight - grid.clientHeight - 50
        }).catch(() => true)
        if (chegouAoFim) break
    }

    const mensagens = Array.from(coletadas.values())
        .sort((a, b) => a.ordem - b.ordem)
        .map(({ remetente, texto }) => ({ remetente, texto }))

    // Extração de metadados do produto e prazo de envio — evaluate separado do scroll
    const metadados = await page.evaluate(() => {
        let produtoId = null
        let produtoNome = null
        let produtoPreco = null
        const stationRoot = document.querySelector('[data-cy="webchat-station-root"]')
        if (stationRoot) {
            const checkbox = stationRoot.querySelector('input[type="checkbox"][value]')
            if (checkbox) produtoId = checkbox.getAttribute('value') || null

            // Seletor primário: nome do produto no card "Interesse do comprador" (texto longo
            // com word-break para não quebrar o layout). Fallback: qualquer [title] dentro do
            // card que pareça um nome de produto (texto longo, não preço/contagem/avaliação).
            let nomeEl = stationRoot.querySelector('[title][style*="word-break"]')
            if (!nomeEl) {
                nomeEl = Array.from(stationRoot.querySelectorAll('[title]')).find((el) => {
                    const t = (el.getAttribute('title') || '').trim()
                    return t.length > 15 && !/^R\$/.test(t) && !/dispon[íi]vel|vendido/i.test(t)
                }) || null
            }
            if (nomeEl) produtoNome = (nomeEl.getAttribute('title') || nomeEl.textContent || '').trim().substring(0, 200) || null

            const precoEl = stationRoot.querySelector('[title^="R$"]')
            if (precoEl) produtoPreco = (precoEl.getAttribute('title') || '').trim() || null
        }

        // Prazo de envio: NÃO fica no cabeçalho do nome do cliente (apesar do que o comentário
        // antigo dizia) — fica no card de resumo do pedido, logo no INÍCIO da área de mensagens
        // ("Você está conversando sobre este pedido" / "Você está falando com o cliente sobre
        // esse pedido"), no formato "Enviar até: DD/MM/AAAA". Por isso buscamos no card inteiro
        // da conversa (sem excluir a área de chat) e exigimos o padrão de data para não pegar
        // só o rótulo "A Enviar" sem a data junto.
        let prazoEnvio = null
        const detalheConversa = document.querySelector('[data-cy="webchat-conversation-detail"]')
        if (detalheConversa) {
            const candidatos = Array.from(detalheConversa.querySelectorAll('div, span'))
            const alvo = candidatos.find((el) => {
                if (el.children.length > 0) return false
                const txt = (el.textContent || '').trim()
                return /enviar\s+at[ée]\s*:?\s*\d{2}\/\d{2}\/\d{4}/i.test(txt) && txt.length < 150
            })
            if (alvo) {
                const dataMatch = alvo.textContent.match(/(\d{2}\/\d{2}\/\d{4})/)
                prazoEnvio = dataMatch ? dataMatch[1] : alvo.textContent.replace(/\s+/g, ' ').trim()
            }
        }

        return { produtoId, produtoNome, produtoPreco, prazoEnvio }
    }).catch(() => ({ produtoId: null, produtoNome: null, produtoPreco: null, prazoEnvio: null }))

    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_historico.png') }).catch(() => {})
    console.log(`📖 [Zyon/chat] Conversa lida: ${mensagens.length} mensagens | Produto: ${metadados.produtoNome || '(não identificado)'}${metadados.produtoId ? ` (#${metadados.produtoId})` : ''} | Prazo de envio: ${metadados.prazoEnvio || '(não encontrado)'}`)
    return { mensagens, ...metadados }
}

// Digita e envia uma mensagem no campo de texto da conversa atualmente aberta.
// O campo real é [data-cy="webchat-conversation-detail-input"] > #inputField > textarea
// (placeholder "Insira uma mensagem aqui", Enter envia / Shift+Enter quebra linha) — confirmado
// no HTML estático. A causa raiz do "campo não encontrado" não era o seletor, e sim a página
// estar na URL errada: extrairInfoProduto navegava a MESMA aba do chat para a lista de produtos
// e, se falhasse no meio do caminho, nunca voltava — então enviarMensagemNoChat procurava o
// campo do chat numa página de cadastro de produtos. Isso foi corrigido fazendo extrairInfoProduto
// rodar numa aba separada (browser.newPage), então a aba do chat nunca sai da conversa aberta.
// Mantemos aqui várias variantes de seletor + checagem de visibilidade real e tentativas
// espaçadas como segurança extra contra timing, e salvamos HTML/screenshot se mesmo assim falhar.
async function localizarCampoMensagem(page, tentativas = 6, intervaloMs = 1500) {
    const candidatos = [
        '[data-cy="webchat-conversation-detail-input"] textarea',
        '#inputField textarea',
        'textarea[placeholder="Insira uma mensagem aqui"]',
        '[data-cy="webchat-conversation-detail-input"] [contenteditable="true"]',
        '#inputField [contenteditable="true"]',
        '[data-cy="webchat-conversation-detail-input"] [contenteditable]',
    ]
    for (let tentativa = 0; tentativa < tentativas; tentativa++) {
        for (const seletor of candidatos) {
            const visivel = await page.evaluate((sel) => {
                const el = document.querySelector(sel)
                if (!el) return false
                const rect = el.getBoundingClientRect()
                return rect.width > 0 && rect.height > 0
            }, seletor)
            if (visivel) return seletor
        }
        await new Promise(r => setTimeout(r, intervaloMs))
    }
    return null
}

async function enviarMensagemNoChat(page, texto) {
    const seletorCampo = await localizarCampoMensagem(page)
    if (!seletorCampo) {
        console.error('❌ [Zyon/chat] Campo de digitação da conversa não encontrado — salvando HTML/screenshot para inspeção')
        await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_campo_nao_encontrado.png') })
        await salvarHtmlDebug(page, 'chat_campo_nao_encontrado')
        throw new Error('campo de digitação da conversa não encontrado')
    }

    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_antes_enviar.png') })
    const caixaTexto = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.top + r.height / 2) }
    }, seletorCampo)
    if (caixaTexto) await humanMouseMove(page, caixaTexto.x, caixaTexto.y)
    await page.click(seletorCampo)
    await randomDelay(1000, 2500)
    await page.type(seletorCampo, texto, { delay: 70 + Math.floor(Math.random() * 60) })
    await randomDelay()
    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_digitado.png') })
    await page.keyboard.press('Enter')
    await randomDelay()
    await page.screenshot({ path: path.join(DEBUG_DIR, 'chat_enviado.png') })
    console.log(`📤 [Zyon/chat] Mensagem enviada via "${seletorCampo}" (${texto.length} chars)`)
}

// Retorna o primeiro elemento de uma lista de ElementHandles que esteja realmente visível
// (bounding box > 0). Evita o erro do Puppeteer "Node is either not clickable or not an
// Element", que ocorre ao chamar .click() num handle escondido/sem layout (offsetParent null).
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

// Localiza o produto pelo nome na aba de Cadastro de Produtos, abre o menu de "3 pontinhos"
// da linha correspondente e clica em "Visualizar página do produto" (sem editar o anúncio),
// extraindo título, preço e descrição da página pública.
//
// Roda numa ABA SEPARADA (browser.newPage), nunca na `page` do chat: assim, mesmo que essa
// extração falhe no meio do caminho (ex: menu "3 pontinhos" não abre), a aba do chat continua
// intacta na conversa aberta e enviarMensagemNoChat não corre o risco de rodar na página errada.
async function extrairInfoProduto(page, nomeProduto) {
    const paginaLista = await page.browser().newPage()
    try {
        await configurarPagina(paginaLista)
        await paginaLista.goto(PRODUTOS_LIST_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await randomDelay()

        if (paginaLista.url().includes('/account/login')) {
            throw new Error('Sessão Shopee expirada. Execute: node shopee-login.js')
        }

        const termoBusca = (nomeProduto || '').substring(0, 60).trim()
        const camposBusca = await paginaLista.$$('input[placeholder*="roduto"], input[placeholder*="esquisar"], input[type="search"]')
        const campoBusca = await primeiroVisivel(camposBusca)
        if (campoBusca && termoBusca) {
            const boxBusca = await campoBusca.boundingBox()
            if (boxBusca) await humanMouseMove(paginaLista, Math.floor(boxBusca.x + boxBusca.width / 2), Math.floor(boxBusca.y + boxBusca.height / 2))
            await campoBusca.click({ clickCount: 3 })
            await randomDelay(500, 1000)
            await campoBusca.type(termoBusca, { delay: 60 + Math.floor(Math.random() * 50) })
            await paginaLista.keyboard.press('Enter')
            await randomDelay()
        }
        await paginaLista.screenshot({ path: path.join(DEBUG_DIR, 'produto_busca.png') })
        console.log(`📸 [Zyon/produto] Screenshot: debug_shopee/produto_busca.png (busca: "${termoBusca}")`)

        const menuAberto = await paginaLista.evaluate(() => {
            const botoes = Array.from(document.querySelectorAll('[class*="more"], [class*="ellipsis"], [class*="dropdown-trigger"], button[class*="action"], [class*="operation"] button'))
            const btn = botoes.find(b => b.offsetParent !== null)
            if (btn) { btn.click(); return true }
            return false
        })
        if (!menuAberto) {
            console.log('⚠️  [Zyon/produto] Menu de "3 pontinhos" não encontrado na lista de produtos')
            return null
        }
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
        if (!clicado) {
            console.log('⚠️  [Zyon/produto] Opção "Visualizar página do produto" não encontrada no menu')
            return null
        }

        let paginaProduto = await novaAbaPromise
        const abriuNovaAba = !!paginaProduto
        if (!paginaProduto) paginaProduto = paginaLista
        await randomDelay()
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

        if (abriuNovaAba) await paginaProduto.close().catch(() => {})
        if (!produtoId) console.log(`⚠️  [Zyon/produto] Não foi possível extrair o ID do produto da URL: ${urlProduto}`)

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

// ───────────────────────── Pedidos em aberto sem arte ─────────────────────────

// Acessa "A Enviar — Em aberto" e retorna TODOS os pedidos da seção, independente do
// nome do produto — não há como saber pela listagem se o cliente precisa enviar arte,
// então essa decisão é feita depois, lendo a conversa de cada um no chat. A extração
// usa o texto "ID do Pedido <ID>" como âncora (igual a verificarNovosPedidos) e sobe pelo
// DOM em busca, no mesmo cartão, do nome do produto e do nome do comprador.
// Seletores genéricos/best-effort: se a Shopee mudar o layout e os campos vierem vazios,
// inspecionar debug_shopee/pedidos_personalizacao.html e ajustar (mesmo processo usado
// para corrigir os seletores do webchat).
async function listarPedidosEmAberto(page) {
    await page.goto(ORDERS_TOSHIP_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 15000))
    await verificarAutenticacaoPendente(page, ORDERS_TOSHIP_URL)

    await page.screenshot({ path: path.join(DEBUG_DIR, 'pedidos_personalizacao.png') })
    await salvarHtmlDebug(page, 'pedidos_personalizacao')

    const pedidos = await page.evaluate(() => {
        const resultado = []
        const folhas = Array.from(document.querySelectorAll('body *')).filter(el => el.children.length === 0)
        const marcadores = folhas.filter(el => /ID do Pedido\s+[A-Z0-9]{6,20}/i.test(el.textContent || ''))

        for (const marcador of marcadores) {
            const idMatch = (marcador.textContent || '').match(/ID do Pedido\s+([A-Z0-9]{6,20})/i)
            if (!idMatch) continue
            const orderId = idMatch[1]
            if (resultado.some(p => p.orderId === orderId)) continue

            // Sobe pelos containers até achar um "cartão" que tenha tanto o nome do
            // produto quanto o nome do comprador — ambos costumam estar no mesmo bloco.
            // O nome do produto fica em [class*="item-name"] (ex: "Camisa Camiseta Polo...")
            // e o nome do comprador em [class*="buyer-username"] — confirmado inspecionando
            // debug_shopee/pedidos_personalizacao.html (não são links com /product//buyer/
            // nem têm atributo [title], como a versão antiga deste seletor assumia — por
            // isso a função vinha retornando 0 pedidos).
            let produtoNome = null
            let comprador = null
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

    console.log(`🎨 [Zyon/arte] ${pedidos.length} pedido(s) lido(s) em "A Enviar — Em aberto"`)
    return pedidos
}

// Abre o chat do comprador diretamente pelo ícone de chat no card do pedido, na própria
// listagem "A Enviar — Em aberto" (botão com data-testid="buyer-chat-action", ao lado do
// nome do comprador — confirmado em debug_shopee/pedidos_personalizacao.html). Isso é bem
// mais confiável que buscar pelo nome dentro do chat (a busca pode não achar a conversa,
// abrir a pessoa errada em caso de nomes parecidos, etc).
// A página precisa já estar na listagem de pedidos (ORDERS_TOSHIP_URL) ao chamar esta função.
// O clique pode tanto abrir o chat numa aba nova quanto trocar a própria aba para o
// new-webchat — os dois casos são tratados, e o retorno indica qual aba usar e se ela
// precisa ser fechada depois (aba nova) ou não (mesma aba, basta navegar de volta).
async function abrirChatDoPedido(page, browser, orderId) {
    await humanMouseMove(page, 400 + Math.floor(Math.random() * 300), 200 + Math.floor(Math.random() * 300))
    await randomDelay(3000, 5000)
    const clicou = await page.evaluate((orderId) => {
        const folhas = Array.from(document.querySelectorAll('body *')).filter(el => el.children.length === 0)
        const marcador = folhas.find(el => (el.textContent || '').includes(`ID do Pedido ${orderId}`))
        if (!marcador) return false

        let container = marcador
        for (let i = 0; i < 12 && container; i++) {
            const botao = container.querySelector('[data-testid="buyer-chat-action"]')
            if (botao) {
                botao.scrollIntoView({ block: 'center' })
                botao.click()
                return true
            }
            container = container.parentElement
        }
        return false
    }, orderId)

    if (!clicou) return null

    // O clique pode abrir uma aba nova com o webchat — espera até 6s para detectar isso
    const totalAntes = (await browser.pages()).length
    let novaPagina = null
    const limite = Date.now() + 6000
    while (Date.now() < limite && !novaPagina) {
        const paginas = await browser.pages()
        if (paginas.length > totalAntes) novaPagina = paginas[paginas.length - 1]
        else await new Promise(r => setTimeout(r, 300))
    }

    const paginaChat = novaPagina || page
    if (novaPagina) {
        await novaPagina.bringToFront()
        await configurarPagina(novaPagina)
    }

    try {
        await paginaChat.waitForSelector(
            '[data-cy="webchat-message-receive"], [data-cy="webchat-message-send"], [data-cy="webchat-conversation-detail-input"]',
            { timeout: 25000 }
        )
    } catch {
        if (novaPagina) await novaPagina.close().catch(() => {})
        return null
    }

    await randomDelay()
    await paginaChat.screenshot({ path: path.join(DEBUG_DIR, 'arte_conversa.png') })
    return { pagina: paginaChat, abaNova: !!novaPagina }
}

// Detecta páginas de autenticação/verificação da Shopee e bloqueia o ciclo até que
// o usuário complete a ação manual (ex: clicar no link de verificação por e-mail).
// Não navega durante a espera — só observa page.url() e o texto da página a cada 30s.
// Quando a sessão se estabiliza, renavega para urlRetomar e retorna ao ciclo normal.
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
            console.log('⏸️  [Zyon] Verificação manual pendente na Shopee (ex: confirmação por e-mail) — aguardando ação manual. Pausando ciclos automáticos até a sessão ficar estável.')
            avisou = true
        } else {
            console.log('⏸️  [Zyon] Ainda aguardando verificação manual...')
        }
        await new Promise(r => setTimeout(r, 30000))
    }
}

module.exports = {
    coletarDadosShopee, verificarNovosPedidos, coletarStatusPedidos, coletarFaturamentoGerencial,
    launchBrowser, resolverChrome, configurarPagina,
    abrirChat, abrirProximaConversaNaoRespondida, lerConversaCompleta, enviarMensagemNoChat, extrairInfoProduto,
    listarPedidosEmAberto, abrirChatDoPedido, ORDERS_TOSHIP_URL,
}
