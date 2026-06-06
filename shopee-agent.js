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
    const paths = [
        // Variável explícita (Railway: defina CHROME_PATH ou PUPPETEER_EXECUTABLE_PATH)
        process.env.CHROME_PATH,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        // Linux — nixpacks/Railway
        '/run/current-system/sw/bin/chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        // Windows — desenvolvimento local
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : null,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean)

    // Chrome embutido no pacote puppeteer (fallback final)
    try {
        const ep = require('puppeteer').executablePath()
        if (ep && !paths.includes(ep)) paths.push(ep)
    } catch {}

    const found = paths.find(p => fs.existsSync(p))
    if (!found) throw new Error('Chrome não encontrado. Defina CHROME_PATH ou PUPPETEER_EXECUTABLE_PATH.')
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

async function coletarStatusPedidos() {
    const browser = await launchBrowser(resolverChrome())
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        // 1. Overview — faturamento do dia e do mês
        await page.goto(`${BASE_URL}/portal/sale/overview`, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 6000))

        if (page.url().includes('/account/login')) {
            throw new Error('Sessão Shopee expirada. Execute: node shopee-login.js')
        }

        const overviewText = await page.evaluate(() =>
            document.body.innerText.replace(/\s+/g, ' ').trim()
        )
        console.log(`📊 [Zyon/overview] ${overviewText.substring(0, 600)}`)

        // 2. Pedidos — A Enviar, Enviados, Concluídos, Alertas
        await page.goto(
            `${BASE_URL}/portal/sale/order?type=toship&source=to_process&invoice_status=all_type&sort_by=confirmed_date_desc`,
            { waitUntil: 'networkidle2', timeout: 30000 }
        )
        await new Promise(r => setTimeout(r, 15000))

        const orderText = await page.evaluate(() =>
            document.body.innerText.replace(/\s+/g, ' ').trim()
        )
        console.log(`📊 [Zyon/orders] ${orderText.substring(0, 600)}`)

        return { overviewText, orderText }
    } finally {
        await browser.close()
    }
}

module.exports = { coletarDadosShopee, verificarNovosPedidos, coletarStatusPedidos }
