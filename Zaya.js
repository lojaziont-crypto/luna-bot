require('dotenv').config()

process.on('uncaughtException', (err) => {
    console.error('[ERRO FATAL]', err.message)
})
process.on('unhandledRejection', (err) => {
    console.error('[PROMISE REJEITADA]', err?.message || err)
})

const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const cron = require('node-cron')
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const pdfParse = require('pdf-parse')

let activeSock = null
let ownerJid = null
let reconnectTimer = null
let ultimoFaturamento = { fatDia: null, fatMes: null, aEnviar: null, atualizadoEm: null }
const STARTUP_TS = Math.floor(Date.now() / 1000)

// ─────────────────────────────────────────────────────────────────────────────
// Listas de Separação (PDFs do grupo Ziont)
// ─────────────────────────────────────────────────────────────────────────────
const LISTAS_FILE = path.join(__dirname, 'zaya_listas_separacao.json')

function carregarListas() {
    try {
        if (fs.existsSync(LISTAS_FILE)) return JSON.parse(fs.readFileSync(LISTAS_FILE, 'utf8'))
    } catch {}
    return []
}
function salvarListas(listas) {
    fs.writeFileSync(LISTAS_FILE, JSON.stringify(listas, null, 2))
}

// JID do grupo Ziont — carregado do env ou resolvido na primeira mensagem recebida
let ziontGroupJid = process.env.ZIONT_GROUP_JID || null

// Resposta pendente do Adriano: map de prazoEnvio (YYYY-MM-DD) → timestamp de quando foi perguntado
const adrianoPendente = new Map()

const OWNER_JID_FILE = path.join(__dirname, 'owner_jid.json')
try {
    if (fs.existsSync(OWNER_JID_FILE)) {
        ownerJid = JSON.parse(fs.readFileSync(OWNER_JID_FILE, 'utf8')).jid
        console.log(`👤 JID do dono carregado: ${ownerJid}`)
    }
} catch {}

function salvarOwnerJid(jid) {
    ownerJid = jid
    fs.writeFileSync(OWNER_JID_FILE, JSON.stringify({ jid }))
    console.log(`👤 JID do dono salvo: ${ownerJid}`)
}

function normalizePhone(jid) {
    return jid.replace(/@.*$/, '').replace(/^55/, '')
}

async function notifyNewOrder(orderId) {
    if (!activeSock) return
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, {
            text: `🛍️ *Nova Venda!*\n\nPedido *#${orderId}* confirmado! 🎉\n\nAcesse a Shopee para preparar o envio.`
        })
        console.log(`🛍️ [Zyon→Zaya] Notificação enviada: pedido #${orderId}`)
    } catch (err) {
        console.error('❌ Erro ao enviar notificação de novo pedido:', err.message)
    }
}

async function notifyChatHuman(nomeCliente, ultimaMensagem, resumo) {
    if (!activeSock) return
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, {
            text: `🖐️ *Atendimento humano necessário (Shopee)*\n\n*Cliente:* ${nomeCliente}\n*Última mensagem:* ${ultimaMensagem}\n\n*Resumo da conversa:*\n${resumo}`
        })
        console.log(`🖐️ [Zyon→Zaya] Notificação de atendimento humano enviada: ${nomeCliente}`)
    } catch (err) {
        console.error('❌ Erro ao enviar notificação de atendimento humano:', err.message)
    }
}

async function notifyChatUpdate(nomeCliente, informacao) {
    if (!activeSock) return
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, {
            text: `📎 *Atualização de atendimento*\nCliente: ${nomeCliente}\nPedido: não informado\nInformação: ${informacao}`
        })
        console.log(`📎 [Zyon→Zaya] Notificação de informação importante enviada: ${nomeCliente}`)
    } catch (err) {
        console.error('❌ Erro ao enviar notificação de informação importante:', err.message)
    }
}

async function notifyFinn(mensagem) {
    if (!activeSock) return
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, { text: mensagem })
        console.log('💰 [Finn→Zaya] Notificação enviada ao dono')
    } catch (err) {
        console.error('❌ Erro ao enviar notificação do Finn:', err.message)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NOVO: Zeon — notificação e repasse de respostas
// ─────────────────────────────────────────────────────────────────────────────

async function notifyZeon(mensagem) {
    if (!activeSock) {
        console.log('⚠️ notifyZeon: WhatsApp não conectado')
        return
    }
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, { text: mensagem })
        console.log('⚡ [Zeon→Zaya] Mensagem enviada ao dono')
    } catch (err) {
        console.error('❌ Erro ao enviar notificação do Zeon:', err.message)
    }
}

