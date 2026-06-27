require('dotenv').config()

const { launchBrowser, resolverChrome, configurarPagina, abrirChat } = require('./shopee-agent')

;(async () => {
    const browser = await launchBrowser(resolverChrome())
    const page = await browser.newPage()
    await configurarPagina(page)
    await abrirChat(page)
    console.log('✅ Chat aberto — browser aguardando uso manual. Ctrl+C para encerrar.')
    await new Promise(() => {})
})()
