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

const SYSTEM_PROMPT = `Você é Luna, uma atendente cordial, leve e natural. Conversa como uma pessoa real no WhatsApp — nunca parece robô.

Como você se comporta:
- Tom amigável, humano e acolhedor, como uma atendente prestativa de verdade
- Linguagem informal e tranquila, sem ser formal demais
- Emojis ocasionais para deixar a conversa mais leve 😊
- Foco em entender e resolver o problema da pessoa
- Respostas CURTAS — 1 a 3 linhas, estilo WhatsApp
- Sem listas, sem textão, sem parecer uma FAQ
- Pode se identificar como Luna quando perguntada, mas nunca menciona que é IA
- Se a pessoa perguntar se é robô ou IA, desvie com leveza: "Que nada, sou a Luna mesmo! 😄"

Quando não souber responder:
- Avise que vai passar para um atendente humano
- Pergunte o nome da pessoa e o assunto, para facilitar o atendimento
- Exemplo: "Deixa eu te passar para alguém que pode te ajudar melhor! Me diz seu nome e o que você precisa? 😊"
- Depois de coletar nome e assunto, confirme: "Perfeito! Já chamo alguém, aguarda um instante 🙏"
- Em seguida, gere um resumo interno da conversa usando EXATAMENTE este formato, sem alterar nada:

---RESUMO---
👤 *Contato:* [nome informado ou "Não informado"]
❓ *Problema:* [resumo do que a pessoa relatou]
🔧 *O que foi tentado:* [o que Luna tentou resolver, ou "Nenhuma solução tentada"]
---FIM---

Responda sempre em português.`

async function getAIResponse(from, userMessage) {
    if (!conversations.has(from)) {
        conversations.set(from, [])
    }

    const history = conversations.get(from)
    history.push({ role: 'user', content: userMessage })

    const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history]
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
            console.log('✅ Luna está online e pronta!')
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            if (msg.key.fromMe) continue
            if (!msg.message) continue

            const from = msg.key.remoteJid
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                null

            if (!text) continue

            const sender = from.replace('@s.whatsapp.net', '').replace('@g.us', ' (grupo)')
            console.log(`\n💬 [${sender}]: ${text}`)

            try {
                await sock.sendPresenceUpdate('composing', from)
                await new Promise(resolve => setTimeout(resolve, 7000))
                const reply = await getAIResponse(from, text)

                // Separa mensagem para o cliente do resumo interno
                const resumoMatch = reply.match(/---RESUMO---([\s\S]*?)---FIM---/)
                if (resumoMatch) {
                    const mensagemCliente = reply.slice(0, reply.indexOf('---RESUMO---')).trim()
                    const resumo = resumoMatch[1].trim()

                    if (mensagemCliente) {
                        await sock.sendMessage(from, { text: mensagemCliente })
                    }
                    await sock.sendMessage(from, { text: `📋 *Resumo para atendimento:*\n\n${resumo}` })
                    console.log(`🤖 Luna: ${mensagemCliente}`)
                    console.log(`📋 Resumo enviado`)
                } else {
                    await sock.sendMessage(from, { text: reply })
                    console.log(`🤖 Luna: ${reply}`)
                }
            } catch (err) {
                console.error('❌ Erro ao responder:', err.message)
            }
        }
    })
}

console.log('🌙 Iniciando Luna...')
connectToWhatsApp()
