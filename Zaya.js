require('dotenv').config()

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    Browsers
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const Groq = require('groq-sdk')
const qrcode = require('qrcode-terminal')
const pino = require('pino')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const conversations = new Map()
const humanAttending = new Map() // JID -> timestamp da última mensagem manual do dono
const lastActivity = new Map()   // JID -> timestamp da última mensagem do cliente
const HUMAN_TIMEOUT_MS = 30 * 60 * 1000    // 30 minutos sem resposta do dono reativa Zaya
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000 // 1 hora sem mensagem reinicia a conversa

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

async function connectToWhatsApp() {
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

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🚫 Dispositivo desconectado pelo WhatsApp. Delete a pasta auth_info e reinicie.')
            } else {
                console.log(`🔌 Reconectando em 5 segundos... (código ${statusCode})`)
                setTimeout(connectToWhatsApp, 5000)
            }
        } else if (connection === 'open') {
            console.log('✅ Zaya está online e pronta!')
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Registra respostas manuais do dono antes de qualquer filtro de tipo
        for (const msg of messages) {
            if (msg.key.fromMe && msg.key.remoteJid) {
                humanAttending.set(msg.key.remoteJid, Date.now())
            }
        }

        if (type !== 'notify') return

        for (const msg of messages) {
            const from = msg.key.remoteJid

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

            // Reinicia conversa se ficou inativo por mais de 1 hora
            const last = lastActivity.get(from)
            if (last && (Date.now() - last) > INACTIVITY_TIMEOUT_MS) {
                conversations.delete(from)
                console.log(`🔄 [${from.replace('@s.whatsapp.net', '')}]: Inatividade detectada, conversa reiniciada.`)
            }
            lastActivity.set(from, Date.now())

            const isFirstMessage = !conversations.has(from) || conversations.get(from).length === 0
            const sender = from.replace('@s.whatsapp.net', '')
            console.log(`\n💬 [${sender}]: ${text}`)

            try {
                await sock.sendPresenceUpdate('composing', from)
                await new Promise(resolve => setTimeout(resolve, 7000))

                // Verifica novamente após o delay — dono pode ter respondido durante a espera
                const ownerCheck = humanAttending.get(from)
                if (ownerCheck && (Date.now() - ownerCheck) < HUMAN_TIMEOUT_MS) {
                    await sock.sendPresenceUpdate('paused', from)
                    console.log(`⏸️  [${sender}]: Dono respondeu durante a espera, Zaya cancelou.`)
                    continue
                }

                const reply = await getAIResponse(from, text, isFirstMessage)

                const resumoMatch = reply.match(/---RESUMO---([\s\S]*?)---FIM---/)
                if (resumoMatch) {
                    const mensagemCliente = reply.slice(0, reply.indexOf('---RESUMO---')).trim()
                    const resumo = resumoMatch[1].trim()

                    if (mensagemCliente) {
                        await sock.sendMessage(from, { text: mensagemCliente })
                    }
                    await sock.sendMessage(from, { text: `📋 *Resumo para atendimento:*\n\n${resumo}` })
                    console.log(`🤖 Zaya: ${mensagemCliente}`)
                    console.log(`📋 Resumo enviado`)
                } else {
                    await sock.sendMessage(from, { text: reply })
                    console.log(`🤖 Zaya: ${reply}`)
                }
            } catch (err) {
                console.error('❌ Erro ao responder:', err.message)
            }
        }
    })
}

console.log('⚡ Iniciando Zaya...')
connectToWhatsApp()
