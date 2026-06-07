require('dotenv').config()

const { Boom } = require('@hapi/boom')
const Groq = require('groq-sdk')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const cron = require('node-cron')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { coletarStatusPedidos } = require('./shopee-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const conversations = new Map()
const humanAttending = new Map()   // JID -> timestamp da última mensagem manual do dono
const lastActivity = new Map()     // JID -> timestamp da última mensagem do cliente
const botSentMessages = new Set()  // IDs de mensagens enviadas pela Zaya (evita falso humanAttending em echoes)
let activeSock = null
let ownerJid = null
let reconnectTimer = null

const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json')
const STATE_FILE = path.join(__dirname, 'state.json')

function loadState() {
    try {
        if (fs.existsSync(CONVERSATIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf8'))
            for (const [jid, history] of Object.entries(data)) {
                conversations.set(jid, history)
            }
            console.log(`📂 Conversas carregadas: ${conversations.size} contatos`)
        }
    } catch (e) { console.error('⚠️ Erro ao carregar conversations.json:', e.message) }

    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
            for (const [jid, ts] of Object.entries(data.humanAttending || {})) {
                humanAttending.set(jid, ts)
            }
            for (const [jid, ts] of Object.entries(data.lastActivity || {})) {
                lastActivity.set(jid, ts)
            }
        }
    } catch (e) { console.error('⚠️ Erro ao carregar state.json:', e.message) }
}

function saveConversations() {
    try {
        fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(Object.fromEntries(conversations)))
    } catch (e) { console.error('⚠️ Erro ao salvar conversations.json:', e.message) }
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            humanAttending: Object.fromEntries(humanAttending),
            lastActivity: Object.fromEntries(lastActivity),
        }))
    } catch (e) { console.error('⚠️ Erro ao salvar state.json:', e.message) }
}

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

// Rastreia mensagens enviadas pela Zaya para não confundir echoes com respostas humanas
function trackSend(sent) {
    if (sent?.key?.id) {
        botSentMessages.add(sent.key.id)
        if (botSentMessages.size > 200) botSentMessages.clear()
    }
}

const HUMAN_TIMEOUT_MS = 30 * 60 * 1000
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000

const SYSTEM_PROMPT = `Você é Zaya, assistente virtual de atendimento. Conversa de forma natural e humana no WhatsApp — nunca parece robô.

Como você se comporta:
- Tom leve, amigável e cordial, como uma atendente prestativa de verdade
- Respostas CURTAS e diretas — 1 a 3 linhas, estilo WhatsApp
- Sem enrolação, sem textão, sem listas ou FAQs
- Foco em resolver o problema do cliente de forma direta
- Emojis ocasionais para deixar a conversa mais natural 😊
- Nunca menciona que é IA; se perguntada, desvie com leveza: "Sou a Zaya, pode falar! 😄"

Na primeira mensagem de um contato novo:
- Apresente-se: diga seu nome (Zaya) e que é assistente virtual de atendimento
- Seja acolhedora e pergunte como pode ajudar
- Exemplo: "Oi! Sou a Zaya, assistente virtual de atendimento 😊 Como posso te ajudar hoje?"

Quando não conseguir resolver o problema:
- Informe que vai transferir para um atendente humano
- Pergunte o nome da pessoa e o assunto
- Exemplo: "Vou te passar para um atendente humano que pode te ajudar melhor! Me diz seu nome e o assunto, por favor? 😊"
- Após coletar nome e assunto, confirme: "Perfeito! Já chamo alguém pra você, aguarda um instante 🙏"
- Em seguida, gere um resumo interno usando EXATAMENTE este formato, sem alterar nada:

---RESUMO---
👤 *Contato:* [nome informado ou "Não informado"]
❓ *Problema:* [resumo do que a pessoa relatou]
🔧 *O que foi tentado:* [o que Zaya tentou resolver, ou "Nenhuma solução tentada"]
---FIM---

Responda sempre em português.`

async function getAIResponse(from, userMessage, isFirstMessage) {
    if (!conversations.has(from)) {
        conversations.set(from, [])
    }

    const history = conversations.get(from)
    history.push({ role: 'user', content: userMessage })

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }]

    if (isFirstMessage) {
        messages.push({
            role: 'system',
            content: 'Esta é a primeira mensagem deste contato. Apresente-se como Zaya, assistente virtual de atendimento, e pergunte como pode ajudar.'
        })
    }

    messages.push(...history)

    const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        messages
    })

    const reply = response.choices[0].message.content
    history.push({ role: 'assistant', content: reply })

    if (history.length > 20) {
        history.splice(0, history.length - 20)
    }

    return reply
}

