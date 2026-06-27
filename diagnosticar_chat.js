require('dotenv').config()

const fs = require('fs')
const path = require('path')
const {
    launchBrowser, resolverChrome, configurarPagina,
    abrirChat, abrirProximaConversaNaoRespondida,
} = require('./shopee-agent')

const DEBUG_DIR = path.join(__dirname, 'debug_shopee')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR)
const SAIDA = path.join(DEBUG_DIR, 'diagnostico_chat.json')

;(async () => {
    const t0 = Date.now()
    const eventos = []

    const ts = () => Date.now() - t0

    const browser = await launchBrowser(resolverChrome())
    const page = await browser.newPage()
    await configurarPagina(page)

    // ── listeners instalados ANTES de qualquer navegação ──────────────────────

    page.on('response', async (response) => {
        const status = response.status()
        const entry = {
            t: ts(),
            tipo: 'response',
            method: response.request().method(),
            status,
            url: response.url(),
        }
        if (status >= 400) {
            try { entry.body = (await response.text()).substring(0, 3000) }
            catch (_) { entry.body = '(erro ao ler corpo)' }
        }
        eventos.push(entry)
    })

    page.on('requestfailed', (req) => {
        eventos.push({
            t: ts(),
            tipo: 'requestfailed',
            method: req.method(),
            url: req.url(),
            motivo: req.failure()?.errorText ?? '(desconhecido)',
        })
    })

    page.on('console', (msg) => {
        eventos.push({
            t: ts(),
            tipo: 'console',
            nivel: msg.type(),
            texto: msg.text(),
        })
    })

    page.on('pageerror', (err) => {
        eventos.push({
            t: ts(),
            tipo: 'pageerror',
            mensagem: err.message,
        })
    })

    // ── abre lista de conversas ───────────────────────────────────────────────

    console.log(`[${ts()}ms] Abrindo chat...`)
    await abrirChat(page)
    eventos.push({ t: ts(), tipo: 'info', mensagem: 'abrirChat() concluído' })

    // ── abre a primeira conversa disponível ───────────────────────────────────

    console.log(`[${ts()}ms] Abrindo primeira conversa não respondida...`)
    const cliente = await abrirProximaConversaNaoRespondida(page, [])
    if (cliente) {
        eventos.push({ t: ts(), tipo: 'info', mensagem: `Conversa aberta: ${cliente}` })
        console.log(`[${ts()}ms] Conversa aberta: ${cliente}`)
    } else {
        eventos.push({ t: ts(), tipo: 'aviso', mensagem: 'Nenhuma conversa não respondida encontrada — sem interação' })
        console.log(`[${ts()}ms] Nenhuma conversa não respondida — aguardando mesmo assim`)
    }

    // ── observa por 10 segundos sem fazer nada ────────────────────────────────

    console.log(`[${ts()}ms] Observando por 10 segundos...`)
    await new Promise(r => setTimeout(r, 10000))
    eventos.push({ t: ts(), tipo: 'info', mensagem: 'Fim do período de observação (10s)' })

    // ── salva e encerra ───────────────────────────────────────────────────────

    const urlFinal = page.url()
    eventos.push({ t: ts(), tipo: 'info', mensagem: `URL final da página: ${urlFinal}` })

    fs.writeFileSync(SAIDA, JSON.stringify({ duracaoMs: ts(), urlFinal, eventos }, null, 2))
    console.log(`\n✅ Diagnóstico salvo em: ${SAIDA}`)
    console.log(`   URL final: ${urlFinal}`)
    console.log(`   Total de eventos capturados: ${eventos.length}`)

    await browser.close()
})()
