// ─────────────────────────────────────────────────────────────────────────────
// maps-prospeccao.js — Busca de empresas no Google Maps (Puppeteer), compartilhada
// entre zvendas.js (canal Zaya) e zmatheus.js (canal Matheus) — mesma lógica de
// prospecção pros dois canais, só o profileDir do browser muda (cada canal precisa
// do seu próprio, nunca reusar userDataDir entre browsers que podem rodar em
// paralelo — mesmo bug já documentado do "Chrome Singleton lock").
// ─────────────────────────────────────────────────────────────────────────────

const { launchBrowser, resolverChrome, configurarPagina } = require('./shopee-agent')

const esperar = ms => new Promise(r => setTimeout(r, ms))

const TERMOS_BUSCA = [
    'restaurante SP', 'escola SP', 'academia SP', 'loja de roupas SP', 'empresa SP',
    'clínica SP', 'escritório SP', 'hotel SP', 'farmácia SP', 'supermercado SP',
    'salão de beleza SP', 'barbearia SP', 'pet shop SP', 'oficina mecânica SP',
    'imobiliária SP', 'contabilidade SP', 'advocacia SP', 'construtora SP',
    'concessionária SP', 'padaria SP', 'pizzaria SP', 'lanchonete SP', 'buffet SP',
    'agência de eventos SP', 'gráfica SP', 'transportadora SP', 'posto de gasolina SP',
    'loja de material de construção SP', 'clínica odontológica SP', 'laboratório SP',
    'academia de luta SP', 'estúdio de dança SP', 'escola de idiomas SP',
    'ONG SP', 'condomínio SP', 'coworking SP',
]

// Busca no Google Maps e extrai nome + telefone de até `quantidade` empresas
// "aberto agora". Puramente leitura (nenhuma mensagem é enviada aqui).
async function buscarEmpresasNoMaps(termo, quantidade, profileDir) {
    const chromePath = resolverChrome()
    const browser = await launchBrowser(chromePath, { userDataDir: profileDir, headless: false })
    const empresas = []
    try {
        const page = await browser.newPage()
        await configurarPagina(page)
        const url = `https://www.google.com/maps/search/${encodeURIComponent(termo)}`
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
        await esperar(3000)

        const feedSelector = 'div[role="feed"]'
        await page.waitForSelector(feedSelector, { timeout: 15000 }).catch(() => {})
        for (let i = 0; i < 6; i++) {
            await page.evaluate(sel => {
                const feed = document.querySelector(sel)
                if (feed) feed.scrollTop = feed.scrollHeight
            }, feedSelector)
            await esperar(1200)
        }

        const links = await page.evaluate(sel => {
            const feed = document.querySelector(sel)
            if (!feed) return []
            return Array.from(feed.querySelectorAll('a[href*="/maps/place/"]')).map(a => a.href)
        }, feedSelector)

        const linksUnicos = [...new Set(links)].slice(0, quantidade * 3)

        for (const link of linksUnicos) {
            if (empresas.length >= quantidade) break
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 })
                await esperar(1500)
                const dados = await page.evaluate(() => {
                    const nomeEl = document.querySelector('h1')
                    const nome = nomeEl ? nomeEl.textContent.trim() : null
                    const botaoTelefone = document.querySelector('button[data-item-id^="phone:"]')
                    let telefone = null
                    if (botaoTelefone) {
                        const aria = botaoTelefone.getAttribute('aria-label') || ''
                        telefone = aria.replace(/[^\d+]/g, '')
                    }
                    // Status "Aberto"/"Fechado" — o Maps mostra vários textos "Fechado · Abre
                    // às..." dentro da tabela de horários por dia, mas o status ATUAL (aberto
                    // agora ou não) é sempre o primeiro candidato na ordem do DOM.
                    const statusCandidatos = Array.from(document.querySelectorAll('span, div'))
                        .map(el => el.textContent?.trim())
                        .filter(t => t && (/^Aberto\b/.test(t) || /^Fechado\b/.test(t)) && t.length < 60)
                    const statusAtual = statusCandidatos[0] || null
                    return { nome, telefone, statusAtual }
                })
                const abertoAgora = dados.statusAtual ? /^Aberto\b/.test(dados.statusAtual) : null
                console.log(`🕐 [Prospecção] ${dados.nome || link} — aberto agora: ${abertoAgora === null ? 'sem info' : (abertoAgora ? 'sim' : 'não')}`)
                if (dados.nome && dados.telefone && dados.telefone.replace(/\D/g, '').length >= 10 && abertoAgora === true) {
                    empresas.push({ nome: dados.nome, telefone: dados.telefone })
                }
            } catch (err) {
                console.error(`⚠️ [Prospecção] Erro ao extrair empresa (${link}): ${err.message}`)
            }
        }
    } finally {
        await browser.close().catch(() => {})
    }
    return empresas
}

module.exports = { TERMOS_BUSCA, buscarEmpresasNoMaps }