function repassarRespostaZeon(idDecisao, resposta) {
    const zeonUrl = process.env.ZEON_URL || 'http://localhost:3003'
    const data = JSON.stringify({ idDecisao, resposta })
    let parsedUrl
    try { parsedUrl = new URL(`${zeonUrl}/resposta-mauricio`) } catch {
        console.error(`❌ [Zaya] ZEON_URL inválida: ${zeonUrl}`)
        return
    }
    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port ? Number(parsedUrl.port) : 80

    const req = lib.request({
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
        console.log(`📨 [Zaya→Zeon] Resposta repassada (HTTP ${res.statusCode}): ${idDecisao} — ${resposta}`)
    })
    req.on('error', err => console.error(`❌ [Zaya] Erro ao repassar resposta ao Zeon: ${err.message}`))
    req.write(data)
    req.end()
}

function enviarMensagemZeon(mensagem) {
    const zeonUrl = process.env.ZEON_URL || 'http://localhost:3003'
    const data = JSON.stringify({ mensagem })
    let parsedUrl
    try { parsedUrl = new URL(`${zeonUrl}/mensagem-mauricio`) } catch {
        console.error(`❌ [Zaya] ZEON_URL inválida: ${zeonUrl}`)
        return
    }
    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port ? Number(parsedUrl.port) : 80

    const req = lib.request({
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
        console.log(`📨 [Zaya→Zeon] Mensagem do Maurício repassada (HTTP ${res.statusCode})`)
    })
    req.on('error', err => console.error(`❌ [Zaya] Erro ao enviar mensagem ao Zeon: ${err.message}`))
    req.write(data)
    req.end()
}

// ─────────────────────────────────────────────────────────────────────────────
// Finn (agente financeiro)
// ─────────────────────────────────────────────────────────────────────────────

const FINN_URL = process.env.FINN_URL || 'http://localhost:3002'

function finnRequest(method, urlPath, dadosEnvio) {
    return new Promise((resolve, reject) => {
        let parsedUrl
        try { parsedUrl = new URL(`${FINN_URL}${urlPath}`) } catch {
            return reject(new Error(`FINN_URL inválida: ${FINN_URL}`))
        }
        const lib = parsedUrl.protocol === 'https:' ? https : http
        const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)
        const data = dadosEnvio ? JSON.stringify(dadosEnvio) : null

        const req = lib.request({
            hostname: parsedUrl.hostname,
            port,
            path: parsedUrl.pathname,
            method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        }, res => {
            let corpo = ''
            res.on('data', chunk => { corpo += chunk })
            res.on('end', () => {
                try { resolve(JSON.parse(corpo)) } catch { resolve({ ok: res.statusCode < 400, raw: corpo }) }
            })
        })
        req.on('error', reject)
        req.setTimeout(120000, () => req.destroy(new Error('Timeout ao falar com o Finn')))
        if (data) req.write(data)
        req.end()
    })
}

const PALAVRAS_LANCAMENTO = ['gastei', 'paguei', 'recebi', 'comprei', 'lancei', 'pagar', 'recebimento', 'gasto', 'compra', 'conta de', 'boleto']
function contemPalavraDeLancamento(textoLower) {
    return PALAVRAS_LANCAMENTO.some(p => textoLower.includes(p))
}

async function responderLimites(sock, from) {
    try {
        const resposta = await finnRequest('GET', '/limites')
        const limitesObtidos = resposta?.limites || {}
        const categorias = Object.keys(limitesObtidos)
        if (categorias.length === 0) {
            await sock.sendMessage(from, { text: '📏 Nenhum limite definido ainda.\n\nPara definir, envie: *limite [categoria] [valor]*' })
            return
        }
        const linhas = categorias.map(cat => `• ${cat}: R$ ${Number(limitesObtidos[cat]).toFixed(2)}`)
        await sock.sendMessage(from, { text: `📏 *Limites mensais definidos:*\n\n${linhas.join('\n')}` })
    } catch (err) {
        console.error('❌ [Zaya/Finn] Erro ao buscar limites:', err.message)
        await sock.sendMessage(from, { text: '❌ Não consegui consultar os limites agora. O Finn está rodando?' })
    }
}

