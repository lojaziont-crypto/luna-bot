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

let activeSock = null
let ownerJid = null
let reconnectTimer = null
let ultimoFaturamento = { fatDia: null, fatMes: null, aEnviar: null, atualizadoEm: null }
const STARTUP_TS = Math.floor(Date.now() / 1000) // segundos — filtra mensagens antigas no sync

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
    if (!activeSock) {
        console.log('⚠️ notifyNewOrder: WhatsApp não conectado')
        return
    }
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, {
            text: `🛍 *Nova Venda!*\n\nPedido *#${orderId}* confirmado! 🎉\n\nAcesse a Shopee para preparar o envio.`
        })
        console.log(`🛍️ [Zyon→Zaya] Notificação enviada: pedido #${orderId}`)
    } catch (err) {
        console.error('❌ Erro ao enviar notificação de novo pedido:', err.message)
    }
}

async function notifyChatHuman(nomeCliente, ultimaMensagem, resumo) {
    if (!activeSock) {
        console.log('⚠️ notifyChatHuman: WhatsApp não conectado')
        return
    }
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, {
            text: `🙋 *Atendimento humano necessário (Shopee)*\n\n*Cliente:* ${nomeCliente}\n*Última mensagem:* ${ultimaMensagem}\n\n*Resumo da conversa:*\n${resumo}`
        })
        console.log(`🙋 [Zyon→Zaya] Notificação de atendimento humano enviada: ${nomeCliente}`)
    } catch (err) {
        console.error('❌ Erro ao enviar notificação de atendimento humano:', err.message)
    }
}

async function notifyChatUpdate(nomeCliente, informacao) {
    if (!activeSock) {
        console.log('⚠️ notifyChatUpdate: WhatsApp não conectado')
        return
    }
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, {
            text: `📌 *Atualização de atendimento*\nCliente: ${nomeCliente}\nPedido: não informado\nInformação: ${informacao}`
        })
        console.log(`📌 [Zyon→Zaya] Notificação de informação importante enviada: ${nomeCliente}`)
    } catch (err) {
        console.error('❌ Erro ao enviar notificação de informação importante:', err.message)
    }
}

async function notifyFinn(mensagem) {
    if (!activeSock) {
        console.log('⚠️ notifyFinn: WhatsApp não conectado')
        return
    }
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        await activeSock.sendMessage(ownerJidToSend, { text: mensagem })
        console.log('💰 [Finn→Zaya] Notificação enviada ao dono')
    } catch (err) {
        console.error('❌ Erro ao enviar notificação do Finn:', err.message)
    }
}

// ───────────────────────── Finn (agente financeiro) ─────────────────────────

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

const PALAVRAS_LANCAMENTO = ['gastei', 'paguei', 'recebi', 'comprei', 'lancei', 'lancei', 'pagar', 'recebimento', 'gasto', 'compra', 'conta de', 'boleto']
function contemPalavraDeLancamento(textoLower) {
    return PALAVRAS_LANCAMENTO.some(p => textoLower.includes(p))
}

async function responderLimites(sock, from) {
    try {
        const resposta = await finnRequest('GET', '/limites')
        const limitesObtidos = resposta?.limites || {}
        const categorias = Object.keys(limitesObtidos)
        if (categorias.length === 0) {
            await sock.sendMessage(from, { text: '📋 Nenhum limite definido ainda.\n\nPara definir, envie: *limite [categoria] [valor]*' })
            return
        }
        const linhas = categorias.map(cat => `• ${cat}: R$ ${Number(limitesObtidos[cat]).toFixed(2)}`)
        await sock.sendMessage(from, { text: `📋 *Limites mensais definidos:*\n\n${linhas.join('\n')}` })
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
        await sock.sendMessage(from, { text: '🧾 Recebi! Estou registrando esse lançamento, aviso quando concluir. ⏳' })
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
        await sock.sendMessage(from, { text: '🧾 Comprovante recebido! Estou extraindo os dados e registrando, aviso quando concluir. ⏳' })
    } catch (err) {
        console.error('❌ [Zaya/Finn] Erro ao processar comprovante de imagem:', err.message)
        await sock.sendMessage(from, { text: '❌ Não consegui processar o comprovante agora. O Finn está rodando?' })
    }
}