async function notifyNewOrder(orderId) {
    if (!activeSock) {
        console.log('⚠️ notifyNewOrder: WhatsApp não conectado')
        return
    }
    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    try {
        trackSend(await activeSock.sendMessage(ownerJidToSend, {
            text: `🛍 *Nova Venda!*\n\nPedido *#${orderId}* confirmado! 🎉\n\nAcesse a Shopee para preparar o envio.`
        }))
        console.log(`🛍️ [Zyon→Zaya] Notificação enviada: pedido #${orderId}`)
    } catch (err) {
        console.error('❌ Erro ao enviar notificação de novo pedido:', err.message)
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
        // Processa apenas mensagens novas — ignora histórico/sincronização
        if (type !== 'notify') return

        // Detecta mensagens enviadas manualmente pelo dono (fromMe = true, mas não enviadas pela Zaya)
        for (const msg of messages) {
            if (msg.key.fromMe && msg.key.remoteJid) {
                // Echo de mensagem enviada pela própria Zaya — ignorar
                if (botSentMessages.has(msg.key.id)) {
                    botSentMessages.delete(msg.key.id)
                    continue
                }
                const jid = msg.key.remoteJid
                const isOwnerJid = jid === ownerJid || jid === process.env.OWNER_JID ||
                    normalizePhone(jid) === normalizePhone(process.env.OWNER_PHONE || '')
                // Mensagem fromMe para um cliente (não o próprio dono) = dono respondeu manualmente
                if (!isOwnerJid) {
                    humanAttending.set(jid, Date.now())
                    saveState()
                }
            }
        }

        for (const msg of messages) {
            const from = msg.key.remoteJid
            if (!from) continue

            if (msg.key.fromMe) continue

            // Nunca responde em grupos
            if (from.endsWith('@g.us')) continue

            if (!msg.message) continue

            // Pausa se o dono respondeu manualmente nos últimos 30 minutos
            const lastOwner = humanAttending.get(from)
            if (lastOwner && (Date.now() - lastOwner) < HUMAN_TIMEOUT_MS) {
                const sender = from.replace('@s.whatsapp.net', '')
                console.log(`⏸️  [${sender}]: Atendimento humano ativo, Zaya pausada.`)
                continue
            }

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                null

            if (!text) continue

            // Mensagens do dono nunca vão para a IA
            const isOwner = from === ownerJid || from === process.env.OWNER_JID ||
                normalizePhone(from) === normalizePhone(process.env.OWNER_PHONE || '')

            if (isOwner) {
                if (text.trim() === '!shopee') {
                    console.log('📲 Comando !shopee recebido — gerando relatório...')
                    gerarResumoShopee()
                }
                continue
            }

            // Registro manual do dono (caso auto-detecção falhe)
            if (text.trim() === `!registrar ${process.env.OWNER_PHONE}`) {
                salvarOwnerJid(from)
                trackSend(await sock.sendMessage(from, { text: '✅ Você foi registrado como dono! Agora use *!shopee* para gerar o relatório.' }))
                continue
            }

            // Reinicia conversa se ficou inativo por mais de 1 hora
            const last = lastActivity.get(from)
            if (last && (Date.now() - last) > INACTIVITY_TIMEOUT_MS) {
                conversations.delete(from)
                console.log(`🔄 [${from.replace('@s.whatsapp.net', '')}]: Inatividade detectada, conversa reiniciada.`)
            }
            lastActivity.set(from, Date.now())
            saveState()

            const isFirstMessage = !conversations.has(from) || conversations.get(from).length === 0
            const sender = from.replace('@s.whatsapp.net', '')
            console.log(`\n💬 [${sender}]: ${text}`)

            try { await sock.sendPresenceUpdate('composing', from) } catch {}

            try {
                await new Promise(resolve => setTimeout(resolve, 3000))

                // Verifica novamente após o delay — dono pode ter respondido durante a espera
                const ownerCheck = humanAttending.get(from)
                if (ownerCheck && (Date.now() - ownerCheck) < HUMAN_TIMEOUT_MS) {
                    try { await sock.sendPresenceUpdate('paused', from) } catch {}
                    console.log(`⏸️  [${sender}]: Dono respondeu durante a espera, Zaya cancelou.`)
                    continue
                }

                const reply = await getAIResponse(from, text, isFirstMessage)

                const resumoMatch = reply.match(/---RESUMO---([\s\S]*?)---FIM---/)
                if (resumoMatch) {
                    const mensagemCliente = reply.slice(0, reply.indexOf('---RESUMO---')).trim()
                    const resumo = resumoMatch[1].trim()

                    if (mensagemCliente) {
                        trackSend(await sock.sendMessage(from, { text: mensagemCliente }))
                    }
                    trackSend(await sock.sendMessage(from, { text: `📋 *Resumo para atendimento:*\n\n${resumo}` }))
                    saveConversations()
                    console.log(`🤖 Zaya: ${mensagemCliente}`)
                    console.log(`📋 Resumo enviado`)
                } else {
                    trackSend(await sock.sendMessage(from, { text: reply }))
                    saveConversations()
                    console.log(`🤖 Zaya: ${reply}`)
                }
            } catch (err) {
                console.error('❌ Erro ao responder:', err.message)
                console.error(err.stack?.split('\n').slice(0, 3).join('\n'))
                try {
                    trackSend(await sock.sendMessage(from, { text: 'Desculpe, tive um problema técnico. Tente novamente em instantes! 🙏' }))
                } catch {}
            }
        }
    })
}