async function definirLimite(sock, from, categoria, valorTexto) {
    const valor = Number(valorTexto.replace(/\./g, '').replace(',', '.'))
    if (!Number.isFinite(valor)) {
        await sock.sendMessage(from, { text: '❌ Valor inválido. Use o formato: *limite [categoria] [valor]* — ex: limite Alimentação 800' })
        return
    }
    try {
        await finnRequest('POST', '/definir-limite', { categoria, valor })
        await sock.sendMessage(from, { text: `✅ Limite definido: *${categoria}* → R$ ${valor.toFixed(2)} por mês` })
    } catch (err) {
        console.error('❌ [Zaya/Finn] Erro ao definir limite:', err.message)
        await sock.sendMessage(from, { text: '❌ Não consegui definir o limite agora. O Finn está rodando?' })
    }
}

async function processarLancamentoTexto(sock, from, texto) {
    try {
        await finnRequest('POST', '/lancar', { texto })
        await sock.sendMessage(from, { text: '🥷 Recebi! Estou registrando esse lançamento, aviso quando concluir. ⏳' })
    } catch (err) {
        console.error('❌ [Zaya/Finn] Erro ao enviar lançamento por texto:', err.message)
        await sock.sendMessage(from, { text: '❌ Não consegui enviar o lançamento ao Finn agora. Ele está rodando?' })
    }
}

