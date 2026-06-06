require('dotenv').config()
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const path = require('path')
const fs = require('fs')

const BASE_URL = 'https://seller.shopee.com.br'
const PROFILE_DIR = path.join(__dirname, 'shopee_profile')
const DEBUG_DIR = path.join(__dirname, 'debug_shopee')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR)
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true })

const SHOPEE_EMAIL = process.env.SHOPEE_EMAIL
const SHOPEE_PASSWORD = process.env.SHOPEE_PASSWORD

if (!SHOPEE_EMAIL || !SHOPEE_PASSWORD) {
    console.error('❌ Defina SHOPEE_EMAIL e SHOPEE_PASSWORD nas variáveis de ambiente.')
    process.exit(1)
}

function resolverChrome() {
    for (const ev of [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH]) {
        if (ev && fs.existsSync(ev)) return ev
    }
    try {
        const ep = require('puppeteer').executablePath()
        if (ep && fs.existsSync(ep)) return ep
    } catch {}
    const paths = [
        '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/run/current-system/sw/bin/chromium',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : null,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean)
    const found = paths.find(p => fs.existsSync(p))
    if (!found) throw new Error('Chrome não encontrado. Defina CHROME_PATH.')
    return found
}

// Digita texto com delay humano entre teclas
async function typeHuman(page, selector, text) {
    await page.focus(selector)
    await page.evaluate(sel => { document.querySelector(sel).value = '' }, selector)
    for (const char of text) {
        await page.type(selector, char, { delay: 60 + Math.random() * 80 })
    }
}

// Tenta clicar no primeiro seletor que existir na página
async function clickFirst(page, selectors) {
    for (const sel of selectors) {
        try {
            const el = await page.$(sel)
            if (el) { await el.click(); return sel }
        } catch {}
    }
    return null
}

// Aguarda URL sair de /account/login com timeout
async function waitForLogin(page, timeoutMs = 40000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const url = page.url()
        if (!url.includes('/account/login') && !url.includes('/login')) return true
        await new Promise(r => setTimeout(r, 1000))
    }
    return false
}

;(async () => {
    console.log('🔐 Iniciando login headless na Shopee Seller Center...')
    console.log(`📧 Conta: ${SHOPEE_EMAIL}`)

    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: resolverChrome(),
        userDataDir: PROFILE_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1366,768',
            '--lang=pt-BR',
        ],
        defaultViewport: { width: 1366, height: 768 },
    })

    try {
        const page = await browser.newPage()
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        console.log('🌐 Acessando página de login...')
        await page.goto(`${BASE_URL}/account/login`, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 3000))

        // Verifica se já está logado
        if (!page.url().includes('/account/login') && !page.url().includes('/login')) {
            console.log('✅ Já está logado! Sessão ativa no perfil salvo.')
            await page.screenshot({ path: path.join(DEBUG_DIR, 'login-ja-logado.png') })
            return
        }

        await page.screenshot({ path: path.join(DEBUG_DIR, 'login-antes.png') })
        console.log(`🌐 URL: ${page.url()}`)

        // Seletores do campo de email/usuário (Shopee usa vários layouts)
        const EMAIL_SELS = [
            'input[name="loginKey"]',
            'input[type="text"][name*="login"]',
            'input[type="text"][name*="email"]',
            'input[type="email"]',
            'input[placeholder*="email" i]',
            'input[placeholder*="usuário" i]',
            'input[placeholder*="celular" i]',
            '.input-field input[type="text"]',
            'form input[type="text"]:first-of-type',
            'input[type="text"]',
        ]

        const PASSWORD_SELS = [
            'input[name="password"]',
            'input[type="password"]',
            '.input-field input[type="password"]',
            'form input[type="password"]',
        ]

        const SUBMIT_SELS = [
            'button[type="submit"]',
            'button.btn-solid-primary',
            '.login__button button',
            'form button:last-of-type',
            'button',
        ]

        // Preenche email
        let emailSel = null
        for (const sel of EMAIL_SELS) {
            try {
                await page.waitForSelector(sel, { timeout: 3000 })
                emailSel = sel
                break
            } catch {}
        }
        if (!emailSel) {
            await page.screenshot({ path: path.join(DEBUG_DIR, 'login-sem-campo-email.png') })
            throw new Error('Campo de email não encontrado. Veja debug_shopee/login-sem-campo-email.png')
        }

        console.log(`📝 Preenchendo email (${emailSel})...`)
        await typeHuman(page, emailSel, SHOPEE_EMAIL)
        await new Promise(r => setTimeout(r, 800))

        // Preenche senha
        let passSel = null
        for (const sel of PASSWORD_SELS) {
            try {
                await page.waitForSelector(sel, { timeout: 3000 })
                passSel = sel
                break
            } catch {}
        }
        if (!passSel) {
            await page.screenshot({ path: path.join(DEBUG_DIR, 'login-sem-campo-senha.png') })
            throw new Error('Campo de senha não encontrado. Veja debug_shopee/login-sem-campo-senha.png')
        }

        console.log(`🔑 Preenchendo senha (${passSel})...`)
        await typeHuman(page, passSel, SHOPEE_PASSWORD)
        await new Promise(r => setTimeout(r, 800))

        await page.screenshot({ path: path.join(DEBUG_DIR, 'login-preenchido.png') })
        console.log('📸 Screenshot: debug_shopee/login-preenchido.png')

        // Clica no botão de login
        console.log('🖱️  Clicando em Entrar...')
        const clickedSel = await clickFirst(page, SUBMIT_SELS)
        if (!clickedSel) {
            // Tenta pressionar Enter no campo de senha como fallback
            await page.keyboard.press('Enter')
            console.log('⌨️  Enter pressionado no campo de senha.')
        }

        console.log('⏳ Aguardando redirecionamento (até 40s)...')
        await new Promise(r => setTimeout(r, 3000))
        await page.screenshot({ path: path.join(DEBUG_DIR, 'login-apos-submit.png') })

        const logado = await waitForLogin(page, 40000)

        await page.screenshot({ path: path.join(DEBUG_DIR, 'login-resultado.png') })
        console.log(`🌐 URL final: ${page.url()}`)
        console.log('📸 Screenshot: debug_shopee/login-resultado.png')

        if (logado) {
            console.log('\n✅ Login bem-sucedido! Sessão salva em shopee_profile/')
            console.log('🛍️  O Zyon vai usar este perfil automaticamente.')
        } else {
            const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500))
            console.error('\n❌ Login falhou — ainda na página de login após 40s.')
            console.error('Possíveis causas: CAPTCHA, credenciais incorretas ou verificação em 2 etapas.')
            console.error(`Texto da página: ${bodyText}`)
            console.error('Verifique: debug_shopee/login-resultado.png')
            process.exit(1)
        }
    } finally {
        await browser.close()
    }
})()