async function gerarResumoShopee() {
    if (!activeSock) {
        console.log('❌ Resumo Shopee: WhatsApp não conectado')
        return
    }

    const ownerJidToSend = ownerJid || `55${process.env.OWNER_PHONE}@s.whatsapp.net`
    console.log(`\n🛍️  Iniciando coleta de dados Shopee... (envio para: ${ownerJidToSend})`)

    try {
        trackSend(await activeSock.sendMessage(ownerJidToSend, { text: '⏳ Coletando dados da sua loja Shopee, aguarde...' }))

        const { overviewText, orderText } = await coletarStatusPedidos()

        const extrair = (texto, regex) => { const m = texto.match(regex); return m ? m[1] : '?' }

        const aEnviar = extrair(orderText, /A Enviar\s*\((\d+)\)/i)

        let fatDia = '?', fatMes = '?'
        const fatPair = overviewText.match(/[Ff]aturamento[^R$]{0,40}R\$\s*([\d.]+,\d{2})[^R$]{0,60}R\$\s*([\d.]+,\d{2})/)
        if (fatPair) {
            fatDia = fatPair[1]
            fatMes = fatPair[2]
        } else {
            const moedas = [...overviewText.matchAll(/R\$\s*([\d.]+,\d{2})/g)].map(m => m[1])
            fatDia = moedas[0] ?? '?'
            fatMes = moedas[1] ?? moedas[0] ?? '?'
        }

        const allText = overviewText + ' ' + orderText
        const alertas = /atraso|cancelamento|reclamação|disputa|penalidade|violação|aviso|atenção/i.test(allText)
            ? 'Há itens que precisam de atenção — verifique o painel Shopee'
            : 'Nenhum'

        const data = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

        const mensagemFinal = [
            `🛍 *Shopee — ${data}*`,
            ``,
            `💰 *Faturamento do dia:* R$ ${fatDia}`,
            `📦 *A Enviar:* ${aEnviar}`,
            `💰 *Faturamento do mês:* R$ ${fatMes}`,
            `⚠️ *Alertas:* ${alertas}`,
        ].join('\n')

        trackSend(await activeSock.sendMessage(ownerJidToSend, { text: mensagemFinal }))
        console.log('📨 Resumo Shopee enviado via WhatsApp')

    } catch (err) {
        console.error('❌ Erro no resumo Shopee:', err.message)
        try {
            trackSend(await activeSock.sendMessage(ownerJidToSend, {
                text: `❌ Erro ao coletar dados da Shopee:\n${err.message}`
            }))
        } catch {}
    }
}

cron.schedule('0 21 * * *', () => {
    console.log('⏰ Cron 21h: iniciando coleta Shopee')
    gerarResumoShopee()
}, { timezone: 'America/Sao_Paulo' })

loadState()
console.log('⚡ Iniciando Zaya...')
console.log('📅 Resumo diário Shopee agendado para 21h (Brasília)')
connectToWhatsApp()