async function processarComprovanteImagem(sock, msg, from, legenda) {
    try {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
        const buffer = await downloadMediaMessage(msg, 'buffer', {})
        const imagemBase64 = buffer.toString('base64')
        const mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg'
        await finnRequest('POST', '/lancar', { imagemBase64, mimeType, texto: legenda || '' })
        await sock.sendMessage(from, { text: '🥷 Comprovante recebido! Estou extraindo os dados e registrando, aviso quando concluir. ⏳' })
    } catch (err) {
        console.error('❌ [Zaya/Finn] Erro ao processar comprovante de imagem:', err.message)
        await sock.sendMessage(from, { text: '❌ Não consegui processar o comprovante agora. O Finn está rodando?' })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Servidor HTTP
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
const server = http.createServer((req, res) => {

    if (req.method === 'POST' && req.url === '/notify-order') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { orderId } = JSON.parse(body)
                await notifyNewOrder(orderId)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    } else if (req.method === 'POST' && req.url === '/notify-chat-human') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { nomeCliente, ultimaMensagem, resumo } = JSON.parse(body)
                await notifyChatHuman(nomeCliente, ultimaMensagem, resumo)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    } else if (req.method === 'POST' && req.url === '/notify-chat-update') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { nomeCliente, informacao } = JSON.parse(body)
                await notifyChatUpdate(nomeCliente, informacao)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    } else if (req.method === 'POST' && req.url === '/finn-notificacao') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { mensagem } = JSON.parse(body)
                await notifyFinn(mensagem)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    // NOVO: Zeon envia mensagem para o Maurício
    } else if (req.method === 'POST' && req.url === '/zeon-notificacao') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { mensagem } = JSON.parse(body)
                await notifyZeon(mensagem)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                console.error('❌ /zeon-notificacao error:', err.message)
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    } else if (req.method === 'POST' && req.url === '/notify-producao-lucas') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { pedidos } = JSON.parse(body)
                if (!activeSock) {
                    console.log('⚠️  [Zaya] /notify-producao-lucas: WhatsApp não conectado')
                    res.writeHead(503, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: 'WhatsApp desconectado' }))
                    return
                }
                const lucasPhone = process.env.LUCAS_PHONE || ''
                if (!lucasPhone) {
                    console.log('⚠️  [Zaya] LUCAS_PHONE não definido — aviso de produção não enviado')
                    res.writeHead(500, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: 'LUCAS_PHONE não configurado' }))
                    return
                }
                const lucasJid = lucasPhone.startsWith('55') ? `${lucasPhone}@s.whatsapp.net` : `55${lucasPhone}@s.whatsapp.net`

                const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
                const linhas = pedidos.map((p, i) =>
                    `${i + 1}. *Pedido #${p.orderId}*\n   Produto: ${p.produtoNome}\n   Comprador: ${p.comprador || '(não identificado)'}`
                ).join('\n\n')

                const mensagem = [
                    `🎨 *Produção pendente — ${hoje}*`,
                    ``,
                    `Lucas, os pedidos abaixo ainda estão em "A Enviar" na Shopee e precisam de arte:`,
                    ``,
                    linhas,
                    ``,
                    `Total: ${pedidos.length} pedido(s) aguardando.`,
                ].join('\n')

                await activeSock.sendMessage(lucasJid, { text: mensagem })
                console.log(`🎨 [Zaya] Aviso de produção enviado ao Lucas (${pedidos.length} pedido(s))`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                console.error('❌ /notify-producao-lucas error:', err.message)
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    } else if (req.method === 'POST' && req.url === '/update-faturamento') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            try {
                const { fatDia, fatMes, aEnviar } = JSON.parse(body)
                ultimoFaturamento = { fatDia, fatMes, aEnviar: aEnviar || null, atualizadoEm: new Date().toISOString() }
                console.log(`📈 [Zaya] Dados recebidos do Zyon — Dia: R$ ${fatDia} | Mês: R$ ${fatMes} | A Enviar: ${aEnviar}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                res.writeHead(400)
                res.end(JSON.stringify({ ok: false }))
            }
        })

    } else if (req.url === '/health') {
        res.writeHead(200)
        res.end('ok')

    } else {
        res.writeHead(404)
        res.end()
    }
})
server.listen(PORT, () => console.log(`🚀 Zaya HTTP server na porta ${PORT}`))

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp
// ─────────────────────────────────────────────────────────────────────────────

async function connectToWhatsApp() {
    const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers } = await import('@whiskeysockets/baileys')

    const { state, saveCreds } = await useMultiFileAuthState('auth_info')

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: false
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('\n📱 Escaneie o QR code abaixo com o seu WhatsApp:\n')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            activeSock = null

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🚪 Dispositivo desconectado pelo WhatsApp. Delete a pasta auth_info e reinicie.')
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('⚠️ Sessão substituída (440) — deletando auth e exibindo novo QR code...')
                try { fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true }) } catch {}
                if (reconnectTimer) clearTimeout(reconnectTimer)
                reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToWhatsApp() }, 3000)
            } else {
                if (reconnectTimer) clearTimeout(reconnectTimer)
                console.log(`🔄 Reconectando em 5s... (código ${statusCode})`)
                reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToWhatsApp() }, 5000)
            }
        } else if (connection === 'open') {
            console.log('✅ Zaya está online e pronta!')
            activeSock = sock
            ;(async () => {
                try {
                    const phone = process.env.OWNER_PHONE || ''
                    const phoneCC = phone.startsWith('55') ? phone : `55${phone}`
                    const results = await sock.onWhatsApp(phoneCC)
                    if (results?.[0]?.exists && results[0].jid) {
                        salvarOwnerJid(results[0].jid)
                        console.log(`👤 JID do dono auto-detectado: ${results[0].jid}`)
                    }
                } catch {
                    console.log('⚠️ JID do dono não detectado — use !registrar para registrar manualmente')
                }
            })()
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📨 [upsert] type=${type} msgs=${messages.length}`)

        if (type !== 'notify' && type !== 'append') return

        for (const msg of messages) {
            const from = msg.key.remoteJid
            if (!from) continue
            if (msg.key.fromMe) continue
            if (!msg.message) continue

            // Mensagens de grupo: só processa o grupo Ziont (PDFs de Lista de Separação)
            if (from.endsWith('@g.us')) {
                await tratarMensagemGrupoZiont(sock, msg, from).catch(err =>
                    console.error('❌ [Zaya/Ziont] Erro ao tratar mensagem de grupo:', err.message)
                )
                continue
            }

            const msgTs = Number(msg.messageTimestamp)
            if (msgTs && msgTs < STARTUP_TS - 120) continue

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                null

            // Verifica resposta do Adriano antes de qualquer outro handler
            if (text && await tratarRespostaAdriano(sock, from, text).catch(() => false)) continue

            const isOwner = from === ownerJid || from === process.env.OWNER_JID ||
                normalizePhone(from) === normalizePhone(process.env.OWNER_PHONE || '')

            if (isOwner) {
                const textoLower = (text || '').toLowerCase().trim()
                const imageMsg = msg.message.imageMessage

                if (imageMsg) {
                    await processarComprovanteImagem(sock, msg, from, text)
                    continue
                }

                if (textoLower.includes('meus limites') || textoLower.includes('listar limites')) {
                    await responderLimites(sock, from)
                    continue
                }

                const matchLimite = textoLower.match(/^limite\s+(.+?)\s+([\d.,]+)\s*$/)
                if (matchLimite) {
                    await definirLimite(sock, from, matchLimite[1].trim(), matchLimite[2])
                    continue
                }

                // mensagem prefixada com "zeon" → repassa ao Zeon
                if (text && /^zeon\b/i.test(text.trim())) {
                    const conteudo = text.trim().replace(/^zeon[^\w]*/i, '').trim()
                    console.log(`⚡ [Zaya→Zeon] Mensagem do Maurício: ${conteudo}`)
                    enviarMensagemZeon(conteudo)
                    continue
                }

                // NOVO: detecta resposta a uma decisão pendente do Zeon
                // Formato: o Zeon envia o ID no final da mensagem (ex: "ID: dec_1234567890")
                // Maurício responde "sim dec_1234567890" ou apenas "sim" (última decisão)
                if (text) {
                    const matchDecisao = text.match(/\b(dec_\d+)\b/)
                    if (matchDecisao) {
                        const idDecisao = matchDecisao[1]
                        const resposta = text.replace(idDecisao, '').trim() || text
                        console.log(`⚡ [Zaya] Resposta do Maurício para decisão ${idDecisao}: ${resposta}`)
                        repassarRespostaZeon(idDecisao, resposta)
                        continue
                    }
                }

                if (text && contemPalavraDeLancamento(textoLower)) {
                    await processarLancamentoTexto(sock, from, text)
                    continue
                }
            }

            if (!text) continue

            if (isOwner && text.trim() === '!shopee') {
                console.log('📓 Comando !shopee recebido — gerando relatório...')
                gerarResumoShopee()
                continue
            }

            if (text.trim() === `!registrar ${process.env.OWNER_PHONE}`) {
                salvarOwnerJid(from)
                await sock.sendMessage(from, { text: '✅ Você foi registrado como dono! Agora use *!shopee* para gerar o relatório.' })
                continue
            }

            const sender = from.replace('@s.whatsapp.net', '')
            console.log(`⏭️  [${sender}]: resposta automática desativada`)
        }
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Grupo Ziont — processamento de PDF "Lista de Separação"
// ─────────────────────────────────────────────────────────────────────────────

async function processarListaSeparacaoPDF(sock, msg) {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
    let buffer
    try {
        buffer = await downloadMediaMessage(msg, 'buffer', {})
    } catch (err) {
        console.error('❌ [Zaya/Ziont] Erro ao baixar PDF:', err.message)
        return
    }

    let texto = ''
    try {
        const parsed = await pdfParse(buffer)
        texto = parsed.text || ''
    } catch (err) {
        console.error('❌ [Zaya/Ziont] Erro ao parsear PDF — não foi possível extrair o texto:', err.message)
        return
    }

    // Extrai prazo de envio — busca padrão "DD/MM" ou "DD/MM/AAAA" após "PRAZO PARA ENVIO"
    let prazoEnvio = null
    const prazoMatch = texto.match(/PRAZO\s+PARA\s+ENVIO\s+AO\s+CLIENTE[^0-9]*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i)
    if (prazoMatch) {
        const dia = prazoMatch[1].padStart(2, '0')
        const mes = prazoMatch[2].padStart(2, '0')
        const anoRaw = prazoMatch[3]
        const ano = anoRaw
            ? (anoRaw.length === 2 ? `20${anoRaw}` : anoRaw)
            : new Date().getFullYear().toString()
        prazoEnvio = `${ano}-${mes}-${dia}`
    }

    // Extrai IDs de pedidos — formato Shopee: sequência alfanumérica de 14+ chars após "Pedido #" ou sozinhos
    const pedidosSet = new Set()
    for (const m of texto.matchAll(/(?:Pedido\s*#?\s*)?([A-Z0-9]{10,20})/g)) {
        const candidato = m[1]
        // Descarta palavras genéricas que possam coincidir com o padrão
        if (!/^(PRAZO|PARA|ENVIO|CLIENTE|LISTA|SEPARACAO|ZIONT|PEDIDO)$/i.test(candidato)) {
            pedidosSet.add(candidato)
        }
    }
    const pedidos = Array.from(pedidosSet)

    if (!prazoEnvio && pedidos.length === 0) {
        console.log('⚠️  [Zaya/Ziont] PDF recebido mas não foi possível extrair prazo nem pedidos — ignorando')
        return
    }

    const novaLista = {
        id: `lista_${Date.now()}`,
        prazoEnvio,
        pedidos,
        recebidoEm: new Date().toISOString(),
        processado: false,
        aguardandoVerificacao: false,
    }

    const listas = carregarListas()
    listas.push(novaLista)
    salvarListas(listas)

    console.log(`📋 [Zaya/Ziont] Lista de Separação salva — prazo: ${prazoEnvio || '(não encontrado)'} | ${pedidos.length} pedido(s): ${pedidos.slice(0, 3).join(', ')}${pedidos.length > 3 ? '...' : ''}`)
}

async function tratarMensagemGrupoZiont(sock, msg, from) {
    // Resolve o JID do grupo "Ziont" uma única vez por sessão se não estiver no env
    if (!ziontGroupJid) {
        try {
            const meta = await sock.groupMetadata(from)
            if (/ziont/i.test(meta.subject || '')) {
                ziontGroupJid = from
                console.log(`📋 [Zaya/Ziont] Grupo "Ziont" identificado — JID: ${from}`)
            }
        } catch {}
    }

    if (ziontGroupJid && from !== ziontGroupJid) return

    const docMsg = msg.message?.documentMessage
    if (!docMsg) return

    const fileName = docMsg.fileName || ''
    const caption = docMsg.caption || ''
    const ehListaSeparacao = /lista.*separa[çc][aã]o/i.test(fileName) || /lista.*separa[çc][aã]o/i.test(caption)
    const ehPdf = /\.pdf$/i.test(fileName) || docMsg.mimetype === 'application/pdf'

    if (!ehListaSeparacao || !ehPdf) return

    console.log(`📋 [Zaya/Ziont] PDF "Lista de Separação" detectado no grupo Ziont — processando...`)
    await processarListaSeparacaoPDF(sock, msg)
}

function solicitarFaturamentoZyon() {
    return new Promise((resolve) => {
        const zyonUrl = process.env.ZYON_URL || 'http://localhost:3001'
        let parsedUrl
        try { parsedUrl = new URL(`${zyonUrl}/solicitar-faturamento`) } catch {
            console.error('❌ [Zaya] ZYON_URL inválida:', zyonUrl)
            return resolve()
        }
        const lib = parsedUrl.protocol === 'https:' ? https : http
        const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)
        const req = lib.request({
            hostname: parsedUrl.hostname,
            port,
            path: '/solicitar-faturamento',
            method: 'POST',
            headers: { 'Content-Length': 0 }
        }, (res) => {
            console.log(`📑 [Zaya] Zyon concluiu coleta (HTTP ${res.statusCode})`)
            res.resume()
            resolve()
        })
        req.setTimeout(180000, () => {
            console.log('⏰ [Zaya] Timeout aguardando Zyon (3 min)')
            req.destroy()
            resolve()
        })
        req.on('error', (err) => {
            console.log(`⚠️  [Zaya] Zyon não disponível: ${err.message}`)
            resolve()
        })
        req.end()
    })
}

async function gerarResumoShopee() {
    if (!activeSock) return
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, { text: '⏳ Coletando dados atualizados, aguarde...' })
        await solicitarFaturamentoZyon()

        if (!ultimoFaturamento.atualizadoEm) {
            await activeSock.sendMessage(ownerJidToSend, { text: '⏳ Zyon não respondeu.\nVerifique se ele está rodando: `node zyon.js`' })
            return
        }

        const fatDia  = ultimoFaturamento.fatDia  || '?'
        const fatMes  = ultimoFaturamento.fatMes  || '?'
        const aEnviar = ultimoFaturamento.aEnviar || '?'
        const hora    = new Date(ultimoFaturamento.atualizadoEm).toLocaleTimeString('pt-BR')
        const data    = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

        const mensagemFinal = [
            `🛍️ *Shopee — ${data}*`,
            `_atualizado às ${hora}_`,
            ``,
            `💰 *Faturamento do dia:* R$ ${fatDia}`,
            `📦 *A Enviar:* ${aEnviar}`,
            `💰 *Faturamento do mês:* R$ ${fatMes}`,
        ].join('\n')

        await activeSock.sendMessage(ownerJidToSend, { text: mensagemFinal })
        console.log('📿 Resumo Shopee enviado via WhatsApp')
    } catch (err) {
        console.error('❌ Erro no resumo Shopee:', err.message)
    }
}