// HTTP server — Zyon envia POST /notify-order para notificar nova venda
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
                console.error('❌ /notify-order error:', err.message)
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
                console.error('❌ /notify-chat-human error:', err.message)
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
                console.error('❌ /notify-chat-update error:', err.message)
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
                console.error('❌ /finn-notificacao error:', err.message)
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
                console.log(`📊 [Zaya] Dados recebidos do Zyon — Dia: R$ ${fatDia} | Mês: R$ ${fatMes} | A Enviar: ${aEnviar}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                console.error('❌ /update-faturamento error:', err.message)
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
server.listen(PORT, () => console.log(`🌐 Zaya HTTP server na porta ${PORT}`))

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
                console.log('🚫 Dispositivo desconectado pelo WhatsApp. Delete a pasta auth_info e reinicie.')
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('⚠️ Sessão substituída (440) — deletando auth e exibindo novo QR code...')
                try { fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true }) } catch {}
                if (reconnectTimer) clearTimeout(reconnectTimer)
                reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToWhatsApp() }, 3000)
            } else {
                if (reconnectTimer) clearTimeout(reconnectTimer)
                console.log(`🔌 Reconectando em 5s... (código ${statusCode})`)
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
        console.log(`📬 [upsert] type=${type} msgs=${messages.length}`)

        // Aceita 'notify' (tempo real) e 'append' (sync de reconexão recente)
        // Mensagens antigas do histórico são filtradas pelo timestamp abaixo
        if (type !== 'notify' && type !== 'append') return

        for (const msg of messages) {
            const from = msg.key.remoteJid
            if (!from) { console.log('⏭️ skip: sem remoteJid'); continue }

            if (msg.key.fromMe) continue

            if (from.endsWith('@g.us')) { console.log(`⏭️ skip: grupo`); continue }

            if (!msg.message) { console.log(`⏭️ skip: sem msg.message`); continue }

            // Ignora mensagens antigas do histórico (chegam via type='append')
            const msgTs = Number(msg.messageTimestamp)
            if (msgTs && msgTs < STARTUP_TS - 120) {
                console.log(`⏭️ skip: mensagem antiga (${new Date(msgTs * 1000).toLocaleTimeString('pt-BR')})`)
                continue
            }

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                null

            // Comando exclusivo do dono
            const isOwner = from === ownerJid || from === process.env.OWNER_JID ||
                normalizePhone(from) === normalizePhone(process.env.OWNER_PHONE || '')

            // ─── Comandos do Finn (agente financeiro) — só para o dono, antes da IA normal ───
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

                if (text && contemPalavraDeLancamento(textoLower)) {
                    await processarLancamentoTexto(sock, from, text)
                    continue
                }
            }

            if (!text) {
                const keys = Object.keys(msg.message).join(',')
                console.log(`⏭️ skip: sem texto (campos: ${keys})`)
                continue
            }

            if (isOwner && text.trim() === '!shopee') {
                console.log('📲 Comando !shopee recebido — gerando relatório...')
                gerarResumoShopee()
                continue
            }

            // Registro manual do dono (caso auto-detecção falhe)
            if (text.trim() === `!registrar ${process.env.OWNER_PHONE}`) {
                salvarOwnerJid(from)
                await sock.sendMessage(from, { text: '✅ Você foi registrado como dono! Agora use *!shopee* para gerar o relatório.' })
                continue
            }

            // Respostas automáticas a clientes foram desativadas — Zaya agora só repassa ao
            // dono os avisos vindos do Zyon (pedidos, chat, faturamento) e atende !shopee/!registrar
            const sender = from.replace('@s.whatsapp.net', '')
            console.log(`⏭️  [${sender}]: resposta automática desativada`)
        }
    })
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
            console.log(`📥 [Zaya] Zyon concluiu coleta (HTTP ${res.statusCode})`)
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
    if (!activeSock) {
        console.log('❌ Resumo Shopee: WhatsApp não conectado')
        return
    }

    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`

    try {
        await activeSock.sendMessage(ownerJidToSend, {
            text: '⏳ Coletando dados atualizados, aguarde...'
        })

        console.log('📲 [Zaya] Solicitando coleta imediata ao Zyon...')
        await solicitarFaturamentoZyon()

        if (!ultimoFaturamento.atualizadoEm) {
            console.log('⚠️  [Zaya] Zyon não respondeu ou não está rodando')
            await activeSock.sendMessage(ownerJidToSend, {
                text: '⏳ Zyon não respondeu.\nVerifique se ele está rodando: `node zyon.js`'
            })
            return
        }

        const fatDia  = ultimoFaturamento.fatDia  || '?'
        const fatMes  = ultimoFaturamento.fatMes  || '?'
        const aEnviar = ultimoFaturamento.aEnviar || '?'
        const hora    = new Date(ultimoFaturamento.atualizadoEm).toLocaleTimeString('pt-BR')
        const data    = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

        console.log(`📊 [Zaya] !shopee — dados do Zyon atualizados às ${hora}`)

        const mensagemFinal = [
            `🛍 *Shopee — ${data}*`,
            `_atualizado às ${hora}_`,
            ``,
            `💰 *Faturamento do dia:* R$ ${fatDia}`,
            `📦 *A Enviar:* ${aEnviar}`,
            `💰 *Faturamento do mês:* R$ ${fatMes}`,
        ].join('\n')

        await activeSock.sendMessage(ownerJidToSend, { text: mensagemFinal })
        console.log('📨 Resumo Shopee enviado via WhatsApp')

    } catch (err) {
        console.error('❌ Erro no resumo Shopee:', err.message)
        try {
            await activeSock.sendMessage(ownerJidToSend, {
                text: `❌ Erro ao gerar relatório:\n${err.message}`
            })
        } catch {}
    }
}

cron.schedule('0 21 * * *', () => {
    console.log('⏰ Cron 21h: iniciando coleta Shopee')
    gerarResumoShopee()
}, { timezone: 'America/Sao_Paulo' })

console.log('⚡ Iniciando Zaya...')
console.log('📅 Resumo diário Shopee agendado para 21h (Brasília)')
connectToWhatsApp()
