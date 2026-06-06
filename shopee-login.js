require('dotenv').config()
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

const path = require('path')
const fs = require('fs')

const BASE_URL = 'https://seller.shopee.com.br'
const PROFILE_DIR = path.join(__dirname, 'shopee_profile')

const chromePaths = [
    process.env.CHROME_PATH,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)
const executablePath = chromePaths.find(p => fs.existsSync(p))
if (!executablePath) { console.error('❌ Chrome não encontrado. Instale o Google Chrome.'); process.exit(1) }

;(async () => {
    console.log('🌐 Abrindo Chrome para login manual na Shopee...')
    console.log(`📁 Perfil salvo em: ${PROFILE_DIR}`)
    console.log('👉 Faça login normalmente. A sessão ficará salva automaticamente.\n')

    if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true })

    const browser = await puppeteer.launch({
        headless: false,
        executablePath,
        userDataDir: PROFILE_DIR,
        defaultViewport: null,
        args: ['--start-maximized', '--lang=pt-BR'],
    })

    const [page] = await browser.pages()
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })
    await page.goto(`${BASE_URL}/account/login`, { waitUntil: 'networkidle2', timeout: 60000 })

    console.log('⏳ Faça login e feche o Chrome quando terminar — a sessão será salva automaticamente.')

    await new Promise(resolve => browser.once('disconnected', resolve))

    console.log('\n✅ Pronto! Zyon vai usar este perfil automaticamente.')
    console.log('⚠️  Se a sessão expirar futuramente, rode novamente: node shopee-login.js')
})()