cron.schedule('0 21 * * *', () => {
    console.log('⏰ Cron 21h: iniciando coleta Shopee')
    gerarResumoShopee()
}, { timezone: 'America/Sao_Paulo' })

// ─────────────────────────────────────────────────────────────────────────────
// Parte 3 — Cobrar o Adriano nos prazos certos (8h, 13h, 18h)
// ─────────────────────────────────────────────────────────────────────────────

async function cobrarAdriano() {
    if (!activeSock) {
        console.log('⚠️  [Zaya/Adriano] WhatsApp não conectado — cobrança adiada')
        return
    }
    const adrianoPhone = process.env.ADRIANO_PHONE || ''
    if (!adrianoPhone) {
        console.log('⚠️  [Zaya/Adriano] ADRIANO_PHONE não definido — cobrança ignorada')
        return
    }
    const adrianoJid = adrianoPhone.startsWith('55') ? `${adrianoPhone}@s.whatsapp.net` : `55${adrianoPhone}@s.whatsapp.net`

    const hoje = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const listas = carregarListas()
    const pendentes = listas.filter(l =>
        l.prazoEnvio === hoje &&
        !l.processado &&
        !l.aguardandoVerificacao &&
        !adrianoPendente.has(l.id)
    )

    if (pendentes.length === 0) {
        console.log('📦 [Zaya/Adriano] Nenhuma lista com prazo hoje aguardando resposta')
        return
    }

    for (const lista of pendentes) {
        const pedidosTexto = lista.pedidos.length > 0
            ? lista.pedidos.map(id => `• ${id}`).join('\n')
            : '(sem IDs identificados)'

        const mensagem = [
            `📦 *Despacho de hoje — ${new Date().toLocaleDateString('pt-BR')}*`,
            ``,
            `Adriano, os pedidos da lista de separação com prazo *hoje* já foram postados nos Correios/transportadora?`,
            ``,
            `Pedidos:`,
            pedidosTexto,
            ``,
            `Responda *"sim"* se já despachados, ou descreva o problema se houver algum impedimento.`,
            ``,
            `_(ref: ${lista.id})_`,
        ].join('\n')

        try {
            await activeSock.sendMessage(adrianoJid, { text: mensagem })
            adrianoPendente.set(lista.id, Date.now())
            console.log(`📦 [Zaya/Adriano] Cobrança enviada — lista ${lista.id}, ${lista.pedidos.length} pedido(s)`)
        } catch (err) {
            console.error(`❌ [Zaya/Adriano] Erro ao enviar cobrança: ${err.message}`)
        }
    }
}

cron.schedule('0 8,13,18 * * *', () => {
    console.log('⏰ [Zaya/Adriano] Verificando despachos do dia...')
    cobrarAdriano().catch(err => console.error('❌ [Zaya/Adriano] Erro no ciclo de cobrança:', err.message))
}, { timezone: 'America/Sao_Paulo' })

// ─────────────────────────────────────────────────────────────────────────────
// Parte 4 — Verificação cruzada com o Zyon após confirmação do Adriano
// ─────────────────────────────────────────────────────────────────────────────

function verificarPedidosComZyon(lista) {
    const zyonUrl = process.env.ZYON_URL || 'http://localhost:3001'
    const data = JSON.stringify({ orderIds: lista.pedidos, listaId: lista.id })
    let parsedUrl
    try { parsedUrl = new URL(`${zyonUrl}/verificar-pedidos-enviados`) } catch {
        console.error(`❌ [Zaya] ZYON_URL inválida: ${zyonUrl}`)
        return
    }
    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)

    const req = lib.request({
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
        let corpo = ''
        res.on('data', chunk => { corpo += chunk })
        res.on('end', () => {
            try {
                const { enviados = [], pendentes = [] } = JSON.parse(corpo)
                console.log(`✅ [Zaya/Zyon] Verificação recebida — enviados: ${enviados.length}, pendentes: ${pendentes.length}`)

                let mensagemZeon
                if (pendentes.length === 0) {
                    mensagemZeon = [
                        `✅ *Despacho confirmado — lista ${lista.id}*`,
                        ``,
                        `Todos os ${enviados.length} pedido(s) da lista foram despachados e saíram de "A Enviar" na Shopee.`,
                    ].join('\n')
                } else {
                    const pendentesTexto = pendentes.map(id => `• ${id}`).join('\n')
                    const enviadosTexto = enviados.length > 0
                        ? `Despachados: ${enviados.map(id => `• ${id}`).join(', ')}`
                        : 'Nenhum marcado como despachado ainda.'
                    mensagemZeon = [
                        `⚠️ *Despacho parcial — lista ${lista.id}*`,
                        ``,
                        `${pendentes.length} pedido(s) ainda em "A Enviar" na Shopee:`,
                        pendentesTexto,
                        ``,
                        enviadosTexto,
                    ].join('\n')
                }

                enviarMensagemZeon(mensagemZeon)

                // Marca lista como processada
                const listas = carregarListas()
                const idx = listas.findIndex(l => l.id === lista.id)
                if (idx !== -1) {
                    listas[idx].processado = true
                    listas[idx].processadoEm = new Date().toISOString()
                    listas[idx].resultadoVerificacao = { enviados, pendentes }
                    salvarListas(listas)
                }
                adrianoPendente.delete(lista.id)
            } catch (err) {
                console.error('❌ [Zaya] Erro ao processar resposta do Zyon (verificação):', err.message)
            }
        })
    })
    req.on('error', err => console.error(`❌ [Zaya] Erro ao chamar Zyon /verificar-pedidos-enviados: ${err.message}`))
    req.setTimeout(120000, () => req.destroy(new Error('Timeout verificação Zyon')))
    req.write(data)
    req.end()
}

async function tratarRespostaAdriano(sock, from, text) {
    const adrianoPhone = process.env.ADRIANO_PHONE || ''
    if (!adrianoPhone) return false
    const adrianoJid = adrianoPhone.startsWith('55') ? `${adrianoPhone}@s.whatsapp.net` : `55${adrianoPhone}@s.whatsapp.net`
    if (from !== adrianoJid) return false
    if (adrianoPendente.size === 0) return false

    const textoLower = text.toLowerCase().trim()
    const confirmou = /\b(sim|j[aá]|despachei|enviei|postei|pronto|feito|ok|enviado|despachado)\b/.test(textoLower)
    const problema = /\b(falt(ou|ando)|n[aã]o|problema|sem\s|n[aã]o\s+(recebi|chegou|tem)|impedi)\b/.test(textoLower)

    if (!confirmou && !problema) return false

    const listas = carregarListas()
    for (const [listaId] of adrianoPendente) {
        const lista = listas.find(l => l.id === listaId)
        if (!lista) continue

        if (confirmou) {
            console.log(`✅ [Zaya/Adriano] Adriano confirmou despacho da lista ${listaId} — iniciando verificação cruzada`)
            lista.aguardandoVerificacao = true
            salvarListas(listas)
            verificarPedidosComZyon(lista)
        } else {
            console.log(`⚠️  [Zaya/Adriano] Adriano reportou problema na lista ${listaId}: "${text}"`)
            const mensagemZeon = [
                `⚠️ *Problema no despacho — lista ${listaId}*`,
                ``,
                `Adriano reportou um problema com os pedidos de hoje:`,
                `"${text}"`,
                ``,
                `Pedidos afetados: ${lista.pedidos.join(', ') || '(não identificados)'}`,
                `Prazo: ${lista.prazoEnvio || '(não definido)'}`,
            ].join('\n')
            enviarMensagemZeon(mensagemZeon)
            adrianoPendente.delete(listaId)
        }
    }
    return true
}

console.log('⚡ Iniciando Zaya...')
console.log('📅 Resumo diário Shopee agendado para 21h (Brasília)')
console.log('⚡ Suporte ao Zeon ativado (endpoint /zeon-notificacao + repasse de decisões)')
console.log('📋 Monitoramento do grupo Ziont ativado (PDFs "Lista de Separação")')
console.log('📦 Cobranças ao Adriano: 8h, 13h e 18h (dias com prazo)')
console.log(`👷 Lucas: ${process.env.LUCAS_PHONE ? `55${process.env.LUCAS_PHONE}` : '(LUCAS_PHONE não definido)'}`)
console.log(`👷 Adriano: ${process.env.ADRIANO_PHONE ? `55${process.env.ADRIANO_PHONE}` : '(ADRIANO_PHONE não definido)'}`)
console.log(`📋 Grupo Ziont JID: ${process.env.ZIONT_GROUP_JID || '(será detectado automaticamente na 1ª mensagem)'}`)
connectToWhatsApp()
